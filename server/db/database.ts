import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getDatabasePath } from "../constants.js";
import type { ScanStateRow, SessionDay, SessionUsage, UsageEvent, UsageSource } from "../types.js";

export class UsageDatabase {
  private readonly db: any;

  constructor(dbPath = getDatabasePath()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.normalizeLegacyCodexSessionIds();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project TEXT NULL,
        model TEXT NOT NULL,
        ts_utc TEXT NOT NULL,
        day_local TEXT NOT NULL,
        input INTEGER DEFAULT 0,
        output INTEGER DEFAULT 0,
        cache_read INTEGER DEFAULT 0,
        cache_write INTEGER DEFAULT 0,
        dedup_key TEXT NOT NULL UNIQUE
      );

      CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_events(day_local, source);

      CREATE TABLE IF NOT EXISTS scan_state (
        file_path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rate_limit_snapshot (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        ts_utc TEXT,
        json TEXT
      );
    `);
  }

  private normalizeLegacyCodexSessionIds() {
    const rows = this.db
      .prepare("SELECT DISTINCT session_id AS sessionId FROM usage_events WHERE source = 'codex'")
      .all() as Array<{ sessionId: string }>;
    const legacySessionIdPattern = /-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i;
    const update = this.db.prepare("UPDATE usage_events SET session_id = ? WHERE source = 'codex' AND session_id = ?");
    const normalize = this.db.transaction((items: Array<{ sessionId: string }>) => {
      for (const { sessionId } of items) {
        const normalizedSessionId = sessionId.match(legacySessionIdPattern)?.[1];
        if (normalizedSessionId && normalizedSessionId !== sessionId) {
          update.run(normalizedSessionId, sessionId);
        }
      }
    });

    normalize(rows);
  }
  close() {
    this.db.close();
  }

  getScanState(filePath: string) {
    return this.db
      .prepare("SELECT file_path, mtime_ms, size_bytes, byte_offset FROM scan_state WHERE file_path = ?")
      .get(filePath) as ScanStateRow | undefined;
  }

  setScanState(filePath: string, mtimeMs: number, sizeBytes: number, byteOffset: number) {
    this.db
      .prepare(
        `
          INSERT INTO scan_state(file_path, mtime_ms, size_bytes, byte_offset)
          VALUES(@filePath, @mtimeMs, @sizeBytes, @byteOffset)
          ON CONFLICT(file_path) DO UPDATE SET
            mtime_ms = excluded.mtime_ms,
            size_bytes = excluded.size_bytes,
            byte_offset = excluded.byte_offset
        `,
      )
      .run({ filePath, mtimeMs, sizeBytes, byteOffset });
  }

  upsertUsageEvents(events: UsageEvent[]) {
    const statement = this.db.prepare(`
      INSERT INTO usage_events(
        source, session_id, project, model, ts_utc, day_local, input, output, cache_read, cache_write, dedup_key
      )
      VALUES(
        @source, @sessionId, @project, @model, @tsUtc, @dayLocal, @input, @output, @cacheRead, @cacheWrite, @dedupKey
      )
      ON CONFLICT(dedup_key) DO UPDATE SET
        source = excluded.source,
        session_id = excluded.session_id,
        project = excluded.project,
        model = excluded.model,
        ts_utc = excluded.ts_utc,
        day_local = excluded.day_local,
        input = excluded.input,
        output = excluded.output,
        cache_read = excluded.cache_read,
        cache_write = excluded.cache_write
    `);

    const transaction = this.db.transaction((rows: UsageEvent[]) => {
      for (const row of rows) {
        statement.run(row);
      }
    });

    transaction(events);
  }

  deleteUsageEventsByFile(filePath: string) {
    this.db.prepare("DELETE FROM usage_events WHERE dedup_key LIKE ?").run(`${filePath}:%`);
  }

  getCodexFileSnapshot(filePath: string) {
    const row = this.db
      .prepare(
        `
          SELECT
            COALESCE(SUM(input), 0) AS input,
            COALESCE(SUM(output), 0) AS output,
            COALESCE(SUM(cache_read), 0) AS cache_read,
            (
              SELECT model
              FROM usage_events
              WHERE dedup_key LIKE ?
              ORDER BY ts_utc DESC, id DESC
              LIMIT 1
            ) AS model
          FROM usage_events
          WHERE dedup_key LIKE ?
        `,
      )
      .get(`${filePath}:%`, `${filePath}:%`) as
      | {
          input: number | null;
          output: number | null;
          cache_read: number | null;
          model: string | null;
        }
      | undefined;

    return {
      input: row?.input ?? 0,
      output: row?.output ?? 0,
      cacheRead: row?.cache_read ?? 0,
      model: row?.model ?? "unknown",
    };
  }

  setRateLimitSnapshot(tsUtc: string, payload: unknown) {
    this.db
      .prepare(
        `
          INSERT INTO rate_limit_snapshot(id, ts_utc, json)
          VALUES(1, @tsUtc, @json)
          ON CONFLICT(id) DO UPDATE SET
            ts_utc = excluded.ts_utc,
            json = excluded.json
        `,
      )
      .run({ tsUtc, json: JSON.stringify(payload) });
  }

  getRateLimitTimestamp() {
    const row = this.db.prepare("SELECT ts_utc FROM rate_limit_snapshot WHERE id = 1").get() as { ts_utc: string | null } | undefined;
    return row?.ts_utc ?? null;
  }

  getRateLimitSnapshot() {
    const row = this.db.prepare("SELECT ts_utc, json FROM rate_limit_snapshot WHERE id = 1").get() as
      | { ts_utc: string | null; json: string | null }
      | undefined;
    return row
      ? {
          tsUtc: row.ts_utc,
          data: row.json ? JSON.parse(row.json) : null,
        }
      : { tsUtc: null, data: null };
  }

  getSetting(key: string) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.db
      .prepare(
        `
          INSERT INTO settings(key, value)
          VALUES(?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
      )
      .run(key, value);
  }

  getSummary(from: string, to: string) {
    const rows = this.db
      .prepare(
        `
          SELECT
            source,
            COALESCE(SUM(input), 0) AS input,
            COALESCE(SUM(output), 0) AS output,
            COALESCE(SUM(cache_read), 0) AS cache_read,
            COALESCE(SUM(cache_write), 0) AS cache_write
          FROM usage_events
          WHERE day_local BETWEEN ? AND ?
          GROUP BY source
        `,
      )
      .all(from, to) as Array<{ source: string; input: number; output: number; cache_read: number; cache_write: number }>;

    const empty = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    const bySource = {
      claude: { ...empty },
      codex: { ...empty },
    };

    for (const row of rows) {
      if (row.source === "claude" || row.source === "codex") {
        bySource[row.source as "claude" | "codex"] = {
          input: row.input,
          output: row.output,
          cache_read: row.cache_read,
          cache_write: row.cache_write,
        };
      }
    }

    return bySource;
  }

  getDaily(from: string, to: string, metric: "total" | "input" | "output" | "cache") {
    const metricSql =
      metric === "input"
        ? "input"
        : metric === "output"
          ? "output"
          : metric === "cache"
            ? "(cache_read + cache_write)"
            : "(input + output + cache_read + cache_write)";

    return this.db
      .prepare(
        `
          SELECT day_local AS day, source, COALESCE(SUM(${metricSql}), 0) AS value
          FROM usage_events
          WHERE day_local BETWEEN ? AND ?
          GROUP BY day_local, source
          ORDER BY day_local ASC
        `,
      )
      .all(from, to) as Array<{ day: string; source: string; value: number }>;
  }

  getModels(from: string, to: string) {
    return this.db
      .prepare(
        `
          SELECT
            model,
            source,
            COALESCE(SUM(input), 0) AS input,
            COALESCE(SUM(output), 0) AS output,
            COALESCE(SUM(cache_read), 0) AS cache_read,
            COALESCE(SUM(cache_write), 0) AS cache_write,
            COALESCE(SUM(input + output + cache_read + cache_write), 0) AS total
          FROM usage_events
          WHERE day_local BETWEEN ? AND ?
          GROUP BY model, source
          ORDER BY total DESC, model ASC
        `,
      )
      .all(from, to) as Array<{
        model: string;
        source: string;
        input: number;
        output: number;
        cache_read: number;
        cache_write: number;
        total: number;
      }>;
  }

  getProjects(from: string, to: string) {
    return this.db
      .prepare(
        `
          SELECT project, COALESCE(SUM(input + output + cache_read + cache_write), 0) AS total
          FROM usage_events
          WHERE source = 'claude' AND project IS NOT NULL AND day_local BETWEEN ? AND ?
          GROUP BY project
          ORDER BY total DESC
        `,
      )
      .all(from, to) as Array<{ project: string; total: number }>;
  }

  getSessions(from: string, to: string): SessionUsage[] {
    const rows = this.db.prepare(`
      SELECT source, session_id AS sessionId, MAX(project) AS project,
        json_group_array(DISTINCT model) AS models,
        MIN(ts_utc) AS firstTs, MAX(ts_utc) AS lastTs,
        SUM(input) AS input, SUM(output) AS output,
        SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite,
        SUM(input + output + cache_read + cache_write) AS total
      FROM usage_events WHERE day_local BETWEEN ? AND ?
      GROUP BY source, session_id
      ORDER BY total DESC, source ASC, session_id ASC
    `).all(from, to) as Array<Omit<SessionUsage, "models"> & { models: string }>;
    return rows.map((row) => ({ ...row, models: (JSON.parse(row.models) as string[]).sort() }));
  }

  getSessionDaily(source: UsageSource, sessionId: string, from: string, to: string): SessionDay[] {
    return this.db.prepare(`
      SELECT day_local AS day, SUM(input + output + cache_read + cache_write) AS total
      FROM usage_events
      WHERE source = ? AND session_id = ? AND day_local BETWEEN ? AND ?
      GROUP BY day_local ORDER BY day_local ASC
    `).all(source, sessionId, from, to) as SessionDay[];
  }

  getLatestSessionUsage(source: "claude" | "codex") {
    const row = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            COALESCE(SUM(input), 0) AS input,
            COALESCE(SUM(output), 0) AS output,
            COALESCE(SUM(cache_read), 0) AS cache_read,
            COALESCE(SUM(cache_write), 0) AS cache_write,
            MAX(ts_utc) AS lastTs
          FROM usage_events
          WHERE source = ?
            AND session_id = (
              SELECT session_id
              FROM usage_events
              WHERE source = ?
              ORDER BY ts_utc DESC, id DESC
              LIMIT 1
            )
        `,
      )
      .get(source, source) as
      | {
          sessionId: string | null;
          input: number;
          output: number;
          cache_read: number;
          cache_write: number;
          lastTs: string | null;
        }
      | undefined;

    return row ?? null;
  }

  getLatestUsageEvent(source: "claude" | "codex") {
    const row = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            project,
            model,
            ts_utc AS tsUtc,
            input,
            output,
            cache_read AS cacheRead,
            cache_write AS cacheWrite
          FROM usage_events
          WHERE source = ?
          ORDER BY ts_utc DESC, id DESC
          LIMIT 1
        `,
      )
      .get(source) as
      | {
          sessionId: string | null;
          project: string | null;
          model: string | null;
          tsUtc: string | null;
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
        }
      | undefined;

    return row ?? null;
  }

  getSessionContextEvent(source: "claude" | "codex", sessionPrefix: string) {
    const matches = this.db
      .prepare(
        `
          SELECT DISTINCT session_id AS sessionId
          FROM usage_events
          WHERE source = ? AND lower(session_id) LIKE ?
          LIMIT 2
        `,
      )
      .all(source, `${sessionPrefix.toLowerCase()}%`) as Array<{ sessionId: string }>;

    if (matches.length !== 1) {
      return { state: matches.length === 0 ? "pending" : "ambiguous" } as const;
    }

    const row = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            ts_utc AS tsUtc,
            input,
            CASE WHEN source = 'codex' THEN MAX(0, input - cache_read) + output + cache_write ELSE input + output + cache_write END AS conversationTokens
          FROM usage_events
          WHERE source = ? AND session_id = ?
          ORDER BY ts_utc DESC, id DESC
          LIMIT 1
        `,
      )
      .get(source, matches[0].sessionId) as { sessionId: string; tsUtc: string; input: number; conversationTokens: number } | undefined;

    return row ? { state: "ready", ...row } as const : { state: "pending" } as const;
  }

  getUsageSince(source: "claude" | "codex", tsUtcFrom: string) {
    const row = this.db
      .prepare(
        `
          SELECT
            COALESCE(SUM(input), 0) AS input,
            COALESCE(SUM(output), 0) AS output,
            COALESCE(SUM(cache_read), 0) AS cache_read,
            COALESCE(SUM(cache_write), 0) AS cache_write
          FROM usage_events
          WHERE source = ? AND ts_utc >= ?
        `,
      )
      .get(source, tsUtcFrom) as
      | {
          input: number;
          output: number;
          cache_read: number;
          cache_write: number;
        }
      | undefined;

    return (
      row ?? {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
      }
    );
  }

  getStats() {
    const indexedFiles = (this.db.prepare("SELECT COUNT(*) AS total FROM scan_state").get() as { total: number } | undefined)?.total ?? 0;
    const latestUsage =
      (this.db.prepare("SELECT MAX(ts_utc) AS ts_utc FROM usage_events").get() as { ts_utc: string | null } | undefined)?.ts_utc ?? null;
    return { indexedFiles, latestUsage };
  }
}
