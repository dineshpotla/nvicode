import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const isTruthy = (value?: string): boolean =>
  value === "1" || value === "true" || value === "yes";

const isGlobalInstall = (): boolean =>
  process.env.npm_config_global === "true" ||
  process.env.npm_config_location === "global";

const isInteractive = (): boolean =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY);

const main = async (): Promise<void> => {
  if (isTruthy(process.env.NVICODE_SKIP_POSTINSTALL) || isTruthy(process.env.CI)) {
    return;
  }

  if (!isGlobalInstall()) {
    return;
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

  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
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
