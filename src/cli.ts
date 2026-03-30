#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { constants, openSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getNvicodePaths,
  loadConfig,
  saveConfig,
  type NvicodeConfig,
} from "./config.js";
import { createProxyServer } from "./proxy.js";
import { CURATED_MODELS, getRecommendedModels } from "./models.js";

const __filename = fileURLToPath(import.meta.url);

const usage = (): void => {
  console.log(`nvicode

Commands:
  nvicode select model        Select and save a NVIDIA model
  nvicode models              Show recommended coding models
  nvicode auth                Save or update NVIDIA API key
  nvicode config              Show current nvicode config
  nvicode launch claude [...] Launch Claude Code through nvicode
  nvicode serve               Run the local proxy in the foreground
`);
};

const question = async (prompt: string): Promise<string> => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
};

const ensureConfigured = async (): Promise<NvicodeConfig> => {
  let config = await loadConfig();
  let changed = false;

  if (!config.apiKey) {
    if (!process.stdin.isTTY) {
      throw new Error("Missing NVIDIA API key. Run `nvicode auth` first.");
    }
    const apiKey = await question("NVIDIA API key: ");
    if (!apiKey) {
      throw new Error("NVIDIA API key is required.");
    }
    config = {
      ...config,
      apiKey,
    };
    changed = true;
  }

  if (!config.model) {
    const [first] = await getRecommendedModels(config.apiKey);
    config = {
      ...config,
      model: first?.id || CURATED_MODELS[0]!.id,
    };
    changed = true;
  }

  if (changed) {
    config = await saveConfig(config);
  }

  return config;
};

const runAuth = async (): Promise<void> => {
  const config = await loadConfig();
  const apiKey = await question(
    config.apiKey ? "NVIDIA API key (leave blank to keep current): " : "NVIDIA API key: ",
  );

  if (!apiKey && config.apiKey) {
    console.log("Kept existing NVIDIA API key.");
    return;
  }
  if (!apiKey) {
    throw new Error("NVIDIA API key is required.");
  }

  await saveConfig({
    ...config,
    apiKey,
  });
  console.log("Saved NVIDIA API key.");
};

const printModels = async (apiKey?: string): Promise<void> => {
  const models = apiKey ? await getRecommendedModels(apiKey) : CURATED_MODELS;
  models.forEach((model, index) => {
    console.log(`${index + 1}. ${model.label}`);
    console.log(`   ${model.id}`);
    console.log(`   ${model.description}`);
  });
};

const runSelectModel = async (): Promise<void> => {
  const config = await ensureConfigured();
  const models = await getRecommendedModels(config.apiKey);

  console.log("Recommended NVIDIA coding models:");
  await printModels(config.apiKey);
  console.log("Type a number from the list or enter a custom model id.");

  const answer = await question("Model selection: ");
  const index = Number(answer);
  const chosenModel =
    Number.isInteger(index) && index >= 1 && index <= models.length
      ? models[index - 1]?.id
      : answer.trim();

  if (!chosenModel) {
    throw new Error("Model selection is required.");
  }

  await saveConfig({
    ...config,
    model: chosenModel,
  });
  console.log(`Saved model: ${chosenModel}`);
};

const runConfig = async (): Promise<void> => {
  const config = await loadConfig();
  const paths = getNvicodePaths();
  console.log(`Config file: ${paths.configFile}`);
  console.log(`State dir:   ${paths.stateDir}`);
  console.log(`Model:       ${config.model}`);
  console.log(`Proxy port:  ${config.proxyPort}`);
  console.log(`Thinking:    ${config.thinking ? "on" : "off"}`);
  console.log(`API key:     ${config.apiKey ? "saved" : "missing"}`);
};

const waitForHealthyProxy = async (port: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
};

const ensureProxyRunning = async (config: NvicodeConfig): Promise<void> => {
  if (await waitForHealthyProxy(config.proxyPort)) {
    return;
  }

  const paths = getNvicodePaths();
  await fs.mkdir(paths.stateDir, { recursive: true });
  const logFd = openSync(paths.logFile, "a");

  const child = spawn(process.execPath, [__filename, "serve"], {
    detached: true,
    env: {
      ...process.env,
    },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  await fs.writeFile(paths.pidFile, `${child.pid}\n`);

  if (!(await waitForHealthyProxy(config.proxyPort))) {
    throw new Error(`nvicode proxy failed to start. See ${paths.logFile}`);
  }
};

const isExecutable = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveClaudeBinary = async (): Promise<string> => {
  const nativeInPath = await findExecutableInPath("claude-native");
  if (nativeInPath) {
    return nativeInPath;
  }

  const versionsDir = path.join(os.homedir(), ".local", "share", "claude", "versions");
  try {
    const entries = await fs.readdir(versionsDir);
    const latest = entries.sort((left, right) =>
      left.localeCompare(right, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    ).at(-1);
    if (latest) {
      return path.join(versionsDir, latest);
    }
  } catch {
    // continue
  }

  const claudeInPath = await findExecutableInPath("claude");
  if (claudeInPath) {
    return claudeInPath;
  }

  throw new Error("Unable to locate Claude Code binary.");
};

const findExecutableInPath = async (name: string): Promise<string | null> => {
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  for (const entry of pathEntries) {
    if (!entry) {
      continue;
    }
    const candidate = path.join(entry, name);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
};

const runLaunchClaude = async (args: string[]): Promise<void> => {
  const config = await ensureConfigured();
  await ensureProxyRunning(config);
  const claudeBinary = await resolveClaudeBinary();

  const child = spawn(claudeBinary, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.proxyPort}`,
      ANTHROPIC_AUTH_TOKEN: config.proxyToken,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: config.model,
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      ANTHROPIC_CUSTOM_MODEL_OPTION: config.model,
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "nvicode custom model",
      ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION:
        "Claude Code via local NVIDIA gateway",
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Claude exited with signal ${signal}`));
        return;
      }
      process.exitCode = code ?? 0;
      resolve();
    });
    child.on("error", reject);
  });
};

const runServe = async (): Promise<void> => {
  const config = await ensureConfigured();
  const server = createProxyServer(config);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.proxyPort, "127.0.0.1", () => resolve());
  });

  console.error(
    `nvicode proxy listening on http://127.0.0.1:${config.proxyPort} using ${config.model}`,
  );

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const [command, ...rest] = args;

  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "serve") {
    await runServe();
    return;
  }

  if (command === "models") {
    const config = await loadConfig();
    await printModels(config.apiKey || undefined);
    return;
  }

  if (command === "auth") {
    await runAuth();
    return;
  }

  if (command === "config") {
    await runConfig();
    return;
  }

  if (
    (command === "select" && rest[0] === "model") ||
    command === "select-model"
  ) {
    await runSelectModel();
    return;
  }

  if (command === "launch") {
    if (rest[0] !== "claude") {
      throw new Error("Only `nvicode launch claude` is supported right now.");
    }
    await runLaunchClaude(rest.slice(1));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
