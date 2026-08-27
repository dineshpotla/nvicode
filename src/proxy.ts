import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendUsageRecord,
  buildUsageRecord,
  getPricingSnapshot,
} from "./usage.js";
import {
  getActiveApiKey,
  getActiveModel,
  getActiveModelLimits,
  type NvicodeConfig,
} from "./config.js";
import { NVICODE_CLAUDE_DESKTOP_GATEWAY_MODEL_ID } from "./claude-desktop.js";
import { getOpenRouterProviderPreferences } from "./openrouter.js";

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicImageBlock {
  type: "image";
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
  };
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: unknown;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicTextBlock[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: unknown;
}

interface OpenAITextPart {
  type: "text";
  text: string;
}

interface OpenAIImagePart {
  type: "image_url";
  image_url: {
    url: string;
  };
}

type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIChoice {
  finish_reason?: string | null;
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
    tool_calls?: Array<{
      id?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
    reasoning?: string;
  };
}

interface OpenAIResponse {
  id?: string;
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface ClineAuth {
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  expiresAt?: number;
}

interface ClineTextBlock {
  type: "text";
  text: string;
}

interface ClineImageBlock {
  type: "image";
  data: string;
  mediaType: string;
}

interface ClineToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ClineToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  name: string;
  content: string;
  is_error?: boolean;
}

type ClineContentBlock =
  | ClineTextBlock
  | ClineImageBlock
  | ClineToolUseBlock
  | ClineToolResultBlock;

interface ClineMessage {
  role: "user" | "assistant";
  content: string | ClineContentBlock[];
}

interface ClineToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ClineStreamChunk =
  | { type: "text"; text: string; id?: string }
  | { type: "reasoning"; reasoning: string; id?: string }
  | {
      type: "tool_calls";
      id?: string;
      tool_call: {
        call_id?: string;
        function: {
          id?: string;
          name?: string;
          arguments?: string | Record<string, unknown>;
        };
      };
    }
  | {
      type: "usage";
      id?: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: "done";
      id?: string;
      success: boolean;
      error?: string;
      incompleteReason?: string;
    };

interface ClineApiHandler {
  createMessage(
    systemPrompt: string,
    messages: ClineMessage[],
    tools?: ClineToolDefinition[],
  ): AsyncGenerator<ClineStreamChunk>;
}

interface ClineLlmsModule {
  createHandler(config: Record<string, unknown>): ClineApiHandler;
}

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TOKENROUTER_URL = "https://api.tokenrouter.com/v1/chat/completions";
const GMICLOUD_URL = "https://api.gmi-serving.com/v1/chat/completions";
const XAI_URL = "https://api.x.ai/v1/chat/completions";
const GROK_CLI_PROXY_URL = "https://cli-chat-proxy.grok.com/v1/chat/completions";
const DEFAULT_RETRY_DELAY_MS = 2_000;
const MAX_UPSTREAM_RETRIES = 3;
const UPSTREAM_TIMEOUT_MS = 240_000;
const PROXY_PROTOCOL_VERSION = 11;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const CONTEXT_ESTIMATE_SAFETY_RATIO = 0.95;

class UpstreamHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(`Upstream API HTTP ${statusCode}: ${body}`);
  }
}

const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const getEnvPositiveInteger = (name: string): number | null => {
  const value = process.env[name];
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const fetchWithTimeout = async (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`Upstream API timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const parseRetryAfterMs = (value: string | null): number | null => {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.max(0, timestamp - Date.now());
};

const createRequestScheduler = (maxRequestsPerMinute: number) => {
  const intervalMs = Math.max(1, Math.ceil(60_000 / maxRequestsPerMinute));
  let nextAvailableAt = 0;
  let queue = Promise.resolve();

  return async <T>(task: () => Promise<T>): Promise<T> => {
    const runTask = async (): Promise<T> => {
      const now = Date.now();
      const scheduledAt = Math.max(now, nextAvailableAt);
      nextAvailableAt = scheduledAt + intervalMs;
      await sleep(scheduledAt - now);
      return task();
    };

    const result = queue.then(runTask, runTask);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
};

const createProviderScheduler = (
  config: NvicodeConfig,
): (<T>(task: () => Promise<T>) => Promise<T>) => {
  if (config.provider !== "nvidia") {
    return async <T>(task: () => Promise<T>): Promise<T> => task();
  }
  return createRequestScheduler(config.maxRequestsPerMinute);
};

const execFileAsync = (
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeout,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

let clineLlmsModulePromise: Promise<ClineLlmsModule> | null = null;

const loadClineLlmsModule = async (): Promise<ClineLlmsModule> => {
  if (!clineLlmsModulePromise) {
    clineLlmsModulePromise = (async () => {
      const candidates = [
        process.env.NVICODE_CLINE_LLMS_MODULE,
        path.join(
          os.homedir(),
          ".npm-global",
          "lib",
          "node_modules",
          "cline",
          "node_modules",
          "@cline",
          "llms",
          "dist",
          "index.js",
        ),
        "/opt/homebrew/lib/node_modules/cline/node_modules/@cline/llms/dist/index.js",
        "/usr/local/lib/node_modules/cline/node_modules/@cline/llms/dist/index.js",
      ].filter((entry): entry is string => Boolean(entry));

      for (const candidate of candidates) {
        if (await pathExists(candidate)) {
          return await import(pathToFileURL(candidate).href) as ClineLlmsModule;
        }
      }

      throw new Error(
        "Unable to locate Cline's @cline/llms module. Install the Cline CLI or set NVICODE_CLINE_LLMS_MODULE.",
      );
    })();
  }

  return clineLlmsModulePromise;
};

const clineProvidersFile = (): string =>
  path.join(os.homedir(), ".cline", "data", "settings", "providers.json");

const readClineAuthCandidates = async (): Promise<ClineAuth[]> => {
  const raw = await fs.readFile(clineProvidersFile(), "utf8");
  const parsed = JSON.parse(raw) as {
    providers?: Record<string, { settings?: { auth?: ClineAuth } }>;
  };

  return ["cline", "cline-pass"]
    .map((provider) => parsed.providers?.[provider]?.settings?.auth)
    .filter((auth): auth is ClineAuth =>
      Boolean(auth?.accessToken && auth.accountId),
    );
};

const isClineAuthFresh = (auth: ClineAuth): boolean =>
  typeof auth.expiresAt === "number" && auth.expiresAt > Date.now() + 60_000;

const chooseBestClineAuth = (candidates: ClineAuth[]): ClineAuth | null => {
  if (candidates.length === 0) {
    return null;
  }

  const fresh = candidates
    .filter(isClineAuthFresh)
    .sort((left, right) => (right.expiresAt ?? 0) - (left.expiresAt ?? 0));
  if (fresh[0]) {
    return fresh[0];
  }

  return [...candidates].sort(
    (left, right) => (right.expiresAt ?? 0) - (left.expiresAt ?? 0),
  )[0] ?? null;
};

const refreshClineAuth = async (model: string): Promise<void> => {
  const clineBinary = process.env.NVICODE_CLINE_CLI_PATH || "cline";
  await execFileAsync(
    clineBinary,
    [
      "--json",
      "-P",
      "cline-pass",
      "-m",
      model,
      "--auto-approve",
      "false",
      "--timeout",
      "60",
      "Reply exactly NVICODE_CLINE_AUTH_OK.",
    ],
    { cwd: os.homedir(), timeout: 90_000 },
  );
};

const getClineAuth = async (model: string): Promise<ClineAuth> => {
  let auth = chooseBestClineAuth(await readClineAuthCandidates());
  if (auth && isClineAuthFresh(auth)) {
    return auth;
  }

  await refreshClineAuth(model);
  auth = chooseBestClineAuth(await readClineAuthCandidates());
  if (!auth?.accessToken || !auth.accountId) {
    throw new Error(
      "ClinePass auth is not available. Run `cline auth cline-pass -m cline-pass/glm-5.2` or sign in to Cline first.",
    );
  }
  return auth;
};

const grokAuthFile = (): string => path.join(os.homedir(), ".grok", "auth.json");

const readGrokCliToken = async (): Promise<string> => {
  const raw = await fs.readFile(grokAuthFile(), "utf8");
  const parsed = JSON.parse(raw) as Record<string, { key?: string }>;
  const auth =
    parsed["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"] ??
    parsed["https://accounts.x.ai/sign-in"];
  if (!auth?.key) {
    throw new Error("Grok CLI auth token is missing. Run `grok login` first.");
  }
  return auth.key;
};

const resolveGrokBinary = async (): Promise<string> => {
  const candidates = [
    process.env.NVICODE_GROK_CLI_PATH,
    path.join(os.homedir(), ".grok", "bin", "grok"),
    "grok",
  ].filter((entry): entry is string => Boolean(entry));

  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      if (await pathExists(candidate)) {
        return candidate;
      }
      continue;
    }
    return candidate;
  }

  return "grok";
};

let grokClientVersionPromise: Promise<string> | null = null;

const getGrokClientVersion = async (): Promise<string> => {
  if (!grokClientVersionPromise) {
    grokClientVersionPromise = (async () => {
      const grokBinary = await resolveGrokBinary();
      try {
        const { stdout } = await execFileAsync(grokBinary, ["--version"], {
          cwd: os.homedir(),
          timeout: 10_000,
        });
        const match = /grok\s+([0-9]+\.[0-9]+\.[0-9]+)/i.exec(stdout);
        if (match?.[1]) {
          return match[1];
        }
      } catch {
        // Fall back to the installed version from this turn.
      }
      return "0.2.93";
    })();
  }
  return grokClientVersionPromise;
};

const refreshGrokCliAuth = async (): Promise<void> => {
  const grokBinary = await resolveGrokBinary();
  await execFileAsync(grokBinary, ["models"], {
    cwd: os.homedir(),
    timeout: 60_000,
  });
};

const parseOpenAiSseResponse = (raw: string): OpenAIResponse => {
  const responseId = `chatcmpl_${randomUUID()}`;
  let id = responseId;
  let content = "";
  let reasoning = "";
  let finishReason: string | null | undefined = "stop";
  let promptTokens = 0;
  let completionTokens = 0;
  const toolCalls = new Map<number, {
    id: string;
    name: string;
    arguments: string;
  }>();

  const appendToolCall = (
    index: number,
    update: {
      id?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    },
  ): void => {
    const current = toolCalls.get(index) ?? {
      id: update.id || `call_${randomUUID()}`,
      name: "",
      arguments: "",
    };
    toolCalls.set(index, {
      id: update.id || current.id,
      name: update.function?.name || current.name,
      arguments: `${current.arguments}${update.function?.arguments || ""}`,
    });
  };

  const consumeJson = (json: unknown): void => {
    const chunk = json as {
      id?: string;
      choices?: Array<{
        finish_reason?: string | null;
        delta?: {
          content?: string;
          reasoning?: string;
          reasoning_content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
        message?: {
          content?: string;
          reasoning?: string;
          tool_calls?: Array<{
            id?: string;
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };

    if (chunk.id) {
      id = chunk.id;
    }
    if (typeof chunk.usage?.prompt_tokens === "number") {
      promptTokens = chunk.usage.prompt_tokens;
    }
    if (typeof chunk.usage?.completion_tokens === "number") {
      completionTokens = chunk.usage.completion_tokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      return;
    }
    finishReason = choice.finish_reason ?? finishReason;
    if (typeof choice.delta?.content === "string") {
      content += choice.delta.content;
    }
    if (typeof choice.delta?.reasoning === "string") {
      reasoning += choice.delta.reasoning;
    }
    if (typeof choice.delta?.reasoning_content === "string") {
      reasoning += choice.delta.reasoning_content;
    }
    if (typeof choice.message?.content === "string") {
      content += choice.message.content;
    }
    if (typeof choice.message?.reasoning === "string") {
      reasoning += choice.message.reasoning;
    }

    for (const toolCall of choice.delta?.tool_calls ?? []) {
      appendToolCall(toolCall.index ?? 0, toolCall);
    }
    choice.message?.tool_calls?.forEach((toolCall, index) => {
      appendToolCall(index, toolCall);
    });
  };

  const dataEntries = raw
    .split(/\n\n+/)
    .flatMap((event) =>
      event
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace(/^data:\s*/, "").trim()),
    )
    .filter(Boolean);

  if (dataEntries.length === 0) {
    consumeJson(JSON.parse(raw));
  } else {
    for (const entry of dataEntries) {
      if (entry === "[DONE]") {
        continue;
      }
      consumeJson(JSON.parse(entry));
    }
  }

  const toolCallList = [...toolCalls.values()]
    .filter((toolCall) => toolCall.name)
    .map((toolCall) => ({
      id: toolCall.id,
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments || "{}",
      },
    }));

  return {
    id,
    choices: [
      {
        finish_reason: toolCallList.length > 0 ? "tool_calls" : finishReason,
        message: {
          content: content || stripThinkingTags(reasoning),
          ...(reasoning ? { reasoning } : {}),
          ...(toolCallList.length > 0 ? { tool_calls: toolCallList } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens || estimateTokens(content || reasoning || toolCallList),
    },
  };
};

const callGrokCliProxyChatCompletions = async (
  config: NvicodeConfig,
  body: Record<string, unknown>,
  targetModel: string,
  refreshed = false,
): Promise<OpenAIResponse> => {
  const token = await readGrokCliToken();
  const version = await getGrokClientVersion();
  const requestBody = {
    ...body,
    model: targetModel,
    stream: true,
  };

  const response = await fetchWithTimeout(GROK_CLI_PROXY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-grok-client-version": version,
      "x-grok-model-override": targetModel,
    },
    body: JSON.stringify(requestBody),
  });

  const raw = await response.text();
  if (response.ok) {
    const upstream = parseOpenAiSseResponse(raw);
    if (!upstream.usage?.prompt_tokens) {
      upstream.usage = {
        prompt_tokens: estimateTokens({
          messages: body.messages ?? [],
          tools: body.tools ?? [],
        }),
        completion_tokens: upstream.usage?.completion_tokens ?? 0,
      };
    }
    return upstream;
  }

  if (!refreshed && [401, 403, 426].includes(response.status)) {
    await refreshGrokCliAuth();
    return callGrokCliProxyChatCompletions(config, body, targetModel, true);
  }

  throw new UpstreamHttpError(response.status, raw);
};

const splitDataUrl = (
  url: string,
): { mediaType: string; data: string } | null => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    mediaType: match[1],
    data: match[2],
  };
};

const openAiContentToClineBlocks = (
  content: OpenAIMessage["content"],
): ClineContentBlock[] => {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: ClineContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      const parsed = splitDataUrl(part.image_url.url);
      if (parsed) {
        blocks.push({
          type: "image",
          mediaType: parsed.mediaType,
          data: parsed.data,
        });
      }
    }
  }
  return blocks;
};

const openAiContentToSystemText = (content: OpenAIMessage["content"]): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n\n");
};

const mapOpenAiMessagesToCline = (
  messages: OpenAIMessage[],
): { systemPrompt: string; messages: ClineMessage[] } => {
  const systemParts: string[] = [];
  const clineMessages: ClineMessage[] = [];
  const toolNamesById = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "system") {
      const systemText = openAiContentToSystemText(message.content);
      if (systemText) {
        systemParts.push(systemText);
      }
      continue;
    }

    if (message.role === "tool") {
      const toolUseId = message.tool_call_id || `toolu_${randomUUID()}`;
      clineMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            name: toolNamesById.get(toolUseId) || "tool",
            content: stringifyContent(message.content),
          },
        ],
      });
      continue;
    }

    const blocks = openAiContentToClineBlocks(message.content);
    if (message.role === "assistant") {
      for (const toolCall of message.tool_calls ?? []) {
        toolNamesById.set(toolCall.id, toolCall.function.name);
        const parsedInput = safeParseJson(toolCall.function.arguments || "{}");
        blocks.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input:
            parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput)
              ? parsedInput as Record<string, unknown>
              : { value: parsedInput },
        });
      }
    }

    clineMessages.push({
      role: message.role,
      content: blocks.length > 0 ? blocks : "",
    });
  }

  return {
    systemPrompt: systemParts.join("\n\n"),
    messages: clineMessages,
  };
};

const mapOpenAiToolsToCline = (
  tools: unknown,
): ClineToolDefinition[] | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  const mapped = tools
    .map((tool): ClineToolDefinition | null => {
      if (!tool || typeof tool !== "object") {
        return null;
      }
      const entry = tool as {
        type?: unknown;
        function?: {
          name?: unknown;
          description?: unknown;
          parameters?: unknown;
        };
      };
      const name = entry.function?.name;
      if (entry.type !== "function" || typeof name !== "string" || !name) {
        return null;
      }
      const parameters = entry.function?.parameters;
      return {
        name,
        description:
          typeof entry.function?.description === "string"
            ? entry.function.description
            : "",
        inputSchema:
          parameters && typeof parameters === "object" && !Array.isArray(parameters)
            ? parameters as Record<string, unknown>
            : { type: "object", properties: {} },
      };
    })
    .filter((tool): tool is ClineToolDefinition => Boolean(tool));

  return mapped.length > 0 ? mapped : undefined;
};

const coerceToolArguments = (
  value: string | Record<string, unknown> | undefined,
): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return "{}";
};

const callClineChatCompletions = async (
  config: NvicodeConfig,
  body: Record<string, unknown>,
  targetModel: string,
  refreshed = false,
): Promise<OpenAIResponse> => {
  const rawMessages = Array.isArray(body.messages)
    ? body.messages as OpenAIMessage[]
    : [];
  const messages = [...rawMessages];
  removeInvalidLeadingChatMessages(messages);

  const { systemPrompt, messages: clineMessages } = mapOpenAiMessagesToCline(messages);
  const tools = mapOpenAiToolsToCline(body.tools);

  try {
    const auth = await getClineAuth(targetModel);
    const module = await loadClineLlmsModule();
    const handler = module.createHandler({
      providerId: "cline-pass",
      modelId: targetModel,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      accountId: auth.accountId,
      reasoningEffort: config.thinking ? "high" : undefined,
      maxOutputTokens:
        typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    });

    const responseId = `chatcmpl_${randomUUID()}`;
    let text = "";
    let reasoning = "";
    let inputTokens = 0;
    let outputTokens = 0;
    const toolCalls = new Map<string, {
      id: string;
      name: string;
      arguments: string;
    }>();

    for await (const chunk of handler.createMessage(systemPrompt, clineMessages, tools)) {
      if (chunk.type === "text") {
        text += chunk.text;
        continue;
      }
      if (chunk.type === "reasoning") {
        reasoning += chunk.reasoning;
        continue;
      }
      if (chunk.type === "usage") {
        inputTokens = chunk.inputTokens ?? inputTokens;
        outputTokens = chunk.outputTokens ?? outputTokens;
        continue;
      }
      if (chunk.type === "tool_calls") {
        const id =
          chunk.tool_call.call_id ||
          chunk.tool_call.function.id ||
          `call_${randomUUID()}`;
        const existing = toolCalls.get(id);
        const name = chunk.tool_call.function.name || existing?.name || "";
        const args = coerceToolArguments(chunk.tool_call.function.arguments);
        toolCalls.set(id, {
          id,
          name,
          arguments: existing ? `${existing.arguments}${args}` : args,
        });
        continue;
      }
      if (chunk.type === "done" && !chunk.success) {
        throw new Error(chunk.error || chunk.incompleteReason || "ClinePass request failed");
      }
    }

    const toolCallList = [...toolCalls.values()]
      .filter((toolCall) => toolCall.name)
      .map((toolCall) => ({
        id: toolCall.id,
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments || "{}",
        },
      }));
    const responseText = text || stripThinkingTags(reasoning);

    return {
      id: responseId,
      choices: [
        {
          finish_reason: toolCallList.length > 0 ? "tool_calls" : "stop",
          message: {
            content: responseText,
            ...(reasoning ? { reasoning } : {}),
            ...(toolCallList.length > 0 ? { tool_calls: toolCallList } : {}),
          },
        },
      ],
      usage: {
        prompt_tokens: inputTokens || estimateTokens({ messages, tools }),
        completion_tokens: outputTokens || estimateTokens(responseText || toolCallList),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!refreshed && /unauthorized|reauthenticate|auth/i.test(message)) {
      await refreshClineAuth(targetModel);
      return callClineChatCompletions(config, body, targetModel, true);
    }
    throw error;
  }
};

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload));
};

const sendAnthropicError = (
  response: ServerResponse,
  statusCode: number,
  type: string,
  message: string,
): void => {
  sendJson(response, statusCode, {
    type: "error",
    error: {
      type,
      message,
    },
  });
};

const parseUpstreamErrorMessage = (body: string): string | null => {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: unknown;
      };
    };
    return typeof parsed.error?.message === "string"
      ? parsed.error.message
      : null;
  } catch {
    return null;
  }
};

const formatUpstreamErrorMessage = (error: UpstreamHttpError): string => {
  const providerMessage = parseUpstreamErrorMessage(error.body);
  const message = providerMessage || error.message;
  if (/context window exceeds limit/i.test(message)) {
    return [
      message,
      "",
      "nvicode: the provider rejected the carried Claude Code context. Start a fresh Claude session or run /compact if this persists.",
    ].join("\n");
  }
  return message;
};

const sendUpstreamAnthropicError = (
  response: ServerResponse,
  error: UpstreamHttpError,
): void => {
  const isClientError = error.statusCode >= 400 && error.statusCode < 500;
  sendAnthropicError(
    response,
    isClientError ? error.statusCode : 502,
    isClientError ? "invalid_request_error" : "api_error",
    formatUpstreamErrorMessage(error),
  );
};

const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const extractBearerToken = (request: IncomingMessage): string | null => {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
};

const stringifyContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stringifyContent(entry)).join("\n");
  }
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value as { type?: unknown }).type === "text" &&
    "text" in value &&
    typeof (value as { text?: unknown }).text === "string"
  ) {
    return (value as { text?: string }).text || "";
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value);
};

const normalizeSystemPrompt = (
  system: AnthropicMessagesRequest["system"],
): string | null => {
  if (!system) {
    return null;
  }
  if (typeof system === "string") {
    return system;
  }
  const text = system.map((block) => block.text).join("\n\n");
  return text || null;
};

const flushUserParts = (
  messages: OpenAIMessage[],
  parts: OpenAIContentPart[],
): void => {
  if (parts.length === 0) {
    return;
  }
  messages.push({
    role: "user",
    content:
      parts.length === 1 && parts[0]?.type === "text"
        ? parts[0].text
        : [...parts],
  });
  parts.length = 0;
};

const mapUserMessage = (message: AnthropicMessage): OpenAIMessage[] => {
  if (typeof message.content === "string") {
    return [
      {
        role: "user",
        content: message.content,
      },
    ];
  }

  const mapped: OpenAIMessage[] = [];
  const parts: OpenAIContentPart[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "image") {
      const mediaType = block.source?.media_type || "application/octet-stream";
      const data = block.source?.data;
      if (!data) {
        continue;
      }
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${mediaType};base64,${data}`,
        },
      });
      continue;
    }

    if (block.type === "tool_result") {
      flushUserParts(mapped, parts);
      mapped.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: stringifyContent(block.content),
      });
    }
  }

  flushUserParts(mapped, parts);
  return mapped;
};

const mapAssistantMessage = (message: AnthropicMessage): OpenAIMessage[] => {
  if (typeof message.content === "string") {
    return [
      {
        role: "assistant",
        content: message.content,
      },
    ];
  }

  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  return [
    {
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("\n\n") : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ];
};

const mapMessages = (payload: AnthropicMessagesRequest): OpenAIMessage[] => {
  const mapped: OpenAIMessage[] = [];
  const system = normalizeSystemPrompt(payload.system);
  if (system) {
    mapped.push({
      role: "system",
      content: system,
    });
  }

  for (const message of payload.messages ?? []) {
    if (message.role === "user") {
      mapped.push(...mapUserMessage(message));
      continue;
    }

    if (message.role === "assistant") {
      mapped.push(...mapAssistantMessage(message));
    }
  }

  return mapped;
};

const mapTools = (tools: AnthropicTool[] | undefined): unknown[] | undefined => {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? {
        type: "object",
        properties: {},
      },
    },
  }));
};

const mapToolChoice = (toolChoice: unknown): unknown => {
  if (!toolChoice || typeof toolChoice !== "object") {
    return undefined;
  }

  const type = (toolChoice as { type?: unknown }).type;
  if (type === "auto") {
    return "auto";
  }
  if (type === "any") {
    return "required";
  }
  if (
    type === "tool" &&
    typeof (toolChoice as { name?: unknown }).name === "string"
  ) {
    return {
      type: "function",
      function: {
        name: (toolChoice as { name: string }).name,
      },
    };
  }

  return undefined;
};

const safeParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return {
      raw: value,
    };
  }
};

const mapStopReason = (finishReason: string | null | undefined): string => {
  switch (finishReason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    default:
      return "end_turn";
  }
};

const stripThinkingTags = (value: string): string =>
  value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*<\/think>\s*/i, "")
    .replace(/\s*<think>[\s\S]*$/i, "")
    .trimStart();

const mapResponseContent = (choice: OpenAIChoice | undefined): AnthropicContentBlock[] => {
  const content: AnthropicContentBlock[] = [];
  const message = choice?.message;

  if (typeof message?.content === "string" && message.content.length > 0) {
    const text = stripThinkingTags(message.content);
    if (text.length > 0) {
      content.push({
        type: "text",
        text,
      });
    }
  } else if (Array.isArray(message?.content)) {
    const text = stripThinkingTags(
      message.content
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .filter((entry) => entry.length > 0)
        .join("\n"),
    );
    if (text.length > 0) {
      content.push({
        type: "text",
        text,
      });
    }
  }

  if (
    content.length === 0 &&
    typeof message?.reasoning === "string" &&
    message.reasoning.trim().length > 0
  ) {
    const text = stripThinkingTags(message.reasoning);
    if (text.length > 0) {
      content.push({
        type: "text",
        text,
      });
    }
  }

  for (const toolCall of message?.tool_calls ?? []) {
    const name = toolCall.function?.name;
    if (!name) {
      continue;
    }

    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${randomUUID()}`,
      name,
      input: safeParseJson(toolCall.function?.arguments || "{}"),
    });
  }

  if (content.length === 0) {
    content.push({
      type: "text",
      text: "",
    });
  }

  return content;
};

const chunkText = (value: string, chunkSize = 1024): string[] => {
  if (!value) {
    return [""];
  }

  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks;
};

const writeSse = (
  response: ServerResponse,
  event: string,
  payload: unknown,
): void => {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const estimateTokens = (payload: unknown): number => {
  const raw = JSON.stringify(payload);
  return Math.max(1, Math.ceil(raw.length / 4));
};

const getCurrentTurnMessages = (
  messages: AnthropicMessage[] | undefined,
): AnthropicMessage[] => {
  const entries = messages ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.role === "assistant") {
      return entries.slice(index + 1);
    }
  }
  return entries;
};

const extractPromptInput = (
  messages: AnthropicMessage[],
): Array<string | OpenAIImagePart> => {
  const parts: Array<string | OpenAIImagePart> = [];

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    if (typeof message.content === "string") {
      if (message.content.trim().length > 0) {
        parts.push(message.content);
      }
      continue;
    }

    for (const block of message.content) {
      if (block.type === "text" && block.text.trim().length > 0) {
        parts.push(block.text);
        continue;
      }

      if (block.type === "image" && block.source?.data) {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type || "application/octet-stream"};base64,${block.source.data}`,
          },
        });
      }
    }
  }

  return parts;
};

const estimateTurnInputTokens = (
  payload: AnthropicMessagesRequest,
): number => {
  const currentTurnMessages = getCurrentTurnMessages(payload.messages);
  const promptInput = extractPromptInput(currentTurnMessages);
  if (promptInput.length === 0) {
    return 0;
  }

  return estimateTokens({
    prompt: promptInput,
  });
};

const estimateTurnOutputTokens = (
  content: AnthropicContentBlock[],
): number => estimateTokens(content);

const resolveTargetModel = (
  config: NvicodeConfig,
  _payload: AnthropicMessagesRequest,
): string => getActiveModel(config);

const resolveRequestedModel = (
  config: NvicodeConfig,
  _model: string | undefined,
): string => getActiveModel(config);

const callUpstreamMessages = async (
  config: NvicodeConfig,
  scheduleRequest: <T>(task: () => Promise<T>) => Promise<T>,
  payload: AnthropicMessagesRequest,
): Promise<{
  targetModel: string;
  upstream: OpenAIResponse;
}> => {
  const targetModel = resolveTargetModel(config, payload);
  const tools = mapTools(payload.tools);
  const trim = trimChatMessagesForProvider(
    config,
    targetModel,
    mapMessages(payload),
    tools,
    payload.max_tokens,
  );
  logTrimmedContext(config, trim);
  assertTrimFitsContext(trim);

  if (config.provider === "clinepass" || config.provider === "xai") {
    const requestBody: Record<string, unknown> = {
      model: targetModel,
      messages: trim.messages,
      stream: false,
    };
    applyMaxTokens(requestBody, config, targetModel, payload.max_tokens);
    if (tools) {
      requestBody.tools = tools;
    }
    return {
      targetModel,
      upstream: await scheduleRequest(() =>
        config.provider === "clinepass"
          ? callClineChatCompletions(config, requestBody, targetModel)
          : callGrokCliProxyChatCompletions(config, requestBody, targetModel),
      ),
    };
  }

  const requestBody: Record<string, unknown> = {
    model: targetModel,
    messages: trim.messages,
    stream: false,
  };
  applyMaxTokens(requestBody, config, targetModel, payload.max_tokens);

  if (typeof payload.temperature === "number") {
    requestBody.temperature = payload.temperature;
  }
  if (typeof payload.top_p === "number") {
    requestBody.top_p = payload.top_p;
  }
  if (payload.stop_sequences && payload.stop_sequences.length > 0) {
    requestBody.stop = payload.stop_sequences;
  }

  if (tools) {
    requestBody.tools = tools;
  }

  const toolChoice = mapToolChoice(payload.tool_choice);
  if (toolChoice) {
    requestBody.tool_choice = toolChoice;
  }

  if (config.provider === "nvidia") {
    requestBody.chat_template_kwargs = {
      thinking: config.thinking,
    };
  }
  if (config.provider === "tokenrouter") {
    requestBody.thinking = {
      type: config.thinking ? "adaptive" : "disabled",
    };
    if (config.thinking) {
      requestBody.reasoning_split = true;
    }
  }

  const openrouterProvider =
    config.provider === "openrouter"
      ? getOpenRouterProviderPreferences(config.openrouterRoute)
      : undefined;
  if (openrouterProvider) {
    requestBody.provider = openrouterProvider;
  }

  const upstreamUrl = getUpstreamChatUrl(config);
  const apiKey = getActiveApiKey(config);

  const invoke = async (): Promise<OpenAIResponse> => {
    for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt += 1) {
      const response = await fetchWithTimeout(upstreamUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const raw = await response.text();
      if (response.ok) {
        return JSON.parse(raw) as OpenAIResponse;
      }

      if (response.status === 429 && attempt < MAX_UPSTREAM_RETRIES) {
        const retryAfterMs =
          parseRetryAfterMs(response.headers.get("retry-after")) ||
          DEFAULT_RETRY_DELAY_MS * 2 ** attempt;
        await sleep(retryAfterMs);
        continue;
      }

      throw new UpstreamHttpError(response.status, raw);
    }

    throw new Error("Upstream API retry loop exhausted unexpectedly.");
  };

  return {
    targetModel,
    upstream: await scheduleRequest(invoke),
  };
};

interface ResponsesInputMessage {
  role: "user" | "assistant" | "system" | "developer";
  content: string | Array<{ type: string; text?: string; image_url?: string }>;
}

interface ResponsesInputFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  id?: string;
  status?: string;
}

interface ResponsesInputFunctionOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesInputFunctionCall
  | ResponsesInputFunctionOutput;

interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

interface ResponsesRequest {
  model?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesFunctionTool[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tool_choice?: unknown;
}

interface ResponsesOutputText {
  type: "output_text";
  text: string;
}

interface ResponsesOutputMessage {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed" | "in_progress";
  content: ResponsesOutputText[];
}

interface ResponsesOutputFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "completed" | "in_progress";
}

type ResponsesOutputItem = ResponsesOutputMessage | ResponsesOutputFunctionCall;

interface ResponsesApiResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "failed" | "in_progress";
  model: string;
  output: ResponsesOutputItem[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

const isInputMessage = (item: ResponsesInputItem): item is ResponsesInputMessage =>
  "role" in item &&
  (!("type" in item) || (item as { type?: string }).type === "message");

const translateResponsesInputToMessages = (
  input: ResponsesInputItem[],
): OpenAIMessage[] => {
  const messages: OpenAIMessage[] = [];
  let pendingToolCalls: OpenAIToolCall[] = [];

  const flushPendingToolCalls = (): void => {
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: pendingToolCalls,
      });
      pendingToolCalls = [];
    }
  };

  for (const item of input) {
    if (isInputMessage(item)) {
      flushPendingToolCalls();
      const role = item.role === "developer" ? "system" as const : item.role;
      if (typeof item.content === "string") {
        messages.push({ role, content: item.content });
      } else {
        const parts: OpenAIContentPart[] = item.content.map((part) => {
          if (part.type === "input_image" && part.image_url) {
            return { type: "image_url" as const, image_url: { url: part.image_url } };
          }
          return { type: "text" as const, text: part.text || "" };
        });
        messages.push({ role, content: parts });
      }
      continue;
    }

    if (item.type === "function_call") {
      pendingToolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }

    if (item.type === "function_call_output") {
      flushPendingToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: item.output,
      });
    }
  }

  flushPendingToolCalls();
  return messages;
};

const translateResponsesTools = (
  tools: ResponsesFunctionTool[] | undefined,
): unknown[] | undefined => {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? { type: "object", properties: {} },
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    }));
};

const buildResponsesApiResponse = (
  upstream: OpenAIResponse,
  requestModel: string,
): ResponsesApiResponse => {
  const choice = upstream.choices?.[0];
  const output: ResponsesOutputItem[] = [];

  const messageContent = choice?.message?.content;
  const text = stripThinkingTags(
    typeof messageContent === "string"
      ? messageContent
      : Array.isArray(messageContent)
        ? messageContent
            .map((p) => (typeof p.text === "string" ? p.text : ""))
            .filter(Boolean)
            .join("\n")
        : "",
  );

  if (
    text.length > 0 ||
    (!choice?.message?.tool_calls?.length &&
      !choice?.message?.reasoning?.trim())
  ) {
    const finalText =
      text.length > 0
        ? text
        : stripThinkingTags(choice?.message?.reasoning?.trim() || "");
    output.push({
      type: "message",
      id: `msg_${randomUUID()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: finalText }],
    });
  }

  for (const tc of choice?.message?.tool_calls ?? []) {
    const name = tc.function?.name;
    if (!name) continue;
    output.push({
      type: "function_call",
      id: `fc_${randomUUID()}`,
      call_id: tc.id || `call_${randomUUID()}`,
      name,
      arguments: tc.function?.arguments || "{}",
      status: "completed",
    });
  }

  if (output.length === 0) {
    output.push({
      type: "message",
      id: `msg_${randomUUID()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "" }],
    });
  }

  return {
    id: upstream.id || `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestModel,
    output,
    usage: {
      input_tokens: upstream.usage?.prompt_tokens ?? 0,
      output_tokens: upstream.usage?.completion_tokens ?? 0,
      total_tokens:
        (upstream.usage?.prompt_tokens ?? 0) +
        (upstream.usage?.completion_tokens ?? 0),
    },
  };
};

const writeResponsesSseEvent = (
  response: ServerResponse,
  type: string,
  payload: Record<string, unknown>,
): void => {
  response.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
};

const streamResponsesApiResponse = (
  response: ServerResponse,
  apiResponse: ResponsesApiResponse,
): void => {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  writeResponsesSseEvent(response, "response.created", {
    response: { ...apiResponse, output: [], status: "in_progress" },
  });

  for (let i = 0; i < apiResponse.output.length; i++) {
    const item = apiResponse.output[i]!;

    if (item.type === "message") {
      writeResponsesSseEvent(response, "response.output_item.added", {
        output_index: i,
        item: { ...item, content: [], status: "in_progress" },
      });

      for (let j = 0; j < item.content.length; j++) {
        const part = item.content[j]!;

        writeResponsesSseEvent(response, "response.content_part.added", {
          output_index: i,
          content_index: j,
          part: { type: "output_text", text: "" },
        });

        for (const chunk of chunkText(part.text)) {
          writeResponsesSseEvent(response, "response.output_text.delta", {
            output_index: i,
            content_index: j,
            delta: chunk,
          });
        }

        writeResponsesSseEvent(response, "response.output_text.done", {
          output_index: i,
          content_index: j,
          text: part.text,
        });

        writeResponsesSseEvent(response, "response.content_part.done", {
          output_index: i,
          content_index: j,
          part,
        });
      }

      writeResponsesSseEvent(response, "response.output_item.done", {
        output_index: i,
        item: { ...item, status: "completed" },
      });
    } else if (item.type === "function_call") {
      writeResponsesSseEvent(response, "response.output_item.added", {
        output_index: i,
        item: { ...item, arguments: "", status: "in_progress" },
      });

      writeResponsesSseEvent(
        response,
        "response.function_call_arguments.delta",
        { output_index: i, delta: item.arguments },
      );

      writeResponsesSseEvent(
        response,
        "response.function_call_arguments.done",
        { output_index: i, arguments: item.arguments },
      );

      writeResponsesSseEvent(response, "response.output_item.done", {
        output_index: i,
        item: { ...item, status: "completed" },
      });
    }
  }

  writeResponsesSseEvent(response, "response.completed", {
    response: apiResponse,
  });

  response.end();
};

const getUpstreamChatUrl = (config: NvicodeConfig): string =>
  config.provider === "openrouter"
    ? OPENROUTER_URL
    : config.provider === "tokenrouter"
      ? TOKENROUTER_URL
      : config.provider === "gmicloud"
        ? GMICLOUD_URL
        : config.provider === "xai"
          ? XAI_URL
      : NVIDIA_URL;

export interface ContextBudget {
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  outputReserveTokens: number;
  inputLimitTokens: number | null;
  source: string | null;
}

const getProviderContextLimitOverride = (config: NvicodeConfig): number | null =>
  getEnvPositiveInteger(
    `NVICODE_${config.provider.toUpperCase()}_CONTEXT_LIMIT_TOKENS`,
  );

export const getContextBudgetForConfig = (
  config: NvicodeConfig,
  model = getActiveModel(config),
  requestedOutputTokens?: number,
): ContextBudget => {
  const limits = getActiveModelLimits(config);
  const modelLimits = limits?.model === model ? limits : undefined;
  const contextWindowTokens = modelLimits?.contextWindowTokens ?? null;
  const maxOutputTokens = modelLimits?.maxOutputTokens ?? null;
  const requestedOutput =
    Number.isInteger(requestedOutputTokens) && (requestedOutputTokens as number) > 0
      ? (requestedOutputTokens as number)
      : DEFAULT_MAX_OUTPUT_TOKENS;
  const outputReserveTokens = maxOutputTokens
    ? Math.min(requestedOutput, maxOutputTokens)
    : requestedOutput;
  const contextDerivedInputLimit = contextWindowTokens
    ? Math.max(
        1,
        Math.floor(contextWindowTokens * CONTEXT_ESTIMATE_SAFETY_RATIO) -
          outputReserveTokens,
      )
    : null;
  const environmentLimit =
    getProviderContextLimitOverride(config) ||
    getEnvPositiveInteger("NVICODE_CONTEXT_LIMIT_TOKENS");
  const explicitLimit =
    environmentLimit ||
    modelLimits?.safeInputTokens ||
    null;
  const candidates = [contextDerivedInputLimit, explicitLimit].filter(
    (value): value is number => typeof value === "number" && value > 0,
  );

  return {
    contextWindowTokens,
    maxOutputTokens,
    outputReserveTokens,
    inputLimitTokens: candidates.length > 0 ? Math.min(...candidates) : null,
    source: environmentLimit ? "environment" : modelLimits?.source || null,
  };
};

const estimateChatInputTokens = (
  messages: OpenAIMessage[],
  tools: unknown[] | undefined,
): number =>
  estimateTokens({
    messages,
    tools: tools ?? [],
  });

const firstNonSystemMessageIndex = (messages: OpenAIMessage[]): number =>
  messages.findIndex((message) => message.role !== "system");

const lastUserMessageIndex = (messages: OpenAIMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return -1;
};

const removeInvalidLeadingChatMessages = (messages: OpenAIMessage[]): number => {
  let removed = 0;
  while (true) {
    const firstIndex = firstNonSystemMessageIndex(messages);
    const first = firstIndex >= 0 ? messages[firstIndex] : undefined;
    if (!first || first.role === "user") {
      return removed;
    }
    messages.splice(firstIndex, 1);
    removed += 1;
  }
};

export const trimChatMessagesForProvider = (
  config: NvicodeConfig,
  model: string,
  messages: OpenAIMessage[],
  tools: unknown[] | undefined,
  requestedOutputTokens?: number,
): {
  messages: OpenAIMessage[];
  originalTokens: number;
  estimatedTokens: number;
  removedMessages: number;
  limitTokens: number | null;
  contextWindowTokens: number | null;
} => {
  const budget = getContextBudgetForConfig(
    config,
    model,
    requestedOutputTokens,
  );
  const limitTokens = budget.inputLimitTokens;
  const originalTokens = estimateChatInputTokens(messages, tools);
  if (!limitTokens || originalTokens <= limitTokens) {
    return {
      messages,
      originalTokens,
      estimatedTokens: originalTokens,
      removedMessages: 0,
      limitTokens,
      contextWindowTokens: budget.contextWindowTokens,
    };
  }

  const trimmed = [...messages];
  let removedMessages = 0;
  let estimatedTokens = originalTokens;

  while (estimatedTokens > limitTokens) {
    const removeIndex = firstNonSystemMessageIndex(trimmed);
    const currentUserIndex = lastUserMessageIndex(trimmed);
    if (
      removeIndex < 0 ||
      currentUserIndex < 0 ||
      removeIndex >= currentUserIndex
    ) {
      break;
    }
    trimmed.splice(removeIndex, 1);
    removedMessages += 1;
    removedMessages += removeInvalidLeadingChatMessages(trimmed);
    estimatedTokens = estimateChatInputTokens(trimmed, tools);
  }

  return {
    messages: trimmed,
    originalTokens,
    estimatedTokens,
    removedMessages,
    limitTokens,
    contextWindowTokens: budget.contextWindowTokens,
  };
};

const assertTrimFitsContext = (
  trim: ReturnType<typeof trimChatMessagesForProvider>,
): void => {
  if (!trim.limitTokens || trim.estimatedTokens <= trim.limitTokens) {
    return;
  }
  throw new UpstreamHttpError(
    400,
    JSON.stringify({
      error: {
        message:
          `nvicode could not fit the current request into the model input budget ` +
          `(${trim.estimatedTokens} estimated tokens > ${trim.limitTokens}). ` +
          "Reduce the current prompt/tools or choose a model with a larger context window.",
        type: "invalid_request_error",
      },
    }),
  );
};

const logTrimmedContext = (
  config: NvicodeConfig,
  trim: ReturnType<typeof trimChatMessagesForProvider>,
): void => {
  if (trim.removedMessages <= 0 || !trim.limitTokens) {
    return;
  }
  console.error(
    `nvicode trimmed ${trim.removedMessages} old message(s) to keep ${config.provider} input under ${trim.limitTokens} estimated tokens (${trim.originalTokens} -> ${trim.estimatedTokens})`,
  );
};

const isMiniMaxModel = (model: string): boolean => /^minimax(?:[-/]|$)/i.test(model);

const shouldForwardMaxTokens = (
  config: NvicodeConfig,
  model: string,
): boolean => !(config.provider === "tokenrouter" && isMiniMaxModel(model));

const applyMaxTokens = (
  requestBody: Record<string, unknown>,
  config: NvicodeConfig,
  model: string,
  maxTokens: number | undefined,
): void => {
  if (!shouldForwardMaxTokens(config, model)) {
    delete requestBody.max_tokens;
    return;
  }
  const budget = getContextBudgetForConfig(config, model, maxTokens);
  const requested = maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  requestBody.max_tokens = budget.maxOutputTokens
    ? Math.min(requested, budget.maxOutputTokens)
    : requested;
};

const callChatCompletions = async (
  config: NvicodeConfig,
  scheduleRequest: <T>(task: () => Promise<T>) => Promise<T>,
  body: Record<string, unknown>,
): Promise<OpenAIResponse> => {
  if (config.provider === "clinepass") {
    const targetModel =
      typeof body.model === "string"
        ? resolveRequestedModel(config, body.model)
        : getActiveModel(config);
    return scheduleRequest(() =>
      callClineChatCompletions(config, { ...body, model: targetModel }, targetModel),
    );
  }
  if (config.provider === "xai") {
    const targetModel =
      typeof body.model === "string"
        ? resolveRequestedModel(config, body.model)
        : getActiveModel(config);
    return scheduleRequest(() =>
      callGrokCliProxyChatCompletions(
        config,
        { ...body, model: targetModel },
        targetModel,
      ),
    );
  }

  const openrouterProvider =
    config.provider === "openrouter"
      ? getOpenRouterProviderPreferences(config.openrouterRoute)
      : undefined;
  const requestBody = openrouterProvider
    ? { ...body, provider: openrouterProvider }
    : body;
  const upstreamUrl = getUpstreamChatUrl(config);
  const apiKey = getActiveApiKey(config);

  const invoke = async (): Promise<OpenAIResponse> => {
    for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt += 1) {
      const resp = await fetchWithTimeout(upstreamUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const raw = await resp.text();
      if (resp.ok) return JSON.parse(raw) as OpenAIResponse;

      if (resp.status === 429 && attempt < MAX_UPSTREAM_RETRIES) {
        const retryMs =
          parseRetryAfterMs(resp.headers.get("retry-after")) ||
          DEFAULT_RETRY_DELAY_MS * 2 ** attempt;
        await sleep(retryMs);
        continue;
      }

      throw new UpstreamHttpError(resp.status, raw);
    }
    throw new Error("Upstream API retry loop exhausted unexpectedly.");
  };

  return scheduleRequest(invoke);
};

export const createProxyServer = (config: NvicodeConfig): Server => {
  const scheduleUpstreamRequest = createProviderScheduler(config);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (url.pathname === "/health") {
        const contextBudget = getContextBudgetForConfig(config);
        sendJson(response, 200, {
          ok: true,
          proxyProtocolVersion: PROXY_PROTOCOL_VERSION,
          provider: config.provider,
          openrouterRoute:
            config.provider === "openrouter" ? config.openrouterRoute || null : null,
          model: getActiveModel(config),
          port: config.proxyPort,
          thinking: config.thinking,
          upstreamTimeoutSeconds: UPSTREAM_TIMEOUT_MS / 1000,
          rateLimited: config.provider === "nvidia",
          maxRequestsPerMinute:
            config.provider === "nvidia" ? config.maxRequestsPerMinute : null,
          contextWindowTokens: contextBudget.contextWindowTokens,
          maxInputTokens: contextBudget.inputLimitTokens,
          maxOutputTokens: contextBudget.maxOutputTokens,
          contextLimitSource: contextBudget.source,
        });
        return;
      }

      const token = extractBearerToken(request);
      if (token !== config.proxyToken) {
        sendAnthropicError(
          response,
          401,
          "authentication_error",
          "Invalid nvicode proxy token",
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        const rawBody = await readRequestBody(request);
        const payload = JSON.parse(rawBody) as AnthropicMessagesRequest;
        const targetModel = resolveTargetModel(config, payload);
        const trim = trimChatMessagesForProvider(
          config,
          targetModel,
          mapMessages(payload),
          mapTools(payload.tools),
          payload.max_tokens,
        );
        sendJson(response, 200, {
          input_tokens: trim.originalTokens,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        const limits = getActiveModelLimits(config);
        const activeModel = getActiveModel(config);
        sendJson(response, 200, {
          object: "list",
          data: [
            {
              id: NVICODE_CLAUDE_DESKTOP_GATEWAY_MODEL_ID,
              object: "model",
              created: 0,
              owned_by: config.provider,
              display_name: activeModel,
              anthropic_family_tier: "sonnet",
              is_family_default: true,
              context_window: limits?.contextWindowTokens,
              max_output_tokens: limits?.maxOutputTokens,
            },
          ],
          models: [],
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const rawBody = await readRequestBody(request);
        const payload = JSON.parse(rawBody) as Record<string, unknown>;
        const targetModel = resolveRequestedModel(
          config,
          typeof payload.model === "string" ? payload.model : undefined,
        );
        const messages = Array.isArray(payload.messages)
          ? payload.messages as OpenAIMessage[]
          : [];
        const tools = Array.isArray(payload.tools) ? payload.tools : undefined;
        const requestedOutputTokens =
          typeof payload.max_tokens === "number" ? payload.max_tokens : undefined;
        const trim = trimChatMessagesForProvider(
          config,
          targetModel,
          messages,
          tools,
          requestedOutputTokens,
        );
        logTrimmedContext(config, trim);
        assertTrimFitsContext(trim);
        const chatBody: Record<string, unknown> = {
          ...payload,
          model: targetModel,
          messages: trim.messages,
          stream: false,
        };
        applyMaxTokens(chatBody, config, targetModel, requestedOutputTokens);
        const upstream = await callChatCompletions(
          config,
          scheduleUpstreamRequest,
          chatBody,
        );
        sendJson(response, 200, upstream);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/messages") {
        const rawBody = await readRequestBody(request);
        const payload = JSON.parse(rawBody) as AnthropicMessagesRequest;
        const targetModel = resolveTargetModel(config, payload);
        const estimatedInputTokens = trimChatMessagesForProvider(
          config,
          targetModel,
          mapMessages(payload),
          mapTools(payload.tools),
          payload.max_tokens,
        ).estimatedTokens;
        const estimatedTurnInputTokens = estimateTurnInputTokens(payload);
        const startedAt = Date.now();
        const pricing = getPricingSnapshot();

        try {
          const { upstream } = await callUpstreamMessages(
            config,
            scheduleUpstreamRequest,
            payload,
          );
          const choice = upstream.choices?.[0];
          const mappedContent = mapResponseContent(choice);
          const estimatedTurnOutputTokens = estimateTurnOutputTokens(
            mappedContent,
          );

          const anthropicResponse = {
            id: upstream.id || `msg_${randomUUID()}`,
            type: "message",
            role: "assistant",
            model: targetModel,
            content: mappedContent,
            stop_reason: mapStopReason(choice?.finish_reason),
            stop_sequence: null,
            usage: {
              input_tokens: upstream.usage?.prompt_tokens ?? estimatedInputTokens,
              output_tokens: upstream.usage?.completion_tokens ?? 0,
            },
          };

          await appendUsageRecord(
            buildUsageRecord({
              id: anthropicResponse.id,
              status: "success",
              model: targetModel,
              inputTokens: anthropicResponse.usage.input_tokens,
              outputTokens: anthropicResponse.usage.output_tokens,
              turnInputTokens: estimatedTurnInputTokens,
              turnOutputTokens: estimatedTurnOutputTokens,
              latencyMs: Date.now() - startedAt,
              stopReason: anthropicResponse.stop_reason,
              pricing,
            }),
          );

          if (!payload.stream) {
            sendJson(response, 200, anthropicResponse);
            return;
          }

          response.writeHead(200, {
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
          });

          writeSse(response, "message_start", {
            type: "message_start",
            message: {
              ...anthropicResponse,
              content: [],
              stop_reason: null,
              usage: {
                input_tokens: anthropicResponse.usage.input_tokens,
                output_tokens: 0,
              },
            },
          });

          mappedContent.forEach((block, index) => {
            if (block.type === "text") {
              writeSse(response, "content_block_start", {
                type: "content_block_start",
                index,
                content_block: {
                  type: "text",
                  text: "",
                },
              });

              for (const chunk of chunkText(block.text)) {
                writeSse(response, "content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: {
                    type: "text_delta",
                    text: chunk,
                  },
                });
              }

              writeSse(response, "content_block_stop", {
                type: "content_block_stop",
                index,
              });
              return;
            }

            if (block.type === "tool_use") {
              writeSse(response, "content_block_start", {
                type: "content_block_start",
                index,
                content_block: {
                  type: "tool_use",
                  id: block.id,
                  name: block.name,
                  input: {},
                },
              });

              writeSse(response, "content_block_delta", {
                type: "content_block_delta",
                index,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.input ?? {}),
                },
              });

              writeSse(response, "content_block_stop", {
                type: "content_block_stop",
                index,
              });
            }
          });

          writeSse(response, "message_delta", {
            type: "message_delta",
            delta: {
              stop_reason: anthropicResponse.stop_reason,
              stop_sequence: null,
            },
            usage: {
              output_tokens: anthropicResponse.usage.output_tokens,
            },
          });
          writeSse(response, "message_stop", {
            type: "message_stop",
          });
          response.end();
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await appendUsageRecord(
            buildUsageRecord({
              id: `err_${randomUUID()}`,
              status: "error",
              model: targetModel,
              inputTokens: estimatedInputTokens,
              outputTokens: 0,
              turnInputTokens: estimatedTurnInputTokens,
              turnOutputTokens: 0,
              latencyMs: Date.now() - startedAt,
              error: message,
              pricing,
            }),
          );
          if (error instanceof UpstreamHttpError) {
            sendUpstreamAnthropicError(response, error);
            return;
          }
          throw error;
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/responses") {

        const rawBody = await readRequestBody(request);
        const payload = JSON.parse(rawBody) as ResponsesRequest;
        const targetModel = resolveRequestedModel(config, payload.model);
        const tools = translateResponsesTools(payload.tools);
        const trim = trimChatMessagesForProvider(
          config,
          targetModel,
          translateResponsesInputToMessages(payload.input),
          tools,
          payload.max_output_tokens,
        );
        logTrimmedContext(config, trim);
        assertTrimFitsContext(trim);

        const chatBody: Record<string, unknown> = {
          model: targetModel,
          messages: trim.messages,
          stream: false,
        };
        applyMaxTokens(chatBody, config, targetModel, payload.max_output_tokens);

        if (config.provider === "nvidia") {
          chatBody.chat_template_kwargs = {
            thinking: config.thinking,
          };
        }
        if (config.provider === "tokenrouter") {
          chatBody.thinking = {
            type: config.thinking ? "adaptive" : "disabled",
          };
          if (config.thinking) {
            chatBody.reasoning_split = true;
          }
        }

        if (typeof payload.temperature === "number") {
          chatBody.temperature = payload.temperature;
        }
        if (typeof payload.top_p === "number") {
          chatBody.top_p = payload.top_p;
        }

        if (tools) chatBody.tools = tools;

        try {
          const upstream = await callChatCompletions(
            config,
            scheduleUpstreamRequest,
            chatBody,
          );

          const apiResponse = buildResponsesApiResponse(upstream, targetModel);

          if (payload.stream === false) {
            sendJson(response, 200, apiResponse);
          } else {
            streamResponsesApiResponse(response, apiResponse);
          }
        } catch (err) {
          const statusCode =
            err instanceof UpstreamHttpError && err.statusCode >= 400 && err.statusCode < 500
              ? err.statusCode
              : 502;
          const msg =
            err instanceof UpstreamHttpError
              ? formatUpstreamErrorMessage(err)
              : err instanceof Error
                ? err.message
                : String(err);
          sendJson(response, statusCode, {
            error: { message: msg, type: "upstream_error", code: "upstream_error" },
          });
        }
        return;
      }

      sendAnthropicError(
        response,
        404,
        "not_found_error",
        `Unsupported route: ${request.method || "GET"} ${url.pathname}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendAnthropicError(response, 500, "api_error", message);
    }
  });
};
