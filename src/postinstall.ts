import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const isTruthy = (value?: string): boolean =>
  value === "1" || value === "true" || value === "yes";

const isInteractive = (): boolean =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY);

const getPackageRoot = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const getCliPath = (): string =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

const runNpmCommand = (args: string[]): string | null => {
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    : spawnSync("npm", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });

  if (result.status !== 0) {
    return null;
  }

  const output = result.stdout?.trim();
  return output ? output : null;
};

const getContextFromPrefix = (prefix: string): { binDir: string; globalRoot: string } => ({
  binDir: process.platform === "win32" ? prefix : path.join(prefix, "bin"),
  globalRoot:
    process.platform === "win32"
      ? path.join(prefix, "node_modules")
      : path.join(prefix, "lib", "node_modules"),
});

const getContextFromGlobalRoot = (globalRoot: string): { binDir: string; globalRoot: string } | null => {
  if (process.platform === "win32") {
    return {
      binDir: path.dirname(globalRoot),
      globalRoot,
    };
  }

  const suffix = path.join("lib", "node_modules");
  if (!globalRoot.endsWith(suffix)) {
    return null;
  }

  const prefix = path.dirname(path.dirname(globalRoot));
  return {
    binDir: path.join(prefix, "bin"),
    globalRoot,
  };
};

const isWithinPath = (targetPath: string, parentPath: string): boolean => {
  const relativePath = path.relative(parentPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
};

const getGlobalBinDir = async (): Promise<string | null> => {
  const packageRoot = await fs.realpath(getPackageRoot()).catch(() => getPackageRoot());
  const contexts = new Map<string, { binDir: string; globalRoot: string }>();

  const envPrefix = process.env.npm_config_prefix || process.env.PREFIX;
  if (envPrefix) {
    const context = getContextFromPrefix(envPrefix);
    contexts.set(`${context.globalRoot}|${context.binDir}`, context);
  }

  const npmPrefix = runNpmCommand(["prefix", "-g"]);
  if (npmPrefix) {
    const context = getContextFromPrefix(npmPrefix);
    contexts.set(`${context.globalRoot}|${context.binDir}`, context);
  }

  const npmGlobalRoot = runNpmCommand(["root", "-g"]);
  if (npmGlobalRoot) {
    const context = getContextFromGlobalRoot(npmGlobalRoot);
    if (context) {
      contexts.set(`${context.globalRoot}|${context.binDir}`, context);
    }
  }

  for (const context of contexts.values()) {
    const globalRoot = await fs.realpath(context.globalRoot).catch(() =>
      path.resolve(context.globalRoot),
    );
    if (isWithinPath(packageRoot, globalRoot)) {
      return context.binDir;
    }
  }

  if (
    process.env.npm_config_global === "true" ||
    process.env.npm_config_location === "global"
  ) {
    return envPrefix ? getContextFromPrefix(envPrefix).binDir : null;
  }

  return null;
};

const createGlobalLauncher = async (): Promise<"created" | "skipped"> => {
  const binDir = await getGlobalBinDir();
  if (!binDir) {
    return "skipped";
  }

  const cliPath = getCliPath();
  const launcherPath =
    process.platform === "win32"
      ? path.join(binDir, "nvicode.cmd")
      : path.join(binDir, "nvicode");

  const launcherContents =
    process.platform === "win32"
      ? [
          "@echo off",
          `node "${cliPath}" %*`,
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `exec node "${cliPath}" "$@"`,
          "",
        ].join("\n");

  try {
    await fs.lstat(launcherPath);
    return "skipped";
  } catch {
    // create launcher only when npm did not create the command entry
  }

  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(launcherPath, launcherContents, "utf8");
  if (process.platform !== "win32") {
    await fs.chmod(launcherPath, 0o755);
  }
  return "created";
};

const main = async (): Promise<void> => {
  if (isTruthy(process.env.NVICODE_SKIP_POSTINSTALL) || isTruthy(process.env.CI)) {
    return;
  }

  try {
    await createGlobalLauncher();
  } catch {
    // keep install resilient even if the launcher cannot be created manually
  }

  if (!isInteractive()) {
    console.log("nvicode installed. Run `nvicode select model` to finish setup.");
    return;
  }

  const config = await loadConfig();
  if (config.nvidiaApiKey || config.openrouterApiKey) {
    console.log("nvicode is already configured. Run `nvicode select model` to change provider, key, or model.");
    return;
  }

  console.log("");
  console.log("nvicode installed. Starting guided setup.");
  console.log("If you want to skip now, press Ctrl+C and run `nvicode select model` later.");
  console.log("");

  const cliPath = getCliPath();
  const result = spawnSync(process.execPath, [cliPath, "select", "model"], {
    stdio: "inherit",
    env: {
      ...process.env,
      NVICODE_FROM_POSTINSTALL: "1",
    },
  });

  if (result.error || result.status !== 0) {
    console.log("");
    console.log("nvicode setup was skipped or did not complete.");
    console.log("Run `nvicode select model` any time to finish setup.");
  }
};

void main().catch(() => {
  console.log("nvicode installed. Run `nvicode select model` to finish setup.");
});
