import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOpenRouterRoute } from "./openrouter.js";

export type ProviderId =
  | "nvidia"
  | "openrouter"
  | "tokenrouter"
  | "gmicloud"
  | "clinepass"
  | "xai";

export type ModelLimitsSource = "router" | "model-spec";

export interface ActiveModelLimits {
  provider: ProviderId;
  model: string;
  openrouterRoute?: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  safeInputTokens?: number;
  source: ModelLimitsSource;
  updatedAt: string;
}

export interface NvicodeConfig {
  provider: ProviderId;
  nvidiaApiKey: string;
  nvidiaModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  openrouterRoute?: string;
  tokenrouterApiKey: string;
  tokenrouterModel: string;
  gmicloudApiKey: string;
  gmicloudModel: string;
  clinepassModel: string;
  xaiApiKey: string;
  xaiModel: string;
  proxyPort: number;
  proxyToken: string;
  thinking: boolean;
  maxRequestsPerMinute: number;
  activeModelLimits?: ActiveModelLimits;
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
const DEFAULT_NVIDIA_MODEL = "deepseek-ai/deepseek-v4-flash-0731";
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.6";
const DEFAULT_TOKENROUTER_MODEL = "MiniMax-M3";
const DEFAULT_GMICLOUD_MODEL = "zai-org/GLM-5.1-FP8";
const DEFAULT_CLINEPASS_MODEL = "cline-pass/glm-5.2";
const DEFAULT_XAI_MODEL = "grok-4.5";
const DEFAULT_PROXY_TOKEN = "sk-ant-nvicode-local-token";
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 40;
const NVIDIA_MODEL_ALIASES: Record<string, string> = {
  "moonshotai/kimi-k2.5": "moonshotai/kimi-k2.6",
  "deepseek/deepseek-v4-pro": "deepseek-ai/deepseek-v4-flash",
  "deepseek-ai/deepseek-v4-pro": "deepseek-ai/deepseek-v4-flash",
  "deepseek-ai/deepseek-v3.2": "deepseek-ai/deepseek-v4-flash",
};
const OPENROUTER_MODEL_ALIASES: Record<string, string> = {
  "qwen/qwen3.6-plus-preview:free": "qwen/qwen3-coder:free",
};

const normalizeNvidiaModel = (model: string): string =>
  NVIDIA_MODEL_ALIASES[model] || model;

const normalizeOpenRouterModel = (model: string): string =>
  OPENROUTER_MODEL_ALIASES[model] || model;

const normalizeProxyToken = (token: string | undefined): string => {
  const trimmed = token?.trim() || "";
  if (!trimmed || trimmed === "nvicode-local-token") {
    return DEFAULT_PROXY_TOKEN;
  }
  if (trimmed.startsWith("sk-ant-")) {
    return trimmed;
  }
  return `sk-ant-nvicode-${trimmed}`;
};

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

const isProviderId = (value: unknown): value is ProviderId =>
  value === "nvidia" ||
  value === "openrouter" ||
  value === "tokenrouter" ||
  value === "gmicloud" ||
  value === "clinepass" ||
  value === "xai";

const normalizePositiveInteger = (value: unknown): number | undefined =>
  Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;

const normalizeActiveModelLimits = (
  value: unknown,
): ActiveModelLimits | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const limits = value as Partial<ActiveModelLimits>;
  const contextWindowTokens = normalizePositiveInteger(limits.contextWindowTokens);
  if (
    !isProviderId(limits.provider) ||
    typeof limits.model !== "string" ||
    !limits.model.trim() ||
    !contextWindowTokens ||
    (limits.source !== "router" && limits.source !== "model-spec")
  ) {
    return undefined;
  }

  return {
    provider: limits.provider,
    model: limits.model.trim(),
    openrouterRoute: normalizeOpenRouterRoute(limits.openrouterRoute),
    contextWindowTokens,
    maxOutputTokens: normalizePositiveInteger(limits.maxOutputTokens),
    safeInputTokens: normalizePositiveInteger(limits.safeInputTokens),
    source: limits.source,
    updatedAt:
      typeof limits.updatedAt === "string" && limits.updatedAt
        ? limits.updatedAt
        : new Date(0).toISOString(),
  };
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
  const provider: ProviderId =
    config.provider === "openrouter" ||
    config.provider === "tokenrouter" ||
    config.provider === "gmicloud" ||
    config.provider === "clinepass" ||
    config.provider === "xai"
      ? config.provider
      : DEFAULT_PROVIDER;

  return {
    provider,
    nvidiaApiKey: config.nvidiaApiKey?.trim() || legacyApiKey,
    nvidiaModel: normalizeNvidiaModel(config.nvidiaModel?.trim() || legacyModel),
    openrouterApiKey: config.openrouterApiKey?.trim() || "",
    openrouterModel: normalizeOpenRouterModel(
      config.openrouterModel?.trim() || DEFAULT_OPENROUTER_MODEL,
    ),
    openrouterRoute: normalizeOpenRouterRoute(config.openrouterRoute),
    tokenrouterApiKey: config.tokenrouterApiKey?.trim() || "",
    tokenrouterModel: config.tokenrouterModel?.trim() || DEFAULT_TOKENROUTER_MODEL,
    gmicloudApiKey: config.gmicloudApiKey?.trim() || "",
    gmicloudModel: config.gmicloudModel?.trim() || DEFAULT_GMICLOUD_MODEL,
    clinepassModel: config.clinepassModel?.trim() || DEFAULT_CLINEPASS_MODEL,
    xaiApiKey: config.xaiApiKey?.trim() || "",
    xaiModel: config.xaiModel?.trim() || DEFAULT_XAI_MODEL,
    proxyPort:
      Number.isInteger(config.proxyPort) && (config.proxyPort as number) > 0
        ? (config.proxyPort as number)
        : DEFAULT_PROXY_PORT,
    proxyToken: normalizeProxyToken(config.proxyToken || randomUUID()),
    thinking: config.thinking ?? false,
    maxRequestsPerMinute:
      envMaxRequestsPerMinute ||
      (Number.isInteger(config.maxRequestsPerMinute) &&
      (config.maxRequestsPerMinute as number) > 0
        ? (config.maxRequestsPerMinute as number)
        : DEFAULT_MAX_REQUESTS_PER_MINUTE),
    activeModelLimits: normalizeActiveModelLimits(config.activeModelLimits),
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
  config.provider === "openrouter"
    ? config.openrouterApiKey
    : config.provider === "tokenrouter"
      ? config.tokenrouterApiKey
      : config.provider === "gmicloud"
        ? config.gmicloudApiKey
        : config.provider === "clinepass"
          ? ""
          : config.provider === "xai"
            ? config.xaiApiKey
            : config.nvidiaApiKey;

export const getActiveModel = (config: NvicodeConfig): string =>
  config.provider === "openrouter"
    ? config.openrouterModel
    : config.provider === "tokenrouter"
      ? config.tokenrouterModel
      : config.provider === "gmicloud"
        ? config.gmicloudModel
        : config.provider === "clinepass"
          ? config.clinepassModel
          : config.provider === "xai"
            ? config.xaiModel
            : config.nvidiaModel;

export const getActiveModelLimits = (
  config: NvicodeConfig,
): ActiveModelLimits | undefined => {
  const limits = config.activeModelLimits;
  if (
    limits?.provider !== config.provider ||
    limits.model !== getActiveModel(config) ||
    limits.openrouterRoute !==
      (config.provider === "openrouter" ? config.openrouterRoute : undefined)
  ) {
    return undefined;
  }
  return limits;
};
