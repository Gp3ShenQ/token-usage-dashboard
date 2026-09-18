export type { MonitorResult, MonitorSnapshot } from "../server/monitor/state";
import type { SessionTask, SessionDay } from "../server/types";
export type { SessionTask, SessionDay } from "../server/types";

const API_BASE = "http://127.0.0.1:5180";

async function requestSessions<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}?${new URLSearchParams(params)}`, { signal });
  const json = await response.json() as { ok: boolean; data: T; error?: string };
  if (!response.ok || !json.ok) throw new Error(json.error ?? "無法載入任務資料，請稍後重試。");
  return json.data;
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  const json = (await response.json()) as { ok: boolean; data: T };
  if (!response.ok || !json.ok) throw new Error("無法更新資料。");
  return json.data;
}

export type SummaryResponse = {
  total: number;
  bySource: {
    claude: { input: number; output: number; cache_read: number; cache_write: number };
    codex: { input: number; output: number; cache_read: number; cache_write: number };
  };
  prevDelta: { total: number; percent: number };
};

export type DailyRow = { day: string; claude: number; codex: number };
export type ModelRow = { model: string; source: string; input: number; output: number; cache_read: number; cache_write: number; total: number };
export type ProjectRow = { project: string; projectDisplay: string; total: number };
export type RateLimitWindow = { used_percent?: number; resets_at?: number };
export type RateLimitPayload = {
  fiveHourEquivalent: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
};
export type ScanStatusResponse = {
  running: boolean;
  filesDone: number;
  filesTotal: number;
  lastFinishedAt: string | null;
  warnings: Array<{ filePath: string; message: string }>;
};
export type MetaResponse = {
  timezone: string;
  paths: { claude: string; codex: string };
  stats: { indexedFiles: number; latestUsage: string | null };
};
export type WidgetResponse = {
  updatedAt: string;
  claude: {
    sessionId: string | null;
    contextTokens: number;
    lastConversationTokens: number;
    contextWindowSize: number;
    contextPercent: number;
    lastEventAt: string | null;
    fiveHourPercent: number | null;
    fiveHourResetsAt: number | null;
    sevenDayPercent: number | null;
    sevenDayResetsAt: number | null;
    statusSource: "snapshot" | "local";
  };
  codex: {
    sessionId: string | null;
    contextTokens: number;
    lastConversationTokens: number;
    lastEventAt: string | null;
    fiveHourTokens: number;
    sevenDayTokens: number;
    fiveHourPercent: number | null;
    fiveHourResetsAt: number | null;
    sevenDayPercent: number | null;
    sevenDayResetsAt: number | null;
  };
};

export type SessionContextResponse =
  | {
      state: "ready";
      sessionId: string;
      tsUtc: string;
      input: number;
      conversationTokens: number;
      running: boolean | null;
      taskLabel: string | null;
    }
  | { state: "pending" | "ambiguous" };

export const api = {
  monitorStream: (source: "claude" | "codex", session: string) =>
    new EventSource(`${API_BASE}/api/monitor/stream?${new URLSearchParams({ source, session })}`),
  sessions: (from: string, to: string, signal?: AbortSignal) =>
    requestSessions<SessionTask[]>("/api/sessions", { from, to }, signal),
  sessionDaily: (source: string, session: string, from: string, to: string, signal?: AbortSignal) =>
    requestSessions<SessionDay[]>("/api/sessions/daily", { source, session, from, to }, signal),
  summary: (from: string, to: string) => request<SummaryResponse>(`/api/summary?from=${from}&to=${to}`),
  daily: (from: string, to: string, metric: string) => request<DailyRow[]>(`/api/daily?from=${from}&to=${to}&metric=${metric}`),
  models: (from: string, to: string) => request<ModelRow[]>(`/api/models?from=${from}&to=${to}`),
  projects: (from: string, to: string) => request<ProjectRow[]>(`/api/projects?from=${from}&to=${to}`),
  rateLimit: () => request<RateLimitPayload>(`/api/ratelimit`),
  scanStatus: () => request<ScanStatusResponse>(`/api/scan/status`),
  meta: () => request<MetaResponse>(`/api/meta`),
  widget: () => request<WidgetResponse>(`/api/widget`),
  sessionContext: (source: "codex" | "claude", session: string) =>
    request<SessionContextResponse>(`/api/session-context?source=${source}&session=${encodeURIComponent(session)}`),
  async triggerScan() {
    const response = await fetch(`${API_BASE}/api/scan`, { method: "POST" });
    const json = (await response.json()) as { ok: boolean; data: { started: boolean; reason?: string } };
    return json.data;
  },
};
