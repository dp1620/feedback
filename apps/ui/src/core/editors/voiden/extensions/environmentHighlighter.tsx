import { Extension } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, EditorView } from "@tiptap/pm/view";
import tippy, { Instance as TippyInstance } from "tippy.js";

// Global state to hold current environment keys
let currentEnvKeys = new Set<string>();

/**
 * Update environment keys and trigger re-render
 */
export function updateEnvironmentKeys(keys: string[]) {
  currentEnvKeys = new Set(keys);
}

/**
 * Find and highlight variables in the document.
 * @param doc - The document to search
 */
function findVariable(doc: Node): DecorationSet {
  const variableRegex = /{{(.*?)}}/g;
  const decorations: Decoration[] = [];

  doc.descendants((node, position) => {
    if (!node.text) return;

    Array.from(node.text.matchAll(variableRegex)).forEach((match) => {
      const variableName = match[1].trim(); // Extract variable name
      const index = match.index || 0;
      const from = position + index;
      const to = from + match[0].length;
      if (variableName.startsWith('process.')) {
        // Skip process variables - handled by variableHighlighter
        return;
      }
      // Check if it's a faker variable
      const isFakerVariable = variableName.startsWith('$faker');
      const isVariableCapture = variableName.startsWith('$req') || variableName.startsWith('$res');
      let decorationClass: string;

      if (isFakerVariable || isVariableCapture) {
        // Cyan for faker variables - uses CSS variables for theme support
        decorationClass = "font-mono rounded-sm font-medium px-1 text-base variable-highlight-faker";
      } else {
        // Check if variable exists in environment (using global state)
        const isVariableInEnv = currentEnvKeys.has(variableName);
        decorationClass = isVariableInEnv
          ? "font-mono rounded-sm font-medium px-1 text-base variable-highlight-valid" // Green for existing variables
          : "font-mono rounded-sm font-medium px-1 text-base variable-highlight-invalid"; // Red for non-existing variables
      }

      decorations.push(Decoration.inline(from, to, { class: decorationClass }));
    });
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * Extract the environment variable name from a decorated span element.
 * Returns null if the element is not a valid environment variable decoration.
 */
function getEnvVariableFromElement(element: HTMLElement): string | null {
  const isEnvVar =
    element.classList.contains("variable-highlight-valid") ||
    element.classList.contains("variable-highlight-invalid");
  if (!isEnvVar) return null;

  const text = element.textContent || "";
  const match = text.match(/^{{(.+?)}}$/);
  return match ? match[1].trim() : null;
}

// Cache to avoid repeated IPC calls for the same variable
const resolveCache = new Map<string, { value: string | null; timestamp: number }>();
const CACHE_TTL = 5000; // 5 seconds

async function resolveEnvVariable(variableName: string): Promise<string | null> {
  const cached = resolveCache.get(variableName);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.value;
  }

  try {
    const value = await window.electron?.env.resolveVariable(variableName);
    resolveCache.set(variableName, { value: value ?? null, timestamp: Date.now() });
    return value ?? null;
  } catch {
    return null;
  }
}

const pluginKey = new PluginKey("colorHighlighter");

/**
 * Environment highlighter extension.
 * @param envKeys - Array of environment variable names (secure - no values exposed)
 * @security Only accepts variable names, never values
 */
export const environmentHighlighter = (envKeys: string[] = []) => {
  // Update global keys
  updateEnvironmentKeys(envKeys);

  return Extension.create({
    name: "colorHighlighter",

    addProseMirrorPlugins() {
      let hoverTooltip: TippyInstance | null = null;

      return [
        new Plugin({
          key: pluginKey,
          state: {
            init(_, { doc }) {
              return findVariable(doc);
            },
            apply(transaction, oldState) {
              // Always recompute if there's a meta flag or doc changed
              if (transaction.getMeta("forceHighlightUpdate") || transaction.docChanged) {
                return findVariable(transaction.doc);
              }
              return oldState;
            },
          },
          props: {
            decorations(state) {
              return this.getState(state);
            },
            handleDOMEvents: {
              mouseover(_view: EditorView, event: MouseEvent) {
                const target = event.target as HTMLElement;
                const variableName = getEnvVariableFromElement(target);

                if (!variableName) return false;

                // Destroy existing tooltip if hovering a different element
                if (hoverTooltip) {
                  hoverTooltip.destroy();
                  hoverTooltip = null;
                }

                // Create tooltip with loading state
                hoverTooltip = tippy(target, {
                  content: "Loading...",
                  showOnCreate: true,
                  allowHTML: true,
                  placement: "top",
                  interactive: false,
                  appendTo: () => document.body,
                  theme: "variable-preview",
                  onHidden(instance) {
                    instance.destroy();
                    if (hoverTooltip === instance) {
                      hoverTooltip = null;
                    }
                  },
                });

                // Resolve variable value asynchronously
                resolveEnvVariable(variableName).then((value) => {
                  if (!hoverTooltip) return;
                  if (value !== null) {
                    const truncated = value.length > 200 ? value.substring(0, 200) + "..." : value;
                    const escaped = truncated
                      .replace(/&/g, "&amp;")
                      .replace(/</g, "&lt;")
                      .replace(/>/g, "&gt;");
                    hoverTooltip.setContent(
                      `<div style="font-family: monospace; font-size: 12px; max-width: 350px; word-break: break-all;">` +
                        `<div style="color: #9ca3af; font-size: 11px; margin-bottom: 2px;">${variableName}</div>` +
                        `<div>${escaped}</div>` +
                      `</div>`
                    );
                  } else {
                    hoverTooltip.setContent(
                      `<div style="font-family: monospace; font-size: 12px;">` +
                        `<div style="color: #9ca3af; font-size: 11px; margin-bottom: 2px;">${variableName}</div>` +
                        `<div style="color: #f87171;">Not defined in active environment</div>` +
                      `</div>`
                    );
                  }
                });

                return false;
              },
              mouseout(_view: EditorView, event: MouseEvent) {
                const relatedTarget = event.relatedTarget as HTMLElement | null;
                // Don't destroy if moving to the tooltip itself
                if (relatedTarget?.closest("[data-tippy-root]")) return false;

                if (hoverTooltip) {
                  hoverTooltip.destroy();
                  hoverTooltip = null;
                }
                return false;
              },
            },
          },
        }),
      ];
    },
  });
};
