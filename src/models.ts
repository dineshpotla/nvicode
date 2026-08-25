import type {
  ActiveModelLimits,
  ModelLimitsSource,
  ProviderId,
} from "./config.js";
import {
  getOpenRouterProviderName,
  normalizeOpenRouterRoute,
} from "./openrouter.js";

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  free?: boolean;
}

export const NVIDIA_CURATED_MODELS: ModelOption[] = [
  {
    id: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
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
    prefer: [/k2\.6/i, /k2\.5/i, /thinking/i, /instruct/i],
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
    prefer: [/5\.2/i, /5\.1/i, /5/i, /4\.7/i],
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
    id: "moonshotai/kimi-k2.6:free",
    label: "Kimi K2.6 (Free)",
    description: "Free OpenRouter Kimi endpoint for coding and agentic workflows.",
  },
  {
    id: "qwen/qwen3-coder:free",
    label: "Qwen3 Coder (Free)",
    description: "Free OpenRouter Qwen coding model.",
  },
  {
    id: "openai/gpt-oss-120b:free",
    label: "GPT-OSS 120B (Free)",
    description: "Free OpenRouter open-weight reasoning model.",
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron 3 Super 120B (Free)",
    description: "Free OpenRouter NVIDIA Nemotron model.",
  },
  {
    id: "google/gemma-4-31b-it:free",
    label: "Gemma 4 31B (Free)",
    description: "Free OpenRouter Gemma instruction model.",
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    label: "Llama 3.3 70B (Free)",
    description: "Free OpenRouter Llama instruction model.",
  },
  {
    id: "qwen/qwen3-next-80b-a3b-instruct:free",
    label: "Qwen3 Next 80B (Free)",
    description: "Free OpenRouter Qwen instruction model.",
  },
];

export const TOKENROUTER_CURATED_MODELS: ModelOption[] = [
  {
    id: "MiniMax-M3",
    label: "MiniMax M3",
    description: "TokenRouter MiniMax M3, 1M-context coding and agentic model.",
  },
];

export const GMICLOUD_CURATED_MODELS: ModelOption[] = [
  {
    id: "moonshotai/kimi-k3",
    label: "Kimi K3",
    description: "GMICLOUD Kimi K3 long-context coding model.",
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash-0731",
    label: "DeepSeek V4 Flash",
    description: "GMICLOUD DeepSeek V4 Flash coding and reasoning model.",
  },
  {
    id: "MiniMaxAI/MiniMax-M3",
    label: "MiniMax M3",
    description: "GMICLOUD MiniMax M3 long-context agentic model.",
  },
  {
    id: "Qwen/Qwen3.8-Max",
    label: "Qwen 3.8 Max",
    description: "GMICLOUD Qwen 3.8 flagship model.",
  },
  {
    id: "zai-org/GLM-5.1-FP8",
    label: "GLM 5.1 FP8",
    description: "GMICLOUD GLM 5.1 FP8 through the OpenAI-compatible endpoint.",
  },
];

export const CLINEPASS_CURATED_MODELS: ModelOption[] = [
  {
    id: "cline-pass/glm-5.2",
    label: "GLM 5.2 (ClinePass)",
    description: "ClinePass GLM 5.2 through the local Cline account.",
  },
  {
    id: "cline-pass/minimax-m3",
    label: "MiniMax M3 (ClinePass)",
    description: "ClinePass MiniMax M3 long-context coding model.",
  },
  {
    id: "cline-pass/kimi-k2.7-code",
    label: "Kimi K2.7 Code (ClinePass)",
    description: "ClinePass Kimi coding-focused model.",
  },
  {
    id: "cline-pass/qwen3.7-max",
    label: "Qwen3.7 Max (ClinePass)",
    description: "ClinePass Qwen flagship model.",
  },
  {
    id: "cline-pass/deepseek-v4-pro",
    label: "DeepSeek V4 Pro (ClinePass)",
    description: "ClinePass DeepSeek V4 Pro model.",
  },
];

export const XAI_CURATED_MODELS: ModelOption[] = [
  {
    id: "grok-4.5",
    label: "Grok 4.5",
    description: "xAI Grok 4.5 through the OpenAI-compatible API.",
  },
  {
    id: "grok-4",
    label: "Grok 4",
    description: "xAI Grok 4 through the OpenAI-compatible API.",
  },
  {
    id: "grok-code-fast-1",
    label: "Grok Code Fast 1",
    description: "xAI coding-focused fast model.",
  },
];

const MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_PROVIDERS_URL = "https://openrouter.ai/api/v1/providers";
const TOKENROUTER_MODELS_URL = "https://api.tokenrouter.com/v1/models";
const GMICLOUD_MODELS_URL = "https://api.gmi-serving.com/v1/models";
const XAI_MODELS_URL = "https://api.x.ai/v1/models";

export const fetchNvidiaModels = async (
  apiKey: string,
): Promise<RouterModelInfo[]> => {
  const response = await fetch(MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Unable to fetch NVIDIA models: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as {
    data?: RouterModelInfo[];
  };
  return body.data ?? [];
};

export const fetchAvailableModelIds = async (
  apiKey: string,
): Promise<Set<string>> => {
  const ids = new Set<string>();
  for (const model of await fetchNvidiaModels(apiKey)) {
    if (typeof model.id === "string" && model.id.length > 0) {
      ids.add(model.id);
    }
  }
  return ids;
};

export interface OpenRouterModelInfo {
  id?: string;
  canonical_slug?: string;
  name?: string;
  description?: string;
  created?: number;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  links?: {
    details?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
  supported_parameters?: string[];
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

export interface RouterModelInfo {
  id?: string;
  name?: string;
  description?: string;
  created?: number;
  owned_by?: string;
  context_length?: number;
  max_context_length?: number;
  max_model_len?: number;
  max_tokens?: number;
  max_output_tokens?: number;
  supported_parameters?: string[];
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface OpenRouterModelFamily {
  name: string;
  labelPrefix: string;
  description: string;
  match: RegExp;
  prefer: RegExp[];
}

const OPENROUTER_MODEL_FAMILIES: OpenRouterModelFamily[] = [
  {
    name: "Kimi",
    labelPrefix: "Kimi",
    description: "Top free Kimi model from OpenRouter.",
    match: /^(?:~)?moonshotai\/kimi/i,
    prefer: [/k2\.6/i, /k2\.5/i, /latest/i, /thinking/i],
  },
  {
    name: "Qwen",
    labelPrefix: "Qwen",
    description: "Top free Qwen coding model from OpenRouter.",
    match: /^qwen\/qwen/i,
    prefer: [/qwen3-coder/i, /qwen3-next/i, /qwen3\.7/i, /qwen3\.6/i, /qwen3/i],
  },
  {
    name: "GPT-OSS",
    labelPrefix: "GPT-OSS",
    description: "Top free GPT-OSS model from OpenRouter.",
    match: /^openai\/gpt-oss/i,
    prefer: [/120b/i, /20b/i],
  },
  {
    name: "Nemotron",
    labelPrefix: "Nemotron",
    description: "Top free NVIDIA Nemotron model from OpenRouter.",
    match: /^nvidia\/nemotron/i,
    prefer: [/super/i, /ultra/i, /nano-omni/i, /nano-30b/i],
  },
  {
    name: "Gemma",
    labelPrefix: "Gemma",
    description: "Top free Gemma model from OpenRouter.",
    match: /^google\/gemma/i,
    prefer: [/31b/i, /26b/i],
  },
  {
    name: "Llama",
    labelPrefix: "Llama",
    description: "Top free Llama-family model from OpenRouter.",
    match: /^(meta-llama\/llama|nousresearch\/hermes-3-llama)/i,
    prefer: [/3\.3-70b/i, /405b/i, /3\.2-3b/i],
  },
];

export interface OpenRouterModelQuery {
  providerRoute?: string;
  programmingOnly?: boolean;
  sort?: "top-weekly" | "newest" | "coding-high-to-low" | "agentic-high-to-low";
}

export const fetchOpenRouterModels = async (
  apiKey?: string,
  query: OpenRouterModelQuery = {},
): Promise<OpenRouterModelInfo[]> => {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const url = new URL(OPENROUTER_MODELS_URL);
  const route = normalizeOpenRouterRoute(query.providerRoute);
  if (route) {
    const providerName = getOpenRouterProviderName(route);
    url.searchParams.set("providers", providerName || route);
  }
  if (query.programmingOnly) {
    url.searchParams.set("category", "programming");
    url.searchParams.set("supported_parameters", "tools");
    url.searchParams.set("output_modalities", "text");
  }
  if (query.sort) {
    url.searchParams.set("sort", query.sort);
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(
      `Unable to fetch OpenRouter models: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as {
    data?: OpenRouterModelInfo[];
  };
  return body.data ?? [];
};

export const fetchOpenRouterProviderSlugs = async (
  apiKey: string,
): Promise<Set<string>> => {
  const response = await fetch(OPENROUTER_PROVIDERS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Unable to fetch OpenRouter providers: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as {
    data?: Array<{ slug?: string }>;
  };
  return new Set(
    (body.data ?? [])
      .map((provider) => provider.slug?.trim().toLowerCase())
      .filter((slug): slug is string => Boolean(slug)),
  );
};

export const fetchTokenRouterModelIds = async (
  apiKey: string,
): Promise<Set<string>> => {
  const ids = new Set<string>();
  for (const model of await fetchTokenRouterModels(apiKey)) {
    if (typeof model.id === "string" && model.id.length > 0) {
      ids.add(model.id);
    }
  }
  return ids;
};

export const fetchTokenRouterModels = async (
  apiKey: string,
): Promise<RouterModelInfo[]> => {
  const response = await fetch(TOKENROUTER_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Unable to fetch TokenRouter models: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as { data?: RouterModelInfo[] };
  return body.data ?? [];
};

export const fetchGmicloudModelIds = async (
  apiKey: string,
): Promise<Set<string>> => {
  const models = await fetchGmicloudModels(apiKey);
  return new Set(
    models
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
};

export const fetchGmicloudModels = async (
  apiKey: string,
): Promise<RouterModelInfo[]> => {
  const response = await fetch(GMICLOUD_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Unable to fetch GMICLOUD models: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as { data?: RouterModelInfo[] };
  return body.data ?? [];
};

export const fetchXaiModelIds = async (
  apiKey: string,
): Promise<Set<string>> => {
  const ids = new Set<string>();
  for (const model of await fetchXaiModels(apiKey)) {
    if (typeof model.id === "string" && model.id.length > 0) {
      ids.add(model.id);
    }
  }
  return ids;
};

export const fetchXaiModels = async (
  apiKey: string,
): Promise<RouterModelInfo[]> => {
  const response = await fetch(XAI_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Unable to fetch xAI models: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as { data?: RouterModelInfo[] };
  return body.data ?? [];
};

export interface ModelLimitSpec {
  contextWindowTokens: number;
  maxOutputTokens?: number;
  safeInputTokens?: number;
  source: ModelLimitsSource;
}

const modelSpec = (
  contextWindowTokens: number,
  maxOutputTokens?: number,
  safeInputTokens?: number,
): ModelLimitSpec => ({
  contextWindowTokens,
  maxOutputTokens,
  safeInputTokens,
  source: "model-spec",
});

export const getModelLimitSpec = (
  provider: ProviderId,
  model: string,
): ModelLimitSpec | undefined => {
  const id = model.toLowerCase();

  if (provider === "nvidia") {
    if (/^moonshotai\/kimi-k2\.6(?:$|-)/.test(id)) return modelSpec(262_144, 16_384);
    if (/^deepseek-ai\/deepseek-v4/.test(id)) return modelSpec(1_048_576, 16_384);
    if (/^z-ai\/glm-?5\.2/.test(id)) return modelSpec(1_000_000, 16_384);
    if (/^z-ai\/glm-?5/.test(id)) return modelSpec(202_752, 16_384);
    if (/^qwen\/qwen3-coder/.test(id)) return modelSpec(262_144, 16_384);
    if (/^qwen\/qwen2\.5-coder/.test(id)) return modelSpec(32_768, 8_192);
    if (/^mistralai\/codestral-22b/.test(id)) return modelSpec(32_768, 8_192);
  }

  if (provider === "tokenrouter") {
    if (/^(?:minimax[-/])?minimax-m3$/.test(id)) {
      // TokenRouter does not publish context metadata. Its MiniMax M3 route has
      // rejected carried Claude sessions above this tested input threshold.
      return modelSpec(1_048_576, undefined, 300_000);
    }
    if (/minimax-m2\.7/.test(id)) return modelSpec(204_800);
    if (/kimi-k2\.6/.test(id)) return modelSpec(262_144);
    if (/deepseek-v4/.test(id)) return modelSpec(1_048_576);
    if (/glm-?5\.2/.test(id)) return modelSpec(1_000_000);
    if (/qwen3\.(?:6|7)|qwen3-coder/.test(id)) return modelSpec(262_144);
  }

  if (provider === "gmicloud") {
    if (/minimax-m3/.test(id)) return modelSpec(1_048_576);
    if (/minimax-m2\.7/.test(id)) return modelSpec(196_608);
    if (/deepseek-v4/.test(id)) return modelSpec(1_048_576);
    if (/kimi-k3/.test(id)) return modelSpec(1_048_576);
    if (/kimi-k2\.[567]/.test(id)) return modelSpec(262_144);
    if (/glm-?5\.2/.test(id)) return modelSpec(1_000_000);
    if (/glm-?(?:5\.1|5|4\.7)/.test(id)) return modelSpec(202_752);
    if (/qwen3/.test(id)) return modelSpec(262_144);
  }

  if (provider === "clinepass") {
    if (/minimax-m3/.test(id)) return modelSpec(1_048_576);
    if (/deepseek-v4/.test(id)) return modelSpec(1_048_576);
    if (/glm-?5\.2/.test(id)) return modelSpec(1_000_000);
    if (/kimi-k2\.7/.test(id)) return modelSpec(262_144);
    if (/qwen3\.7/.test(id)) return modelSpec(262_144);
  }

  if (provider === "xai") {
    if (/^grok-4\.5(?:$|-)/.test(id)) return modelSpec(500_000);
    if (/^grok-4(?:$|-)/.test(id)) return modelSpec(256_000);
    if (/^grok-code-fast-1(?:$|-)/.test(id)) return modelSpec(256_000);
  }

  return undefined;
};

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;

const getReportedModelLimits = (
  model: OpenRouterModelInfo | RouterModelInfo | undefined,
): ModelLimitSpec | undefined => {
  if (!model) {
    return undefined;
  }

  const openRouter = model as OpenRouterModelInfo;
  const generic = model as RouterModelInfo;
  const contextWindowTokens =
    positiveInteger(openRouter.top_provider?.context_length) ||
    positiveInteger(generic.context_length) ||
    positiveInteger(generic.max_context_length) ||
    positiveInteger(generic.max_model_len);
  if (!contextWindowTokens) {
    return undefined;
  }

  return {
    contextWindowTokens,
    maxOutputTokens:
      positiveInteger(openRouter.top_provider?.max_completion_tokens) ||
      positiveInteger(generic.max_output_tokens) ||
      positiveInteger(generic.max_tokens),
    source: "router",
  };
};

const findModel = <T extends { id?: string }>(
  models: T[],
  model: string,
): T | undefined => {
  const exact = models.find((entry) => entry.id === model);
  if (exact) {
    return exact;
  }
  const normalized = model.toLowerCase();
  return models.find((entry) => entry.id?.toLowerCase() === normalized);
};

export const resolveModelLimits = async (
  provider: ProviderId,
  apiKey: string,
  model: string,
  openrouterRoute?: string,
): Promise<ActiveModelLimits | undefined> => {
  let resolved: ModelLimitSpec | undefined;

  try {
    if (provider === "openrouter") {
      const models = await fetchOpenRouterModels(apiKey, {
        providerRoute: openrouterRoute,
      });
      const direct = findModel(models, model);
      const canonical =
        direct || models.find((entry) => entry.canonical_slug === model);
      resolved = getReportedModelLimits(canonical);
    } else if (provider === "gmicloud" && apiKey) {
      resolved = getReportedModelLimits(
        findModel(await fetchGmicloudModels(apiKey), model),
      );
    }
  } catch {
    // A temporary catalog failure must not block launching a configured tool.
  }

  resolved ||= getModelLimitSpec(provider, model);
  if (!resolved) {
    return undefined;
  }

  return {
    provider,
    model,
    openrouterRoute:
      provider === "openrouter"
        ? normalizeOpenRouterRoute(openrouterRoute)
        : undefined,
    ...resolved,
    updatedAt: new Date().toISOString(),
  };
};

const formatModelNameToken = (part: string): string => {
  const normalized = part.toLowerCase();
  const brandNames: Record<string, string> = {
    deepseek: "DeepSeek",
    gpt: "GPT",
    glm: "GLM",
    kimi: "Kimi",
    llama: "Llama",
    oss: "OSS",
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
  family: { labelPrefix: string },
  id: string,
): string => {
  const modelName = (id.split("/").at(-1) || id).replace(/:free$/i, "");
  return `${family.labelPrefix}: ${titleCaseModelPart(modelName)}`;
};

const formatLiveModelLabel = (model: RouterModelInfo): string => {
  const id = model.id || "";
  return model.name?.trim() || titleCaseModelPart((id.split("/").at(-1) || id).replace(/:free$/i, ""));
};

const cleanModelDescription = (description: string | undefined): string => {
  const normalized = description?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Live model from the provider catalog.";
  }
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
};

const isLikelyNonChatModel = (id: string): boolean =>
  /(?:embedding|rerank|moderation|whisper|transcri(?:be|ption)|text-to-speech|tts|image-generation)/i.test(
    id,
  );

const isFreeRouterModel = (model: RouterModelInfo): boolean | undefined => {
  if (model.id?.endsWith(":free")) {
    return true;
  }
  const prompt = Number(model.pricing?.prompt ?? Number.NaN);
  const completion = Number(model.pricing?.completion ?? Number.NaN);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) {
    return undefined;
  }
  return prompt === 0 && completion === 0;
};

const getLiveModelOption = (model: RouterModelInfo): ModelOption | null => {
  const id = model.id?.trim();
  if (!id || isLikelyNonChatModel(id)) {
    return null;
  }
  if (
    Array.isArray(model.supported_parameters) &&
    model.supported_parameters.length > 0 &&
    !model.supported_parameters.includes("tools")
  ) {
    return null;
  }

  const limits = getReportedModelLimits(model);
  return {
    id,
    label: formatLiveModelLabel({ ...model, id }),
    description: cleanModelDescription(model.description),
    contextWindowTokens: limits?.contextWindowTokens,
    maxOutputTokens: limits?.maxOutputTokens,
    free: isFreeRouterModel(model),
  };
};

const sortLiveRouterModels = (
  left: { model: RouterModelInfo; index: number },
  right: { model: RouterModelInfo; index: number },
): number => {
  const leftId = left.model.id || "";
  const rightId = right.model.id || "";
  const leftCoding = /(?:code|coder|coding|agent|instruct|reason|thinking|kimi|deepseek|glm|qwen)/i.test(leftId);
  const rightCoding = /(?:code|coder|coding|agent|instruct|reason|thinking|kimi|deepseek|glm|qwen)/i.test(rightId);
  if (leftCoding !== rightCoding) {
    return rightCoding ? 1 : -1;
  }
  const createdDelta = (right.model.created || 0) - (left.model.created || 0);
  return createdDelta || left.index - right.index;
};

const getRecommendedLiveRouterModels = (
  models: RouterModelInfo[],
  fallback: ModelOption[],
): ModelOption[] => {
  const live = models
    .map((model, index) => ({ model, index, option: getLiveModelOption(model) }))
    .filter((entry): entry is { model: RouterModelInfo; index: number; option: ModelOption } =>
      Boolean(entry.option),
    )
    .sort(sortLiveRouterModels)
    .map((entry) => entry.option);

  return live.length > 0 ? live.slice(0, 30) : fallback;
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

const isFreeOpenRouterModel = (model: OpenRouterModelInfo): boolean => {
  if (model.id?.endsWith(":free")) {
    return true;
  }
  const prompt = Number(model.pricing?.prompt ?? Number.NaN);
  const completion = Number(model.pricing?.completion ?? Number.NaN);
  return prompt === 0 && completion === 0;
};

const supportsToolCalling = (model: OpenRouterModelInfo): boolean =>
  Array.isArray(model.supported_parameters) &&
  model.supported_parameters.includes("tools");

const scoreOpenRouterFamilyModel = (
  family: OpenRouterModelFamily,
  model: OpenRouterModelInfo,
): number => {
  const id = model.id || "";
  const idWithoutDates = id.replace(/\b20\d{6}\b/g, "");
  let score = getVersionScore(idWithoutDates);

  family.prefer.forEach((pattern, index) => {
    if (pattern.test(id)) {
      score += (family.prefer.length - index) * 1000;
    }
  });

  if (isFreeOpenRouterModel(model)) {
    score += 500;
  }
  if (/preview|beta|experimental/i.test(id)) {
    score -= 10;
  }
  if (id.startsWith("~")) {
    score -= 100;
  }

  return score;
};

const pickOpenRouterFamilyModel = (
  family: OpenRouterModelFamily,
  models: OpenRouterModelInfo[],
): ModelOption | null => {
  const candidates = models.filter((model) => {
    const id = model.id || "";
    return family.match.test(id);
  });
  if (candidates.length === 0) {
    return null;
  }

  const [best] = candidates.sort((left, right) => {
    const scoreDelta =
      scoreOpenRouterFamilyModel(family, right) -
      scoreOpenRouterFamilyModel(family, left);
    return (
      scoreDelta ||
      (right.id || "").localeCompare(left.id || "", undefined, {
        numeric: true,
      })
    );
  });
  if (!best?.id) {
    return null;
  }

  const freeLabel = isFreeOpenRouterModel(best) ? " (Free)" : "";
  return {
    id: best.id,
    label: `${formatDynamicLabel(family, best.id)}${freeLabel}`,
    description: family.description,
  };
};

export const getRecommendedNvidiaModels = (available: Set<string>): ModelOption[] => {
  const ids = [...available];
  const picked = NVIDIA_MODEL_FAMILIES
    .map((family) => pickFamilyModel(family, ids))
    .filter((model): model is ModelOption => Boolean(model));
  const seen = new Set(picked.map((model) => model.id));
  const fallback = NVIDIA_CURATED_MODELS.filter((model) => available.has(model.id) && !seen.has(model.id));
  return [...picked, ...fallback];
};

export const getRecommendedOpenRouterModels = (
  models: OpenRouterModelInfo[],
  providerRoute?: string,
): ModelOption[] => {
  const route = normalizeOpenRouterRoute(providerRoute);
  if (route) {
    const routeBase = route.split("/", 1)[0];
    const routeFamily =
      routeBase === "deepseek"
        ? /^deepseek\//i
        : routeBase === "google-vertex" || routeBase === "google-ai-studio"
          ? /^google\//i
          : routeBase === "openai"
            ? /^openai\//i
            : routeBase === "anthropic"
              ? /^anthropic\//i
              : routeBase === "minimax"
                ? /^(?:minimax|minimaxai)\//i
                : routeBase === "nvidia"
                  ? /^nvidia\//i
                  : undefined;
    const toolModels = models.filter(supportsToolCalling);
    const compatibleModels = (toolModels.length > 0 ? toolModels : models).filter((model) => {
      const id = model.id || "";
      return id.length > 0 && !isLikelyNonChatModel(id);
    });
    const focusedModels = routeFamily
      ? compatibleModels.filter((model) => routeFamily.test(model.id || ""))
      : [];
    const selectedModels = focusedModels.length > 0 ? focusedModels : compatibleModels;
    const routeName = getOpenRouterProviderName(route) || route;
    const live = selectedModels.map((model) => {
      const limits = getReportedModelLimits(model);
      const id = model.id || "";
      const free = isFreeOpenRouterModel(model);
      return {
        id,
        label: `${model.name?.trim() || titleCaseModelPart((id.split("/").at(-1) || id).replace(/:free$/i, ""))}${free ? " (Free)" : ""}`,
        description:
          cleanModelDescription(model.description) === "Live model from the provider catalog."
            ? `${routeName}-hosted coding model through OpenRouter.`
            : cleanModelDescription(model.description),
        contextWindowTokens: limits?.contextWindowTokens,
        maxOutputTokens: limits?.maxOutputTokens,
        free,
      } satisfies ModelOption;
    });
    return live.slice(0, 30);
  }

  const freeModels = models.filter(
    (model) => isFreeOpenRouterModel(model) && supportsToolCalling(model),
  );
  const picked = OPENROUTER_MODEL_FAMILIES
    .map((family) => pickOpenRouterFamilyModel(family, freeModels))
    .filter((model): model is ModelOption => Boolean(model));
  const seen = new Set(picked.map((model) => model.id));
  const available = new Set(
    freeModels
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const fallback = OPENROUTER_CURATED_MODELS.filter(
    (model) => available.has(model.id) && !seen.has(model.id),
  );
  return [...picked, ...fallback];
};

export const getRecommendedTokenRouterModels = (
  available: Set<string>,
): ModelOption[] => {
  const seen = new Set<string>();
  const models = TOKENROUTER_CURATED_MODELS.filter((model) => {
    if (seen.has(model.id) || !available.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });

  if (models.length > 0) {
    return models;
  }

  return TOKENROUTER_CURATED_MODELS;
};

export const getRecommendedGmicloudModels = (
  available: Set<string>,
): ModelOption[] => {
  const seen = new Set<string>();
  const models = GMICLOUD_CURATED_MODELS.filter((model) => {
    if (seen.has(model.id) || !available.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });

  if (models.length > 0) {
    return models;
  }

  return GMICLOUD_CURATED_MODELS;
};

export const getRecommendedXaiModels = (
  available: Set<string>,
): ModelOption[] => {
  const seen = new Set<string>();
  const models = XAI_CURATED_MODELS.filter((model) => {
    if (seen.has(model.id) || !available.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });

  if (models.length > 0) {
    return models;
  }

  return XAI_CURATED_MODELS;
};

export const getRecommendedModels = async (
  provider: ProviderId,
  apiKey: string,
  openrouterRoute?: string,
): Promise<ModelOption[]> => {
  if (provider === "clinepass") {
    return CLINEPASS_CURATED_MODELS;
  }

  if (provider === "openrouter") {
    try {
      const route = normalizeOpenRouterRoute(openrouterRoute);
      const available = await fetchOpenRouterModels(apiKey || undefined, {
        providerRoute: route,
        programmingOnly: true,
        sort: route ? "newest" : "top-weekly",
      });
      const dynamic = getRecommendedOpenRouterModels(available, route);
      return dynamic.length > 0 ? dynamic : OPENROUTER_CURATED_MODELS;
    } catch {
      return OPENROUTER_CURATED_MODELS;
    }
  }

  if (provider === "tokenrouter") {
    try {
      const available = await fetchTokenRouterModels(apiKey);
      return getRecommendedLiveRouterModels(available, TOKENROUTER_CURATED_MODELS);
    } catch {
      return TOKENROUTER_CURATED_MODELS;
    }
  }

  if (provider === "gmicloud") {
    try {
      const available = await fetchGmicloudModels(apiKey);
      return getRecommendedLiveRouterModels(available, GMICLOUD_CURATED_MODELS);
    } catch {
      return GMICLOUD_CURATED_MODELS;
    }
  }

  if (provider === "xai") {
    try {
      const available = await fetchXaiModels(apiKey);
      return getRecommendedLiveRouterModels(available, XAI_CURATED_MODELS);
    } catch {
      return XAI_CURATED_MODELS;
    }
  }

  try {
    const available = await fetchNvidiaModels(apiKey);
    const dynamic = getRecommendedLiveRouterModels(available, NVIDIA_CURATED_MODELS);
    return dynamic.length > 0 ? dynamic : NVIDIA_CURATED_MODELS;
  } catch {
    return NVIDIA_CURATED_MODELS;
  }
};
