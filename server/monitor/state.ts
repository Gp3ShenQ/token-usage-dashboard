export type AgentSource = "claude" | "codex";
export type RunStatus = "unknown" | "running" | "waiting_input" | "waiting_approval" | "idle" | "interrupted" | "error" | "ended";
export type MonitorSnapshot = {
  source: AgentSource;
  sessionId: string;
  cwd?: string;
  status: RunStatus;
  statusAt: string | null;
  turnId: string | null;
  turnStartedAt: string | null;
  turnEndedAt: string | null;
  model: string | null;
  effort: string | null;
  contextPercent: number | null;
  contextWindow: number | null;
  sessionTokens: number | null;
  turnTokens: number | null;
  sourceUpdatedAt: string | null;
  observedAt: string | null;
  readError: boolean;
};
export type MonitorResult = { state: "ready"; data: MonitorSnapshot } | { state: "pending" | "ambiguous" };
export type MonitorRecord = {
  source: AgentSource;
  sessionId: string;
  event: string;
  eventId: string;
  timestamp: string;
  turnId?: string;
  toolName?: string;
  toolUseId?: string;
  model?: string;
  transcriptPath?: string;
  snapshot?: Record<string, any>;
};
const tokenValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const sum = (...values: unknown[]) => values.reduce<number>((total, value) => total + (tokenValue(value) ?? 0), 0);
const textValue = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const terminalStatuses: RunStatus[] = ["idle", "interrupted", "error", "ended"];

export class SessionMonitorState {
  readonly data: MonitorSnapshot;
  private claudeMessages = new Map<string, { tokens: number; timestamp: string }>();
  private codexTotal = 0;
  private codexBaseline = 0;
  private hookIds = new Set<string>();
  private cwdAt = "";
  private modelAt = "";
  private effortAt = "";
  private contextAt = "";
  private waitingTools = new Map<string, RunStatus>();
  private pendingTurnHooks = new Map<string, MonitorRecord[]>();

  constructor(source: AgentSource, sessionId: string) {
    this.data = { source, sessionId, status: "unknown", statusAt: null, turnId: null, turnStartedAt: null,
      turnEndedAt: null, model: null, effort: null, contextPercent: null, contextWindow: null,
      sessionTokens: null, turnTokens: null, sourceUpdatedAt: null, observedAt: null, readError: false };
  }

  private timestamp(value: unknown) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
    const timestamp = new Date(value).toISOString();
    if (!this.data.sourceUpdatedAt || timestamp > this.data.sourceUpdatedAt) this.data.sourceUpdatedAt = timestamp;
    return timestamp;
  }

  private status(status: RunStatus, timestamp: string) {
    if (this.data.statusAt && timestamp < this.data.statusAt) return;
    // Repeated stop events must not move the turn's end or create another notification.
    if (this.data.status === status && terminalStatuses.includes(status)) return;
    if (terminalStatuses.includes(status)) this.waitingTools.clear();
    this.data.status = status;
    this.data.statusAt = timestamp;
    this.data.turnEndedAt = terminalStatuses.includes(status) ? timestamp : null;
    this.updateClaudeTurnTokens();
  }

  private updateClaudeTurnTokens() {
    if (this.data.source !== "claude" || !this.data.turnStartedAt) return;
    let total = 0;
    for (const row of this.claudeMessages.values()) {
      if (row.timestamp >= this.data.turnStartedAt && (!this.data.turnEndedAt || row.timestamp <= this.data.turnEndedAt)) total += row.tokens;
    }
    this.data.turnTokens = total;
  }

  private begin(turnId: string, timestamp: string) {
    if (this.data.source === "claude" && this.data.statusAt && timestamp < this.data.statusAt) return;
    if (this.data.turnStartedAt && timestamp < this.data.turnStartedAt) return;
    if (turnId !== this.data.turnId) {
      this.waitingTools.clear();
      this.data.turnId = turnId;
      this.data.turnStartedAt = timestamp;
      this.codexBaseline = this.codexTotal;
      this.data.turnTokens = 0;
    }
    this.status("running", timestamp);
    const pending = this.pendingTurnHooks.get(turnId) ?? [];
    this.pendingTurnHooks.delete(turnId);
    for (const record of pending) {
      this.hookIds.delete(record.eventId);
      this.acceptHook(record);
    }
  }

  private model(model: unknown, timestamp: string, effort?: unknown) {
    if (timestamp >= this.modelAt) {
      const name = textValue(model);
      if (name) this.data.model = name;
      this.modelAt = timestamp;
    }
    if (effort !== undefined && timestamp >= this.effortAt) {
      this.data.effort = textValue(effort);
      this.effortAt = timestamp;
    }
  }

  acceptHook(record: MonitorRecord) {
    if (record?.source !== this.data.source || record.sessionId !== this.data.sessionId ||
      typeof record.eventId !== "string" || this.hookIds.has(record.eventId)) return;
    const timestamp = this.timestamp(record.timestamp);
    if (!timestamp) return;
    this.hookIds.add(record.eventId);
    if (this.hookIds.size > 2000) this.hookIds.delete(this.hookIds.values().next().value!);
    if (record.event === "StatusLine" && record.snapshot?.session_id === this.data.sessionId) {
      const snapshot = record.snapshot;
      this.model(snapshot.model?.display_name ?? snapshot.model?.id, timestamp, snapshot.effort?.level ?? null);
      if (timestamp >= this.contextAt) {
        this.contextAt = timestamp;
        this.data.contextWindow = tokenValue(snapshot.context_window?.context_window_size);
        const percent = tokenValue(snapshot.context_window?.used_percentage);
        this.data.contextPercent = percent === null ? null : Math.min(100, percent);
      }
      return;
    }
    if (record.turnId && record.turnId !== this.data.turnId &&
      !["UserPromptSubmit", "SessionStart"].includes(record.event)) {
      const pending = this.pendingTurnHooks.get(record.turnId) ?? [];
      if (pending.length < 64) pending.push(record);
      this.pendingTurnHooks.set(record.turnId, pending);
      if (this.pendingTurnHooks.size > 8) this.pendingTurnHooks.delete(this.pendingTurnHooks.keys().next().value!);
      return;
    }
    if (record.model) this.model(record.model, timestamp);
    if (this.data.statusAt && timestamp < this.data.statusAt) return;
    const toolKey = record.toolUseId ?? record.toolName ?? "pending-tool";
    const refreshToolStatus = () => this.status(
      [...this.waitingTools.values()].includes("waiting_approval") ? "waiting_approval" :
      this.waitingTools.size ? "waiting_input" : "running", timestamp);
    switch (record.event) {
      case "SessionStart":
        if (!this.data.statusAt || timestamp >= this.data.statusAt) {
          this.waitingTools.clear();
          this.data.turnId = null;
          this.data.turnStartedAt = null;
          this.data.turnTokens = null;
          this.status("unknown", timestamp);
        }
        break;
      case "UserPromptSubmit":
        // Codex logs own the turn id and token baseline. Hook delivery can lag behind them.
        if (this.data.source === "claude") this.begin(record.turnId ?? record.eventId, timestamp);
        else this.status("running", timestamp);
        break;
      case "PermissionRequest":
        this.waitingTools.set(toolKey, "waiting_approval");
        refreshToolStatus();
        break;
      case "PreToolUse":
        if (/AskUserQuestion|request_user_input/.test(record.toolName ?? "")) this.waitingTools.set(toolKey, "waiting_input");
        if (/ExitPlanMode/.test(record.toolName ?? "")) this.waitingTools.set(toolKey, "waiting_approval");
        refreshToolStatus();
        break;
      case "PostToolUse":
      case "PostToolUseFailure":
        if (!record.toolUseId && !record.toolName) this.waitingTools.clear();
        else this.waitingTools.delete(toolKey);
        refreshToolStatus();
        break;
      case "Stop":
        if (this.data.source === "claude" && !["interrupted", "error", "ended"].includes(this.data.status)) this.status("idle", timestamp);
        break;
      case "Interrupt": this.status("interrupted", timestamp); break;
      case "StopFailure": this.status("error", timestamp); break;
      case "SessionEnd": this.status("ended", timestamp); break;
    }
  }

  acceptLog(record: any) {
    if (!record || typeof record !== "object") return;
    const timestamp = this.timestamp(record.timestamp);
    if (!timestamp) return;
    const cwd = this.data.source === "claude" ? (!record.isSidechain ? record.cwd : null) :
      ["session_meta", "turn_context"].includes(record.type) ? record.payload?.cwd : null;
    if (typeof cwd === "string" && cwd.trim() && timestamp >= this.cwdAt) {
      this.data.cwd = cwd;
      this.cwdAt = timestamp;
    }
    if (this.data.source === "claude") {
      const message = record.message;
      const content = message?.content;
      const interrupted = typeof content === "string" ? content :
        Array.isArray(content) && content.length === 1 && content[0]?.type === "text" ? content[0].text : null;
      if (record.type === "user" && !record.isSidechain &&
        /^\[Request interrupted by user(?: for tool use)?\]$/.test(interrupted ?? "")) {
        this.status("interrupted", timestamp);
        return;
      }
      if (message?.role !== "assistant" || typeof message.id !== "string" || !message.usage || message.model === "<synthetic>") return;
      const usage = message.usage;
      const tokens = sum(usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens);
      const previous = this.claudeMessages.get(message.id);
      this.claudeMessages.set(message.id, { tokens, timestamp });
      this.data.sessionTokens = (this.data.sessionTokens ?? 0) + tokens - (previous?.tokens ?? 0);
      if (!record.isSidechain) this.model(message.model, timestamp);
      if (this.data.turnStartedAt) {
        const belongs = (row: { timestamp: string }) => row.timestamp >= this.data.turnStartedAt! &&
          (!this.data.turnEndedAt || row.timestamp <= this.data.turnEndedAt);
        this.data.turnTokens = (this.data.turnTokens ?? 0) + (belongs({ timestamp }) ? tokens : 0) -
          (previous && belongs(previous) ? previous.tokens : 0);
      }
      return;
    }
    const payload = record.payload;
    if (!payload || typeof payload !== "object") return;
    if (record.type === "turn_context") this.model(payload.model, timestamp, payload.effort ?? null);
    if (record.type !== "event_msg") return;
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      this.begin(payload.turn_id, timestamp);
      this.data.contextWindow = tokenValue(payload.model_context_window) ?? this.data.contextWindow;
    }
    if (["task_complete", "turn_aborted"].includes(payload.type) &&
      (!payload.turn_id || payload.turn_id === this.data.turnId) &&
      (payload.type !== "task_complete" || !["error", "interrupted", "ended"].includes(this.data.status))) {
      this.status(payload.type === "task_complete" ? "idle" : "interrupted", timestamp);
    }
    if (payload.type === "error") this.status("error", timestamp);
    if (payload.type !== "token_count" || !payload.info) return;
    const total = payload.info.total_token_usage;
    if (total) {
      // cached_input_tokens is already part of Codex input_tokens.
      const nextTotal = tokenValue(total.total_tokens) ?? sum(total.input_tokens, total.output_tokens);
      if (nextTotal >= this.codexTotal) {
        this.codexTotal = nextTotal;
        this.data.sessionTokens = nextTotal;
        this.data.turnTokens = this.data.turnId ? Math.max(0, nextTotal - this.codexBaseline) : null;
      }
    }
    if (timestamp < this.contextAt) return;
    this.contextAt = timestamp;
    this.data.contextWindow = tokenValue(payload.info.model_context_window) ?? this.data.contextWindow;
    const last = payload.info.last_token_usage;
    const contextTokens = last ? tokenValue(last.total_tokens) ?? sum(last.input_tokens, last.output_tokens) : null;
    this.data.contextPercent = contextTokens !== null && this.data.contextWindow ? Math.min(100, contextTokens / this.data.contextWindow * 100) : null;
  }
}
