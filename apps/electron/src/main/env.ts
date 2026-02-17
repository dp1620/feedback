import path from "path";
import { getActiveProject, getAppState } from "./state";
import fs from "node:fs/promises";
import { ipcMain, IpcMainInvokeEvent } from "electron";
import { saveState } from "./persistState";
import { getSettings } from "./settings";

/**
 * Check if an env file is a private override file (ends with .private).
 * Private env files contain sensitive/user-specific values and are:
 * - Excluded from the env selection UI
 * - Automatically loaded as overrides when their parent env is active
 * - Expected to be .gitignored
 */
function isPrivateEnvFile(filePath: string): boolean {
  return path.basename(filePath).endsWith(".private");
}

/**
 * Build a merged environment by applying the full hierarchy chain.
 *
 * When hierarchy is enabled and activeEnvPath is e.g. /project/.env.staging:
 *   1. .env           (base)
 *   2. .env.private   (base private overrides)
 *   3. .env.staging   (environment-specific)
 *   4. .env.staging.private (environment-specific private overrides)
 *
 * When hierarchy is disabled:
 *   1. <activeEnvFile>
 *   2. <activeEnvFile>.private
 *
 * Private files always accompany their non-private counterpart regardless
 * of the hierarchy setting, since they contain user-specific overrides.
 */
function buildMergedEnv(
  activeEnvPath: string,
  projectPath: string,
  envData: Record<string, Record<string, string>>,
  useHierarchy: boolean
): Record<string, string> {
  const layers: Record<string, string>[] = [];

  const baseEnvPath = path.join(projectPath, ".env");
  const basePrivatePath = baseEnvPath + ".private";

  if (useHierarchy) {
    // Layer 1: base .env
    if (envData[baseEnvPath]) layers.push(envData[baseEnvPath]);
    // Layer 2: base .env.private
    if (envData[basePrivatePath]) layers.push(envData[basePrivatePath]);
  }

  // Layer 3: active env (skip if it's the base itself to avoid duplication)
  if (activeEnvPath !== baseEnvPath) {
    if (envData[activeEnvPath]) layers.push(envData[activeEnvPath]);
  } else if (!useHierarchy) {
    // Hierarchy disabled and active IS the base — still load it
    if (envData[activeEnvPath]) layers.push(envData[activeEnvPath]);
  }

  // Layer 4: active env's private counterpart
  const activePrivatePath = activeEnvPath + ".private";
  if (envData[activePrivatePath]) layers.push(envData[activePrivatePath]);

  return Object.assign({}, ...layers);
}

/**
 * Parse the content of a .env file into an object.
 */
function parseEnvContent(content: string) {
  const env: Record<string, string> = {};
  content.split(/\r?\n/).forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith("#")) return;

    const eqIndex = line.indexOf("=");
    if (eqIndex < 0) return; // Skip malformed lines

    const key = line.substring(0, eqIndex).trim();
    let value = line.substring(eqIndex + 1).trim();

    // Remove optional surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.substring(1, value.length - 1);
    }

    env[key] = value;
  });
  return env;
}

/**
 * Recursively search for files starting with ".env" in the given directory.
 * Returns an array of absolute file paths.
 */
async function findEnvFilesRecursively(dir: string) {
  let envFiles: string[] = [];

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // console.error(`Unable to read directory ${dir}:`, err);
    return envFiles;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Recursively search in subdirectory
      const subDirEnvFiles = await findEnvFilesRecursively(fullPath);
      envFiles = envFiles.concat(subDirEnvFiles);
    } else if (entry.isFile() && (entry.name.startsWith(".env") || entry.name.endsWith(".env"))) {
      envFiles.push(fullPath);
    }
  }

  return envFiles;
}

/**
 * Load all .env files (including nested ones) in the given project path and combine their content.
 * If there are duplicate keys, later files in the array will override earlier ones.
 */
async function loadProjectEnv(projectPath: string) {
  const envData: Record<string, Record<string, string>> = {};

  // Recursively find .env files starting from the projectPath.
  const envFiles = await findEnvFilesRecursively(projectPath);

  // Optionally sort the file paths to ensure a consistent order.
  envFiles.sort((a, b) => a.localeCompare(b));

  for (const filePath of envFiles) {
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (err) {
      // console.error(`Unable to read ${filePath}:`, err);
      continue;
    }
    const parsedEnv = parseEnvContent(content);

    // Use the full file path as the key
    envData[filePath] = parsedEnv;
  }

  return envData;
}

ipcMain.handle("env:load", async (event:IpcMainInvokeEvent) => {
  const appState = getAppState(event);
  const activeProject = await getActiveProject(event);
  if (!appState.directories[activeProject]) return {};
  let activeEnv = appState.directories[activeProject].activeEnv;
  if (!activeProject) return {};
  const envs = await loadProjectEnv(activeProject);
  if (!envs[activeEnv]) {
    activeEnv = null;
  }

  // Build merged env using the full hierarchy chain (including .private files)
  const settings = getSettings();
  if (activeEnv) {
    envs[activeEnv] = buildMergedEnv(activeEnv, activeProject, envs, settings.environment.use_hierarchy);
  }

  // Filter out .private files from the data sent to the UI —
  // they should not appear in the environment selector
  const visibleEnvs: Record<string, Record<string, string>> = {};
  for (const [filePath, data] of Object.entries(envs)) {
    if (!isPrivateEnvFile(filePath)) {
      visibleEnvs[filePath] = data;
    }
  }

  return {
    activeEnv,
    data: visibleEnvs,
  };
});

ipcMain.handle("env:setActive", async (event:IpcMainInvokeEvent, envPath) => {
  const appState = getAppState(event);
  const activeProject = await getActiveProject(event);
  appState.directories[activeProject].activeEnv = envPath;
  await saveState(appState);
});

/**
 * Replace {{VARIABLE}} patterns with values from active environment.
 * This runs in Electron main process - UI never sees the actual values.
 *
 * @security Environment values never leave the main process
 */
export async function replaceVariablesSecure(text: string, projectPath: string): Promise<string> {

  const appState = getAppState();
  const activeEnvPath = appState.directories[projectPath]?.activeEnv;

  if (!activeEnvPath) {
    return text;
  }

  // Load environment data
  const envData = await loadProjectEnv(projectPath);

  if (!envData[activeEnvPath]) {
    return text;
  }

  // Build merged env using the full hierarchy chain (including .private files)
  const settings = getSettings();
  const env = buildMergedEnv(activeEnvPath, projectPath, envData, settings.environment.use_hierarchy);

  // Replace {{VAR_NAME}} patterns
  const result = text.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
    const trimmedVarName = varName.trim();

    // Skip faker variables - they should already be replaced by Stage 5 faker hook
    // This is a defensive check in case the order changes
    if (trimmedVarName.startsWith('$faker.')) {
      return match;
    }

    const value = env[trimmedVarName];

    if (value !== undefined) {
      return value;
    }

    return match; // Keep original if not found
  });

  return result;
}

/**
 * Secure IPC handler for variable replacement.
 * UI sends raw text with {{variables}}, receives replaced text.
 * UI never sees the actual environment values.
 */
ipcMain.handle("env:replaceVariables", async (_, text: string) => {
  const activeProject = await getActiveProject();
  if (!activeProject) {
    // console.error("[env:replaceVariables] No active project");
    return text;
  }
  return replaceVariablesSecure(text, activeProject);
});

/**
 * Resolve a single environment variable's value for hover preview.
 * @param variableName - The variable name to resolve
 * @returns The variable's value, or null if not found
 */
ipcMain.handle("env:resolveVariable", async (event: IpcMainInvokeEvent, variableName: string) => {
  const appState = getAppState(event);
  const activeProject = await getActiveProject();

  if (!activeProject || !variableName) {
    return null;
  }

  const activeEnvPath = appState.directories[activeProject]?.activeEnv;

  if (!activeEnvPath) {
    return null;
  }

  const envData = await loadProjectEnv(activeProject);

  if (!envData[activeEnvPath]) {
    return null;
  }

  // Build merged env using the full hierarchy chain (including .private files)
  const settings = getSettings();
  const env = buildMergedEnv(activeEnvPath, activeProject, envData, settings.environment.use_hierarchy);

  const value = env[variableName.trim()];
  return value !== undefined ? value : null;
});

/**
 * Get keys (names) of environment variables for autocomplete.
 * Returns only metadata, not values.
 *
 * @security Only returns variable names, not values
 */
ipcMain.handle("env:getKeys", async (event:IpcMainInvokeEvent) => {
  const appState = getAppState(event);
  const activeProject = await getActiveProject();

  if (!activeProject) {
    return [];
  }

  const activeEnvPath = appState.directories[activeProject]?.activeEnv;

  if (!activeEnvPath) {
    return [];
  }

  // Load environment data
  const envData = await loadProjectEnv(activeProject);

  if (!envData[activeEnvPath]) {
    return [];
  }

  // Build merged env using the full hierarchy chain (including .private files)
  const settings = getSettings();
  const env = buildMergedEnv(activeEnvPath, activeProject, envData, settings.environment.use_hierarchy);

  return Object.keys(env);
});

// Simple handler to extend all .env files
ipcMain.handle('env:extend-env-files', async (event, { comment, variables }) => {
  try {
    // Use your existing function to find all .env files
    const activeProject = await getActiveProject(eve);
    const envFiles = await findEnvFilesRecursively(activeProject);

    const results = [];
    // Process each .env file (skip .private files — they are user-specific overrides)
    for (const filePath of envFiles.filter(f => !isPrivateEnvFile(f))) {
      try {
        await extendEnvFile(filePath, comment, variables);
        results.push({
          file: path.relative(process.cwd(), filePath),
          success: true
        });
      } catch (error) {
        console.log(error)
      }
    }
  } catch (error) {
    console.log(error)
  }
});

// Function to extend a single .env file
async function extendEnvFile(filePath: string, comment: string, variables: Array<{key: string, value: string}>) {
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    console.log('File does not exist');
    return;
  }
  if (content && !content.endsWith('\n')) {
    content += '\n';
  }

  content += `\n# ${comment}\n`;
  for (const variable of variables) {
    content += `${variable.key}=${variable.value}\n`;
  }
  await fs.writeFile(filePath, content, 'utf8');
}