import { Extension } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, EditorView } from "@tiptap/pm/view";
import Suggestion, { SuggestionOptions } from "@tiptap/suggestion";
import tippy, { Instance as TippyInstance } from "tippy.js";

// Global state to hold current variable keys
let currentVariableKeys = new Set<string>();

/**
 * Update variable keys from .voiden/.process.env.json
 */
export function updateVariableKeys(keys: string[]) {
    currentVariableKeys = new Set(keys);
}

/**
 * Find and highlight process variables in the document.
 * @param doc - The document to search
 */
function findProcessVariables(doc: Node): DecorationSet {
    const variableRegex = /{{(.*?)}}/g;
    const decorations: Decoration[] = [];

    doc.descendants((node, position) => {
        if (!node.text) return;

        Array.from(node.text.matchAll(variableRegex)).forEach((match) => {
            const variableName = match[1].trim(); // Extract variable name (e.g., "process.userId")
            const index = match.index || 0;
            const from = position + index;
            const to = from + match[0].length;
            const isVariableCapture = variableName.startsWith('$req') || variableName.startsWith('$res');
            const isProcessVariable = variableName.startsWith('process.');
            if (!isVariableCapture && !isProcessVariable) {
                return; // Skip non-process and non-variable-capture variables
            }
            // Extract the key after "process."
            const processKey = variableName.replace('process.', '');
            const isValidProcessVar = currentVariableKeys.has(processKey);


            let decorationClass: string;

            if (isVariableCapture) {
                // Bright cyan for faker variables - high contrast on dark backgrounds
                decorationClass = "font-mono bg-cyan-400/20 text-cyan-300 rounded-sm font-medium px-1 text-base";
            } else {
                decorationClass = isValidProcessVar
                    ? "font-mono bg-emerald-400/20 text-emerald-300 rounded-sm font-medium px-1 text-base variable-process-valid" // Green for valid process variables
                    : "font-mono bg-rose-400/20 text-rose-300 rounded-sm font-medium px-1 text-base variable-process-invalid"; // Red for invalid
            }


            decorations.push(Decoration.inline(from, to, { class: decorationClass }));
        });
    });

    return DecorationSet.create(doc, decorations);
}

/**
 * Extract the process variable name from a decorated span element.
 * Returns the key (without "process." prefix) or null if not applicable.
 */
function getProcessVariableFromElement(element: HTMLElement): { key: string; fullName: string } | null {
    const isProcessVar =
        element.classList.contains("variable-process-valid") ||
        element.classList.contains("variable-process-invalid");
    if (!isProcessVar) return null;

    const text = element.textContent || "";
    const match = text.match(/^{{process\.(.+?)}}$/);
    return match ? { key: match[1].trim(), fullName: `process.${match[1].trim()}` } : null;
}

// Cache to avoid repeated IPC calls for the same variable
const resolveCache = new Map<string, { value: string | null; timestamp: number }>();
const CACHE_TTL = 5000; // 5 seconds

async function resolveProcessVariable(variableName: string): Promise<string | null> {
    const cached = resolveCache.get(variableName);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.value;
    }

    try {
        const value = await window.electron?.variables.resolveVariable(variableName);
        resolveCache.set(variableName, { value: value ?? null, timestamp: Date.now() });
        return value ?? null;
    } catch {
        return null;
    }
}

const pluginKey = new PluginKey("variableHighlighter");

/**
 * Variable highlighter extension with process variable suggestions.
 * @param variableKeys - Array of keys from .voiden/.process.env.json
 */
export const variableHighlighter = (variableKeys: string[] = []) => {
    // Update global keys
    updateVariableKeys(variableKeys);

    return Extension.create({
        name: "variableHighlighter",
        addProseMirrorPlugins() {
            let hoverTooltip: TippyInstance | null = null;

            return [
                new Plugin({
                    key: pluginKey,
                    state: {
                        init(_, { doc }) {
                            return findProcessVariables(doc);
                        },
                        apply(transaction, oldState) {
                            // Always recompute if there's a meta flag or doc changed
                            if (transaction.getMeta("forceVariableHighlightUpdate") || transaction.docChanged) {
                                return findProcessVariables(transaction.doc);
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
                                const varInfo = getProcessVariableFromElement(target);

                                if (!varInfo) return false;

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
                                resolveProcessVariable(varInfo.key).then((value) => {
                                    if (!hoverTooltip) return;
                                    if (value !== null) {
                                        const truncated = value.length > 200 ? value.substring(0, 200) + "..." : value;
                                        const escaped = truncated
                                            .replace(/&/g, "&amp;")
                                            .replace(/</g, "&lt;")
                                            .replace(/>/g, "&gt;");
                                        hoverTooltip.setContent(
                                            `<div style="font-family: monospace; font-size: 12px; max-width: 350px; word-break: break-all;">` +
                                                `<div style="color: #9ca3af; font-size: 11px; margin-bottom: 2px;">${varInfo.fullName}</div>` +
                                                `<div>${escaped}</div>` +
                                            `</div>`
                                        );
                                    } else {
                                        hoverTooltip.setContent(
                                            `<div style="font-family: monospace; font-size: 12px;">` +
                                                `<div style="color: #9ca3af; font-size: 11px; margin-bottom: 2px;">${varInfo.fullName}</div>` +
                                                `<div style="color: #f87171;">Not defined in process variables</div>` +
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
        }
    });
};

// Helper function to load variables from file
export async function loadVariablesFromFile(): Promise<string[]> {
    try {
        const fileContent = await window.electron?.files?.read('.voiden/.process.env.json');
        const variables = JSON.parse(fileContent || '{}');
        return Object.keys(variables);
    } catch (error) {
        console.warn("Could not load .voiden/.process.env.json:", error);
        return [];
    }
}
