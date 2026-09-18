import fs from "node:fs";
import readline from "node:readline";
import { glob } from "glob";
import { CLAUDE_GLOB, CODEX_GLOB } from "../constants.js";
import { UsageDatabase } from "../db/database.js";
import { ClaudeIncrementalParser } from "./claude-parser.js";
import { CodexIncrementalParser } from "./codex-parser.js";
import type { ScanStatus, ScanWarning } from "../types.js";

type ScanFile = {
  source: "claude" | "codex";
  filePath: string;
};

export class UsageScanner {
  private status: ScanStatus = {
    running: false,
    filesDone: 0,
    filesTotal: 0,
    lastFinishedAt: null,
    warnings: [],
  };

  private runningPromise: Promise<{ started: boolean; reason?: string }> | null = null;

  constructor(private readonly db: UsageDatabase) {}

  getStatus() {
    return this.status;
  }

  async scan() {
    if (this.runningPromise) {
      return { started: false as const, reason: "running" };
    }

    this.status = {
      running: true,
      filesDone: 0,
      filesTotal: 0,
      lastFinishedAt: this.status.lastFinishedAt,
      warnings: [],
    };

    this.runningPromise = this.runScan();
    const result = await this.runningPromise;
    this.runningPromise = null;
    return result;
  }

  private async runScan() {
    const files = await this.collectFiles();
    this.status.filesTotal = files.length;

    for (const item of files) {
      try {
        await this.scanFile(item);
      } catch (error) {
        this.pushWarning(item.filePath, error instanceof Error ? error.message : "Unknown scan error");
      } finally {
        this.status.filesDone += 1;
      }
    }

    this.status.running = false;
    this.status.lastFinishedAt = new Date().toISOString();
    return { started: true as const };
  }

  private async collectFiles() {
    const [claudeFiles, codexFiles] = await Promise.all([
      glob(CLAUDE_GLOB, { windowsPathsNoEscape: true }),
      glob(CODEX_GLOB, { windowsPathsNoEscape: true }),
    ]);

    return [
      ...claudeFiles.map((filePath) => ({ source: "claude" as const, filePath })),
      ...codexFiles.map((filePath) => ({ source: "codex" as const, filePath })),
    ].sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  private async scanFile({ source, filePath }: ScanFile) {
    const stat = await fs.promises.stat(filePath);
    const previous = this.db.getScanState(filePath);
    const sizeShrank = previous && stat.size < previous.size_bytes;
    const sizeGrew = previous && stat.size > previous.size_bytes;
    const unchanged = previous && stat.size === previous.size_bytes && stat.mtimeMs === previous.mtime_ms;

    if (unchanged) {
      return;
    }

    let startOffset = 0;
    if (previous && sizeGrew && source === "claude") {
      startOffset = previous.byte_offset;
    }

    if (sizeShrank || (source === "codex" && sizeGrew)) {
      this.db.deleteUsageEventsByFile(filePath);
      startOffset = 0;
    }

    const input = fs.createReadStream(filePath, {
      encoding: "utf8",
      start: startOffset,
    });

    const lineReader = readline.createInterface({
      input,
      crlfDelay: Infinity,
    });

    if (source === "claude") {
      const parser = new ClaudeIncrementalParser(filePath);
      for await (const line of lineReader) {
        parser.consume(line);
      }
      this.db.upsertUsageEvents(parser.flush());
    } else {
      const snapshot = this.db.getCodexFileSnapshot(filePath);
      const parser = new CodexIncrementalParser(filePath, snapshot, 0);
      for await (const line of lineReader) {
        parser.consume(line);
      }
      const { events, latestRateLimit } = parser.flush();
      this.db.upsertUsageEvents(events);

      if (latestRateLimit) {
        const currentTs = this.db.getRateLimitTimestamp();
        if (!currentTs || latestRateLimit.tsUtc > currentTs) {
          this.db.setRateLimitSnapshot(latestRateLimit.tsUtc, latestRateLimit.data);
        }
      }
    }

    this.db.setScanState(filePath, stat.mtimeMs, stat.size, stat.size);
  }

  private pushWarning(filePath: string, message: string) {
    const warning: ScanWarning = { filePath, message };
    this.status.warnings = [...this.status.warnings, warning].slice(-50);
  }
}
