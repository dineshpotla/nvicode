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
    id: "deepseek-ai/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "Responsive DeepSeek V4-family model.",
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

interface NvidiaModelFamily {
  name: string;
  labelPrefix: string;
  description: string;
  match: RegExp;
  prefer: RegExp[];
}

const NVIDIA_MODEL_FAMILIES: NvidiaModelFamily[] = [
  {
    name: "Kimi",
    labelPrefix: "Kimi",
    description: "Latest available Kimi model from NVIDIA.",
    match: /^moonshotai\/kimi/i,
    prefer: [/k2\.5/i, /thinking/i, /instruct/i],
  },
  {
    name: "DeepSeek",
    labelPrefix: "DeepSeek",
    description: "Latest available DeepSeek model from NVIDIA.",
    match: /^deepseek-ai\/deepseek/i,
    prefer: [/v4-flash/i, /v4-pro/i, /v4/i, /v3\.2/i, /coder/i],
  },
  {
    name: "GLM",
    labelPrefix: "GLM",
    description: "Latest available GLM model from NVIDIA.",
    match: /^z-ai\/glm/i,
    prefer: [/5\.1/i, /5/i, /4\.7/i],
  },
  {
    name: "Qwen",
    labelPrefix: "Qwen",
    description: "Latest available Qwen coding model from NVIDIA.",
    match: /^qwen\/qwen/i,
    prefer: [/qwen3-coder/i, /qwen3\.5/i, /qwen3-next/i, /qwen3/i, /qwen2\.5-coder/i],
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

const formatModelNameToken = (part: string): string => {
  const normalized = part.toLowerCase();
  const brandNames: Record<string, string> = {
    deepseek: "DeepSeek",
    glm: "GLM",
    kimi: "Kimi",
    qwen: "Qwen",
  };
  if (brandNames[normalized]) {
    return brandNames[normalized];
  }
  if (/^[vk]\d/i.test(part) || /^\d+b$/i.test(part) || /^a\d+b$/i.test(part)) {
    return part.toUpperCase();
  }
  return part.charAt(0).toUpperCase() + part.slice(1);
};

const titleCaseModelPart = (value: string): string =>
  value
    .split(/[-_]/)
    .filter(Boolean)
    .map(formatModelNameToken)
    .join(" ");

const formatDynamicLabel = (
  family: NvidiaModelFamily,
  id: string,
): string => {
  const modelName = id.split("/").at(-1) || id;
  return `${family.labelPrefix}: ${titleCaseModelPart(modelName)}`;
};

const getVersionScore = (id: string): number => {
  const versionNumbers = [...id.matchAll(/\d+(?:\.\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
  if (versionNumbers.length === 0) {
    return 0;
  }
  return Math.max(...versionNumbers);
};

const scoreFamilyModel = (
  family: NvidiaModelFamily,
  id: string,
): number => {
  let score = getVersionScore(id);
  family.prefer.forEach((pattern, index) => {
    if (pattern.test(id)) {
      score += (family.prefer.length - index) * 1000;
    }
  });
  if (/preview|beta|experimental/i.test(id)) {
    score -= 10;
  }
  return score;
};

const pickFamilyModel = (
  family: NvidiaModelFamily,
  ids: string[],
): ModelOption | null => {
  const candidates = ids.filter((id) => family.match.test(id));
  if (candidates.length === 0) {
    return null;
  }

  const [best] = candidates.sort((left, right) => {
    const scoreDelta = scoreFamilyModel(family, right) - scoreFamilyModel(family, left);
    return scoreDelta || right.localeCompare(left, undefined, { numeric: true });
  });
  if (!best) {
    return null;
  }

  return {
    id: best,
    label: formatDynamicLabel(family, best),
    description: family.description,
  };
};

const getDynamicNvidiaModels = (available: Set<string>): ModelOption[] => {
  const ids = [...available];
  const picked = NVIDIA_MODEL_FAMILIES
    .map((family) => pickFamilyModel(family, ids))
    .filter((model): model is ModelOption => Boolean(model));
  const seen = new Set(picked.map((model) => model.id));
  const fallback = NVIDIA_CURATED_MODELS.filter((model) => available.has(model.id) && !seen.has(model.id));
  return [...picked, ...fallback];
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
    const dynamic = getDynamicNvidiaModels(available);
    return dynamic.length > 0 ? dynamic : NVIDIA_CURATED_MODELS;
  } catch {
    return NVIDIA_CURATED_MODELS;
  }
};
