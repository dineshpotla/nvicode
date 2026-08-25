import assert from "node:assert/strict";
import test from "node:test";

import {
  getContextBudgetForConfig,
  trimChatMessagesForProvider,
} from "../dist/proxy.js";
import { getRecommendedOpenRouterModels } from "../dist/models.js";

const baseConfig = (patch = {}) => ({
  provider: "nvidia",
  nvidiaApiKey: "test-nvidia-key",
  nvidiaModel: "moonshotai/kimi-k2.6",
  openrouterApiKey: "test-openrouter-key",
  openrouterModel: "qwen/qwen3-coder:free",
  tokenrouterApiKey: "test-tokenrouter-key",
  tokenrouterModel: "MiniMax-M3",
  gmicloudApiKey: "test-gmicloud-key",
  gmicloudModel: "moonshotai/kimi-k3",
  clinepassModel: "cline-pass/glm-5.2",
  xaiApiKey: "",
  xaiModel: "grok-4.5",
  proxyPort: 8788,
  proxyToken: "sk-ant-nvicode-test",
  thinking: false,
  maxRequestsPerMinute: 40,
  ...patch,
});

const activeLimits = (provider, model, patch) => ({
  provider,
  model,
  contextWindowTokens: 262_144,
  maxOutputTokens: 16_384,
  source: "model-spec",
  updatedAt: new Date().toISOString(),
  ...patch,
});

test("uses the active NVIDIA model context and reserves output space", () => {
  const config = baseConfig({
    activeModelLimits: activeLimits("nvidia", "moonshotai/kimi-k2.6"),
  });
  const budget = getContextBudgetForConfig(config);

  assert.equal(budget.contextWindowTokens, 262_144);
  assert.equal(budget.maxOutputTokens, 16_384);
  assert.equal(budget.outputReserveTokens, 16_384);
  assert.equal(budget.inputLimitTokens, 232_652);
});

test("uses TokenRouter MiniMax M3's router-safe input cap", () => {
  const config = baseConfig({
    provider: "tokenrouter",
    activeModelLimits: activeLimits("tokenrouter", "MiniMax-M3", {
      contextWindowTokens: 1_048_576,
      maxOutputTokens: undefined,
      safeInputTokens: 300_000,
    }),
  });
  const budget = getContextBudgetForConfig(config);

  assert.equal(budget.contextWindowTokens, 1_048_576);
  assert.equal(budget.inputLimitTokens, 300_000);
});

test("never applies cached limits from another provider or model", () => {
  const config = baseConfig({
    activeModelLimits: activeLimits("openrouter", "qwen/qwen3-coder:free"),
  });
  const budget = getContextBudgetForConfig(config);

  assert.equal(budget.contextWindowTokens, null);
  assert.equal(budget.inputLimitTokens, null);
});

test("provider-specific environment cap takes precedence", () => {
  const previous = process.env.NVICODE_NVIDIA_CONTEXT_LIMIT_TOKENS;
  process.env.NVICODE_NVIDIA_CONTEXT_LIMIT_TOKENS = "123456";
  try {
    const config = baseConfig({
      activeModelLimits: activeLimits("nvidia", "moonshotai/kimi-k2.6"),
    });
    const budget = getContextBudgetForConfig(config);
    assert.equal(budget.inputLimitTokens, 123_456);
    assert.equal(budget.source, "environment");
  } finally {
    if (previous === undefined) {
      delete process.env.NVICODE_NVIDIA_CONTEXT_LIMIT_TOKENS;
    } else {
      process.env.NVICODE_NVIDIA_CONTEXT_LIMIT_TOKENS = previous;
    }
  }
});

test("old context is trimmed to the active model input budget", () => {
  const config = baseConfig({
    activeModelLimits: activeLimits("nvidia", "moonshotai/kimi-k2.6", {
      contextWindowTokens: 20_000,
      maxOutputTokens: 2_000,
    }),
  });
  const budget = getContextBudgetForConfig(config, undefined, 2_000);
  assert.equal(budget.inputLimitTokens, 17_000);

  const trim = trimChatMessagesForProvider(
    config,
    "moonshotai/kimi-k2.6",
    [
      { role: "user", content: "old context ".repeat(20_000) },
      { role: "assistant", content: "noted" },
      { role: "user", content: "current request" },
    ],
    undefined,
    2_000,
  );
  assert.equal(trim.removedMessages, 2);
  assert.ok(trim.estimatedTokens < 100);
});

test("the current user request is never silently removed", () => {
  const config = baseConfig({
    activeModelLimits: activeLimits("nvidia", "moonshotai/kimi-k2.6", {
      contextWindowTokens: 2_000,
      maxOutputTokens: 1_000,
    }),
  });
  const trim = trimChatMessagesForProvider(
    config,
    "moonshotai/kimi-k2.6",
    [{ role: "user", content: "current request ".repeat(2_000) }],
    undefined,
    1_000,
  );

  assert.equal(trim.removedMessages, 0);
  assert.equal(trim.messages.length, 1);
  assert.ok(trim.estimatedTokens > (trim.limitTokens ?? 0));
});

test("OpenRouter recommendations exclude models without tool calling", () => {
  const models = getRecommendedOpenRouterModels([
    {
      id: "qwen/qwen3-coder-new:free",
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["max_tokens"],
    },
    {
      id: "qwen/qwen3-coder-tools:free",
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["max_tokens", "tools"],
    },
  ]);

  assert.ok(models.some((model) => model.id === "qwen/qwen3-coder-tools:free"));
  assert.ok(!models.some((model) => model.id === "qwen/qwen3-coder-new:free"));
});
