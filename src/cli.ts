#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { constants, openSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getActiveApiKey,
  getActiveModel,
  getActiveModelLimits,
  getNvicodePaths,
  loadConfig,
  saveConfig,
  type ProviderId,
  type NvicodeConfig,
} from "./config.js";
import { createProxyServer, getContextBudgetForConfig } from "./proxy.js";
import {
  fetchAvailableModelIds,
  fetchOpenRouterProviderSlugs,
  getRecommendedModels,
  getRecommendedNvidiaModels,
  resolveModelLimits,
} from "./models.js";
import {
  getOpenRouterProviderRoute,
  normalizeOpenRouterRoute,
  OPENROUTER_PROVIDER_ROUTES,
} from "./openrouter.js";
import {
  configureClaudeDesktop,
  findClaudeDesktopApp,
  getClaudeDesktopPaths,
  isClaudeDesktopRunning,
  isClaudeDesktopSupported,
  openClaudeDesktop,
  restartClaudeDesktop,
  restoreClaudeDesktop,
  type ClaudeDesktopPaths,
} from "./claude-desktop.js";
import {
  filterRecordsSince,
  formatDuration,
  formatInteger,
  formatTimestamp,
  formatUsd,
  readUsageRecords,
  summarizeUsage,
} from "./usage.js";

const __filename = fileURLToPath(import.meta.url);
const NVICODE_WRAPPER_MARKER = "managed by nvicode";
const CODEX_APP_CONFIG_START = "# >>> nvicode codex app provider >>>";
const CODEX_APP_CONFIG_END = "# <<< nvicode codex app provider <<<";
const MODEL_LIMITS_CACHE_MS = 24 * 60 * 60 * 1000;

const usage = (): void => {
  console.log(`nvicode

Commands:
  nvicode select model          Guided provider, key, and model selection
  nvicode models                Show recommended models for the active provider
  nvicode auth                  Save or update the API key for the active provider
  nvicode config                Show current nvicode config
  nvicode usage                 Show token usage and cost comparison
  nvicode activity              Show recent request activity
  nvicode dashboard             Show usage summary and recent activity
  nvicode launch claude [...]   Launch Claude Code through nvicode
  nvicode launch claude-desktop   Launch Claude Desktop through nvicode
  nvicode launch openclaw [...] Launch OpenClaw through nvicode
  nvicode launch codex [...]    Launch Codex through nvicode
  nvicode configure claude-desktop Configure Claude Desktop without opening it
  nvicode restore claude-desktop Restore Claude Desktop's standard profile
  nvicode configure codex-app   Configure the Codex desktop app
  nvicode launch codex-app      Configure and open the Codex desktop app
  nvicode serve                 Run the local proxy in the foreground
`);
};

const isWindows = process.platform === "win32";

const getPathExts = (): string[] => {
  if (!isWindows) {
    return [""];
  }

  const raw = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => ext.toLowerCase());
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const getProviderLabel = (provider: ProviderId): string =>
  provider === "openrouter"
    ? "OpenRouter"
    : provider === "tokenrouter"
      ? "TokenRouter"
      : provider === "gmicloud"
        ? "GMICLOUD"
        : provider === "clinepass"
          ? "ClinePass"
          : provider === "xai"
            ? "xAI"
            : "NVIDIA";

const getProviderApiKey = (
  config: NvicodeConfig,
  provider: ProviderId,
): string =>
  provider === "openrouter"
    ? config.openrouterApiKey
    : provider === "tokenrouter"
      ? config.tokenrouterApiKey
      : provider === "gmicloud"
        ? config.gmicloudApiKey
        : provider === "clinepass"
          ? ""
          : provider === "xai"
            ? config.xaiApiKey
            : config.nvidiaApiKey;

const withProviderApiKey = (
  config: NvicodeConfig,
  provider: ProviderId,
  apiKey: string,
): Pick<NvicodeConfig, "nvidiaApiKey" | "openrouterApiKey" | "tokenrouterApiKey" | "gmicloudApiKey" | "xaiApiKey"> => ({
  nvidiaApiKey: provider === "nvidia" ? apiKey : config.nvidiaApiKey,
  openrouterApiKey: provider === "openrouter" ? apiKey : config.openrouterApiKey,
  tokenrouterApiKey: provider === "tokenrouter" ? apiKey : config.tokenrouterApiKey,
  gmicloudApiKey: provider === "gmicloud" ? apiKey : config.gmicloudApiKey,
  xaiApiKey: provider === "xai" ? apiKey : config.xaiApiKey,
});

const withProviderModel = (
  provider: ProviderId,
  model: string,
): Partial<Pick<NvicodeConfig, "nvidiaModel" | "openrouterModel" | "tokenrouterModel" | "gmicloudModel" | "clinepassModel" | "xaiModel">> => {
  if (provider === "openrouter") {
    return { openrouterModel: model };
  }
  if (provider === "tokenrouter") {
    return { tokenrouterModel: model };
  }
  if (provider === "gmicloud") {
    return { gmicloudModel: model };
  }
  if (provider === "clinepass") {
    return { clinepassModel: model };
  }
  if (provider === "xai") {
    return { xaiModel: model };
  }
  return { nvidiaModel: model };
};

const getClaudeCommandNames = (): string[] =>
  isWindows ? ["claude.exe", "claude.cmd", "claude.bat", "claude"] : ["claude"];

const getOpenClawCommandNames = (): string[] =>
  isWindows
    ? ["openclaw.exe", "openclaw.cmd", "openclaw.bat", "openclaw"]
    : ["openclaw"];

const getCodexCommandNames = (): string[] =>
  isWindows
    ? ["codex.exe", "codex.cmd", "codex.bat", "codex"]
    : ["codex"];

const getClaudeNativeNames = (): string[] =>
  isWindows
    ? ["claude-native.exe", "claude-native.cmd", "claude-native.bat", "claude-native"]
    : ["claude-native"];

const getCodexNativeNames = (): string[] =>
  isWindows
    ? ["codex-native.exe", "codex-native.cmd", "codex-native.bat", "codex-native"]
    : ["codex-native"];

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const readIfExists = async (targetPath: string): Promise<string | null> => {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return null;
  }
};

const readTextPrefixIfExists = async (
  targetPath: string,
  byteLength = 4096,
): Promise<string | null> => {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(targetPath, "r");
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const isManagedClaudeWrapper = async (targetPath: string): Promise<boolean> => {
  const contents = await readTextPrefixIfExists(targetPath);
  return contents?.includes(NVICODE_WRAPPER_MARKER) ?? false;
};

const renderClaudeWrapper = (): string => {
  if (isWindows) {
    return [
      "@echo off",
      `REM ${NVICODE_WRAPPER_MARKER}`,
      `"${process.execPath}" "${__filename}" launch claude %*`,
      "",
    ].join("\r\n");
  }

  return [
    "#!/bin/sh",
    `# ${NVICODE_WRAPPER_MARKER}`,
    `exec "${process.execPath}" "${__filename}" launch claude "$@"`,
    "",
  ].join("\n");
};

const renderCodexWrapper = (): string => {
  if (isWindows) {
    return [
      "@echo off",
      `REM ${NVICODE_WRAPPER_MARKER}`,
      `"${process.execPath}" "${__filename}" launch codex %*`,
      "",
    ].join("\r\n");
  }

  return [
    "#!/bin/sh",
    `# ${NVICODE_WRAPPER_MARKER}`,
    `exec "${process.execPath}" "${__filename}" launch codex "$@"`,
    "",
  ].join("\n");
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

const promptProviderSelection = async (
  initialProvider: ProviderId,
): Promise<ProviderId> => {
  console.log("Choose a provider:");
  console.log("1. NVIDIA");
  console.log("   Uses the local nvicode proxy and usage dashboard.");
  console.log("2. OpenRouter");
  console.log("   Uses Claude Code direct Anthropic-compatible connection.");
  console.log("3. TokenRouter");
  console.log("   Uses MiniMax M3 through TokenRouter.");
  console.log("4. GMICLOUD");
  console.log("   Uses GMICLOUD's OpenAI-compatible chat endpoint through nvicode.");
  console.log("5. ClinePass");
  console.log("   Uses your local Cline account and ClinePass models through nvicode.");
  console.log("6. xAI");
  console.log("   Uses Grok models through the xAI OpenAI-compatible API.");

  const defaultChoice =
    initialProvider === "openrouter"
      ? "2"
      : initialProvider === "tokenrouter"
        ? "3"
        : initialProvider === "gmicloud"
          ? "4"
          : initialProvider === "clinepass"
            ? "5"
            : initialProvider === "xai"
              ? "6"
              : "1";
  const answer = (
    await question(`Provider selection [${defaultChoice}]: `)
  ).toLowerCase();
  const normalized = answer || defaultChoice;

  if (normalized === "1" || normalized === "nvidia") {
    return "nvidia";
  }
  if (
    normalized === "2" ||
    normalized === "openrouter" ||
    normalized === "open-router"
  ) {
    return "openrouter";
  }
  if (
    normalized === "3" ||
    normalized === "tokenrouter" ||
    normalized === "token-router"
  ) {
    return "tokenrouter";
  }
  if (
    normalized === "4" ||
    normalized === "gmicloud" ||
    normalized === "gmi" ||
    normalized === "gmi-cloud"
  ) {
    return "gmicloud";
  }
  if (
    normalized === "5" ||
    normalized === "clinepass" ||
    normalized === "cline-pass" ||
    normalized === "cline"
  ) {
    return "clinepass";
  }
  if (
    normalized === "6" ||
    normalized === "xai" ||
    normalized === "x-ai" ||
    normalized === "grok"
  ) {
    return "xai";
  }

  throw new Error("Provider selection is required.");
};

const getOpenRouterRouteOptions = async (
  apiKey: string,
): Promise<typeof OPENROUTER_PROVIDER_ROUTES[number][]> => {
  if (!apiKey) {
    return [...OPENROUTER_PROVIDER_ROUTES];
  }

  try {
    const available = await fetchOpenRouterProviderSlugs(apiKey);
    const liveRoutes = OPENROUTER_PROVIDER_ROUTES.filter((route) =>
      available.has(route.slug),
    );
    return liveRoutes.length > 0 ? liveRoutes : [...OPENROUTER_PROVIDER_ROUTES];
  } catch {
    console.log("OpenRouter provider catalog is temporarily unavailable; showing the saved route list.");
    return [...OPENROUTER_PROVIDER_ROUTES];
  }
};

const promptOpenRouterRoute = async (
  currentRoute: string | undefined,
  apiKey: string,
): Promise<string | undefined> => {
  const routes = await getOpenRouterRouteOptions(apiKey);
  const currentIndex = routes.findIndex((route) => route.slug === currentRoute);
  const defaultChoice = currentIndex >= 0 ? String(currentIndex + 1) : "0";

  console.log("");
  console.log("OpenRouter upstream provider (optional):");
  console.log("0. Auto");
  console.log("   Let OpenRouter choose the available provider.");
  routes.forEach((route, index) => {
    console.log(`${index + 1}. ${route.label} (${route.slug})`);
    console.log(`   ${route.description}`);
  });
  console.log("You can also paste an exact OpenRouter provider slug.");

  const answer = (await question(`Provider route [${defaultChoice}]: `)).toLowerCase();
  const normalized = answer || defaultChoice;
  if (normalized === "0" || normalized === "auto" || normalized === "default") {
    return undefined;
  }

  const index = Number(normalized);
  if (Number.isInteger(index) && index >= 1 && index <= routes.length) {
    return routes[index - 1]?.slug;
  }

  const route = normalizeOpenRouterRoute(answer);
  if (!route) {
    throw new Error("OpenRouter provider route must be a provider slug such as `deepinfra`.");
  }
  return route;
};

const promptApiKeyUpdate = async (
  config: NvicodeConfig,
  provider: ProviderId,
): Promise<Pick<NvicodeConfig, "nvidiaApiKey" | "openrouterApiKey" | "tokenrouterApiKey" | "gmicloudApiKey" | "xaiApiKey">> => {
  if (provider === "clinepass") {
    console.log("ClinePass uses your existing local Cline login; no API key is stored in nvicode.");
    return {
      nvidiaApiKey: config.nvidiaApiKey,
      openrouterApiKey: config.openrouterApiKey,
      tokenrouterApiKey: config.tokenrouterApiKey,
      gmicloudApiKey: config.gmicloudApiKey,
      xaiApiKey: config.xaiApiKey,
    };
  }
  if (provider === "xai") {
    console.log("xAI uses your existing local Grok CLI login; no API key is stored in nvicode.");
    return {
      nvidiaApiKey: config.nvidiaApiKey,
      openrouterApiKey: config.openrouterApiKey,
      tokenrouterApiKey: config.tokenrouterApiKey,
      gmicloudApiKey: config.gmicloudApiKey,
      xaiApiKey: config.xaiApiKey,
    };
  }

  const providerLabel = getProviderLabel(provider);
  const currentApiKey = getProviderApiKey(config, provider);

  if (currentApiKey) {
    const answer = (
      await question(
        `${providerLabel} API key already saved. Update it? [y/N]: `,
      )
    ).toLowerCase();

    if (answer !== "y" && answer !== "yes") {
      return withProviderApiKey(config, provider, currentApiKey);
    }

    const nextKey = await question(
      `${providerLabel} API key (press Enter or type "skip" to keep current): `,
    );
    if (!nextKey || nextKey.toLowerCase() === "skip") {
      return withProviderApiKey(config, provider, currentApiKey);
    }

    return withProviderApiKey(config, provider, nextKey);
  }

  const nextKey = await question(
    `${providerLabel} API key (press Enter or type "skip" to skip): `,
  );
  if (!nextKey || nextKey.toLowerCase() === "skip") {
    return {
      nvidiaApiKey: config.nvidiaApiKey,
      openrouterApiKey: config.openrouterApiKey,
      tokenrouterApiKey: config.tokenrouterApiKey,
      gmicloudApiKey: config.gmicloudApiKey,
      xaiApiKey: config.xaiApiKey,
    };
  }

  return withProviderApiKey(config, provider, nextKey);
};

const promptRequiredApiKey = async (
  providerLabel: string,
): Promise<string> => {
  const apiKey = await question(`${providerLabel} API key: `);
  if (!apiKey) {
    throw new Error(`${providerLabel} API key is required.`);
  }
  return apiKey;
};

const hasFreshActiveModelLimits = (config: NvicodeConfig): boolean => {
  const limits = getActiveModelLimits(config);
  if (!limits) {
    return false;
  }
  const updatedAt = Date.parse(limits.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < MODEL_LIMITS_CACHE_MS;
};

const ensureActiveModelLimits = async (
  config: NvicodeConfig,
  force = false,
): Promise<NvicodeConfig> => {
  if (!force && hasFreshActiveModelLimits(config)) {
    return config;
  }

  const resolved = await resolveModelLimits(
    config.provider,
    getActiveApiKey(config),
    getActiveModel(config),
    config.openrouterRoute,
  );
  if (!resolved) {
    return config;
  }

  return await saveConfig({
    ...config,
    activeModelLimits: resolved,
  });
};

const ensureConfigured = async (): Promise<NvicodeConfig> => {
  let config = await loadConfig();
  let changed = false;
  const providerLabel = getProviderLabel(config.provider);
  const activeApiKey = getActiveApiKey(config);
  const activeModel = getActiveModel(config);

  if (
    !activeApiKey &&
    config.provider !== "clinepass" &&
    config.provider !== "xai"
  ) {
    if (!process.stdin.isTTY) {
      throw new Error(`Missing ${providerLabel} API key. Run \`nvicode auth\` first.`);
    }
    console.error(`Missing ${providerLabel} API key. Enter it now to continue.`);
    const apiKey = await promptRequiredApiKey(providerLabel);
    config = {
      ...config,
      ...withProviderApiKey(config, config.provider, apiKey),
    };
    changed = true;
    console.error(`Saved ${providerLabel} API key. Continuing launch.`);
  }

  if (!activeModel) {
    const [first] = await getRecommendedModels(
      config.provider,
      getActiveApiKey(config),
      config.openrouterRoute,
    );
    const fallbackModel =
      config.provider === "openrouter"
        ? "anthropic/claude-sonnet-4.6"
        : config.provider === "tokenrouter"
          ? "MiniMax-M3"
          : config.provider === "gmicloud"
            ? "zai-org/GLM-5.1-FP8"
            : config.provider === "clinepass"
              ? "cline-pass/glm-5.2"
              : config.provider === "xai"
                ? "grok-4.5"
                : "deepseek-ai/deepseek-v4-flash-0731";
    config = {
      ...config,
      ...withProviderModel(config.provider, first?.id || fallbackModel),
    };
    changed = true;
  }

  if (config.provider === "nvidia" && config.nvidiaApiKey && config.nvidiaModel) {
    try {
      const available = await fetchAvailableModelIds(config.nvidiaApiKey);
      if (!available.has(config.nvidiaModel)) {
        const [first] = getRecommendedNvidiaModels(available);
        if (first && first.id !== config.nvidiaModel) {
          console.error(
            `Saved NVIDIA model ${config.nvidiaModel} is no longer available. Switching to ${first.id}.`,
          );
          config = {
            ...config,
            nvidiaModel: first.id,
          };
          changed = true;
        }
      }
    } catch {
      // Keep the saved model when the NVIDIA catalog is temporarily unavailable.
    }
  }

  if (changed) {
    config = await saveConfig(config);
  }

  return await ensureActiveModelLimits(config);
};

const runAuth = async (): Promise<void> => {
  const config = await loadConfig();
  if (config.provider === "clinepass") {
    console.log("ClinePass uses your existing local Cline login.");
    console.log("To refresh it, run: cline auth cline-pass -m cline-pass/glm-5.2");
    return;
  }
  if (config.provider === "xai") {
    console.log("xAI uses your existing local Grok CLI login.");
    console.log("To refresh it, run: grok login or reinstall with GROK_DEPLOYMENT_KEY.");
    return;
  }

  const providerLabel = getProviderLabel(config.provider);
  const currentApiKey = getActiveApiKey(config);
  const apiKey = currentApiKey
    ? await question(`${providerLabel} API key (leave blank to keep current): `)
    : await promptRequiredApiKey(providerLabel);

  if (!apiKey && currentApiKey) {
    console.log(`Kept existing ${providerLabel} API key.`);
    return;
  }

  await saveConfig({
    ...config,
    ...withProviderApiKey(config, config.provider, apiKey),
  });
  console.log(`Saved ${providerLabel} API key.`);
};

const printModels = async (
  provider: ProviderId,
  apiKey?: string,
  openrouterRoute?: string,
): Promise<void> => {
  const models = await getRecommendedModels(provider, apiKey || "", openrouterRoute);
  printModelOptions(models);
};

const printModelOptions = (models: Awaited<ReturnType<typeof getRecommendedModels>>): void => {
  models.forEach((model, index) => {
    console.log(`${index + 1}. ${model.label}`);
    console.log(`   ${model.id}`);
    console.log(`   ${model.description}`);
    const metadata = [
      model.free === true ? "Free" : model.free === false ? "Paid" : "",
      model.contextWindowTokens
        ? `${formatInteger(model.contextWindowTokens)} context`
        : "",
    ].filter(Boolean);
    if (metadata.length > 0) {
      console.log(`   ${metadata.join(" · ")}`);
    }
  });
};

const runSelectModel = async (): Promise<void> => {
  const config = await loadConfig();
  const provider = await promptProviderSelection(config.provider);
  const providerLabel = getProviderLabel(provider);
  const keyPatch = await promptApiKeyUpdate(config, provider);
  const openrouterRoute =
    provider === "openrouter"
      ? await promptOpenRouterRoute(config.openrouterRoute, keyPatch.openrouterApiKey)
      : config.openrouterRoute;
  const nextConfig = await saveConfig({
    ...config,
    ...keyPatch,
    provider,
    openrouterRoute,
  });
  const models = await getRecommendedModels(
    provider,
    getActiveApiKey(nextConfig),
    openrouterRoute,
  );

  console.log(
    provider === "openrouter"
      ? getOpenRouterProviderRoute(openrouterRoute)
        ? `Live compatible ${getOpenRouterProviderRoute(openrouterRoute)?.label} models through OpenRouter:`
        : "Live compatible OpenRouter models:"
      : provider === "tokenrouter"
        ? "Live compatible TokenRouter models:"
        : provider === "gmicloud"
          ? "Live compatible GMICLOUD models:"
          : provider === "clinepass"
            ? "Top ClinePass models:"
            : provider === "xai"
              ? "Live compatible xAI models:"
              : "Live compatible NVIDIA models:",
  );
  printModelOptions(models);
  console.log("These entries come from the selected provider's live model catalog when available.");
  console.log("Or paste a full custom model id; nvicode will use it exactly.");
  console.log(
    provider === "openrouter"
      ? "Example: qwen/qwen3-coder:free"
      : provider === "tokenrouter"
        ? "Example: MiniMax-M3"
        : provider === "gmicloud"
          ? "Example: moonshotai/kimi-k3"
          : provider === "clinepass"
            ? "Example: cline-pass/glm-5.2"
            : provider === "xai"
              ? "Example: grok-4.5"
              : "Example: moonshotai/kimi-k2.6",
  );

  const answer = await question("Model selection: ");
  const index = Number(answer);
  const chosenModel =
    Number.isInteger(index) && index >= 1 && index <= models.length
      ? models[index - 1]?.id
      : answer.trim();

  if (!chosenModel) {
    throw new Error("Model selection is required.");
  }

  const saved = await saveConfig({
    ...nextConfig,
    ...withProviderModel(provider, chosenModel),
    activeModelLimits: undefined,
  });
  const refreshed = await ensureActiveModelLimits(saved, true);
  console.log(`Saved model: ${chosenModel}`);
  const limits = getActiveModelLimits(refreshed);
  if (limits) {
    console.log(
      `Context window: ${formatInteger(limits.contextWindowTokens)} tokens (${limits.source})`,
    );
  } else {
    console.log("Context window: not published by this router/model");
  }
};

const runConfig = async (): Promise<void> => {
  const config = await ensureActiveModelLimits(await loadConfig());
  const paths = getNvicodePaths();
  console.log(`Config file: ${paths.configFile}`);
  console.log(`State dir:   ${paths.stateDir}`);
  console.log(`Usage log:   ${paths.usageLogFile}`);
  console.log(`Provider:    ${getProviderLabel(config.provider)}`);
  if (config.provider === "openrouter") {
    const route = getOpenRouterProviderRoute(config.openrouterRoute);
    console.log(
      `Route:       ${route?.label || config.openrouterRoute || "Auto (OpenRouter)"}`,
    );
  }
  console.log(`Model:       ${getActiveModel(config)}`);
  const limits = getActiveModelLimits(config);
  const contextBudget = getContextBudgetForConfig(config);
  console.log(
    `Context:     ${limits ? `${formatInteger(limits.contextWindowTokens)} tokens (${limits.source})` : "unknown"}`,
  );
  console.log(
    `Input cap:   ${contextBudget.inputLimitTokens ? `${formatInteger(contextBudget.inputLimitTokens)} estimated tokens` : "provider enforced"}`,
  );
  console.log(
    `Max output:  ${limits?.maxOutputTokens ? `${formatInteger(limits.maxOutputTokens)} tokens` : "provider default"}`,
  );
  console.log(`Proxy port:  ${config.proxyPort}`);
  console.log(
    config.provider === "nvidia"
      ? `Max RPM:     ${config.maxRequestsPerMinute}`
      : "Max RPM:     provider native (nvicode pacing off)",
  );
  console.log(`Thinking:    ${config.thinking ? "on" : "off"}`);
  console.log(`NVIDIA key:  ${config.nvidiaApiKey ? "saved" : "missing"}`);
  console.log(`OpenRouter key: ${config.openrouterApiKey ? "saved" : "missing"}`);
  console.log(`TokenRouter key: ${config.tokenrouterApiKey ? "saved" : "missing"}`);
  console.log(`GMICLOUD key: ${config.gmicloudApiKey ? "saved" : "missing"}`);
  console.log(`ClinePass auth: local Cline login`);
  console.log(`xAI auth: local Grok CLI login`);
};

const printUsageBlock = (
  label: string,
  records: Awaited<ReturnType<typeof readUsageRecords>>,
  providerLabel = "Provider",
): void => {
  const summary = summarizeUsage(records);
  console.log(label);
  console.log(
    `Requests: ${formatInteger(summary.requests)} (${formatInteger(summary.successes)} ok, ${formatInteger(summary.errors)} error)`,
  );
  console.log(`Turn input tokens: ${formatInteger(summary.turnInputTokens)}`);
  console.log(`Billed input tokens: ${formatInteger(summary.inputTokens)}`);
  console.log(`Turn output tokens: ${formatInteger(summary.turnOutputTokens)}`);
  console.log(`Billed output tokens: ${formatInteger(summary.outputTokens)}`);
  console.log(`${providerLabel} cost: ${formatUsd(summary.providerCostUsd)}`);
  console.log(`Estimated savings: ${formatUsd(summary.savingsUsd)}`);
};

const getUsageView = async (providerLabel = "Provider"): Promise<string> => {
  const records = await readUsageRecords();
  if (records.length === 0) {
    return [
      "nvicode usage",
      "",
      "No usage recorded yet.",
      "Keep this open and new activity will appear automatically.",
    ].join("\n");
  }

  const now = Date.now();
  const latestPricing = records[0]?.pricing;
  const lines: string[] = ["nvicode usage", ""];
  if (latestPricing) {
    lines.push("Pricing basis:");
    lines.push(
      `- ${providerLabel} configured cost: ${formatUsd(latestPricing.providerInputUsdPerMTok)} / MTok input, ${formatUsd(latestPricing.providerOutputUsdPerMTok)} / MTok output`,
    );
    lines.push(
      `- ${latestPricing.compareModel}: ${formatUsd(latestPricing.compareInputUsdPerMTok)} / MTok input, ${formatUsd(latestPricing.compareOutputUsdPerMTok)} / MTok output`,
    );
    lines.push(
      `- Comparison source: ${latestPricing.comparePricingSource} (${latestPricing.comparePricingUpdatedAt})`,
    );
    lines.push("- In/Out columns show current-turn tokens.");
    lines.push("- Billed In/Billed Out include the full Claude Code request context.");
    lines.push("");
  }

  const windows = [
    { label: "Last 1 hour", durationMs: 1 * 60 * 60 * 1000 },
    { label: "Last 6 hours", durationMs: 6 * 60 * 60 * 1000 },
    { label: "Last 12 hours", durationMs: 12 * 60 * 60 * 1000 },
    { label: "Last 1 day", durationMs: 24 * 60 * 60 * 1000 },
    { label: "Last 1 week", durationMs: 7 * 24 * 60 * 60 * 1000 },
    { label: "Last 1 month", durationMs: 30 * 24 * 60 * 60 * 1000 },
  ];

  const rows = windows.map((window) => {
    const summary = summarizeUsage(filterRecordsSince(records, now - window.durationMs));
    return {
      window: window.label,
      requests: `${formatInteger(summary.requests)} (${formatInteger(summary.successes)} ok/${formatInteger(summary.errors)} err)`,
      inputTokens: formatInteger(summary.turnInputTokens),
      billedInputTokens: formatInteger(summary.inputTokens),
      outputTokens: formatInteger(summary.turnOutputTokens),
      billedOutputTokens: formatInteger(summary.outputTokens),
      providerCost: formatUsd(summary.providerCostUsd),
      savings: formatUsd(summary.savingsUsd),
    };
  });

  lines.push(
    `Snapshot: ${formatTimestamp(new Date(now).toISOString())}`,
  );
  lines.push("");
  lines.push(
    "Window        Requests         In Tok   Billed In  Out Tok  Billed Out  Provider    Saved",
  );
  rows.forEach((row) => {
    lines.push(
      `${row.window.padEnd(13)} ${row.requests.padEnd(16)} ${row.inputTokens.padStart(8)} ${row.billedInputTokens.padStart(11)} ${row.outputTokens.padStart(8)} ${row.billedOutputTokens.padStart(11)} ${row.providerCost.padStart(10)} ${row.savings.padStart(10)}`,
    );
  });

  return lines.join("\n");
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const getNodeVersionParts = (): { major: number; minor: number; patch: number } => {
  const parts = process.versions.node.split(".").map((part) => Number(part));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return {
    major: Number.isFinite(major) ? major : 0,
    minor: Number.isFinite(minor) ? minor : 0,
    patch: Number.isFinite(patch) ? patch : 0,
  };
};

const isNodeAtLeast = (major: number, minor = 0, patch = 0): boolean => {
  const current = getNodeVersionParts();
  if (current.major !== major) {
    return current.major > major;
  }
  if (current.minor !== minor) {
    return current.minor > minor;
  }
  return current.patch >= patch;
};

const clearTerminal = (): void => {
  process.stdout.write("\x1b[2J\x1b[H");
};

const runUsage = async (): Promise<void> => {
  const config = await loadConfig();
  const providerLabel = getProviderLabel(config.provider);

  const interactive = process.stdout.isTTY && process.stdin.isTTY;
  if (!interactive) {
    console.log(await getUsageView(providerLabel));
    return;
  }

  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    while (!stopped) {
      clearTerminal();
      process.stdout.write(await getUsageView(providerLabel));
      process.stdout.write("\n\nRefreshing every 2s. Press Ctrl+C to exit.\n");
      await sleep(2_000);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
};

const runActivity = async (): Promise<void> => {
  const config = await loadConfig();
  const providerLabel = getProviderLabel(config.provider);

  const records = await readUsageRecords();
  if (records.length === 0) {
    console.log("No activity recorded yet.");
    return;
  }

  console.log(
    "Timestamp             Status  Model                         In Tok  Bill In  Out Tok Bill Out  Latency  Provider   Saved",
  );
  for (const record of records.slice(0, 15)) {
    const model = record.model.length > 28 ? `${record.model.slice(0, 25)}...` : record.model;
    const status = record.status === "success" ? "ok" : "error";
    console.log(
      `${formatTimestamp(record.timestamp).padEnd(21)} ${status.padEnd(6)} ${model.padEnd(29)} ${formatInteger(record.turnInputTokens ?? record.visibleInputTokens ?? record.inputTokens).padStart(7)} ${formatInteger(record.inputTokens).padStart(8)} ${formatInteger(record.turnOutputTokens ?? record.visibleOutputTokens ?? record.outputTokens).padStart(8)} ${formatInteger(record.outputTokens).padStart(8)} ${formatDuration(record.latencyMs).padStart(8)} ${formatUsd(record.providerCostUsd).padStart(10)} ${formatUsd(record.savingsUsd).padStart(10)}`,
    );
    if (record.error) {
      console.log(`  error: ${record.error}`);
    }
  }
};

const runDashboard = async (): Promise<void> => {
  const config = await loadConfig();
  const providerLabel = getProviderLabel(config.provider);

  const records = await readUsageRecords();
  if (records.length === 0) {
    console.log("No usage recorded yet.");
    return;
  }

  const last7Days = filterRecordsSince(records, Date.now() - 7 * 24 * 60 * 60 * 1000);
  printUsageBlock("Usage (7d)", last7Days, providerLabel);
  console.log("");
  console.log("Recent activity");
  console.log("");
  await runActivity();
};

const PROXY_PROTOCOL_VERSION = 10;

interface ProxyHealthResponse {
  ok?: boolean;
  proxyProtocolVersion?: number;
  provider?: ProviderId;
  openrouterRoute?: string | null;
  model?: string;
  port?: number;
  thinking?: boolean;
  upstreamTimeoutSeconds?: number;
  rateLimited?: boolean;
  maxRequestsPerMinute?: number | null;
  contextWindowTokens?: number | null;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  contextLimitSource?: string | null;
}

const isExpectedProxyHealth = (
  config: NvicodeConfig,
  health: ProxyHealthResponse,
): boolean => {
  const budget = getContextBudgetForConfig(config);
  return (
    health.ok === true &&
    health.proxyProtocolVersion === PROXY_PROTOCOL_VERSION &&
    health.provider === config.provider &&
    health.openrouterRoute ===
      (config.provider === "openrouter" ? config.openrouterRoute || null : null) &&
    health.model === getActiveModel(config) &&
    health.port === config.proxyPort &&
    health.thinking === config.thinking &&
    health.rateLimited === (config.provider === "nvidia") &&
    health.maxRequestsPerMinute ===
      (config.provider === "nvidia" ? config.maxRequestsPerMinute : null) &&
    health.contextWindowTokens === budget.contextWindowTokens &&
    health.maxInputTokens === budget.inputLimitTokens &&
    health.maxOutputTokens === budget.maxOutputTokens &&
    health.contextLimitSource === budget.source
  );
};

const waitForHealthyProxy = async (config: NvicodeConfig): Promise<boolean> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.proxyPort}/health`);
      if (response.ok && isExpectedProxyHealth(config, await response.json() as ProxyHealthResponse)) {
        return true;
      }
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
};

const stopExistingProxy = async (): Promise<void> => {
  const paths = getNvicodePaths();
  const rawPid = await readIfExists(paths.pidFile);
  const pid = Number(rawPid?.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      break;
    }
  }
};

const ensureProxyRunning = async (config: NvicodeConfig): Promise<void> => {
  if (await waitForHealthyProxy(config)) {
    return;
  }

  const paths = getNvicodePaths();
  await stopExistingProxy();
  await fs.mkdir(paths.stateDir, { recursive: true });
  const logFd = openSync(paths.logFile, "a");

  const child = spawn(process.execPath, [__filename, "serve"], {
    detached: true,
    env: {
      ...process.env,
    },
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();

  await fs.writeFile(paths.pidFile, `${child.pid}\n`);

  if (!(await waitForHealthyProxy(config))) {
    throw new Error(`nvicode proxy failed to start. See ${paths.logFile}`);
  }
};

const isExecutable = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath, isWindows ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const buildExecutableCandidates = (entry: string, name: string): string[] => {
  const base = path.join(entry, name);
  if (!isWindows) {
    return [base];
  }

  if (path.extname(name)) {
    return [base];
  }

  return unique([base, ...getPathExts().map((ext) => `${base}${ext}`)]);
};

const resolveClaudeVersionEntry = async (entryPath: string): Promise<string | null> => {
  if (await isExecutable(entryPath)) {
    return entryPath;
  }

  const nestedCandidates = isWindows
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
    : ["claude"];

  for (const candidateName of nestedCandidates) {
    const candidate = path.join(entryPath, candidateName);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
};

const findExistingClaudeNativeInDirectory = async (
  directory: string,
): Promise<string | null> => {
  for (const name of getClaudeNativeNames()) {
    const candidate = path.join(directory, name);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
};

const resolvePersistentClaudeCommand = async (): Promise<string | null> => {
  for (const name of getClaudeCommandNames()) {
    const found = await findExecutableInPath(name);
    if (found) {
      return found;
    }
  }

  return null;
};

const normalizePathForComparison = async (targetPath: string): Promise<string> => {
  const resolved = path.resolve(targetPath);
  try {
    const real = await fs.realpath(resolved);
    return isWindows ? real.toLowerCase() : real;
  } catch {
    return isWindows ? resolved.toLowerCase() : resolved;
  }
};

const getPathDirectoryIndex = async (directory: string): Promise<number> => {
  const target = await normalizePathForComparison(directory);
  const pathEntries = (process.env.PATH || "").split(path.delimiter);

  for (let index = 0; index < pathEntries.length; index += 1) {
    const entry = pathEntries[index];
    if (!entry) {
      continue;
    }
    if ((await normalizePathForComparison(entry)) === target) {
      return index;
    }
  }

  return -1;
};

const resolveClaudeShadowWrapperPath = async (
  claudeCommandPath: string,
): Promise<string | null> => {
  const nvicodeCommandPath = await findExecutableInPath("nvicode");
  if (!nvicodeCommandPath) {
    return null;
  }

  const nvicodeDirectory = path.dirname(nvicodeCommandPath);
  const claudeDirectory = path.dirname(claudeCommandPath);
  if (
    (await normalizePathForComparison(nvicodeDirectory)) ===
    (await normalizePathForComparison(claudeDirectory))
  ) {
    return null;
  }

  const nvicodeIndex = await getPathDirectoryIndex(nvicodeDirectory);
  const claudeIndex = await getPathDirectoryIndex(claudeDirectory);
  if (nvicodeIndex < 0 || claudeIndex < 0 || nvicodeIndex > claudeIndex) {
    return null;
  }

  for (const candidate of buildExecutableCandidates(nvicodeDirectory, "claude")) {
    if ((await pathExists(candidate)) && !(await isManagedClaudeWrapper(candidate))) {
      return null;
    }
  }

  return path.join(nvicodeDirectory, isWindows ? "claude.cmd" : "claude");
};

type ClaudeRoutingStatus = "installed" | "updated" | "already" | "skipped";

const mergeRoutingStatus = (
  left: ClaudeRoutingStatus,
  right: ClaudeRoutingStatus,
): ClaudeRoutingStatus => {
  if (left === "installed" || right === "installed") {
    return "installed";
  }
  if (left === "updated" || right === "updated") {
    return "updated";
  }
  if (left === "already" || right === "already") {
    return "already";
  }
  return "skipped";
};

const resolveLatestClaudeManagedVersion = async (): Promise<string | null> => {
  const versionsDir = path.join(os.homedir(), ".local", "share", "claude", "versions");
  try {
    const entries = await fs.readdir(versionsDir);
    const sortedEntries = entries.sort((left, right) =>
      left.localeCompare(right, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );

    for (let index = sortedEntries.length - 1; index >= 0; index -= 1) {
      const entry = sortedEntries[index];
      if (!entry) {
        continue;
      }
      const resolved = await resolveClaudeVersionEntry(path.join(versionsDir, entry));
      if (resolved) {
        return resolved;
      }
    }
  } catch {
    // continue with other install layouts
  }

  return null;
};

const getWrapperInstallPaths = async (
  claudeCommandPath: string,
): Promise<{ wrapperPath: string; nativePath: string }> => {
  const directory = path.dirname(claudeCommandPath);
  const existingNative = await findExistingClaudeNativeInDirectory(directory);
  if (existingNative) {
    return {
      wrapperPath: claudeCommandPath,
      nativePath: existingNative,
    };
  }

  if (isWindows && path.extname(claudeCommandPath).toLowerCase() === ".exe") {
    return {
      wrapperPath: path.join(directory, "claude.cmd"),
      nativePath: path.join(directory, "claude-native.exe"),
    };
  }

  const extension = path.extname(claudeCommandPath);
  return {
    wrapperPath: claudeCommandPath,
    nativePath: path.join(directory, `claude-native${extension}`),
  };
};

const writeExecutableTextFile = async (
  targetPath: string,
  contents: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, contents, "utf8");
  if (!isWindows) {
    await fs.chmod(targetPath, 0o755);
  }
};

const getCodexConfigFile = (): string =>
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");

const renderTomlString = (value: string): string => JSON.stringify(value);

const renderTomlStringArray = (values: string[]): string =>
  `[${values.map(renderTomlString).join(", ")}]`;

const stripManagedCodexAppProvider = (contents: string): string => {
  let remaining = contents;

  while (remaining.includes(CODEX_APP_CONFIG_START)) {
    const start = remaining.indexOf(CODEX_APP_CONFIG_START);
    const end = remaining.indexOf(CODEX_APP_CONFIG_END, start);
    if (end < 0) {
      throw new Error(
        `Unable to update Codex app config: missing ${CODEX_APP_CONFIG_END}`,
      );
    }

    remaining = [
      remaining.slice(0, start).trimEnd(),
      remaining.slice(end + CODEX_APP_CONFIG_END.length).trimStart(),
    ]
      .filter(Boolean)
      .join("\n");
  }

  return remaining;
};

const upsertRootTomlSetting = (
  contents: string,
  key: string,
  value: string,
): string => {
  const lines = contents.split("\n");
  const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTableIndex < 0 ? lines.length : firstTableIndex;
  const settingPattern = new RegExp(`^\\s*${key}\\s*=`);

  for (let index = 0; index < rootEnd; index += 1) {
    if (settingPattern.test(lines[index] || "")) {
      lines[index] = `${key} = ${value}`;
      return lines.join("\n");
    }
  }

  const modelIndex = lines.findIndex(
    (line, index) => index < rootEnd && /^\s*model\s*=/.test(line),
  );
  lines.splice(modelIndex >= 0 ? modelIndex + 1 : 0, 0, `${key} = ${value}`);
  return lines.join("\n");
};

const renderManagedCodexAppProvider = (config: NvicodeConfig): string => {
  const proxyBaseUrl = `http://127.0.0.1:${config.proxyPort}/v1`;

  return [
    CODEX_APP_CONFIG_START,
    "[model_providers.nvicode]",
    'name = "nvicode proxy"',
    `base_url = ${renderTomlString(proxyBaseUrl)}`,
    'wire_api = "responses"',
    "supports_websockets = false",
    "",
    "[model_providers.nvicode.auth]",
    `command = ${renderTomlString(process.execPath)}`,
    `args = ${renderTomlStringArray([__filename, "codex-app-token"])}`,
    "timeout_ms = 15000",
    CODEX_APP_CONFIG_END,
  ].join("\n");
};

const ensureCodexAppConfigured = async (
  config: NvicodeConfig,
): Promise<{ configFile: string; updated: boolean }> => {
  const configFile = getCodexConfigFile();
  const existing = (await readIfExists(configFile)) || "";
  let next = stripManagedCodexAppProvider(existing);

  if (/^\s*\[model_providers\.nvicode(?:\.auth)?\]\s*$/m.test(next)) {
    throw new Error(
      `Unable to configure Codex app: ${configFile} already contains an unmanaged [model_providers.nvicode] block.`,
    );
  }

  next = upsertRootTomlSetting(next, "model", renderTomlString(getActiveModel(config)));
  next = upsertRootTomlSetting(next, "model_provider", '"nvicode"');
  next = `${next.trimEnd()}\n\n${renderManagedCodexAppProvider(config)}\n`;

  if (next === existing) {
    return { configFile, updated: false };
  }

  await fs.mkdir(path.dirname(configFile), { recursive: true });
  if (await pathExists(configFile)) {
    await fs.copyFile(
      configFile,
      `${configFile}.nvicode.bak`,
      constants.COPYFILE_EXCL,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    });
  }
  await fs.writeFile(configFile, next, "utf8");
  return { configFile, updated: true };
};

const ensureClaudeShadowRouting = async (
  claudeCommandPath: string,
  wrapperContents: string,
): Promise<ClaudeRoutingStatus> => {
  const shadowWrapperPath = await resolveClaudeShadowWrapperPath(claudeCommandPath);
  if (!shadowWrapperPath) {
    return "skipped";
  }

  if (await isManagedClaudeWrapper(shadowWrapperPath)) {
    const currentWrapper = await readIfExists(shadowWrapperPath);
    if (currentWrapper === wrapperContents) {
      return "already";
    }
    await writeExecutableTextFile(shadowWrapperPath, wrapperContents);
    return "updated";
  }

  if (await pathExists(shadowWrapperPath)) {
    return "skipped";
  }

  await writeExecutableTextFile(shadowWrapperPath, wrapperContents);
  return "installed";
};

const ensurePersistentClaudeRouting = async (): Promise<ClaudeRoutingStatus> => {
  const claudeCommandPath = await resolvePersistentClaudeCommand();
  if (!claudeCommandPath) {
    return "skipped";
  }

  const wrapperContents = renderClaudeWrapper();
  const { wrapperPath, nativePath } = await getWrapperInstallPaths(claudeCommandPath);
  let routingStatus: ClaudeRoutingStatus = "skipped";

  if (await isManagedClaudeWrapper(wrapperPath)) {
    const currentWrapper = await readIfExists(wrapperPath);
    if (currentWrapper === wrapperContents) {
      routingStatus = "already";
    } else {
      await writeExecutableTextFile(wrapperPath, wrapperContents);
      routingStatus = "updated";
    }
  } else {
    if (!(await pathExists(nativePath))) {
      await fs.rename(claudeCommandPath, nativePath);
    } else if (claudeCommandPath !== wrapperPath && await pathExists(wrapperPath)) {
      await fs.rm(wrapperPath, { force: true });
    } else if (claudeCommandPath === wrapperPath) {
      await fs.rm(wrapperPath, { force: true });
    }

    await writeExecutableTextFile(wrapperPath, wrapperContents);
    routingStatus = "installed";
  }

  return mergeRoutingStatus(
    routingStatus,
    await ensureClaudeShadowRouting(claudeCommandPath, wrapperContents),
  );
};

const findExistingCodexNativeInDirectory = async (
  directory: string,
): Promise<string | null> => {
  for (const name of getCodexNativeNames()) {
    const candidate = path.join(directory, name);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
};

const resolvePersistentCodexCommand = async (): Promise<string | null> => {
  for (const name of getCodexCommandNames()) {
    const found = await findExecutableInPath(name);
    if (found) {
      return found;
    }
  }
  return null;
};

const getCodexWrapperInstallPaths = async (
  codexCommandPath: string,
): Promise<{ wrapperPath: string; nativePath: string }> => {
  const directory = path.dirname(codexCommandPath);
  const existingNative = await findExistingCodexNativeInDirectory(directory);
  if (existingNative) {
    return { wrapperPath: codexCommandPath, nativePath: existingNative };
  }

  if (isWindows && path.extname(codexCommandPath).toLowerCase() === ".exe") {
    return {
      wrapperPath: path.join(directory, "codex.cmd"),
      nativePath: path.join(directory, "codex-native.exe"),
    };
  }

  const extension = path.extname(codexCommandPath);
  return {
    wrapperPath: codexCommandPath,
    nativePath: path.join(directory, `codex-native${extension}`),
  };
};

const ensurePersistentCodexRouting = async (): Promise<"installed" | "updated" | "already" | "skipped"> => {
  const codexCommandPath = await resolvePersistentCodexCommand();
  if (!codexCommandPath) {
    return "skipped";
  }

  if (await isManagedClaudeWrapper(codexCommandPath)) {
    const currentWrapper = await readIfExists(codexCommandPath);
    const wrapperContents = renderCodexWrapper();
    if (currentWrapper === wrapperContents) {
      return "already";
    }
    await writeExecutableTextFile(codexCommandPath, wrapperContents);
    return "updated";
  }

  const { wrapperPath, nativePath } = await getCodexWrapperInstallPaths(codexCommandPath);
  const wrapperContents = renderCodexWrapper();

  if (!(await pathExists(nativePath))) {
    await fs.rename(codexCommandPath, nativePath);
  } else if (codexCommandPath !== wrapperPath && await pathExists(wrapperPath)) {
    await fs.rm(wrapperPath, { force: true });
  } else if (codexCommandPath === wrapperPath) {
    await fs.rm(wrapperPath, { force: true });
  }

  await writeExecutableTextFile(wrapperPath, wrapperContents);
  return "installed";
};

const resolveClaudeBinary = async (): Promise<string> => {
  const latestManagedVersion = await resolveLatestClaudeManagedVersion();
  if (latestManagedVersion) {
    return latestManagedVersion;
  }

  for (const name of getClaudeNativeNames()) {
    const nativeInPath = await findExecutableInPath(name);
    if (nativeInPath) {
      return nativeInPath;
    }
  }

  const homeBinCandidates = isWindows
    ? [
        path.join(os.homedir(), ".local", "bin", "claude.exe"),
        path.join(os.homedir(), ".local", "bin", "claude.cmd"),
        path.join(os.homedir(), ".local", "bin", "claude.bat"),
        path.join(os.homedir(), ".local", "bin", "claude"),
      ]
    : [
        path.join(os.homedir(), ".local", "bin", "claude-native"),
        path.join(os.homedir(), ".local", "bin", "claude"),
      ];
  for (const candidate of homeBinCandidates) {
    if ((await isExecutable(candidate)) && !(await isManagedClaudeWrapper(candidate))) {
      return candidate;
    }
  }

  for (const name of getClaudeCommandNames()) {
    const claudeInPath = await findExecutableInPath(name);
    if (claudeInPath && !(await isManagedClaudeWrapper(claudeInPath))) {
      return claudeInPath;
    }
  }

  throw new Error("Unable to locate Claude Code binary.");
};

const resolveOpenClawBinary = async (): Promise<string> => {
  const homeBinCandidates = isWindows
    ? [
        path.join(os.homedir(), ".local", "bin", "openclaw.exe"),
        path.join(os.homedir(), ".local", "bin", "openclaw.cmd"),
        path.join(os.homedir(), ".local", "bin", "openclaw.bat"),
        path.join(os.homedir(), ".local", "bin", "openclaw"),
      ]
    : [path.join(os.homedir(), ".local", "bin", "openclaw")];

  for (const candidate of homeBinCandidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  for (const name of getOpenClawCommandNames()) {
    const openclawInPath = await findExecutableInPath(name);
    if (openclawInPath) {
      return openclawInPath;
    }
  }

  throw new Error(
    "Unable to locate OpenClaw binary. Install OpenClaw first with `npm install -g openclaw@latest`.",
  );
};

const resolveCodexBinary = async (): Promise<string> => {
  for (const name of getCodexNativeNames()) {
    const nativeInPath = await findExecutableInPath(name);
    if (nativeInPath) {
      return nativeInPath;
    }
  }

  const homeBinCandidates = isWindows
    ? [
        path.join(os.homedir(), ".local", "bin", "codex-native.exe"),
        path.join(os.homedir(), ".local", "bin", "codex-native"),
        path.join(os.homedir(), ".local", "bin", "codex.exe"),
        path.join(os.homedir(), ".local", "bin", "codex.cmd"),
        path.join(os.homedir(), ".local", "bin", "codex.bat"),
        path.join(os.homedir(), ".local", "bin", "codex"),
      ]
    : [
        path.join(os.homedir(), ".local", "bin", "codex-native"),
        path.join(os.homedir(), ".local", "bin", "codex"),
      ];

  for (const candidate of homeBinCandidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  for (const name of getCodexCommandNames()) {
    const codexInPath = await findExecutableInPath(name);
    if (codexInPath && !(await isManagedClaudeWrapper(codexInPath))) {
      return codexInPath;
    }
  }

  throw new Error(
    "Unable to locate Codex binary. Install Codex first with `npm install -g @openai/codex`.",
  );
};

const findExecutableInPath = async (name: string): Promise<string | null> => {
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  for (const entry of pathEntries) {
    if (!entry) {
      continue;
    }
    for (const candidate of buildExecutableCandidates(entry, name)) {
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
};

const buildOpenClawEnv = (
  baseEnv: NodeJS.ProcessEnv,
  activeApiKey?: string,
): NodeJS.ProcessEnv => ({
  ...baseEnv,
  ...(activeApiKey ? { CUSTOM_API_KEY: activeApiKey } : {}),
});

const getOpenClawPaths = () => {
  const paths = getNvicodePaths();

  return {
    markerFile: path.join(paths.stateDir, "openclaw-profile.json"),
  };
};

const getOpenClawProviderId = (config: NvicodeConfig): string =>
  config.provider === "openrouter"
    ? "nvicode-openrouter"
    : config.provider === "tokenrouter"
      ? "nvicode-tokenrouter"
      : config.provider === "gmicloud"
        ? "nvicode-gmicloud"
        : config.provider === "clinepass"
          ? "nvicode-clinepass"
          : config.provider === "xai"
            ? "nvicode-xai"
            : "nvicode-nvidia";

const getOpenAiCompatibleBaseUrl = (config: NvicodeConfig): string =>
  config.provider === "openrouter" && config.openrouterRoute
    ? `http://127.0.0.1:${config.proxyPort}/v1`
    : config.provider === "openrouter"
      ? "https://openrouter.ai/api/v1"
    : config.provider === "tokenrouter"
      ? "https://api.tokenrouter.com/v1"
      : config.provider === "gmicloud"
        ? "https://api.gmi-serving.com/v1"
        : config.provider === "clinepass"
          ? `http://127.0.0.1:${config.proxyPort}/v1`
          : config.provider === "xai"
            ? "https://api.x.ai/v1"
            : "https://integrate.api.nvidia.com/v1";

const getOpenClawModelPath = (config: NvicodeConfig): string =>
  `${getOpenClawProviderId(config)}/${getActiveModel(config)}`;

const getOpenClawProfileSignature = (
  config: NvicodeConfig,
  activeApiKey: string,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        provider: config.provider,
        openrouterRoute: config.openrouterRoute,
        model: getActiveModel(config),
        apiKey: activeApiKey,
      }),
    )
    .digest("hex");

const runOpenClawCommand = async (
  openclawBinary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> => {
  const child = spawnClaudeProcess(openclawBinary, args, env);

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`OpenClaw exited with signal ${signal}`));
        return;
      }
      if ((code ?? 0) !== 0) {
        reject(new Error(`OpenClaw command failed with exit code ${code ?? 0}`));
        return;
      }
      resolve();
    });
    child.on("error", reject);
  });
};

const ensureOpenClawConfigured = async (
  openclawBinary: string,
  config: NvicodeConfig,
  activeApiKey: string,
): Promise<{ env: NodeJS.ProcessEnv; updated: boolean }> => {
  if (!isNodeAtLeast(22, 14, 0)) {
    throw new Error(
      `OpenClaw requires Node.js >=22.14.0. Current version is ${process.versions.node}.`,
    );
  }

  const openclawPaths = getOpenClawPaths();
  const baseEnv = buildOpenClawEnv(process.env, activeApiKey);
  await fs.mkdir(path.dirname(openclawPaths.markerFile), { recursive: true });

  const profileSignature = getOpenClawProfileSignature(config, activeApiKey);
  const existingMarkerRaw = await readIfExists(openclawPaths.markerFile);
  if (existingMarkerRaw) {
    try {
      const parsed = JSON.parse(existingMarkerRaw) as { signature?: string };
      if (parsed.signature === profileSignature) {
        return { env: baseEnv, updated: false };
      }
    } catch {
      // continue with reprovisioning
    }
  }

  const providerId = getOpenClawProviderId(config);
  const onboardArgs = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--flow",
    "advanced",
    "--auth-choice",
    "custom-api-key",
    "--custom-provider-id",
    providerId,
    "--custom-compatibility",
    "openai",
    "--custom-base-url",
    getOpenAiCompatibleBaseUrl(config),
    "--custom-model-id",
    getActiveModel(config),
    "--no-install-daemon",
    "--skip-channels",
    "--skip-skills",
    "--skip-health",
    "--skip-ui",
  ];

  await runOpenClawCommand(
    openclawBinary,
    onboardArgs,
    baseEnv,
  );
  await runOpenClawCommand(
    openclawBinary,
    ["config", "set", "agents.defaults.model.primary", JSON.stringify(getOpenClawModelPath(config))],
    baseEnv,
  );

  await fs.writeFile(
    openclawPaths.markerFile,
    `${JSON.stringify(
      {
        signature: profileSignature,
        provider: config.provider,
        openrouterRoute: config.openrouterRoute,
        model: getActiveModel(config),
        configuredAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  return { env: baseEnv, updated: true };
};

const spawnClaudeProcess = (
  claudeBinary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => {
  if (isWindows && /\.(cmd|bat)$/i.test(claudeBinary)) {
    return spawn(claudeBinary, args, {
      stdio: "inherit",
      env,
      shell: true,
      windowsHide: true,
    });
  }

  return spawn(claudeBinary, args, {
    stdio: "inherit",
    env,
    windowsHide: true,
  });
};

const normalizeLaunchArgs = (args: string[]): string[] =>
  args[0] === "--" ? args.slice(1) : args;

const shouldAddClaudeBareMode = (args: string[]): boolean => {
  // Keep Claude Code's normal interactive UI. Bare mode strips the visual
  // terminal chrome that users expect from plain `claude`.
  return false;

  if (args.includes("--bare")) {
    return false;
  }
  if (
    args.includes("-p") ||
    args.includes("--print") ||
    args.includes("-h") ||
    args.includes("--help") ||
    args.includes("-v") ||
    args.includes("--version")
  ) {
    return false;
  }

  const passthroughCommands = new Set([
    "agents",
    "auth",
    "auto-mode",
    "doctor",
    "install",
    "mcp",
    "plugin",
    "plugins",
    "project",
    "setup-token",
    "ultrareview",
    "update",
    "upgrade",
  ]);

  return !passthroughCommands.has(args[0] || "");
};

const ensureClaudeCustomApiKeyApproved = async (
  apiKey: string,
): Promise<void> => {
  if (!apiKey) {
    return;
  }

  const claudeConfigFile = path.join(os.homedir(), ".claude.json");
  const raw = await readIfExists(claudeConfigFile);
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
  }

  const responses =
    typeof parsed.customApiKeyResponses === "object" &&
    parsed.customApiKeyResponses !== null
      ? (parsed.customApiKeyResponses as Record<string, unknown>)
      : {};
  const approved = Array.isArray(responses.approved)
    ? responses.approved.filter((entry): entry is string => typeof entry === "string")
    : [];
  const rejected = Array.isArray(responses.rejected)
    ? responses.rejected.filter((entry): entry is string => typeof entry === "string")
    : [];

  const approvalIds = unique([
    apiKey,
    apiKey.replace(/^sk-ant-/, ""),
    apiKey.replace(/^sk-ant/, ""),
  ].filter(Boolean));
  const nextApproved = unique([...approved, ...approvalIds]);
  const nextRejected = rejected.filter((entry) => !approvalIds.includes(entry));
  const changed =
    nextApproved.length !== approved.length ||
    nextRejected.length !== rejected.length;

  if (!changed) {
    return;
  }

  parsed.customApiKeyResponses = {
    ...responses,
    approved: nextApproved,
    rejected: nextRejected,
  };

  await fs.writeFile(claudeConfigFile, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
};

const readJsonObject = async (
  filePath: string,
): Promise<Record<string, unknown>> => {
  const raw = await readIfExists(filePath);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const getClaudeContextEnv = (config: NvicodeConfig): Record<string, string> => {
  const budget = getContextBudgetForConfig(config);
  const env: Record<string, string> = {};
  if (budget.inputLimitTokens) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(budget.inputLimitTokens);
  }
  if (budget.maxOutputTokens) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(budget.maxOutputTokens);
  }
  return env;
};

const ensureClaudeSettingsEnvConfigured = async (
  config: NvicodeConfig,
): Promise<void> => {
  const settingsFile = path.join(os.homedir(), ".claude", "settings.json");
  const parsed = await readJsonObject(settingsFile);
  const existingEnv =
    typeof parsed.env === "object" && parsed.env !== null
      ? parsed.env as Record<string, unknown>
      : {};
  const model = getActiveModel(config);
  const contextEnv = getClaudeContextEnv(config);
  const nextEnv: Record<string, unknown> = {
    ...existingEnv,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.proxyPort}`,
    ANTHROPIC_AUTH_TOKEN: config.proxyToken,
    ANTHROPIC_API_KEY: config.proxyToken,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_CUSTOM_MODEL_OPTION: model,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: model,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION:
      `Claude Code via local ${getProviderLabel(config.provider)} gateway`,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    ...contextEnv,
  };
  if (!contextEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
    delete nextEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  }
  if (!contextEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
    delete nextEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  }

  const next = {
    ...parsed,
    model,
    env: nextEnv,
  };

  if (JSON.stringify(parsed) === JSON.stringify(next)) {
    return;
  }

  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
};

const runLaunchOpenClaw = async (args: string[]): Promise<void> => {
  const config = await ensureConfigured();
  const launchArgs = normalizeLaunchArgs(args);
  const usesLocalProxy =
    config.provider === "clinepass" ||
    (config.provider === "openrouter" && Boolean(config.openrouterRoute));
  const activeApiKey = usesLocalProxy ? config.proxyToken : getActiveApiKey(config);
  const openclawBinary = await resolveOpenClawBinary();
  if (usesLocalProxy) {
    await ensureProxyRunning(config);
  }
  const { env, updated } = await ensureOpenClawConfigured(
    openclawBinary,
    config,
    activeApiKey,
  );
  if (updated) {
    console.error(
      "nvicode updated the default OpenClaw config. Restart the OpenClaw gateway to apply it: `openclaw gateway restart` (or `openclaw gateway run` for a foreground test).",
    );
  }
  const child = spawnClaudeProcess(openclawBinary, launchArgs, env);

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`OpenClaw exited with signal ${signal}`));
        return;
      }
      process.exitCode = code ?? 0;
      resolve();
    });
    child.on("error", reject);
  });
};

const runLaunchCodex = async (args: string[]): Promise<void> => {
  const config = await ensureConfigured();
  const launchArgs = normalizeLaunchArgs(args);
  const routingStatus = await ensurePersistentCodexRouting().catch(() => "skipped" as const);
  const activeModel = getActiveModel(config);
  const codexBinary = await resolveCodexBinary();

  await ensureProxyRunning(config);

  const proxyBaseUrl = `http://127.0.0.1:${config.proxyPort}/v1`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NVICODE_PROXY_TOKEN: config.proxyToken,
  };

  const hasModelFlag = launchArgs.includes("--model") || launchArgs.includes("-m");
  const codexArgs = [
    "-c", `model_provider="nvicode"`,
    "-c", `model_providers.nvicode.name="nvicode proxy"`,
    "-c", `model_providers.nvicode.base_url="${proxyBaseUrl}"`,
    "-c", `model_providers.nvicode.env_key="NVICODE_PROXY_TOKEN"`,
    "-c", `model_providers.nvicode.wire_api="responses"`,
    "-c", `model_providers.nvicode.supports_websockets=false`,
    ...(hasModelFlag ? [] : ["--model", activeModel]),
    ...launchArgs,
  ];

  if (
    process.stdout.isTTY &&
    (routingStatus === "installed" || routingStatus === "updated")
  ) {
    console.error(
      "nvicode installed persistent `codex` routing. Future plain `codex` launches will use the selected nvicode provider and model.",
    );
  }

  const child = spawnClaudeProcess(codexBinary, codexArgs, env);

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Codex exited with signal ${signal}`));
        return;
      }
      process.exitCode = code ?? 0;
      resolve();
    });
    child.on("error", reject);
  });
};

const resolveCodexAppBundle = async (): Promise<string> => {
  if (process.platform !== "darwin") {
    throw new Error("Codex desktop app launch is currently supported on macOS only.");
  }

  const candidates = [
    "/Applications/Codex.app",
    path.join(os.homedir(), "Applications", "Codex.app"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to locate Codex.app. Install the Codex desktop app first.");
};

const runConfigureCodexApp = async (): Promise<void> => {
  const config = await ensureConfigured();
  const { configFile, updated } = await ensureCodexAppConfigured(config);
  console.log(
    updated
      ? `Configured Codex desktop app routing in ${configFile}.`
      : `Codex desktop app routing is already configured in ${configFile}.`,
  );
  console.log(`Codex desktop app model: ${getActiveModel(config)}`);
};

const runCodexAppToken = async (): Promise<void> => {
  const config = await ensureConfigured();
  await ensureCodexAppConfigured(config);
  await ensureProxyRunning(config);
  console.log(config.proxyToken);
};

const runLaunchCodexApp = async (args: string[]): Promise<void> => {
  const codexAppBundle = await resolveCodexAppBundle();
  const config = await ensureConfigured();
  const launchArgs = normalizeLaunchArgs(args);
  const { configFile, updated } = await ensureCodexAppConfigured(config);
  await ensureProxyRunning(config);

  console.error(
    `${updated ? "Configured" : "Using"} Codex desktop app routing in ${configFile}.`,
  );
  console.error(`Opening Codex.app with ${getActiveModel(config)} through nvicode.`);
  console.error("If Codex.app was already running, quit and reopen it once to reload the provider config.");

  const child = spawn("/usr/bin/open", ["-a", codexAppBundle, ...launchArgs], {
    stdio: "inherit",
    windowsHide: true,
  });

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Unable to open Codex.app: open exited with signal ${signal}`));
        return;
      }
      if ((code ?? 0) !== 0) {
        reject(new Error(`Unable to open Codex.app: open exited with code ${code ?? 0}`));
        return;
      }
      resolve();
    });
    child.on("error", reject);
  });
};

const resolveClaudeDesktopApp = async (
  paths: ClaudeDesktopPaths,
): Promise<string | null> => {
  const bundled = await findClaudeDesktopApp(paths);
  if (bundled) {
    return bundled;
  }

  const commandNames =
    paths.platform === "win32"
      ? ["Claude.exe", "claude.exe", "claude-desktop.exe"]
      : ["claude-desktop"];
  for (const name of commandNames) {
    const found = await findExecutableInPath(name);
    if (found) {
      return found;
    }
  }
  return null;
};

const applyClaudeDesktopAndOpen = async (
  appPath: string,
  apply: () => Promise<void>,
  paths: ClaudeDesktopPaths,
): Promise<void> => {
  if (!(await isClaudeDesktopRunning(paths.platform))) {
    await openClaudeDesktop(appPath, paths.platform);
    return;
  }

  if (!process.stdin.isTTY) {
    console.error(
      "Claude Desktop is already running. Quit it completely and run `nvicode launch claude-desktop` again to reload the profile.",
    );
    return;
  }

  const answer = (
    await question("Claude Desktop is running. Restart it now? [y/N]: ")
  ).toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    console.error(
      "Profile saved. Quit and reopen Claude Desktop when you are ready to use nvicode.",
    );
    return;
  }

  await restartClaudeDesktop(appPath, apply, paths.platform);
};

const runConfigureClaudeDesktop = async (): Promise<void> => {
  if (!isClaudeDesktopSupported(process.platform)) {
    throw new Error(
      "Claude Desktop third-party routing is supported on macOS, Windows, and Linux.",
    );
  }

  const config = await ensureConfigured();
  await ensureProxyRunning(config);
  const result = await configureClaudeDesktop({
    baseUrl: `http://127.0.0.1:${config.proxyPort}`,
    apiKey: config.proxyToken,
    model: getActiveModel(config),
  });
  console.log(
    `${result.updated ? "Configured" : "Using"} Claude Desktop's 3P profile in ${result.paths.profileFile}.`,
  );
  console.log(`Claude Desktop model: ${result.model}`);
  console.log(
    "Fully quit and reopen Claude Desktop to load the profile, or run `nvicode launch claude-desktop`.",
  );
};

const runRestoreClaudeDesktop = async (): Promise<void> => {
  if (!isClaudeDesktopSupported(process.platform)) {
    throw new Error(
      "Claude Desktop third-party routing is supported on macOS, Windows, and Linux.",
    );
  }

  const paths = getClaudeDesktopPaths();
  const result = await restoreClaudeDesktop();
  const appPath = await resolveClaudeDesktopApp(paths);
  console.error(
    `${result.updated ? "Restored" : "No Nvicode profile found for"} Claude Desktop's standard profile.`,
  );

  if (!appPath) {
    console.error(
      `Claude Desktop was not found. Reopen it manually after reviewing ${result.paths.profileRoot}.`,
    );
    return;
  }

  await applyClaudeDesktopAndOpen(
    appPath,
    async () => {
      await restoreClaudeDesktop();
    },
    paths,
  );
};

const runLaunchClaudeDesktop = async (args: string[]): Promise<void> => {
  const launchArgs = normalizeLaunchArgs(args);
  const restore = launchArgs.includes("--restore");
  const unsupportedArgs = launchArgs.filter((arg) => arg !== "--restore");
  if (unsupportedArgs.length > 0) {
    throw new Error(
      "`nvicode launch claude-desktop` does not accept app arguments. Use `--restore` to restore the standard profile.",
    );
  }
  if (!isClaudeDesktopSupported(process.platform)) {
    throw new Error(
      "Claude Desktop third-party routing is supported on macOS, Windows, and Linux.",
    );
  }

  const paths = getClaudeDesktopPaths();
  const appPath = await resolveClaudeDesktopApp(paths);
  if (!restore && !appPath) {
    throw new Error(
      "Unable to locate Claude Desktop. Install it first, then run `nvicode launch claude-desktop` again.",
    );
  }

  if (restore) {
    await runRestoreClaudeDesktop();
    return;
  }

  const config = await ensureConfigured();
  await ensureProxyRunning(config);
  const apply = async (): Promise<void> => {
    await configureClaudeDesktop({
      baseUrl: `http://127.0.0.1:${config.proxyPort}`,
      apiKey: config.proxyToken,
      model: getActiveModel(config),
    });
  };
  const result = await configureClaudeDesktop({
    baseUrl: `http://127.0.0.1:${config.proxyPort}`,
    apiKey: config.proxyToken,
    model: getActiveModel(config),
  });

  console.error(
    `${result.updated ? "Configured" : "Using"} Claude Desktop 3P routing for ${getActiveModel(config)} through ${getProviderLabel(config.provider)}.`,
  );
  if (!appPath) {
    throw new Error("Unable to locate Claude Desktop application.");
  }
  await applyClaudeDesktopAndOpen(appPath, apply, paths);
};

const runLaunchClaude = async (args: string[]): Promise<void> => {
  const config = await ensureConfigured();
  const routingStatus = await ensurePersistentClaudeRouting().catch(() => "skipped" as const);
  const claudeBinary = await resolveClaudeBinary();
  const activeModel = getActiveModel(config);
  const launchArgs = normalizeLaunchArgs(args);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.proxyPort}`,
    ANTHROPIC_AUTH_TOKEN: config.proxyToken,
    ANTHROPIC_API_KEY: config.proxyToken,
    ANTHROPIC_MODEL: activeModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: activeModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: activeModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: activeModel,
    CLAUDE_CODE_SUBAGENT_MODEL: activeModel,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    ANTHROPIC_CUSTOM_MODEL_OPTION: activeModel,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: activeModel,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION:
      `Claude Code via local ${getProviderLabel(config.provider)} gateway`,
    ...getClaudeContextEnv(config),
  };

  await ensureProxyRunning(config);
  await ensureClaudeCustomApiKeyApproved(config.proxyToken);
  await ensureClaudeSettingsEnvConfigured(config);

  if (
    process.stdout.isTTY &&
    (routingStatus === "installed" || routingStatus === "updated")
  ) {
    console.error(
      "nvicode installed persistent `claude` routing. Future plain `claude` launches will use the selected nvicode provider and model.",
    );
  }

  const claudeArgs = shouldAddClaudeBareMode(launchArgs)
    ? ["--bare", ...launchArgs]
    : launchArgs;
  const child = spawnClaudeProcess(claudeBinary, claudeArgs, env);

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
    `nvicode proxy listening on http://127.0.0.1:${config.proxyPort} using ${getActiveModel(config)} (${config.provider})`,
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

  if (command === "codex-app-token") {
    await runCodexAppToken();
    return;
  }

  if (command === "models") {
    const config = await loadConfig();
    await printModels(
      config.provider,
      getActiveApiKey(config) || undefined,
      config.openrouterRoute,
    );
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

  if (command === "usage") {
    await runUsage();
    return;
  }

  if (command === "activity") {
    await runActivity();
    return;
  }

  if (command === "dashboard") {
    await runDashboard();
    return;
  }

  if (
    (command === "select" && rest[0] === "model") ||
    command === "select-model"
  ) {
    await runSelectModel();
    return;
  }

  if (command === "configure" && rest[0] === "codex-app") {
    await runConfigureCodexApp();
    return;
  }

  if (command === "configure" && rest[0] === "claude-desktop") {
    await runConfigureClaudeDesktop();
    return;
  }

  if (command === "restore" && rest[0] === "claude-desktop") {
    await runRestoreClaudeDesktop();
    return;
  }

  if (command === "launch") {
    if (rest[0] === "claude") {
      await runLaunchClaude(rest.slice(1));
      return;
    }
    if (rest[0] === "claude-desktop" || rest[0] === "desktop") {
      await runLaunchClaudeDesktop(rest.slice(1));
      return;
    }
    if (rest[0] === "openclaw") {
      await runLaunchOpenClaw(rest.slice(1));
      return;
    }
    if (rest[0] === "codex") {
      await runLaunchCodex(rest.slice(1));
      return;
    }
    if (rest[0] === "codex-app") {
      await runLaunchCodexApp(rest.slice(1));
      return;
    }
    throw new Error(
      "Supported launch targets are `claude`, `claude-desktop`, `openclaw`, `codex`, and `codex-app`.",
    );
  }

  throw new Error(`Unknown command: ${command}`);
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
