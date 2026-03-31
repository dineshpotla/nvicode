import type { ProviderId } from "./config.js";

export interface ModelOption {
  id: string;
  label: string;
  description: string;
}

export const NVIDIA_CURATED_MODELS: ModelOption[] = [
  {
    id: "moonshotai/kimi-k2.5",
    label: "Kimi K2.5",
    description: "Strong coding and agentic workflow model.",
  },
  {
    id: "qwen/qwen3-coder-480b-a35b-instruct",
    label: "Qwen3 Coder 480B",
    description: "Large coding-focused Qwen model.",
  },
  {
    id: "z-ai/glm5",
    label: "GLM5",
    description: "General purpose reasoning model with code capability.",
  },
  {
    id: "deepseek-ai/deepseek-v3.2",
    label: "DeepSeek V3.2",
    description: "General coding and reasoning model.",
  },
  {
    id: "mistralai/codestral-22b-instruct-v0.1",
    label: "Codestral 22B",
    description: "Compact coding-specialized model.",
  },
  {
    id: "qwen/qwen2.5-coder-32b-instruct",
    label: "Qwen2.5 Coder 32B",
    description: "Smaller coding-focused Qwen model.",
  },
];

export const OPENROUTER_CURATED_MODELS: ModelOption[] = [
  {
    id: "qwen/qwen3.6-plus-preview:free",
    label: "Qwen 3.6 Plus Preview (Free)",
    description: "Free OpenRouter Qwen preview model.",
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    label: "Claude Sonnet 4.6",
    description: "Recommended OpenRouter model for Claude Code compatibility.",
  },
  {
    id: "anthropic/claude-opus-4.6",
    label: "Claude Opus 4.6",
    description: "Higher-end Anthropic model through OpenRouter.",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    description: "Faster lower-cost Anthropic model through OpenRouter.",
  },
];

const MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

export const fetchAvailableModelIds = async (
  apiKey: string,
): Promise<Set<string>> => {
  const response = await fetch(MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Unable to fetch NVIDIA models: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as {
    data?: Array<{ id?: string }>;
  };

  const ids = new Set<string>();
  for (const model of body.data ?? []) {
    if (typeof model.id === "string" && model.id.length > 0) {
      ids.add(model.id);
    }
  }
  return ids;
};

export const getRecommendedModels = async (
  provider: ProviderId,
  apiKey: string,
): Promise<ModelOption[]> => {
  if (provider === "openrouter") {
    return OPENROUTER_CURATED_MODELS;
  }

  try {
    const available = await fetchAvailableModelIds(apiKey);
    const curated = NVIDIA_CURATED_MODELS.filter((model) => available.has(model.id));
    return curated.length > 0 ? curated : NVIDIA_CURATED_MODELS;
  } catch {
    return NVIDIA_CURATED_MODELS;
  }
};
