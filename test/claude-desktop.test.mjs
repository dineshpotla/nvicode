import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configureClaudeDesktop,
  getClaudeDesktopPaths,
  restoreClaudeDesktop,
  NVICODE_CLAUDE_DESKTOP_PROFILE_ID,
} from "../dist/claude-desktop.js";
import { createProxyServer } from "../dist/proxy.js";

const makeTempHome = async () => fs.mkdtemp(path.join(os.tmpdir(), "nvicode-claude-desktop-"));

test("resolves the documented Claude Desktop 3P profile locations", () => {
  const home = "/tmp/nvicode-home";
  const mac = getClaudeDesktopPaths("darwin", home, {});
  assert.equal(
    mac.configLibrary,
    "/tmp/nvicode-home/Library/Application Support/Claude-3p/configLibrary",
  );

  const linux = getClaudeDesktopPaths("linux", home, {});
  assert.equal(linux.configLibrary, "/tmp/nvicode-home/.config/Claude-3p/configLibrary");

  const windows = getClaudeDesktopPaths("win32", home, {
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  });
  assert.match(windows.configLibrary, /Claude-3p[\\/]configLibrary$/);
});

test("configures a gateway profile without dropping existing profile fields", async () => {
  const home = await makeTempHome();
  try {
    const paths = getClaudeDesktopPaths("linux", home, {});
    await fs.mkdir(path.dirname(paths.profileFile), { recursive: true });
    await fs.writeFile(paths.profileFile, JSON.stringify({ customFlag: true }) + "\n");
    await fs.writeFile(paths.metaFile, JSON.stringify({ entries: [{ id: "other", name: "Other" }] }) + "\n");

    const result = await configureClaudeDesktop(
      {
        baseUrl: "http://127.0.0.1:8788",
        apiKey: "sk-ant-nvicode-test",
        model: "moonshotai/kimi-k2.6",
      },
      { platform: "linux", homeDirectory: home, env: {} },
    );
    assert.equal(result.updated, true);

    const profile = JSON.parse(await fs.readFile(paths.profileFile, "utf8"));
    assert.equal(profile.customFlag, true);
    assert.equal(profile.inferenceProvider, "gateway");
    assert.equal(profile.inferenceCredentialKind, "static");
    assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:8788");
    assert.equal(profile.inferenceGatewayApiKey, "sk-ant-nvicode-test");
    assert.equal(profile.modelDiscoveryEnabled, false);
    assert.equal(profile.deploymentDisplayName, "moonshotai/kimi-k2.6");
    assert.deepEqual(profile.inferenceModels[0], {
      name: "moonshotai/kimi-k2.6",
      labelOverride: "moonshotai/kimi-k2.6",
      anthropicFamilyTier: "sonnet",
      isFamilyDefault: true,
    });

    const metadata = JSON.parse(await fs.readFile(paths.metaFile, "utf8"));
    assert.equal(metadata.appliedId, NVICODE_CLAUDE_DESKTOP_PROFILE_ID);
    assert.deepEqual(metadata.entries, [
      { id: "other", name: "Other" },
      { id: NVICODE_CLAUDE_DESKTOP_PROFILE_ID, name: "Nvicode" },
    ]);
    const deployment = JSON.parse(await fs.readFile(paths.deploymentConfigFile, "utf8"));
    assert.equal(deployment.deploymentMode, "3p");
    assert.ok(await fs.stat(`${paths.profileFile}.nvicode.bak`));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("keeps long model IDs exact while capping Claude Desktop display labels", async () => {
  const home = await makeTempHome();
  try {
    const paths = await configureClaudeDesktop(
      {
        baseUrl: "http://127.0.0.1:8788",
        apiKey: "sk-ant-nvicode-test",
        model: `provider/${"x".repeat(70)}`,
      },
      { platform: "linux", homeDirectory: home, env: {} },
    );
    const profile = JSON.parse(await fs.readFile(paths.paths.profileFile, "utf8"));
    const model = profile.inferenceModels[0];
    assert.equal(model.name, `provider/${"x".repeat(70)}`);
    assert.equal(model.labelOverride.length, 60);
    assert.equal(model.labelOverride.endsWith("..."), true);
    assert.equal(profile.deploymentDisplayName, model.labelOverride);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("restores only Nvicode's profile and leaves unrelated metadata intact", async () => {
  const home = await makeTempHome();
  try {
    const paths = getClaudeDesktopPaths("linux", home, {});
    await configureClaudeDesktop(
      {
        baseUrl: "http://127.0.0.1:8788",
        apiKey: "sk-ant-nvicode-test",
        model: "qwen/qwen3-coder:free",
      },
      { platform: "linux", homeDirectory: home, env: {} },
    );

    const result = await restoreClaudeDesktop({
      platform: "linux",
      homeDirectory: home,
      env: {},
    });
    assert.equal(result.updated, true);
    await assert.rejects(fs.stat(paths.profileFile), { code: "ENOENT" });
    const metadata = JSON.parse(await fs.readFile(paths.metaFile, "utf8"));
    assert.equal(metadata.appliedId, undefined);
    assert.deepEqual(metadata.entries, []);
    const deployment = JSON.parse(await fs.readFile(paths.deploymentConfigFile, "utf8"));
    assert.equal(deployment.deploymentMode, "1p");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("advertises the selected model in the Anthropic-compatible model catalog", async () => {
  const server = createProxyServer({
    provider: "nvidia",
    nvidiaApiKey: "test-key",
    nvidiaModel: "moonshotai/kimi-k2.6",
    openrouterApiKey: "",
    openrouterModel: "qwen/qwen3-coder:free",
    tokenrouterApiKey: "",
    tokenrouterModel: "MiniMax-M3",
    gmicloudApiKey: "",
    gmicloudModel: "zai-org/GLM-5.1-FP8",
    clinepassModel: "cline-pass/glm-5.2",
    xaiApiKey: "",
    xaiModel: "grok-4.5",
    proxyPort: 8788,
    proxyToken: "sk-ant-nvicode-test",
    thinking: false,
    maxRequestsPerMinute: 40,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: "Bearer sk-ant-nvicode-test" },
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data[0].id, "moonshotai/kimi-k2.6");
    assert.equal(payload.data[0].display_name, "Nvicode - moonshotai/kimi-k2.6");
    assert.equal(payload.data[0].anthropic_family_tier, "sonnet");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
