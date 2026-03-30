import { promises as fs } from "node:fs";
import { getNvicodePaths } from "./config.js";

export interface UsagePricingSnapshot {
  providerInputUsdPerMTok: number;
  providerOutputUsdPerMTok: number;
  compareModel: string;
  compareInputUsdPerMTok: number;
  compareOutputUsdPerMTok: number;
  comparePricingSource: string;
  comparePricingUpdatedAt: string;
}

export interface UsageRecord {
  id: string;
  timestamp: string;
  status: "success" | "error";
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  providerCostUsd: number;
  compareCostUsd: number;
  savingsUsd: number;
  stopReason?: string | null;
  error?: string;
  pricing: UsagePricingSnapshot;
}

export interface UsageSummary {
  requests: number;
  successes: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: number;
  compareCostUsd: number;
  savingsUsd: number;
}

const OPUS_4_6_INPUT_USD_PER_MTOK = 5;
const OPUS_4_6_OUTPUT_USD_PER_MTOK = 25;
const OPUS_4_6_PRICING_SOURCE = "https://www.anthropic.com/claude/opus";
const OPUS_4_6_PRICING_UPDATED_AT = "2026-03-30";

const getEnvUsdRate = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
};

export const getPricingSnapshot = (): UsagePricingSnapshot => ({
  providerInputUsdPerMTok: getEnvUsdRate("NVICODE_INPUT_USD_PER_MTOK", 0),
  providerOutputUsdPerMTok: getEnvUsdRate("NVICODE_OUTPUT_USD_PER_MTOK", 0),
  compareModel: "Claude Opus 4.6",
  compareInputUsdPerMTok: OPUS_4_6_INPUT_USD_PER_MTOK,
  compareOutputUsdPerMTok: OPUS_4_6_OUTPUT_USD_PER_MTOK,
  comparePricingSource: OPUS_4_6_PRICING_SOURCE,
  comparePricingUpdatedAt: OPUS_4_6_PRICING_UPDATED_AT,
});

export const estimateCostUsd = (
  inputTokens: number,
  outputTokens: number,
  inputUsdPerMTok: number,
  outputUsdPerMTok: number,
): number =>
  (inputTokens / 1_000_000) * inputUsdPerMTok +
  (outputTokens / 1_000_000) * outputUsdPerMTok;

export const buildUsageRecord = ({
  id,
  timestamp = new Date().toISOString(),
  status,
  model,
  inputTokens,
  outputTokens,
  latencyMs,
  stopReason,
  error,
  pricing = getPricingSnapshot(),
}: {
  id: string;
  timestamp?: string;
  status: UsageRecord["status"];
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  stopReason?: string | null;
  error?: string;
  pricing?: UsagePricingSnapshot;
}): UsageRecord => {
  const providerCostUsd = estimateCostUsd(
    inputTokens,
    outputTokens,
    pricing.providerInputUsdPerMTok,
    pricing.providerOutputUsdPerMTok,
  );
  const compareCostUsd = estimateCostUsd(
    inputTokens,
    outputTokens,
    pricing.compareInputUsdPerMTok,
    pricing.compareOutputUsdPerMTok,
  );

  return {
    id,
    timestamp,
    status,
    model,
    inputTokens,
    outputTokens,
    latencyMs,
    providerCostUsd,
    compareCostUsd,
    savingsUsd: compareCostUsd - providerCostUsd,
    stopReason: stopReason ?? null,
    ...(error ? { error } : {}),
    pricing,
  };
};

export const appendUsageRecord = async (record: UsageRecord): Promise<void> => {
  const paths = getNvicodePaths();
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.appendFile(paths.usageLogFile, `${JSON.stringify(record)}\n`, "utf8");
};

export const readUsageRecords = async (): Promise<UsageRecord[]> => {
  const paths = getNvicodePaths();

  try {
    const raw = await fs.readFile(paths.usageLogFile, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UsageRecord)
      .filter((record) => typeof record.timestamp === "string")
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

export const summarizeUsage = (records: UsageRecord[]): UsageSummary =>
  records.reduce<UsageSummary>(
    (summary, record) => {
      summary.requests += 1;
      summary.successes += record.status === "success" ? 1 : 0;
      summary.errors += record.status === "error" ? 1 : 0;
      summary.inputTokens += record.inputTokens;
      summary.outputTokens += record.outputTokens;
      summary.providerCostUsd += record.providerCostUsd;
      summary.compareCostUsd += record.compareCostUsd;
      summary.savingsUsd += record.savingsUsd;
      return summary;
    },
    {
      requests: 0,
      successes: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      providerCostUsd: 0,
      compareCostUsd: 0,
      savingsUsd: 0,
    },
  );

export const filterRecordsSince = (
  records: UsageRecord[],
  sinceMs: number,
): UsageRecord[] =>
  records.filter((record) => {
    const timestamp = Date.parse(record.timestamp);
    return !Number.isNaN(timestamp) && timestamp >= sinceMs;
  });

const integerFormatter = new Intl.NumberFormat("en-US");
const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

export const formatInteger = (value: number): string =>
  integerFormatter.format(Math.round(value));

export const formatUsd = (value: number): string => moneyFormatter.format(value);

export const formatDuration = (ms: number): string => {
  if (ms < 1_000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
};

export const formatTimestamp = (value: string): string => {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return value;
  }

  return timestamp.toISOString().replace("T", " ").slice(0, 19);
};
