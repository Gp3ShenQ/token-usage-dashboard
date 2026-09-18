import path from "node:path";
import { safeJsonParse, toDayLocal, toInt } from "../utils.js";
import type { UsageEvent } from "../types.js";

type CodexLine = {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    model?: string;
    info?: {
      total_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
      };
      last_token_usage?: unknown;
    };
    rate_limits?: unknown;
  };
};

type Snapshot = {
  input: number;
  output: number;
  cacheRead: number;
  model: string;
};

export class CodexIncrementalParser {
  private readonly events: UsageEvent[] = [];
  private model: string;
  private cumulativeInput: number;
  private cumulativeOutput: number;
  private cumulativeCacheRead: number;
  private lineNumber: number;
  private latestRateLimit: { tsUtc: string; data: unknown } | null = null;

  constructor(
    private readonly filePath: string,
    snapshot: Snapshot,
    private readonly offsetLineNumber = 0,
  ) {
    this.model = snapshot.model;
    this.cumulativeInput = snapshot.input;
    this.cumulativeOutput = snapshot.output;
    this.cumulativeCacheRead = snapshot.cacheRead;
    this.lineNumber = offsetLineNumber;
  }

  consume(rawLine: string) {
    this.lineNumber += 1;
    const line = safeJsonParse<CodexLine>(rawLine);
    if (!line) {
      return;
    }

    if (line.type === "turn_context" && line.payload?.model) {
      this.model = line.payload.model;
      return;
    }

    if (line.type !== "event_msg" || line.payload?.type !== "token_count" || !line.timestamp) {
      return;
    }

    if (line.payload.rate_limits) {
      this.latestRateLimit = {
        tsUtc: line.timestamp,
        data: line.payload.rate_limits,
      };
    }

    const total = line.payload.info?.total_token_usage;
    const nextInput = toInt(total?.input_tokens);
    const nextOutput = toInt(total?.output_tokens);
    const nextCacheRead = toInt(total?.cached_input_tokens);
    const inputDelta = nextInput - this.cumulativeInput;
    const outputDelta = nextOutput - this.cumulativeOutput;
    const cacheReadDelta = nextCacheRead - this.cumulativeCacheRead;

    if (inputDelta < 0 || outputDelta < 0 || cacheReadDelta < 0) {
      return;
    }

    const delta = inputDelta + outputDelta + cacheReadDelta;
    if (delta === 0) {
      this.cumulativeInput = nextInput;
      this.cumulativeOutput = nextOutput;
      this.cumulativeCacheRead = nextCacheRead;
      return;
    }
    const rolloutName = path.basename(this.filePath, ".jsonl");
    const sessionId = rolloutName.match(/-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i)?.[1] ?? rolloutName;

    this.events.push({
      source: "codex",
      sessionId,
      project: null,
      model: this.model || "unknown",
      tsUtc: line.timestamp,
      dayLocal: toDayLocal(line.timestamp),
      input: Math.max(0, inputDelta),
      output: Math.max(0, outputDelta),
      cacheRead: Math.max(0, cacheReadDelta),
      cacheWrite: 0,
      dedupKey: `${this.filePath}:${this.lineNumber}`,
    });

    this.cumulativeInput = nextInput;
    this.cumulativeOutput = nextOutput;
    this.cumulativeCacheRead = nextCacheRead;
  }

  flush() {
    return {
      events: this.events,
      latestRateLimit: this.latestRateLimit,
      processedLines: this.lineNumber,
    };
  }
}
