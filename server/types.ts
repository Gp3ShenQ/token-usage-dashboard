export type UsageSource = "claude" | "codex";

export type SessionUsage = {
  source: UsageSource;
  sessionId: string;
  project: string | null;
  models: string[];
  firstTs: string;
  lastTs: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type SessionTask = SessionUsage & { taskLabel: string | null };
export type SessionDay = { day: string; total: number };

export type UsageEvent = {
  source: UsageSource;
  sessionId: string;
  project: string | null;
  model: string;
  tsUtc: string;
  dayLocal: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  dedupKey: string;
};

export type ScanStateRow = {
  file_path: string;
  mtime_ms: number;
  size_bytes: number;
  byte_offset: number;
};

export type RateLimitSnapshot = {
  tsUtc: string | null;
  json: unknown | null;
};

export type ScanWarning = {
  filePath: string;
  message: string;
};

export type ScanStatus = {
  running: boolean;
  filesDone: number;
  filesTotal: number;
  lastFinishedAt: string | null;
  warnings: ScanWarning[];
};
