import assert from "node:assert/strict";
import test from "node:test";

import {
  getOpenRouterProviderPreferences,
  getOpenRouterProviderName,
  normalizeOpenRouterRoute,
  OPENROUTER_PROVIDER_ROUTES,
} from "../dist/openrouter.js";
import {
  fetchOpenRouterModels,
  getRecommendedOpenRouterModels,
} from "../dist/models.js";

test("ships the top 20 OpenRouter provider routes", () => {
  assert.equal(OPENROUTER_PROVIDER_ROUTES.length, 20);
  assert.ok(
    OPENROUTER_PROVIDER_ROUTES.some((route) => route.slug === "deepinfra"),
  );
  assert.ok(
    OPENROUTER_PROVIDER_ROUTES.some((route) => route.slug === "google-vertex"),
  );
});

test("pins OpenRouter requests to one provider without fallback", () => {
  assert.deepEqual(getOpenRouterProviderPreferences("deepinfra"), {
    order: ["deepinfra"],
    only: ["deepinfra"],
    allow_fallbacks: false,
  });
  assert.equal(getOpenRouterProviderPreferences(undefined), undefined);
});

test("accepts exact OpenRouter endpoint variant slugs safely", () => {
  assert.equal(normalizeOpenRouterRoute("google-vertex/us-east5"), "google-vertex/us-east5");
  assert.equal(normalizeOpenRouterRoute(" Auto "), undefined);
  assert.equal(normalizeOpenRouterRoute("deep infra"), undefined);
});

test("maps route slugs to the provider names used by the model catalog", () => {
  assert.equal(getOpenRouterProviderName("google-vertex/us-east5"), "Google Vertex");
  assert.equal(getOpenRouterProviderName("deepseek"), "DeepSeek");
  assert.equal(getOpenRouterProviderName("custom-provider"), "custom-provider");
});

test("route-specific recommendations stay focused on the selected model family", () => {
  const models = getRecommendedOpenRouterModels(
    [
      {
        id: "deepseek/deepseek-chat-v4",
        name: "DeepSeek Chat V4",
        supported_parameters: ["tools"],
      },
      {
        id: "google/gemini-3.5-pro",
        name: "Gemini 3.5 Pro",
        supported_parameters: ["tools"],
      },
    ],
    "deepseek",
  );

  assert.deepEqual(models.map((model) => model.id), ["deepseek/deepseek-chat-v4"]);
});

test("fetches programming models from the selected OpenRouter provider", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestHeaders;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = init?.headers;
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await fetchOpenRouterModels("test-key", {
      providerRoute: "google-vertex/us-east5",
      programmingOnly: true,
      sort: "newest",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const url = new URL(requestUrl);
  assert.equal(url.searchParams.get("providers"), "Google Vertex");
  assert.equal(url.searchParams.get("category"), "programming");
  assert.equal(url.searchParams.get("supported_parameters"), "tools");
  assert.equal(url.searchParams.get("output_modalities"), "text");
  assert.equal(url.searchParams.get("sort"), "newest");
  assert.equal(requestHeaders.Authorization, "Bearer test-key");
});
