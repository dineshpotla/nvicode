export interface OpenRouterProviderRoute {
  slug: string;
  label: string;
  description: string;
}

// These are the top provider routes surfaced by OpenRouter's provider usage page.
// The slugs are sent to OpenRouter; labels are only for the interactive CLI.
export const OPENROUTER_PROVIDER_ROUTES: readonly OpenRouterProviderRoute[] = [
  {
    slug: "tencent",
    label: "Tencent Cloud",
    description: "Tencent-hosted models through OpenRouter.",
  },
  {
    slug: "openai",
    label: "OpenAI",
    description: "OpenAI-hosted models through OpenRouter.",
  },
  {
    slug: "novita",
    label: "NovitaAI",
    description: "Novita-hosted open models through OpenRouter.",
  },
  {
    slug: "google-vertex",
    label: "Google Vertex",
    description: "Google Vertex-hosted models through OpenRouter.",
  },
  {
    slug: "deepinfra",
    label: "DeepInfra",
    description: "DeepInfra-hosted open models through OpenRouter.",
  },
  {
    slug: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek-hosted models through OpenRouter.",
  },
  {
    slug: "xiaomi",
    label: "Xiaomi",
    description: "Xiaomi-hosted models through OpenRouter.",
  },
  {
    slug: "amazon-bedrock",
    label: "Amazon Bedrock",
    description: "Amazon Bedrock-hosted models through OpenRouter.",
  },
  {
    slug: "nvidia",
    label: "NVIDIA",
    description: "NVIDIA-hosted models through OpenRouter.",
  },
  {
    slug: "coreweave",
    label: "CoreWeave",
    description: "CoreWeave-hosted models through OpenRouter.",
  },
  {
    slug: "gmicloud",
    label: "GMICloud",
    description: "GMICloud-hosted models through OpenRouter.",
  },
  {
    slug: "anthropic",
    label: "Anthropic",
    description: "Anthropic-hosted models through OpenRouter.",
  },
  {
    slug: "streamlake",
    label: "StreamLake",
    description: "StreamLake-hosted models through OpenRouter.",
  },
  {
    slug: "poolside",
    label: "Poolside",
    description: "Poolside-hosted models through OpenRouter.",
  },
  {
    slug: "alibaba",
    label: "Alibaba Cloud Int.",
    description: "Alibaba Cloud-hosted models through OpenRouter.",
  },
  {
    slug: "google-ai-studio",
    label: "Google AI Studio",
    description: "Google AI Studio-hosted models through OpenRouter.",
  },
  {
    slug: "minimax",
    label: "MiniMax",
    description: "MiniMax-hosted models through OpenRouter.",
  },
  {
    slug: "siliconflow",
    label: "SiliconFlow",
    description: "SiliconFlow-hosted models through OpenRouter.",
  },
  {
    slug: "stepfun",
    label: "StepFun",
    description: "StepFun-hosted models through OpenRouter.",
  },
  {
    slug: "baidu-qianfan",
    label: "Baidu Qianfan",
    description: "Baidu Qianfan-hosted models through OpenRouter.",
  },
];

const routeBySlug = new Map(
  OPENROUTER_PROVIDER_ROUTES.map((route) => [route.slug, route]),
);

export const normalizeOpenRouterRoute = (
  value: string | undefined,
): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "auto" || normalized === "default") {
    return undefined;
  }

  // OpenRouter also exposes endpoint variants such as `google-vertex/us-east5`.
  // Keep accepting those exact slugs while rejecting whitespace and control data.
  return /^[a-z0-9][a-z0-9._/-]{0,119}$/.test(normalized)
    ? normalized
    : undefined;
};

export const getOpenRouterProviderRoute = (
  slug: string | undefined,
): OpenRouterProviderRoute | undefined => {
  const normalized = normalizeOpenRouterRoute(slug);
  if (!normalized) {
    return undefined;
  }
  const baseSlug = normalized.split("/", 1)[0] || normalized;
  return routeBySlug.get(baseSlug);
};

/**
 * OpenRouter's model catalog filters by the provider's display name, while
 * request routing uses the provider slug. Keep that translation in one place.
 */
export const getOpenRouterProviderName = (slug: string | undefined): string | undefined => {
  const normalized = normalizeOpenRouterRoute(slug);
  if (!normalized) {
    return undefined;
  }

  return getOpenRouterProviderRoute(normalized)?.label || normalized.split("/", 1)[0] || normalized;
};

export const getOpenRouterProviderPreferences = (
  slug: string | undefined,
): Record<string, unknown> | undefined => {
  const route = normalizeOpenRouterRoute(slug);
  if (!route) {
    return undefined;
  }

  return {
    order: [route],
    only: [route],
    allow_fallbacks: false,
  };
};
