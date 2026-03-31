import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  appendUsageRecord,
  buildUsageRecord,
  getPricingSnapshot,
} from "./usage.js";
import type { NvicodeConfig } from "./config.js";

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

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_RETRY_DELAY_MS = 2_000;
const MAX_NVIDIA_RETRIES = 3;

const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
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

const mapResponseContent = (choice: OpenAIChoice | undefined): AnthropicContentBlock[] => {
  const content: AnthropicContentBlock[] = [];
  const message = choice?.message;

  if (typeof message?.content === "string" && message.content.length > 0) {
    content.push({
      type: "text",
      text: message.content,
    });
  } else if (Array.isArray(message?.content)) {
    const text = message.content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter((entry) => entry.length > 0)
      .join("\n");
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
    content.push({
      type: "text",
      text: message.reasoning,
    });
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
  payload: AnthropicMessagesRequest,
): string =>
  payload.model && payload.model.includes("/") && !payload.model.startsWith("claude-")
    ? payload.model
    : config.model;

const callNvidia = async (
  config: NvicodeConfig,
  scheduleRequest: <T>(task: () => Promise<T>) => Promise<T>,
  payload: AnthropicMessagesRequest,
): Promise<{
  targetModel: string;
  upstream: OpenAIResponse;
}> => {
  const targetModel = resolveTargetModel(config, payload);

  const requestBody: Record<string, unknown> = {
    model: targetModel,
    messages: mapMessages(payload),
    max_tokens: payload.max_tokens ?? 16_384,
    stream: false,
  };

  if (typeof payload.temperature === "number") {
    requestBody.temperature = payload.temperature;
  }
  if (typeof payload.top_p === "number") {
    requestBody.top_p = payload.top_p;
  }
  if (payload.stop_sequences && payload.stop_sequences.length > 0) {
    requestBody.stop = payload.stop_sequences;
  }

  const tools = mapTools(payload.tools);
  if (tools) {
    requestBody.tools = tools;
  }

  const toolChoice = mapToolChoice(payload.tool_choice);
  if (toolChoice) {
    requestBody.tool_choice = toolChoice;
  }

  if (config.thinking) {
    requestBody.chat_template_kwargs = {
      thinking: true,
    };
  }

  const invoke = async (): Promise<OpenAIResponse> => {
    for (let attempt = 0; attempt <= MAX_NVIDIA_RETRIES; attempt += 1) {
      const response = await fetch(NVIDIA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const raw = await response.text();
      if (response.ok) {
        return JSON.parse(raw) as OpenAIResponse;
      }

      if (response.status === 429 && attempt < MAX_NVIDIA_RETRIES) {
        const retryAfterMs =
          parseRetryAfterMs(response.headers.get("retry-after")) ||
          DEFAULT_RETRY_DELAY_MS * 2 ** attempt;
        await sleep(retryAfterMs);
        continue;
      }

      throw new Error(`NVIDIA API HTTP ${response.status}: ${raw}`);
    }

    throw new Error("NVIDIA API retry loop exhausted unexpectedly.");
  };

  return {
    targetModel,
    upstream: await scheduleRequest(invoke),
  };
};

export const createProxyServer = (config: NvicodeConfig): Server => {
  const scheduleNvidiaRequest = createRequestScheduler(config.maxRequestsPerMinute);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          model: config.model,
          port: config.proxyPort,
          thinking: config.thinking,
          maxRequestsPerMinute: config.maxRequestsPerMinute,
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
        sendJson(response, 200, {
          input_tokens: estimateTokens({
            system: payload.system ?? null,
            messages: payload.messages ?? [],
            tools: payload.tools ?? [],
          }),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/messages") {
        const rawBody = await readRequestBody(request);
        const payload = JSON.parse(rawBody) as AnthropicMessagesRequest;
        const targetModel = resolveTargetModel(config, payload);
        const estimatedInputTokens = estimateTokens({
          system: payload.system ?? null,
          messages: payload.messages ?? [],
          tools: payload.tools ?? [],
        });
        const estimatedTurnInputTokens = estimateTurnInputTokens(payload);
        const startedAt = Date.now();
        const pricing = getPricingSnapshot();

        try {
          const { upstream } = await callNvidia(
            config,
            scheduleNvidiaRequest,
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
          throw error;
        }
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
