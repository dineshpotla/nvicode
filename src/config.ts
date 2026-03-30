import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface NvicodeConfig {
  apiKey: string;
  model: string;
  proxyPort: number;
  proxyToken: string;
  thinking: boolean;
}

type PartialConfig = Partial<NvicodeConfig>;

export interface NvicodePaths {
  configDir: string;
  configFile: string;
  stateDir: string;
  logFile: string;
  pidFile: string;
}

const DEFAULT_PROXY_PORT = 8788;
const DEFAULT_MODEL = "moonshotai/kimi-k2.5";

export const getNvicodePaths = (): NvicodePaths => {
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".local", "share");
  const stateHome =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");

  const configDir = path.join(configHome, "nvicode");
  const stateDir = path.join(stateHome, "nvicode");

  return {
    configDir,
    configFile: path.join(configDir, "config.json"),
    stateDir,
    logFile: path.join(stateDir, "proxy.log"),
    pidFile: path.join(stateDir, "proxy.pid"),
  };
};

const withDefaults = (config: PartialConfig): NvicodeConfig => ({
  apiKey: config.apiKey?.trim() || "",
  model: config.model?.trim() || DEFAULT_MODEL,
  proxyPort:
    Number.isInteger(config.proxyPort) && (config.proxyPort as number) > 0
      ? (config.proxyPort as number)
      : DEFAULT_PROXY_PORT,
  proxyToken: config.proxyToken?.trim() || randomUUID(),
  thinking: config.thinking ?? false,
});

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
