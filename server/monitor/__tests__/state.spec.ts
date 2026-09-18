import { describe, expect, it } from "vitest";
import { SessionMonitorState, type MonitorRecord } from "../state.js";

const timestamp = (second: number) => new Date(Date.UTC(2026, 8, 18, 0, 0, second)).toISOString();
const hook = (event: string, second: number, extra: Partial<MonitorRecord> = {}): MonitorRecord =>
  ({ source: "claude", sessionId: "session-one", event, eventId: event + second, timestamp: timestamp(second), ...extra });
const usage = (id: string, second: number, output: number, extra = {}) => ({
  timestamp: timestamp(second), message: { role: "assistant", id, model: "claude-test",
    usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } }, ...extra,
});
const codex = (type: string, second: number, payload = {}) => ({ timestamp: timestamp(second), type: "event_msg", payload: { type, ...payload } });

describe("session monitor state", () => {
  it("counts the final streamed Claude usage once and isolates each turn", () => {
    const state = new SessionMonitorState("claude", "session-one");
    state.acceptHook(hook("UserPromptSubmit", 1));
    state.acceptLog(usage("message-1", 2, 2));
    state.acceptLog(usage("message-1", 3, 8));
    state.acceptHook(hook("Stop", 4));
    expect(state.data).toMatchObject({ sessionTokens: 43, turnTokens: 43, status: "idle", turnEndedAt: timestamp(4) });
    state.acceptHook(hook("UserPromptSubmit", 5));
    state.acceptLog(usage("message-2", 6, 1, { isSidechain: true }));
    expect(state.data).toMatchObject({ sessionTokens: 79, turnTokens: 36, status: "running" });
  });

  it("restores Claude current-turn usage when hooks are read before the transcript", () => {
    const state = new SessionMonitorState("claude", "session-one");
    state.acceptHook(hook("UserPromptSubmit", 5));
    state.acceptHook(hook("Stop", 8));
    state.acceptLog(usage("old", 2, 1));
    state.acceptLog(usage("current", 7, 3));
    expect(state.data).toMatchObject({ sessionTokens: 74, turnTokens: 38, turnEndedAt: timestamp(8) });
  });

  it("distinguishes questions, approvals, recoverable tool failure and turn failure", () => {
    const state = new SessionMonitorState("claude", "session-one");
    state.acceptHook(hook("UserPromptSubmit", 1));
    state.acceptHook(hook("PreToolUse", 2, { toolName: "AskUserQuestion" }));
    expect(state.data.status).toBe("waiting_input");
    state.acceptHook(hook("PostToolUse", 3));
    state.acceptHook(hook("PermissionRequest", 4));
    expect(state.data.status).toBe("waiting_approval");
    state.acceptHook(hook("PostToolUseFailure", 5));
    expect(state.data.status).toBe("running");
    state.acceptHook(hook("StopFailure", 6));
    state.acceptHook(hook("Stop", 7));
    expect(state.data.status).toBe("error");
  });

  it("does not treat user interruption as successful completion", () => {
    const state = new SessionMonitorState("claude", "session-one");
    state.acceptHook(hook("UserPromptSubmit", 1));
    state.acceptLog({ timestamp: timestamp(2), type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    state.acceptHook(hook("Stop", 3));
    expect(state.data).toMatchObject({ status: "interrupted", turnEndedAt: timestamp(2) });
  });

  it("rejects another session and outdated model/context snapshots", () => {
    const state = new SessionMonitorState("claude", "session-one");
    const snapshot = (percent: number) => ({ session_id: "session-one", model: { display_name: "Claude" },
      effort: { level: "high" }, context_window: { used_percentage: percent, context_window_size: 200_000 } });
    state.acceptHook(hook("StatusLine", 8, { snapshot: snapshot(40) }));
    state.acceptHook(hook("StatusLine", 2, { snapshot: snapshot(2) }));
    state.acceptHook(hook("Stop", 10, { sessionId: "other-session" }));
    state.acceptLog(usage("older", 3, 1));
    expect(state.data).toMatchObject({ status: "unknown", model: "Claude", contextPercent: 40, effort: "high" });
  });

  it("keeps unknown fields null and ignores malformed timestamps", () => {
    const state = new SessionMonitorState("claude", "session-one");
    state.acceptHook(hook("Stop", 1, { timestamp: "invalid" }));
    state.acceptLog(null);
    state.acceptLog({ timestamp: 42 });
    expect(state.data).toMatchObject({ status: "unknown", sessionTokens: null, contextPercent: null, sourceUpdatedAt: null });
    state.acceptHook(hook("StatusLine", 2, { snapshot: { session_id: "session-one", context_window: { used_percentage: -5 } } }));
    expect(state.data.contextPercent).toBeNull();
  });

  it("does not count Codex cumulative counters or cached input twice", () => {
    const state = new SessionMonitorState("codex", "session-one");
    state.acceptLog(codex("token_count", 1, { info: { total_token_usage: { total_tokens: 1000 } } }));
    state.acceptLog(codex("task_started", 2, { turn_id: "turn-1" }));
    state.acceptLog(codex("token_count", 3, { info: {
      total_token_usage: { input_tokens: 1100, output_tokens: 100, cached_input_tokens: 900 },
      last_token_usage: { total_tokens: 500 }, model_context_window: 2000,
    } }));
    state.acceptLog(codex("token_count", 4, { info: { total_token_usage: { total_tokens: 1200 } } }));
    state.acceptLog(codex("token_count", 5, { info: { total_token_usage: { total_tokens: 800 } } }));
    expect(state.data).toMatchObject({ sessionTokens: 1200, turnTokens: 200 });
    state.acceptLog(codex("task_complete", 6, { turn_id: "turn-1" }));
    expect(state.data.status).toBe("idle");
  });

  it("keeps the Codex baseline when a newer hook arrives before task_started", () => {
    const state = new SessionMonitorState("codex", "session-one");
    state.acceptLog(codex("token_count", 1, { info: { total_token_usage: { total_tokens: 100 } } }));
    state.acceptHook(hook("PermissionRequest", 4, { source: "codex", turnId: "turn-1" }));
    state.acceptLog(codex("task_started", 2, { turn_id: "turn-1" }));
    state.acceptLog(codex("token_count", 3, { info: { total_token_usage: { total_tokens: 140 } } }));
    expect(state.data).toMatchObject({ status: "waiting_approval", turnTokens: 40, turnStartedAt: timestamp(2) });
  });

  it("ignores an old turn finishing after the next turn starts", () => {
    const state = new SessionMonitorState("codex", "session-one");
    state.acceptLog(codex("task_started", 1, { turn_id: "old" }));
    state.acceptLog(codex("task_started", 2, { turn_id: "current" }));
    state.acceptLog(codex("task_complete", 3, { turn_id: "old" }));
    state.acceptHook(hook("Interrupt", 4, { source: "codex", turnId: "old" }));
    expect(state.data).toMatchObject({ status: "running", turnId: "current" });
  });

  it("preserves Codex errors when a cleanup task_complete follows", () => {
    const state = new SessionMonitorState("codex", "session-one");
    state.acceptLog(codex("task_started", 1, { turn_id: "turn-1" }));
    state.acceptLog(codex("error", 2));
    state.acceptLog(codex("task_complete", 3, { turn_id: "turn-1" }));
    expect(state.data.status).toBe("error");
  });

  it("does not extend a finished turn when Stop is duplicated", () => {
    const state = new SessionMonitorState("claude", "session-one");
    state.acceptHook(hook("UserPromptSubmit", 1));
    state.acceptHook(hook("Stop", 2));
    state.acceptHook(hook("Stop", 3));
    expect(state.data.turnEndedAt).toBe(timestamp(2));
  });
});

it("keeps a pending question visible when a parallel tool completes", () => {
  const state = new SessionMonitorState("claude", "session-one");
  state.acceptHook(hook("UserPromptSubmit", 1));
  state.acceptHook(hook("PreToolUse", 2, { toolName: "AskUserQuestion", toolUseId: "question" }));
  state.acceptHook(hook("PreToolUse", 3, { toolName: "Read", toolUseId: "read" }));
  state.acceptHook(hook("PostToolUse", 4, { toolName: "Read", toolUseId: "read" }));
  expect(state.data.status).toBe("waiting_input");
  state.acceptHook(hook("PostToolUse", 5, { toolName: "AskUserQuestion", toolUseId: "question" }));
  expect(state.data.status).toBe("running");
});

it("holds a next-turn Codex approval until that turn is identified by the log", () => {
  const state = new SessionMonitorState("codex", "session-one");
  state.acceptLog(codex("task_started", 1, { turn_id: "old" }));
  state.acceptHook(hook("PermissionRequest", 4, { source: "codex", turnId: "next" }));
  state.acceptLog(codex("task_started", 3, { turn_id: "next" }));
  expect(state.data).toMatchObject({ status: "waiting_approval", turnId: "next", turnStartedAt: timestamp(3) });
});

it("retains reasoning effort even when a newer hook supplied only the model", () => {
  const state = new SessionMonitorState("codex", "session-one");
  state.acceptHook(hook("SessionStart", 4, { source: "codex", model: "codex-test" }));
  state.acceptLog({ type: "turn_context", timestamp: timestamp(3), payload: { model: "codex-test", effort: "high" } });
  expect(state.data).toMatchObject({ model: "codex-test", effort: "high" });
});
