import path from "node:path";
import { safeJsonParse, toDayLocal, toInt } from "../utils.js";
import type { UsageEvent } from "../types.js";

type ClaudeLine = {
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
};

export class ClaudeIncrementalParser {
  private readonly events = new Map<string, UsageEvent>();

  constructor(private readonly filePath: string) {}

  consume(rawLine: string) {
    const line = safeJsonParse<ClaudeLine>(rawLine);
    if (!line?.message?.usage || line.message.role !== "assistant") {
      return;
    }

    if (!line.message.id || !line.timestamp || !line.message.model || line.message.model === "<synthetic>") {
      return;
    }

    const sessionId = path.basename(this.filePath, ".jsonl");
    const project = path.basename(path.dirname(this.filePath));
    const dedupKey = `${this.filePath}:${line.message.id}`;

    this.events.set(line.message.id, {
      source: "claude",
      sessionId,
      project,
      model: line.message.model,
      tsUtc: line.timestamp,
      dayLocal: toDayLocal(line.timestamp),
      input: toInt(line.message.usage.input_tokens),
      output: toInt(line.message.usage.output_tokens),
      cacheRead: toInt(line.message.usage.cache_read_input_tokens),
      cacheWrite: toInt(line.message.usage.cache_creation_input_tokens),
      dedupKey,
    });
  }

  flush() {
    return [...this.events.values()];
  }
}
