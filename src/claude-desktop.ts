import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ClaudeDesktopPlatform = "darwin" | "win32" | "linux";
export type JsonObject = Record<string, unknown>;

export const NVICODE_CLAUDE_DESKTOP_PROFILE_ID =
  "00000000-0000-4000-8000-000000000878";
export const NVICODE_CLAUDE_DESKTOP_PROFILE_NAME = "Nvicode";
// Claude Desktop validates configured gateway model IDs as Anthropic routes.
// The proxy maps this compatibility route to the user's selected model.
export const NVICODE_CLAUDE_DESKTOP_GATEWAY_MODEL_ID = "claude-sonnet-4-5";

export interface ClaudeDesktopPaths {
  platform: ClaudeDesktopPlatform;
  profileRoot: string;
  configLibrary: string;
  profileFile: string;
  metaFile: string;
  deploymentConfigFile: string;
  normalDeploymentConfigFile: string;
  appCandidates: string[];
}

export interface ClaudeDesktopGatewayConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  profileName?: string;
}

export interface ClaudeDesktopConfigureResult {
  paths: ClaudeDesktopPaths;
  updated: boolean;
  model: string;
}

export interface ClaudeDesktopRestoreResult {
  paths: ClaudeDesktopPaths;
  updated: boolean;
}

const isPlatform = (value: string): value is ClaudeDesktopPlatform =>
  value === "darwin" || value === "win32" || value === "linux";

export const isClaudeDesktopSupported = (
  platform: string = process.platform,
): platform is ClaudeDesktopPlatform => isPlatform(platform);

const getWindowsLocalAppData = (
  homeDirectory: string,
  env: NodeJS.ProcessEnv,
): string =>
  env.LOCALAPPDATA?.trim() ||
  env.APPDATA?.trim() ||
  path.join(homeDirectory, "AppData", "Local");

const getProfileRoot = (
  platform: ClaudeDesktopPlatform,
  homeDirectory: string,
  env: NodeJS.ProcessEnv,
): string => {
  if (platform === "darwin") {
    return path.join(
      homeDirectory,
      "Library",
      "Application Support",
      "Claude-3p",
    );
  }
  if (platform === "win32") {
    return path.join(getWindowsLocalAppData(homeDirectory, env), "Claude-3p");
  }
  return path.join(homeDirectory, ".config", "Claude-3p");
};

const getNormalRoot = (
  platform: ClaudeDesktopPlatform,
  homeDirectory: string,
  env: NodeJS.ProcessEnv,
): string => {
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "Claude");
  }
  if (platform === "win32") {
    return path.join(getWindowsLocalAppData(homeDirectory, env), "Claude");
  }
  return path.join(homeDirectory, ".config", "Claude");
};

const getAppCandidates = (
  platform: ClaudeDesktopPlatform,
  homeDirectory: string,
  env: NodeJS.ProcessEnv,
): string[] => {
  if (platform === "darwin") {
    return [
      "/Applications/Claude.app",
      path.join(homeDirectory, "Applications", "Claude.app"),
    ];
  }

  if (platform === "win32") {
    const localAppData = getWindowsLocalAppData(homeDirectory, env);
    return [
      path.join(localAppData, "Programs", "Claude", "Claude.exe"),
      path.join(localAppData, "Programs", "Claude Desktop", "Claude.exe"),
      path.join(localAppData, "Claude", "Claude.exe"),
      path.join(localAppData, "Claude Nest", "Claude.exe"),
      path.join(localAppData, "Claude Desktop", "Claude.exe"),
      path.join(localAppData, "AnthropicClaude", "Claude.exe"),
    ];
  }

  return [
    "/usr/bin/claude-desktop",
    "/usr/local/bin/claude-desktop",
    "/opt/Claude/claude",
    "/opt/Claude/Claude",
    path.join(homeDirectory, ".local", "bin", "claude-desktop"),
    path.join(homeDirectory, ".local", "share", "Claude", "claude"),
  ];
};

export const getClaudeDesktopPaths = (
  platform: string = process.platform,
  homeDirectory: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ClaudeDesktopPaths => {
  if (!isPlatform(platform)) {
    throw new Error(
      "Claude Desktop third-party routing is supported on macOS, Windows, and Linux.",
    );
  }

  const profileRoot = getProfileRoot(platform, homeDirectory, env);
  const normalRoot = getNormalRoot(platform, homeDirectory, env);
  const configLibrary = path.join(profileRoot, "configLibrary");

  return {
    platform,
    profileRoot,
    configLibrary,
    profileFile: path.join(
      configLibrary,
      `${NVICODE_CLAUDE_DESKTOP_PROFILE_ID}.json`,
    ),
    metaFile: path.join(configLibrary, "_meta.json"),
    deploymentConfigFile: path.join(profileRoot, "claude_desktop_config.json"),
    normalDeploymentConfigFile: path.join(
      normalRoot,
      "claude_desktop_config.json",
    ),
    appCandidates: getAppCandidates(platform, homeDirectory, env),
  };
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const readJsonObject = async (filePath: string): Promise<JsonObject> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as JsonObject
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to parse Claude Desktop JSON at ${filePath}.`);
  }
};

const backupIfNeeded = async (filePath: string): Promise<void> => {
  if (!(await pathExists(filePath))) {
    return;
  }

  await fs.copyFile(
    filePath,
    `${filePath}.nvicode.bak`,
    constants.COPYFILE_EXCL,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") {
      throw error;
    }
  });
};

const writeJsonIfChanged = async (
  filePath: string,
  current: JsonObject,
  next: JsonObject,
): Promise<boolean> => {
  if (JSON.stringify(current) === JSON.stringify(next)) {
    return false;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await backupIfNeeded(filePath);
  const temporaryFile = `${filePath}.nvicode.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(
      temporaryFile,
      `${JSON.stringify(next, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.rename(temporaryFile, filePath);
    if (process.platform !== "win32") {
      await fs.chmod(filePath, 0o600);
    }
  } finally {
    await fs.rm(temporaryFile, { force: true }).catch(() => undefined);
  }
  return true;
};

const buildGatewayProfile = (
  config: ClaudeDesktopGatewayConfig,
): JsonObject => {
  // Claude Desktop caps the deployment label at 60 characters. Keep the
  // gateway model ID visible instead of falling back to its generic Default
  // label, while retaining the full selected ID in the visible label.
  const displayName =
    config.model.length > 60 ? `${config.model.slice(0, 57)}...` : config.model;
  const gatewayModel = NVICODE_CLAUDE_DESKTOP_GATEWAY_MODEL_ID;
  return {
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: config.baseUrl,
    inferenceGatewayApiKey: config.apiKey,
    inferenceGatewayAuthScheme: "bearer",
    inferenceModels: [
      {
        name: gatewayModel,
        labelOverride: displayName,
        anthropicFamilyTier: "sonnet",
        isFamilyDefault: true,
      },
    ],
    deploymentDisplayName: displayName,
    modelDiscoveryEnabled: false,
    chatTabEnabled: true,
    isClaudeCodeForDesktopEnabled: true,
    coworkTabEnabled: true,
    disableDeploymentModeChooser: true,
  };
};

const updateDeploymentMode = async (
  filePath: string,
  mode: "1p" | "3p",
  createIfMissing = true,
): Promise<boolean> => {
  if (!createIfMissing && !(await pathExists(filePath))) {
    return false;
  }
  const current = await readJsonObject(filePath);
  return writeJsonIfChanged(filePath, current, {
    ...current,
    deploymentMode: mode,
  });
};

const updateMetadata = async (
  filePath: string,
  applied: boolean,
): Promise<boolean> => {
  const current = await readJsonObject(filePath);
  const hasEntriesArray = Array.isArray(current.entries);
  const rawEntries: unknown[] = hasEntriesArray
    ? current.entries as unknown[]
    : [];
  const entries = rawEntries.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return true;
    }
    return (entry as JsonObject).id !== NVICODE_CLAUDE_DESKTOP_PROFILE_ID;
  });

  if (applied) {
    entries.push({
      id: NVICODE_CLAUDE_DESKTOP_PROFILE_ID,
      name: NVICODE_CLAUDE_DESKTOP_PROFILE_NAME,
    });
  }

  const next: JsonObject = { ...current };
  if (applied || hasEntriesArray) {
    next.entries = entries;
  } else {
    delete next.entries;
  }
  if (applied) {
    next.appliedId = NVICODE_CLAUDE_DESKTOP_PROFILE_ID;
  } else if (next.appliedId === NVICODE_CLAUDE_DESKTOP_PROFILE_ID) {
    delete next.appliedId;
  }

  if (
    !applied &&
    !hasEntriesArray &&
    current.appliedId !== NVICODE_CLAUDE_DESKTOP_PROFILE_ID
  ) {
    return false;
  }
  return writeJsonIfChanged(filePath, current, next);
};

const removeProfile = async (filePath: string): Promise<boolean> => {
  if (!(await pathExists(filePath))) {
    return false;
  }
  await backupIfNeeded(filePath);
  await fs.rm(filePath, { force: true });
  return true;
};

export const configureClaudeDesktop = async (
  config: ClaudeDesktopGatewayConfig,
  options: {
    platform?: string;
    homeDirectory?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ClaudeDesktopConfigureResult> => {
  const model = config.model.trim();
  const baseUrl = config.baseUrl.trim();
  const apiKey = config.apiKey.trim();
  if (!model || !baseUrl || !apiKey) {
    throw new Error("Claude Desktop gateway configuration requires a model, URL, and token.");
  }

  const paths = getClaudeDesktopPaths(
    options.platform,
    options.homeDirectory,
    options.env,
  );
  const profileCurrent = await readJsonObject(paths.profileFile);
  const profileNext = {
    ...profileCurrent,
    ...buildGatewayProfile({ ...config, model, baseUrl, apiKey }),
  };
  let updated = await writeJsonIfChanged(
    paths.profileFile,
    profileCurrent,
    profileNext,
  );
  updated = (await updateMetadata(paths.metaFile, true)) || updated;
  updated = (await updateDeploymentMode(paths.deploymentConfigFile, "3p")) || updated;
  updated =
    (await updateDeploymentMode(paths.normalDeploymentConfigFile, "3p")) || updated;

  return { paths, updated, model };
};

export const restoreClaudeDesktop = async (
  options: {
    platform?: string;
    homeDirectory?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ClaudeDesktopRestoreResult> => {
  const paths = getClaudeDesktopPaths(
    options.platform,
    options.homeDirectory,
    options.env,
  );
  let updated = await removeProfile(paths.profileFile);
  updated = (await updateMetadata(paths.metaFile, false)) || updated;
  updated =
    (await updateDeploymentMode(paths.deploymentConfigFile, "1p", false)) || updated;
  updated =
    (await updateDeploymentMode(paths.normalDeploymentConfigFile, "1p", false)) || updated;
  return { paths, updated };
};

export const findClaudeDesktopApp = async (
  paths: ClaudeDesktopPaths,
): Promise<string | null> => {
  for (const candidate of paths.appCandidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
};

export const isClaudeDesktopRunning = async (
  platform: ClaudeDesktopPlatform = process.platform as ClaudeDesktopPlatform,
): Promise<boolean> => {
  try {
    if (platform === "darwin") {
      await execFileAsync("pgrep", ["-f", "Claude.app/Contents/MacOS/Claude"]);
      return true;
    }
    if (platform === "win32") {
      const result = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        "(Get-Process Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).Id",
      ]);
      return result.stdout.trim().length > 0;
    }
    await execFileAsync("pgrep", ["-f", "[c]laude-desktop|/Claude"]);
    return true;
  } catch (error) {
    const exitCode = (error as { code?: number }).code;
    if (exitCode === 1) {
      return false;
    }
    throw error;
  }
};

export const quitClaudeDesktop = async (
  platform: ClaudeDesktopPlatform = process.platform as ClaudeDesktopPlatform,
): Promise<void> => {
  if (platform === "darwin") {
    await execFileAsync("osascript", ["-e", 'tell application "Claude" to quit']);
    return;
  }
  if (platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-Process Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }",
    ]);
    return;
  }
  await execFileAsync("pkill", ["-TERM", "-f", "[c]laude-desktop|/Claude"]);
};

export const waitForClaudeDesktopExit = async (
  platform: ClaudeDesktopPlatform = process.platform as ClaudeDesktopPlatform,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isClaudeDesktopRunning(platform))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    "Claude Desktop did not quit. Quit it manually and run `nvicode launch claude-desktop` again.",
  );
};

const quotePowerShellString = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

export const openClaudeDesktop = async (
  appPath: string,
  platform: ClaudeDesktopPlatform = process.platform as ClaudeDesktopPlatform,
): Promise<void> => {
  if (platform === "darwin") {
    await execFileAsync("/usr/bin/open", [appPath]);
    return;
  }
  if (platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Start-Process -FilePath ${quotePowerShellString(appPath)}`,
    ]);
    return;
  }

  const child = spawn(appPath, [], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
};

export const restartClaudeDesktop = async (
  appPath: string,
  reapply: () => Promise<void>,
  platform: ClaudeDesktopPlatform = process.platform as ClaudeDesktopPlatform,
): Promise<void> => {
  await quitClaudeDesktop(platform);
  await waitForClaudeDesktopExit(platform);
  // Desktop persists profile state while shutting down, so write it once more
  // after the process exits before reopening the app.
  await reapply();
  await openClaudeDesktop(appPath, platform);
};
