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
  getActiveApiKey,
  getActiveModel,
  getNvicodePaths,
  loadConfig,
  saveConfig,
  type ProviderId,
  type NvicodeConfig,
} from "./config.js";
import { createProxyServer } from "./proxy.js";
import { getRecommendedModels } from "./models.js";
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

const usage = (): void => {
  console.log(`nvicode

Commands:
  nvicode select model        Guided provider, key, and model selection
  nvicode models              Show recommended models for the active provider
  nvicode auth                Save or update the API key for the active provider
  nvicode config              Show current nvicode config
  nvicode usage               Show token usage and cost comparison
  nvicode activity            Show recent request activity
  nvicode dashboard           Show usage summary and recent activity
  nvicode launch claude [...] Launch Claude Code through nvicode
  nvicode serve               Run the local proxy in the foreground
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
  provider === "openrouter" ? "OpenRouter" : "NVIDIA";

const getClaudeCommandNames = (): string[] =>
  isWindows ? ["claude.exe", "claude.cmd", "claude.bat", "claude"] : ["claude"];

const getClaudeNativeNames = (): string[] =>
  isWindows
    ? ["claude-native.exe", "claude-native.cmd", "claude-native.bat", "claude-native"]
    : ["claude-native"];

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

const isManagedClaudeWrapper = async (targetPath: string): Promise<boolean> => {
  const contents = await readIfExists(targetPath);
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

  const defaultChoice = initialProvider === "openrouter" ? "2" : "1";
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

  throw new Error("Provider selection is required.");
};

const promptApiKeyUpdate = async (
  config: NvicodeConfig,
  provider: ProviderId,
): Promise<Pick<NvicodeConfig, "nvidiaApiKey" | "openrouterApiKey">> => {
  const providerLabel = getProviderLabel(provider);
  const currentApiKey =
    provider === "openrouter" ? config.openrouterApiKey : config.nvidiaApiKey;

  if (currentApiKey) {
    const answer = (
      await question(
        `${providerLabel} API key already saved. Update it? [y/N]: `,
      )
    ).toLowerCase();

    if (answer !== "y" && answer !== "yes") {
      return provider === "openrouter"
        ? { openrouterApiKey: currentApiKey, nvidiaApiKey: config.nvidiaApiKey }
        : { nvidiaApiKey: currentApiKey, openrouterApiKey: config.openrouterApiKey };
    }

    const nextKey = await question(
      `${providerLabel} API key (press Enter or type "skip" to keep current): `,
    );
    if (!nextKey || nextKey.toLowerCase() === "skip") {
      return provider === "openrouter"
        ? { openrouterApiKey: currentApiKey, nvidiaApiKey: config.nvidiaApiKey }
        : { nvidiaApiKey: currentApiKey, openrouterApiKey: config.openrouterApiKey };
    }

    return provider === "openrouter"
      ? { openrouterApiKey: nextKey, nvidiaApiKey: config.nvidiaApiKey }
      : { nvidiaApiKey: nextKey, openrouterApiKey: config.openrouterApiKey };
  }

  const nextKey = await question(
    `${providerLabel} API key (press Enter or type "skip" to skip): `,
  );
  if (!nextKey || nextKey.toLowerCase() === "skip") {
    return {
      nvidiaApiKey: config.nvidiaApiKey,
      openrouterApiKey: config.openrouterApiKey,
    };
  }

  return provider === "openrouter"
    ? { openrouterApiKey: nextKey, nvidiaApiKey: config.nvidiaApiKey }
    : { nvidiaApiKey: nextKey, openrouterApiKey: config.openrouterApiKey };
};

const ensureConfigured = async (): Promise<NvicodeConfig> => {
  let config = await loadConfig();
  let changed = false;
  const providerLabel = getProviderLabel(config.provider);
  const activeApiKey = getActiveApiKey(config);
  const activeModel = getActiveModel(config);

  if (!activeApiKey) {
    if (!process.stdin.isTTY) {
      throw new Error(`Missing ${providerLabel} API key. Run \`nvicode auth\` first.`);
    }
    const apiKey = await question(`${providerLabel} API key: `);
    if (!apiKey) {
      throw new Error(`${providerLabel} API key is required.`);
    }
    config = {
      ...config,
      ...(config.provider === "openrouter"
        ? { openrouterApiKey: apiKey }
        : { nvidiaApiKey: apiKey }),
    };
    changed = true;
  }

  if (!activeModel) {
    const [first] = await getRecommendedModels(config.provider, getActiveApiKey(config));
    config = {
      ...config,
      ...(config.provider === "openrouter"
        ? { openrouterModel: first?.id || "anthropic/claude-sonnet-4.6" }
        : { nvidiaModel: first?.id || "moonshotai/kimi-k2.5" }),
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
  const providerLabel = getProviderLabel(config.provider);
  const currentApiKey = getActiveApiKey(config);
  const apiKey = await question(
    currentApiKey
      ? `${providerLabel} API key (leave blank to keep current): `
      : `${providerLabel} API key: `,
  );

  if (!apiKey && currentApiKey) {
    console.log(`Kept existing ${providerLabel} API key.`);
    return;
  }
  if (!apiKey) {
    throw new Error(`${providerLabel} API key is required.`);
  }

  await saveConfig({
    ...config,
    ...(config.provider === "openrouter"
      ? { openrouterApiKey: apiKey }
      : { nvidiaApiKey: apiKey }),
  });
  console.log(`Saved ${providerLabel} API key.`);
};

const printModels = async (
  provider: ProviderId,
  apiKey?: string,
): Promise<void> => {
  const models = await getRecommendedModels(provider, apiKey || "");
  models.forEach((model, index) => {
    console.log(`${index + 1}. ${model.label}`);
    console.log(`   ${model.id}`);
    console.log(`   ${model.description}`);
  });
};

const runSelectModel = async (): Promise<void> => {
  const config = await loadConfig();
  const provider = await promptProviderSelection(config.provider);
  const providerLabel = getProviderLabel(provider);
  const keyPatch = await promptApiKeyUpdate(config, provider);
  const nextConfig = await saveConfig({
    ...config,
    ...keyPatch,
    provider,
  });
  const models = await getRecommendedModels(provider, getActiveApiKey(nextConfig));

  console.log(`Top popular ${providerLabel} models:`);
  await printModels(provider, getActiveApiKey(nextConfig));
  console.log("Or paste a full model id.");
  console.log("Example: qwen/qwen3.6-plus-preview:free");

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
    ...nextConfig,
    ...(provider === "openrouter"
      ? { openrouterModel: chosenModel }
      : { nvidiaModel: chosenModel }),
  });
  console.log(`Saved model: ${chosenModel}`);
};

const runConfig = async (): Promise<void> => {
  const config = await loadConfig();
  const paths = getNvicodePaths();
  console.log(`Config file: ${paths.configFile}`);
  console.log(`State dir:   ${paths.stateDir}`);
  console.log(`Usage log:   ${paths.usageLogFile}`);
  console.log(`Provider:    ${getProviderLabel(config.provider)}`);
  console.log(`Model:       ${getActiveModel(config)}`);
  console.log(`Proxy port:  ${config.proxyPort}`);
  console.log(`Max RPM:     ${config.maxRequestsPerMinute}`);
  console.log(`Thinking:    ${config.thinking ? "on" : "off"}`);
  console.log(`NVIDIA key:  ${config.nvidiaApiKey ? "saved" : "missing"}`);
  console.log(`OpenRouter key: ${config.openrouterApiKey ? "saved" : "missing"}`);
};

const printUsageBlock = (
  label: string,
  records: Awaited<ReturnType<typeof readUsageRecords>>,
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
  console.log(`NVIDIA cost: ${formatUsd(summary.providerCostUsd)}`);
  console.log(`Estimated savings: ${formatUsd(summary.savingsUsd)}`);
};

const getUsageView = async (): Promise<string> => {
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
      `- NVIDIA configured cost: ${formatUsd(latestPricing.providerInputUsdPerMTok)} / MTok input, ${formatUsd(latestPricing.providerOutputUsdPerMTok)} / MTok output`,
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
      nvidiaCost: formatUsd(summary.providerCostUsd),
      savings: formatUsd(summary.savingsUsd),
    };
  });

  lines.push(
    `Snapshot: ${formatTimestamp(new Date(now).toISOString())}`,
  );
  lines.push("");
  lines.push(
    "Window        Requests         In Tok   Billed In  Out Tok  Billed Out  NVIDIA      Saved",
  );
  rows.forEach((row) => {
    lines.push(
      `${row.window.padEnd(13)} ${row.requests.padEnd(16)} ${row.inputTokens.padStart(8)} ${row.billedInputTokens.padStart(11)} ${row.outputTokens.padStart(8)} ${row.billedOutputTokens.padStart(11)} ${row.nvidiaCost.padStart(10)} ${row.savings.padStart(10)}`,
    );
  });

  return lines.join("\n");
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const clearTerminal = (): void => {
  process.stdout.write("\x1b[2J\x1b[H");
};

const runUsage = async (): Promise<void> => {
  const config = await loadConfig();
  if (config.provider === "openrouter") {
    console.log("OpenRouter uses a direct Claude Code connection.");
    console.log("Local nvicode usage stats are only available for NVIDIA proxy sessions.");
    console.log("Use the OpenRouter activity dashboard for OpenRouter usage.");
    return;
  }

  const interactive = process.stdout.isTTY && process.stdin.isTTY;
  if (!interactive) {
    console.log(await getUsageView());
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
      process.stdout.write(await getUsageView());
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
  if (config.provider === "openrouter") {
    console.log("OpenRouter uses a direct Claude Code connection.");
    console.log("Local nvicode activity logs are only available for NVIDIA proxy sessions.");
    return;
  }

  const records = await readUsageRecords();
  if (records.length === 0) {
    console.log("No activity recorded yet.");
    return;
  }

  console.log(
    "Timestamp             Status  Model                         In Tok  Bill In  Out Tok Bill Out  Latency  NVIDIA     Saved",
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
  if (config.provider === "openrouter") {
    console.log("OpenRouter uses a direct Claude Code connection.");
    console.log("Local nvicode dashboards are only available for NVIDIA proxy sessions.");
    return;
  }

  const records = await readUsageRecords();
  if (records.length === 0) {
    console.log("No usage recorded yet.");
    return;
  }

  const last7Days = filterRecordsSince(records, Date.now() - 7 * 24 * 60 * 60 * 1000);
  printUsageBlock("Usage (7d)", last7Days);
  console.log("");
  console.log("Recent activity");
  console.log("");
  await runActivity();
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
    windowsHide: true,
  });
  child.unref();

  await fs.writeFile(paths.pidFile, `${child.pid}\n`);

  if (!(await waitForHealthyProxy(config.proxyPort))) {
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

const ensurePersistentClaudeRouting = async (): Promise<"installed" | "updated" | "already" | "skipped"> => {
  const claudeCommandPath = await resolvePersistentClaudeCommand();
  if (!claudeCommandPath) {
    return "skipped";
  }

  const wrapperContents = renderClaudeWrapper();
  const { wrapperPath, nativePath } = await getWrapperInstallPaths(claudeCommandPath);

  if (await isManagedClaudeWrapper(wrapperPath)) {
    const currentWrapper = await readIfExists(wrapperPath);
    if (currentWrapper === wrapperContents) {
      return "already";
    }

    await writeExecutableTextFile(wrapperPath, wrapperContents);
    return "updated";
  }

  if (!(await pathExists(nativePath))) {
    await fs.rename(claudeCommandPath, nativePath);
  } else if (claudeCommandPath !== wrapperPath && await pathExists(wrapperPath)) {
    await fs.rm(wrapperPath, { force: true });
  } else if (claudeCommandPath === wrapperPath) {
    await fs.rm(wrapperPath, { force: true });
  }

  await writeExecutableTextFile(wrapperPath, wrapperContents);
  return "installed";
};

const resolveClaudeBinary = async (): Promise<string> => {
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
    if (await isExecutable(candidate)) {
      return candidate;
    }
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
      const resolved = await resolveClaudeVersionEntry(path.join(versionsDir, latest));
      if (resolved) {
        return resolved;
      }
    }
  } catch {
    // continue
  }

  for (const name of getClaudeCommandNames()) {
    const claudeInPath = await findExecutableInPath(name);
    if (claudeInPath && !(await isManagedClaudeWrapper(claudeInPath))) {
      return claudeInPath;
    }
  }

  throw new Error("Unable to locate Claude Code binary.");
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

const runLaunchClaude = async (args: string[]): Promise<void> => {
  const config = await ensureConfigured();
  const routingStatus = await ensurePersistentClaudeRouting().catch(() => "skipped" as const);
  const claudeBinary = await resolveClaudeBinary();
  const activeModel = getActiveModel(config);
  const activeApiKey = getActiveApiKey(config);

  const env =
    config.provider === "openrouter"
      ? {
          ...process.env,
          ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
          ANTHROPIC_AUTH_TOKEN: activeApiKey,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_MODEL: activeModel,
          ANTHROPIC_DEFAULT_SONNET_MODEL: activeModel,
          ANTHROPIC_DEFAULT_OPUS_MODEL: activeModel,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: activeModel,
          CLAUDE_CODE_SUBAGENT_MODEL: activeModel,
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
        }
      : (() => {
          return {
            ...process.env,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.proxyPort}`,
            ANTHROPIC_AUTH_TOKEN: config.proxyToken,
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_MODEL: activeModel,
            CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
            ANTHROPIC_CUSTOM_MODEL_OPTION: activeModel,
            ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "nvicode custom model",
            ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION:
              "Claude Code via local NVIDIA gateway",
          };
        })();

  if (config.provider === "nvidia") {
    await ensureProxyRunning(config);
  }

  if (
    process.stdout.isTTY &&
    (routingStatus === "installed" || routingStatus === "updated")
  ) {
    console.error(
      "nvicode installed persistent `claude` routing. Future plain `claude` launches will use the selected nvicode provider and model.",
    );
  }

  const child = spawnClaudeProcess(claudeBinary, args, env);

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
  if (config.provider !== "nvidia") {
    throw new Error("`nvicode serve` is only available for the NVIDIA provider.");
  }
  const server = createProxyServer(config);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.proxyPort, "127.0.0.1", () => resolve());
  });

  console.error(
    `nvicode proxy listening on http://127.0.0.1:${config.proxyPort} using ${config.nvidiaModel}`,
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
    await printModels(config.provider, getActiveApiKey(config) || undefined);
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
