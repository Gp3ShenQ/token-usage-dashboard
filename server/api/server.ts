import { registerMonitorRoutes } from "../monitor/routes.js";
import type { SessionMonitorService } from "../monitor/service.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import dayjs from "dayjs";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  API_HOST,
  API_PORT,
  APP_TIMEZONE,
  CLAUDE_GLOB,
  CLAUDE_SESSIONS_DIR,
  CLAUDE_STATUS_SNAPSHOT,
  CODEX_GLOB,
  CODEX_SESSION_INDEX,
  SESSION_TASK_LABEL_DIR,
} from "../constants.js";
import { UsageDatabase } from "../db/database.js";
import { UsageScanner } from "../scanner/scanner.js";
import { percentChange, projectDisplayName } from "../utils.js";

function rangeDays(from: string, to: string) {
  const rows: string[] = [];
  let cursor = dayjs(from);
  const end = dayjs(to);

  while (cursor.isBefore(end) || cursor.isSame(end, "day")) {
    rows.push(cursor.format("YYYY-MM-DD"));
    cursor = cursor.add(1, "day");
  }

  return rows;
}

function rangeFromPreset(days: number) {
  const to = dayjs().format("YYYY-MM-DD");
  const from = dayjs().subtract(days - 1, "day").format("YYYY-MM-DD");
  return { from, to };
}

function conversationTokens(
  source: "claude" | "codex",
  row: { input: number; output: number; cache_read: number; cache_write: number } | { input: number; output: number; cacheRead: number; cacheWrite: number },
) {
  const cacheRead = "cache_read" in row ? row.cache_read : row.cacheRead;
  const cacheWrite = "cache_write" in row ? row.cache_write : row.cacheWrite;
  return Math.max(0, row.input - (source === "codex" ? cacheRead : 0)) + row.output + cacheWrite;
}
function totalTokens(
  row:
    | { input: number; output: number; cache_read: number; cache_write: number }
    | { input: number; output: number; cacheRead: number; cacheWrite: number },
) {
  const cacheRead = "cache_read" in row ? row.cache_read : row.cacheRead;
  const cacheWrite = "cache_write" in row ? row.cache_write : row.cacheWrite;
  return row.input + row.output + cacheRead + cacheWrite;
}

type ClaudeStatusSnapshot = {
  session_id?: string;
  model?: { display_name?: string };
  context_window?: {
    context_window_size?: number;
    total_input_tokens?: number;
    used_percentage?: number;
  };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
  timestamp?: string;
};

type CodexRateLimitWindow = {
  used_percent?: number;
  resets_at?: number;
  window_minutes?: number;
};

type CodexRateLimitWindows = {
  fiveHourEquivalent: CodexRateLimitWindow | null;
  sevenDay: CodexRateLimitWindow | null;
};

function codexRateLimitWindows(rateLimit: unknown) {
  const data = rateLimit as { primary?: CodexRateLimitWindow | null; secondary?: CodexRateLimitWindow | null } | null;
  const windows = [data?.primary, data?.secondary].filter((item): item is CodexRateLimitWindow => Boolean(item?.window_minutes));

  return windows.reduce<CodexRateLimitWindows>(
    (result, item) => {
      if (item.window_minutes === 300) {
        result.fiveHourEquivalent = item;
      }

      if (item.window_minutes === 10_080) {
        result.sevenDay = item;
      }

      return result;
    },
    { fiveHourEquivalent: null, sevenDay: null },
  );
}

function readClaudeStatusSnapshot() {
  try {
    if (!fs.existsSync(CLAUDE_STATUS_SNAPSHOT)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(CLAUDE_STATUS_SNAPSHOT, "utf8")) as ClaudeStatusSnapshot;
  } catch {
    return null;
  }
}

function readClaudeSessionEntry(sessionId: string): { running: boolean | null; projectName: string | null } {
  try {
    for (const name of fs.readdirSync(CLAUDE_SESSIONS_DIR)) {
      if (!name.endsWith(".json")) {
        continue;
      }

      try {
        const entry = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, name), "utf8")) as {
          sessionId?: string;
          status?: string;
          cwd?: string;
        };
        if (entry.sessionId === sessionId) {
          const running = entry.status === "busy" ? true : entry.status === "idle" ? false : null;
          const projectName = typeof entry.cwd === "string" ? path.basename(entry.cwd) : null;
          return { running, projectName };
        }
      } catch {
        // skip unreadable/unrelated entry
      }
    }
  } catch {
    // sessions dir missing or unreadable
  }

  return { running: null, projectName: null };
}

const NOISE_PHRASES = ["工作路徑"];

function cleanTaskLabel(label: string | null, projectName?: string | null): string | null {
  if (!label) {
    return label;
  }

  let cleaned = label;
  for (const phrase of NOISE_PHRASES) {
    cleaned = cleaned.split(phrase).join("");
  }
  if (projectName) {
    cleaned = cleaned.split(projectName).join("");
  }
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  return cleaned || null;
}

function readClaudeTaskLabel(sessionId: string, projectName: string | null): string | null {
  try {
    const filePath = path.join(SESSION_TASK_LABEL_DIR, `${sessionId}.task.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as { taskLabel?: string };
    return cleanTaskLabel(typeof data.taskLabel === "string" ? data.taskLabel : null, projectName);
  } catch {
    return null;
  }
}

function extractCodexTaskTitle(title: string | null): string | null {
  if (!title) {
    return null;
  }

  // Codex terminal titles follow "model · effort · cwd · task".
  // Claude labels do not use this format and deliberately bypass this helper.
  const parts = title.split(" · ");
  return parts.length >= 4 ? parts.slice(3).join(" · ") : title;
}

function readCodexTaskLabel(sessionId: string): string | null {
  try {
    if (!fs.existsSync(CODEX_SESSION_INDEX)) {
      return null;
    }

    const lines = fs.readFileSync(CODEX_SESSION_INDEX, "utf8").split("\n");
    let label: string | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { id?: string; thread_name?: string };
        if (entry.id === sessionId && typeof entry.thread_name === "string") {
          label = entry.thread_name;
        }
      } catch {
        // skip malformed line
      }
    }
    return cleanTaskLabel(extractCodexTaskTitle(label));
  } catch {
    return null;
  }
}

async function readSessionTaskLabels(sessions: Array<{ source: string; sessionId: string }>) {
  const labels = new Map<string, string>();
  const codexIds = new Set(sessions.filter((row) => row.source === "codex").map((row) => row.sessionId));
  if (codexIds.size) {
    const input = fs.createReadStream(CODEX_SESSION_INDEX, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try {
          const entry = JSON.parse(line) as { id?: string; thread_name?: string } | null;
          if (entry?.id && codexIds.has(entry.id) && typeof entry.thread_name === "string") {
            const label = cleanTaskLabel(extractCodexTaskTitle(entry.thread_name));
            if (label) labels.set(`codex:${entry.id}`, label);
          }
        } catch {
          // A malformed index line must not hide other historical tasks.
        }
      }
    } catch {
      // Missing metadata does not invalidate indexed usage.
    } finally {
      lines.close();
      input.destroy();
    }
  }
  for (const session of sessions) {
    if (session.source !== "claude" || !/^[a-zA-Z0-9_-]+$/.test(session.sessionId)) continue;
    const label = readClaudeTaskLabel(session.sessionId, null);
    if (label) labels.set(`claude:${session.sessionId}`, label);
  }
  return labels;
}

function isSessionDateRange(from: string, to: string) {
  const isDate = (value: string) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && dayjs(value).isValid() && dayjs(value).format("YYYY-MM-DD") === value;
  return isDate(from) && isDate(to) && from <= to;
}

export async function createApiServer(db: UsageDatabase, scanner: UsageScanner, monitor?: SessionMonitorService) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  if (monitor) registerMonitorRoutes(app, monitor);

  app.get<{ Querystring: { from?: string; to?: string } }>("/api/sessions", async (request, reply) => {
    const { from = "", to = "" } = request.query;
    if (!isSessionDateRange(from, to)) {
      return reply.code(400).send({ ok: false, error: "請選擇有效的日期區間，起日不可晚於迄日。" });
    }
    const sessions = db.getSessions(from, to);
    const labels = await readSessionTaskLabels(sessions);
    return { ok: true, data: sessions.map((row) => ({ ...row, taskLabel: labels.get(`${row.source}:${row.sessionId}`) ?? null })) };
  });

  app.get<{ Querystring: { source?: string; session?: string; from?: string; to?: string } }>("/api/sessions/daily", async (request, reply) => {
    const { source, session, from = "", to = "" } = request.query;
    if ((source !== "claude" && source !== "codex") || typeof session !== "string" || !session || session.length > 256 || !isSessionDateRange(from, to)) {
      return reply.code(400).send({ ok: false, error: "任務或日期區間無效。" });
    }
    return { ok: true, data: db.getSessionDaily(source, session, from, to) };
  });

  app.get("/api/summary", async (request) => {
    const query = request.query as { from?: string; to?: string };
    const { from, to } = query.from && query.to ? { from: query.from, to: query.to } : rangeFromPreset(7);
    const current = db.getSummary(from, to);
    const currentTotal =
      current.claude.input +
      current.claude.output +
      current.claude.cache_read +
      current.claude.cache_write +
      current.codex.input +
      current.codex.output +
      current.codex.cache_read +
      current.codex.cache_write;

    const span = Math.max(1, dayjs(to).diff(dayjs(from), "day") + 1);
    const prevTo = dayjs(from).subtract(1, "day").format("YYYY-MM-DD");
    const prevFrom = dayjs(from).subtract(span, "day").format("YYYY-MM-DD");
    const previous = db.getSummary(prevFrom, prevTo);
    const previousTotal =
      previous.claude.input +
      previous.claude.output +
      previous.claude.cache_read +
      previous.claude.cache_write +
      previous.codex.input +
      previous.codex.output +
      previous.codex.cache_read +
      previous.codex.cache_write;

    return {
      ok: true,
      data: {
        total: currentTotal,
        bySource: current,
        prevDelta: {
          total: previousTotal,
          percent: percentChange(currentTotal, previousTotal),
        },
      },
    };
  });

  app.get("/api/daily", async (request) => {
    const query = request.query as { from?: string; to?: string; metric?: "total" | "input" | "output" | "cache" };
    const { from, to } = query.from && query.to ? { from: query.from, to: query.to } : rangeFromPreset(30);
    const rows = db.getDaily(from, to, query.metric ?? "total");
    const grouped = new Map<string, { day: string; claude: number; codex: number }>();

    for (const day of rangeDays(from, to)) {
      grouped.set(day, { day, claude: 0, codex: 0 });
    }

    for (const row of rows) {
      const item = grouped.get(row.day);
      if (!item) {
        continue;
      }

      if (row.source === "claude" || row.source === "codex") {
        item[row.source as "claude" | "codex"] = row.value;
      }
    }

    return { ok: true, data: [...grouped.values()] };
  });

  app.get("/api/models", async (request) => {
    const query = request.query as { from?: string; to?: string };
    const { from, to } = query.from && query.to ? { from: query.from, to: query.to } : rangeFromPreset(30);
    return { ok: true, data: db.getModels(from, to) };
  });

  app.get("/api/projects", async (request) => {
    const query = request.query as { from?: string; to?: string };
    const { from, to } = query.from && query.to ? { from: query.from, to: query.to } : rangeFromPreset(30);
    const data = db.getProjects(from, to).map((row: { project: string; total: number }) => ({
      project: row.project,
      projectDisplay: projectDisplayName(row.project),
      total: row.total,
    }));
    return { ok: true, data };
  });

  app.get("/api/ratelimit", async () => {
    const snapshot = db.getRateLimitSnapshot();
    return { ok: true, data: codexRateLimitWindows(snapshot.data) };
  });

  app.get("/api/widget", async () => {
    const now = dayjs();
    const claudeSession = db.getLatestSessionUsage("claude");
    const codexSession = db.getLatestSessionUsage("codex");
    const latestClaudeEvent = db.getLatestUsageEvent("claude");
    const latestCodexEvent = db.getLatestUsageEvent("codex");
    const codex5h = db.getUsageSince("codex", now.subtract(5, "hour").toISOString());
    const codex7d = db.getUsageSince("codex", now.subtract(7, "day").toISOString());
    const rateLimit = db.getRateLimitSnapshot();
    const codexLimits = codexRateLimitWindows(rateLimit.data);
    const claudeStatus = readClaudeStatusSnapshot();

    return {
      ok: true,
      data: {
        updatedAt: now.toISOString(),
        claude: {
          sessionId: claudeStatus?.session_id ?? latestClaudeEvent?.sessionId ?? claudeSession?.sessionId ?? null,
          contextTokens: claudeStatus?.context_window?.total_input_tokens ?? (latestClaudeEvent ? totalTokens(latestClaudeEvent) : 0),
          lastConversationTokens: latestClaudeEvent ? conversationTokens("claude", latestClaudeEvent) : 0,
          contextWindowSize: claudeStatus?.context_window?.context_window_size ?? 0,
          contextPercent: claudeStatus?.context_window?.used_percentage ?? 0,
          lastEventAt: claudeStatus?.timestamp ?? latestClaudeEvent?.tsUtc ?? claudeSession?.lastTs ?? null,
          fiveHourPercent: claudeStatus?.rate_limits?.five_hour?.used_percentage ?? null,
          fiveHourResetsAt: claudeStatus?.rate_limits?.five_hour?.resets_at ?? null,
          sevenDayPercent: claudeStatus?.rate_limits?.seven_day?.used_percentage ?? null,
          sevenDayResetsAt: claudeStatus?.rate_limits?.seven_day?.resets_at ?? null,
          statusSource: claudeStatus ? "snapshot" : "local",
        },
        codex: {
          sessionId: latestCodexEvent?.sessionId ?? codexSession?.sessionId ?? null,
          contextTokens: latestCodexEvent ? totalTokens(latestCodexEvent) : 0,
          lastConversationTokens: latestCodexEvent ? conversationTokens("codex", latestCodexEvent) : 0,
          lastEventAt: latestCodexEvent?.tsUtc ?? codexSession?.lastTs ?? null,
          fiveHourTokens: totalTokens(codex5h),
          sevenDayTokens: totalTokens(codex7d),
          fiveHourPercent: codexLimits.fiveHourEquivalent?.used_percent ?? null,
          fiveHourResetsAt: codexLimits.fiveHourEquivalent?.resets_at ?? null,
          sevenDayPercent: codexLimits.sevenDay?.used_percent ?? null,
          sevenDayResetsAt: codexLimits.sevenDay?.resets_at ?? null,
        },
      },
    };
  });

  app.get("/api/session-context", async (request) => {
    const query = request.query as { source?: string; session?: string };
    if (
      (query.source !== "claude" && query.source !== "codex") ||
      !query.session ||
      !/^[0-9a-f-]{8,36}$/i.test(query.session)
    ) {
      return { ok: false, data: { state: "pending" } };
    }

    const context = db.getSessionContextEvent(query.source, query.session);
    if (context.state !== "ready") {
      return { ok: true, data: context };
    }

    const { running, projectName } =
      query.source === "claude" ? readClaudeSessionEntry(context.sessionId) : { running: null, projectName: null };
    const taskLabel =
      query.source === "claude" ? readClaudeTaskLabel(context.sessionId, projectName) : readCodexTaskLabel(context.sessionId);

    return { ok: true, data: { ...context, running, taskLabel } };
  });

  app.post("/api/scan", async () => {
    const result = await scanner.scan();
    return { ok: true, data: result };
  });

  app.get("/api/scan/status", async () => {
    return { ok: true, data: scanner.getStatus() };
  });

  app.get("/api/meta", async () => {
    return {
      ok: true,
      data: {
        timezone: APP_TIMEZONE,
        paths: {
          claude: CLAUDE_GLOB,
          codex: CODEX_GLOB,
        },
        stats: db.getStats(),
      },
    };
  });

  return {
    app,
    async listen() {
      await app.listen({ host: API_HOST, port: API_PORT });
    },
    async close() {
      await app.close();
    },
  };
}
