import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ProviderId = "nvidia" | "openrouter";

export interface NvicodeConfig {
  provider: ProviderId;
  nvidiaApiKey: string;
  nvidiaModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  proxyPort: number;
  proxyToken: string;
  thinking: boolean;
  maxRequestsPerMinute: number;
}

type PartialConfig = Partial<NvicodeConfig> & {
  apiKey?: string;
  model?: string;
};

export interface NvicodePaths {
  configDir: string;
  configFile: string;
  stateDir: string;
  logFile: string;
  pidFile: string;
  usageLogFile: string;
}

const DEFAULT_PROXY_PORT = 8788;
const DEFAULT_PROVIDER: ProviderId = "nvidia";
const DEFAULT_NVIDIA_MODEL = "moonshotai/kimi-k2.5";
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.6";
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 40;
const NVIDIA_MODEL_ALIASES: Record<string, string> = {
  "deepseek/deepseek-v4-pro": "deepseek-ai/deepseek-v4-flash",
  "deepseek-ai/deepseek-v4-pro": "deepseek-ai/deepseek-v4-flash",
  "deepseek-ai/deepseek-v3.2": "deepseek-ai/deepseek-v4-flash",
};

const normalizeNvidiaModel = (model: string): string =>
  NVIDIA_MODEL_ALIASES[model] || model;

const getEnvNumber = (name: string): number | null => {
  const raw = process.env[name];
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
};

const getDefaultConfigHome = (): string => {
  if (process.env.XDG_CONFIG_HOME) {
    return process.env.XDG_CONFIG_HOME;
  }

  if (process.platform === "win32") {
    return (
      process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), ".local", "share")
    );
  }

  return path.join(os.homedir(), ".local", "share");
};

const getDefaultStateHome = (): string => {
  if (process.env.XDG_STATE_HOME) {
    return process.env.XDG_STATE_HOME;
  }

  if (process.platform === "win32") {
    return (
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      path.join(os.homedir(), ".local", "state")
    );
  }

  return path.join(os.homedir(), ".local", "state");
};

export const getNvicodePaths = (): NvicodePaths => {
  const configHome = getDefaultConfigHome();
  const stateHome = getDefaultStateHome();

  const configDir = path.join(configHome, "nvicode");
  const stateDir = path.join(stateHome, "nvicode");

  return {
    configDir,
    configFile: path.join(configDir, "config.json"),
    stateDir,
    logFile: path.join(stateDir, "proxy.log"),
    pidFile: path.join(stateDir, "proxy.pid"),
    usageLogFile: path.join(stateDir, "usage.jsonl"),
  };
};

const withDefaults = (config: PartialConfig): NvicodeConfig => {
  const envMaxRequestsPerMinute = getEnvNumber("NVICODE_MAX_RPM");
  const legacyApiKey = config.apiKey?.trim() || "";
  const legacyModel = config.model?.trim() || DEFAULT_NVIDIA_MODEL;

  return {
    provider: config.provider === "openrouter" ? "openrouter" : DEFAULT_PROVIDER,
    nvidiaApiKey: config.nvidiaApiKey?.trim() || legacyApiKey,
    nvidiaModel: normalizeNvidiaModel(config.nvidiaModel?.trim() || legacyModel),
    openrouterApiKey: config.openrouterApiKey?.trim() || "",
    openrouterModel: config.openrouterModel?.trim() || DEFAULT_OPENROUTER_MODEL,
    proxyPort:
      Number.isInteger(config.proxyPort) && (config.proxyPort as number) > 0
        ? (config.proxyPort as number)
        : DEFAULT_PROXY_PORT,
    proxyToken: config.proxyToken?.trim() || randomUUID(),
    thinking: config.thinking ?? false,
    maxRequestsPerMinute:
      envMaxRequestsPerMinute ||
      (Number.isInteger(config.maxRequestsPerMinute) &&
      (config.maxRequestsPerMinute as number) > 0
        ? (config.maxRequestsPerMinute as number)
        : DEFAULT_MAX_REQUESTS_PER_MINUTE),
  };
};

export const loadConfig = async (): Promise<NvicodeConfig> => {
  const paths = getNvicodePaths();

  try {
    const raw = await fs.readFile(paths.configFile, "utf8");
    return withDefaults(JSON.parse(raw) as PartialConfig);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return withDefaults({});
    }
    throw error;
  }
};

export const saveConfig = async (config: PartialConfig): Promise<NvicodeConfig> => {
  const paths = getNvicodePaths();
  await fs.mkdir(paths.configDir, { recursive: true });
  await fs.mkdir(paths.stateDir, { recursive: true });

  const resolved = withDefaults(config);
  await fs.writeFile(paths.configFile, `${JSON.stringify(resolved, null, 2)}\n`);
  return resolved;
};

export const updateConfig = async (
  patch: PartialConfig,
): Promise<NvicodeConfig> => {
  const current = await loadConfig();
  return await saveConfig({
    ...current,
    ...patch,
  });
};

export const getActiveApiKey = (config: NvicodeConfig): string =>
  config.provider === "openrouter" ? config.openrouterApiKey : config.nvidiaApiKey;

export const getActiveModel = (config: NvicodeConfig): string =>
  config.provider === "openrouter" ? config.openrouterModel : config.nvidiaModel;
