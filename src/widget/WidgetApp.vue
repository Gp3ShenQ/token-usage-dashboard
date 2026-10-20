<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, type MonitorResult, type SessionContextResponse, type WidgetResponse } from "@/api";
import { formatResetAt, formatTokenCompact } from "@/utils";
import { statusLabels, formatTurnClock, formatEventAge, formatResetShort } from "./monitor-display";

type AgentKind = "codex" | "claude";

// hover state for widget panel
const isHovered = ref(false);
const searchParams = new URLSearchParams(window.location.search);
const currentAgent = ref<AgentKind>(searchParams.get("agent") === "claude" ? "claude" : "codex");
const isOverlay = searchParams.get("overlay") === "1";
const sessionPrefix = searchParams.get("session") ?? "";
const terminalHwnd = searchParams.get("hwnd") ?? "";
const isMatchingTerminalSession = (sessionId: string) => !!sessionPrefix &&
  sessionId.toLowerCase().startsWith(sessionPrefix.toLowerCase());
const directTaskLabel = null;

const fixedOpacity = 0.3;
const refreshSeconds = ref(60);
const loading = ref(false);
const widget = ref<WidgetResponse | null>(null);
const sessionContext = ref<SessionContextResponse | null>(null);
let refreshTimer: number | null = null;
let scanTimer: number | null = null;
let clockTimer: number | null = null;
let stream: EventSource | null = null;
let disposed = false;
let loadInProgress = false;
const monitorResult = ref<MonitorResult>({ state: "pending" });
const connected = ref(false);
const lastMessageAt = ref(0);
const now = ref(Date.now());
const quotaError = ref(false);
const monitor = computed(() => monitorResult.value.state === "ready" ? monitorResult.value.data : null);
const live = computed(() => connected.value && now.value - lastMessageAt.value < 35_000);
const mascotState = computed(() => {
  if (!sessionPrefix || !live.value || !monitor.value) return "unavailable";
  if (monitor.value.readError) return "failed";
  const status = monitor.value.status;
  if (status === "running") return "running";
  if (status === "waiting_input" || status === "waiting_approval") return "waiting";
  if (status === "idle") return "resting";
  if (status === "interrupted" || status === "error") return "failed";
  return "stopped";
});
const waitingBubble = computed(() => monitor.value?.status === "waiting_approval" ? "!" : "?");
// A finished turn celebrates briefly before the mascot falls asleep.
const CELEBRATE_MS = 1800;
const celebrating = ref(false);
let celebrateTimer: number | null = null;
watch(mascotState, (next, previous) => {
  if (celebrateTimer) window.clearTimeout(celebrateTimer);
  celebrateTimer = null;
  celebrating.value = previous === "running" && next === "resting";
  if (celebrating.value) celebrateTimer = window.setTimeout(() => { celebrating.value = false; }, CELEBRATE_MS);
});
const stageState = computed(() => celebrating.value ? "celebrating" : mascotState.value);
const statusText = computed(() => {
  if (!sessionPrefix) return "未綁定";
  if (monitorResult.value.state === "ambiguous") return "識別不唯一";
  if (!live.value) return "連線中斷";
  if (!monitor.value) return "等待資料";
  if (monitor.value.readError) return "狀態未確認";
  return statusLabels[monitor.value.status];
});
const turnClock = computed(() => formatTurnClock(monitor.value, live.value ? now.value : lastMessageAt.value));
const eventAge = computed(() => formatEventAge(monitor.value?.sourceUpdatedAt, now.value));
// Only problems earn a line; the mascot already shows a healthy connection.
const healthIssue = computed(() => !sessionPrefix ? null : !live.value ? "即時連線中斷" : monitor.value?.readError ? "紀錄讀取異常" : quotaError.value ? "額度更新失敗" : null);
const tokensText = (value: number | null | undefined) => value == null ? "—" : formatTokenCompact(value);

const handoff = ref<import("../../server/monitor/handoff").HandoffStatus | null>(null);
const handoffBusy = ref(false);
const handoffNotice = ref("");
let handoffTimer: number | null = null;
let handoffLoading = false;
let handoffStatusFailed = false;
let lastApprovedPrompt = "";
let approvalInProgress = false;
const HANDOFF_ACTIVE_POLL_MS = 2000;
const HANDOFF_IDLE_POLL_MS = 30_000;
const isExactSession = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionPrefix);
const HANDOFF_CONTEXT_THRESHOLD = 72;
const CONTEXT_WARN_MARGIN = 10;
const QUOTA_DANGER_PERCENT = 80;
const showHandoffControls = computed(() => isOverlay && (monitor.value?.contextPercent ?? 0) > HANDOFF_CONTEXT_THRESHOLD);
const canHandoff = computed(() => isExactSession && live.value && !!monitor.value?.cwd &&
  monitor.value.sessionId === sessionPrefix && !monitor.value.readError && !!window.tokenHud?.copyHandoffText);
const handoffLabel = computed(() => {
  if (handoffBusy.value) return "處理中…";
  if (handoff.value?.phase === "received") return "已接收，待移除";
  if (handoff.value?.phase === "ready") return "複製接手指令";
  if (handoff.value?.phase === "manual" || handoff.value?.phase === "failed") return "複製交接指令";
  if (handoff.value && ["waiting", "sending", "queued"].includes(handoff.value.phase)) return "等待交接報告";
  return currentAgent.value === "codex" ? "產生交接報告" : "複製交接指令";
});
const handoffDisabled = computed(() => handoffBusy.value || (!canHandoff.value && handoff.value?.phase !== "ready") ||
  (!!handoff.value && ["waiting", "sending", "queued", "received"].includes(handoff.value.phase)));
const handoffMessage = computed(() => handoffNotice.value || handoff.value?.message ||
  (!isExactSession ? "需要完整 session 綁定" : !canHandoff.value ? "等待 session 與工作目錄確認" :
    currentAgent.value === "claude" ? "貼到原 AI，由它整理交接" : "原 AI 完成本輪後整理交接"));

async function loadHandoffStatus() {
  if (disposed || !isOverlay || !isExactSession || handoffLoading) return;
  if (handoffBusy.value) { resetHandoffTimer(); return; }
  handoffLoading = true;
  try {
    const result = await api.handoff<import("../../server/monitor/handoff").HandoffStatus | null>(currentAgent.value, sessionPrefix, "status");
    if (!disposed) {
      if (handoffStatusFailed) handoffNotice.value = "";
      handoffStatusFailed = false;
      if (result?.phase !== handoff.value?.phase) handoffNotice.value = "";
      handoff.value = result;
    }
  } catch (error) {
    handoffStatusFailed = true;
    if (!disposed) handoffNotice.value = error instanceof Error ? error.message : "無法確認交接狀態。";
  } finally { handoffLoading = false; resetHandoffTimer(); }
}

function resetHandoffTimer() {
  if (handoffTimer) window.clearTimeout(handoffTimer);
  handoffTimer = null;
  if (disposed || !isOverlay || !isExactSession) return;
  const phase = handoff.value?.phase;
  const interval = handoffStatusFailed || phase === "ready" || phase === "received"
    ? HANDOFF_IDLE_POLL_MS
    : phase && ["manual", "waiting", "sending", "queued"].includes(phase) ? HANDOFF_ACTIVE_POLL_MS : null;
  if (interval) handoffTimer = window.setTimeout(() => void loadHandoffStatus(), interval);
}

watch(() => handoff.value?.phase, resetHandoffTimer);
watch(showHandoffControls, visible => { if (visible) void loadHandoffStatus(); });

async function handleHandoff() {
  if (handoffDisabled.value) return;
  handoffBusy.value = true;
  handoffNotice.value = "";
  try {
    if (!handoff.value || ["removed", "complete"].includes(handoff.value.phase)) {
      handoff.value = await api.handoff(currentAgent.value, sessionPrefix, "prepare",
        currentAgent.value === "codex" ? "queue" : "manual");
    }
    if (handoff.value && ["manual", "ready", "failed"].includes(handoff.value.phase)) {
      const receiving = handoff.value.phase === "ready";
      const prompt = await api.handoff<string>(currentAgent.value, sessionPrefix, receiving ? "receive" : "generate");
      if (!window.tokenHud) throw new Error("剪貼簿橋接未就緒。");
      await window.tokenHud.copyHandoffText(prompt);
      handoffNotice.value = receiving ? "已複製；到同工作目錄的新 AI 貼上" :
        "已複製；先確認原 AI 未收到，再貼上";
    }
  } catch (error) {
    handoffNotice.value = error instanceof Error ? error.message : "交接操作失敗。";
  } finally { handoffBusy.value = false; }
}

function connectMonitor() {
  if (!sessionPrefix) return;
  stream = api.monitorStream(currentAgent.value, sessionPrefix);
  stream.onmessage = (event) => {
    try {
      monitorResult.value = JSON.parse(event.data) as MonitorResult;
      connected.value = true;
      lastMessageAt.value = Date.now();
      void approveCurrentTerminalPrompt();
    } catch { connected.value = false; }
  };
  stream.onerror = () => { connected.value = false; };
}

async function approveCurrentTerminalPrompt() {
  const snapshot = monitorResult.value;
  if (!isOverlay || !terminalHwnd || snapshot.state !== "ready" || snapshot.data.status !== "waiting_approval" ||
    snapshot.data.readError || !snapshot.data.turnId || !isMatchingTerminalSession(snapshot.data.sessionId) || !window.tokenHud?.approveTerminal) return;

  const approvalKey = `${snapshot.data.sessionId}:${snapshot.data.turnId}`;
  if (approvalKey === lastApprovedPrompt || approvalInProgress) return;
  approvalInProgress = true;
  try {
    const result = await window.tokenHud.approveTerminal({
      hwnd: terminalHwnd,
      agent: currentAgent.value,
      sessionId: snapshot.data.sessionId,
      turnId: snapshot.data.turnId,
    });
    if (result.ok) lastApprovedPrompt = approvalKey;
  } finally {
    approvalInProgress = false;
  }
}
const panelStyle = computed(() => ({
  "--widget-alpha": `${fixedOpacity}`,
}));

const claudeFiveHourPercent = computed(() => Math.max(0, Math.min(100, widget.value?.claude.fiveHourPercent ?? 0)));

const claudeSevenDayPercent = computed(() => Math.max(0, Math.min(100, widget.value?.claude.sevenDayPercent ?? 0)));

const codexPrimaryResetText = computed(() => formatResetShort(widget.value?.codex.fiveHourResetsAt, now.value));
const codexSecondaryResetText = computed(() => formatResetShort(widget.value?.codex.sevenDayResetsAt, now.value));
const codexPrimaryResetAtText = computed(() => formatResetAt(widget.value?.codex.fiveHourResetsAt));
const codexSecondaryResetAtText = computed(() => formatResetAt(widget.value?.codex.sevenDayResetsAt));
const claudeFiveHourResetText = computed(() => formatResetShort(widget.value?.claude.fiveHourResetsAt, now.value));
const claudeSevenDayResetText = computed(() => formatResetShort(widget.value?.claude.sevenDayResetsAt, now.value));
const claudeFiveHourResetAtText = computed(() => formatResetAt(widget.value?.claude.fiveHourResetsAt));
const claudeSevenDayResetAtText = computed(() => formatResetAt(widget.value?.claude.sevenDayResetsAt));
const cardClass = computed(() => `${currentAgent.value}-card`);
const fiveHourPercent = computed(() => currentAgent.value === "codex" ? widget.value?.codex.fiveHourPercent ?? 0 : claudeFiveHourPercent.value);
const sevenDayPercent = computed(() => currentAgent.value === "codex" ? widget.value?.codex.sevenDayPercent ?? 0 : claudeSevenDayPercent.value);
const quotaStrained = computed(() => fiveHourPercent.value > QUOTA_DANGER_PERCENT);
const contextLevel = computed(() => {
  const percent = monitor.value?.contextPercent ?? 0;
  if (percent > HANDOFF_CONTEXT_THRESHOLD) return "danger";
  return percent >= HANDOFF_CONTEXT_THRESHOLD - CONTEXT_WARN_MARGIN ? "warn" : "";
});
const showTurnClock = computed(() => stageState.value === "running" || stageState.value === "waiting");
const sweating = computed(() => quotaStrained.value && ["running", "waiting", "celebrating"].includes(stageState.value));
const titleText = computed(() => currentAgent.value === "codex" ? "Codex" : "Claude");
const runningState = computed(() => monitor.value?.status === "running" ? true : monitor.value?.status === "idle" ? false : null);
const taskLabel = computed(() => {
  const indexedTaskLabel = sessionContext.value?.state === "ready" ? sessionContext.value.taskLabel : null;
  return indexedTaskLabel || directTaskLabel;
});
const taskClass = computed(() => {
  if (runningState.value === true) return "active";
  if (runningState.value === false) return "idle";
  return "pending";
});
const taskText = computed(() => {
  return taskLabel.value ?? "等資料";
});

async function load() {
  if (loadInProgress) return;
  loadInProgress = true;
  loading.value = !widget.value;
  try {
    const [nextWidget, nextContext] = await Promise.all([
      api.widget(),
      sessionPrefix ? api.sessionContext(currentAgent.value, sessionPrefix) : Promise.resolve({ state: "pending" } as SessionContextResponse),
    ]);
    if (disposed) return;
    widget.value = nextWidget;
    sessionContext.value = nextContext;
    quotaError.value = false;
  } catch { quotaError.value = true; }
  finally { loading.value = false; loadInProgress = false; }
}

async function persistSettings() {
  await window.tokenHud?.saveWidgetSettings({
    refreshSeconds: refreshSeconds.value,
  });
}

function closeWidget() {
  void window.tokenHud?.minimizeToTray();
}

async function resetTimers() {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
  }

  refreshTimer = window.setInterval(async () => {
    await load();
  }, refreshSeconds.value * 1000);
}

function startClock() {
  now.value = Date.now();
  if (!clockTimer) clockTimer = window.setInterval(() => { now.value = Date.now(); }, 1000);
}

// Hidden overlays skip the per-second clock and resync as soon as they are shown again.
function handleVisibility() {
  if (!document.hidden) return startClock();
  if (clockTimer) window.clearInterval(clockTimer);
  clockTimer = null;
}

onMounted(async () => {
  connectMonitor();
  if (isOverlay) void loadHandoffStatus();
  startClock();
  document.addEventListener("visibilitychange", handleVisibility);
  const saved = await window.tokenHud?.getWidgetSettings().catch(() => undefined);
  if (disposed) return;
  refreshSeconds.value = saved?.refreshSeconds ?? 60;
  await load();
  if (disposed) return;
  await resetTimers();
  if (!isOverlay) {
    scanTimer = window.setInterval(() => void api.triggerScan(), 300_000);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener("visibilitychange", handleVisibility);
  stream?.close();
  if (handoffTimer) window.clearTimeout(handoffTimer);
  if (celebrateTimer) window.clearTimeout(celebrateTimer);
  if (clockTimer) window.clearInterval(clockTimer);
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
  }
  if (scanTimer) {
    window.clearInterval(scanTimer);
  }
});
</script>

<template>
  <div class="widget-shell monitor-shell" :class="{ 'overlay-shell': isOverlay }" :style="panelStyle" @mouseenter="isHovered = true" @mouseleave="isHovered = false">
    <div class="widget-panel monitor-panel" :class="{ 'is-hovered': isHovered, 'overlay-panel': isOverlay }">
      <section class="stack-card single-agent-card" :class="cardClass">
        <div class="stack-head" :class="{ 'widget-handle': !isOverlay }">
          <div class="stack-title">
            <span class="mascot-stage" :class="[currentAgent, stageState]">
              <span class="stage-far" aria-hidden="true"></span>
              <span class="stage-ground" aria-hidden="true"></span>
              <strong class="stage-name">{{ titleText }}</strong>
              <span v-if="showTurnClock" class="stage-timer" :title="'本輪耗時 ' + turnClock">{{ turnClock }}</span>
              <span class="agent-mascot" :class="[currentAgent, stageState]" aria-hidden="true">
                <svg v-if="currentAgent === 'claude'" class="clawd" viewBox="0 0 32 32" shape-rendering="crispEdges">
                  <g class="clawd-body" fill="#D97757">
                    <path d="M6 7h20v3h3v12h-3v3H6v-3H3V10h3z" />
                    <path class="clawd-arm clawd-arm-left" d="M0 14h4v7H0z" />
                    <path class="clawd-arm clawd-arm-right" d="M28 14h4v7h-4z" />
                    <path class="clawd-feet-a" d="M6 24h4v6H6zM22 24h4v6h-4z" />
                    <path class="clawd-feet-b" d="M12 24h3v5h-3zM17 24h3v5h-3z" />
                    <g class="clawd-eyes" fill="#2f2a24"><path d="M9 13h3v6H9zM20 13h3v6h-3z" /></g>
                    <g class="clawd-eyes-x" fill="#2f2a24"><path d="M9 14h1v1H9zM11 14h1v1h-1zM10 15h1v1h-1zM9 16h1v1H9zM11 16h1v1h-1zM20 14h1v1h-1zM22 14h1v1h-1zM21 15h1v1h-1zM20 16h1v1h-1zM22 16h1v1h-1z" /></g>
                  </g>
                </svg>
                <!-- Official Codey sheet: 8 columns, 9 rows of 192 × 208 frames.
                     Source: https://learn.chatgpt.com/images/codex/app/pets/codex-spritesheet.webp -->
                <span v-else class="codey"></span>
              </span>
              <span v-if="stageState === 'resting'" class="sleep-z" aria-hidden="true"><i>z</i><i>z</i><i>Z</i></span>
              <span v-else-if="stageState === 'waiting'" class="alert-bubble" aria-hidden="true">{{ waitingBubble }}</span>
              <span v-else-if="stageState === 'celebrating'" class="sparkles" aria-hidden="true"><i></i><i></i><i></i></span>
              <span v-if="sweating" class="sweat-drop" aria-hidden="true"></span>
            </span>
          </div>
          <!-- Status text stays for screen readers; the mascot stage shows it visually. -->
          <span class="session-status" role="status">{{ statusText }}</span>
          <button v-if="!isOverlay" class="close-button" type="button" title="最小化至系統匣" @click="closeWidget">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <div class="session-model">
          <span :title="monitor?.model ?? '來源尚未提供模型'">{{ monitor?.model ?? "—" }}</span>
          <span class="session-effort">{{ monitor?.effort ?? "—" }}</span>
        </div>
        <div class="line-metric task-label" :class="taskClass">
          <span class="task-label-heading">任務</span>
          <strong class="task-label-value" :title="taskText">{{ taskText }}</strong>
        </div>

        <div class="line-metric">
          <div class="metric-copy">
            <span :title="currentAgent === 'codex' ? 'Codex 5 小時等效額度（估算）' : undefined">{{ currentAgent === "codex" ? "5H ≈" : "5H" }}</span>
            <template v-if="currentAgent === 'codex'">
              <strong :class="{ danger: quotaStrained }">{{ loading || widget?.codex.fiveHourPercent == null ? "--" : `${widget.codex.fiveHourPercent.toFixed(1)}%` }}</strong>
              <span class="extra-info" :title="`重設時間：${codexPrimaryResetAtText}`">{{ loading ? "--" : codexPrimaryResetText }}</span>
            </template>
            <template v-else>
              <strong :class="{ danger: quotaStrained }">{{ loading ? "--" : widget?.claude.fiveHourPercent == null ? "--" : `${claudeFiveHourPercent.toFixed(1)}%` }}</strong>
              <span class="extra-info" :title="`重設時間：${claudeFiveHourResetAtText}`">{{ loading ? "--" : claudeFiveHourResetText }}</span>
            </template>
          </div>
          <div class="line-track" :class="currentAgent">
            <div
              class="line-fill"
              :class="[currentAgent, { danger: quotaStrained }]"
              :style="{ width: `${fiveHourPercent}%` }"
            ></div>
          </div>
        </div>

        <div class="line-metric">
          <div class="metric-copy">
            <span>7D</span>
            <template v-if="currentAgent === 'codex'">
              <strong :class="{ danger: sevenDayPercent > QUOTA_DANGER_PERCENT }">{{ loading || widget?.codex.sevenDayPercent == null ? "--" : `${widget.codex.sevenDayPercent.toFixed(1)}%` }}</strong>
              <span class="extra-info" :title="`重設時間：${codexSecondaryResetAtText}`">{{ loading ? "--" : codexSecondaryResetText }}</span>
            </template>
            <template v-else>
              <strong :class="{ danger: sevenDayPercent > QUOTA_DANGER_PERCENT }">{{ loading ? "--" : widget?.claude.sevenDayPercent == null ? "--" : `${claudeSevenDayPercent.toFixed(1)}%` }}</strong>
              <span class="extra-info" :title="`重設時間：${claudeSevenDayResetAtText}`">{{ loading ? "--" : claudeSevenDayResetText }}</span>
            </template>
          </div>
          <div class="line-track" :class="currentAgent">
            <div
              class="line-fill alt"
              :class="[currentAgent, { danger: sevenDayPercent > QUOTA_DANGER_PERCENT }]"
              :style="{ width: `${sevenDayPercent}%` }"
            ></div>
          </div>
        </div>

        <div class="line-metric session-context">
          <div class="metric-copy"><span>{{ currentAgent === "codex" ? "Context ≈" : "Context" }}</span><strong :class="contextLevel">{{ monitor?.contextPercent == null ? "—" : monitor.contextPercent.toFixed(1) + "%" }}</strong></div>
          <div class="line-track" :class="currentAgent">
            <div class="line-fill" :class="[currentAgent, contextLevel]" :style="{ width: (monitor?.contextPercent ?? 0) + '%' }"></div>
            <i class="threshold-mark" :style="{ left: HANDOFF_CONTEXT_THRESHOLD + '%' }" :title="'超過 ' + HANDOFF_CONTEXT_THRESHOLD + '% 出現交接按鈕'"></i>
          </div>
        </div>
        <div class="session-row session-tokens" :title="'累積 token：' + (monitor?.sessionTokens ?? '未知') + '\n本輪 token：' + (monitor?.turnTokens ?? '未知') + '\n事件 ' + eventAge">
          <span>Tokens</span><strong>{{ tokensText(monitor?.sessionTokens) }}<em>+{{ tokensText(monitor?.turnTokens) }}</em></strong>
        </div>
        <div v-if="healthIssue" class="session-health"><span>{{ healthIssue }}</span><span>事件 {{ eventAge }}</span></div>
        <div v-if="showHandoffControls" class="handoff-controls" data-handoff-controls>
          <button type="button" class="handoff-button" :disabled="handoffDisabled" @click="handleHandoff">{{ handoffLabel }}</button>
          <span class="handoff-message" role="status" :title="handoffMessage">{{ handoffMessage }}</span>
        </div>
      </section>

      <footer v-if="!isOverlay" class="micro-controls">
        <select v-model="refreshSeconds" @change="persistSettings(); resetTimers()">
          <option :value="30">30s</option>
          <option :value="60">60s</option>
          <option :value="300">300s</option>
        </select>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* The scene bleeds to the card's top, left and right edges (card padding is 8px 10px, radius 16px). */
.stack-head { position: relative; width: auto; margin: -8px -10px 0; }
.stack-head .close-button { position: absolute; top: 4px; right: 4px; }
.stack-title { flex: 1 1 auto; min-width: 0; }
/* Pixel scenery scrolls past the mascot while it works and freezes into a night scene while idle. */
@font-face { font-family: "Silkscreen"; src: url("/fonts/Silkscreen-Regular.ttf") format("truetype"); font-display: block; }
/* --stride is one walk cycle; the ground moves one 16px tile per cycle so feet do not slide. */
.mascot-stage { --stride: 0.8s; position: relative; flex: 1 1 auto; min-width: 64px; height: 40px; overflow: hidden; border-radius: 15px 15px 0 0; pointer-events: none;
  background: linear-gradient(rgba(186, 222, 236, 0.55), rgba(232, 244, 226, 0.35)); image-rendering: pixelated; }
.mascot-stage::before { content: ""; position: absolute; inset: 0; opacity: 0; transition: opacity 0.6s ease;
  background: radial-gradient(1px 1px at 30% 22%, #fff 99%, transparent), radial-gradient(1px 1px at 62% 12%, #fff 99%, transparent),
    radial-gradient(1px 1px at 84% 34%, #fff 99%, transparent), linear-gradient(#27304a, #46506c); }
.mascot-stage.codex { --stride: 1.2s; }
.mascot-stage.resting::before { opacity: 0.85; }
.stage-far, .stage-ground { position: absolute; left: 0; right: 0; background-repeat: repeat-x; transition: filter 0.6s ease; }
.stage-far { bottom: 8px; height: 24px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 12' shape-rendering='crispEdges'%3E%3Cpath fill='%23fff' fill-opacity='.8' d='M21 2h4v1h2v1h-8V3h2z'/%3E%3Cpath fill='%2385ad82' fill-opacity='.6' d='M0 12V9h3V8h3V7h4v1h2v1h3v3zM18 12v-2h3V9h5v1h3v1h3v1z'/%3E%3C/svg%3E");
  background-size: 64px 24px; animation: stage-scroll-far calc(var(--stride) * 16) linear infinite paused; }
.stage-ground { bottom: 0; height: 8px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 4' shape-rendering='crispEdges'%3E%3Cpath fill='%2379a957' d='M0 0h8v1H0z'/%3E%3Cpath fill='%23a6cf74' d='M2 0h2v1H2z'/%3E%3Cpath fill='%239c7650' d='M0 1h8v3H0z'/%3E%3Cpath fill='%237a5636' d='M1 2h1v1H1zM5 1h1v1H5zM6 3h1v1H6zM3 3h1v1H3z'/%3E%3C/svg%3E");
  background-size: 16px 8px; animation: stage-scroll-ground var(--stride) linear infinite paused; }
.mascot-stage.running .stage-far, .mascot-stage.running .stage-ground { animation-play-state: running; }
.mascot-stage.resting .stage-far, .mascot-stage.resting .stage-ground { filter: brightness(0.55) saturate(0.7); }
.mascot-stage.unavailable { opacity: 0.5; }
.mascot-stage.failed { background: linear-gradient(rgba(170, 170, 170, 0.5), rgba(214, 214, 214, 0.35)); }
.mascot-stage.failed .stage-far, .mascot-stage.failed .stage-ground { filter: grayscale(1) brightness(0.95); }
@keyframes stage-scroll-far { to { background-position-x: -64px; } }
@keyframes stage-scroll-ground { to { background-position-x: -16px; } }
/* Pixel-outlined title sits in the sky like a game HUD and dims with the night scene. */
.stack-title .stage-name { position: absolute; right: 14px; top: 8px; z-index: 1; font: 400 8px/1 "Silkscreen", ui-monospace, monospace; letter-spacing: 0;
  --name-outline: #fffaf2; text-shadow: 1px 0 var(--name-outline), -1px 0 var(--name-outline), 0 1px var(--name-outline), 0 -1px var(--name-outline), 1px 1px var(--name-outline);
  transition: color 0.6s ease; }
.mascot-stage.claude .stage-name { color: #c4613f; }
.mascot-stage.codex .stage-name { color: #3d5fd9; }
.mascot-stage.resting .stage-name { color: #f3e7c9; --name-outline: #1f2740; }
.stack-head:has(.close-button) .stage-name, .stack-head:has(.close-button) .stage-timer { right: 32px; }
.stage-timer { position: absolute; right: 14px; top: 19px; z-index: 1; font: 400 8px/1 "Silkscreen", ui-monospace, monospace; font-variant-numeric: tabular-nums;
  text-shadow: 1px 0 #fffaf2, -1px 0 #fffaf2, 0 1px #fffaf2, 0 -1px #fffaf2; }
.mascot-stage.claude .stage-timer { color: #c4613f; }
.mascot-stage.codex .stage-timer { color: #3d5fd9; }
.sweat-drop { position: absolute; left: 9px; top: 9px; width: 2px; height: 3px; background: #7cc4f0; box-shadow: 0 -1px 0 -0.5px #7cc4f0, 0 0 0 1px rgba(47, 42, 36, 0.35); animation: sweat-drip 1.1s ease-in infinite; }
@keyframes sweat-drip { 0% { opacity: 0; transform: translateY(0); } 20% { opacity: 1; } 100% { opacity: 0; transform: translateY(8px); } }
.agent-mascot { position: absolute; left: 14px; bottom: 4px; display: inline-flex; width: 28px; height: 31px; align-items: flex-end; justify-content: center; }
.sleep-z { position: absolute; left: 40px; top: 6px; display: flex; gap: 1px; font: 700 8px/1 ui-monospace, Consolas, monospace; color: #e4e9ff; }
.sleep-z i { font-style: normal; opacity: 0; animation: sleep-z 2.4s ease-out infinite; }
.sleep-z i:nth-child(2) { animation-delay: 0.8s; font-size: 9px; }
.sleep-z i:nth-child(3) { animation-delay: 1.6s; font-size: 10px; }
.alert-bubble { position: absolute; left: 38px; top: 5px; width: 9px; height: 10px; display: grid; place-items: center; font: 400 8px/1 "Silkscreen", ui-monospace, monospace;
  color: #2f2a24; background: #fffaf2; box-shadow: 0 0 0 1px #2f2a24; animation: alert-blink 0.8s steps(1, end) infinite; }
.alert-bubble::after { content: ""; position: absolute; left: 1px; bottom: -3px; width: 2px; height: 2px; background: #fffaf2; box-shadow: 0 1px 0 0 #2f2a24, -1px 0 0 0 #2f2a24; }
@keyframes alert-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.sparkles i { position: absolute; width: 2px; height: 2px; background: #ffd75e; box-shadow: 0 -2px #ffd75e, 0 2px #ffd75e, -2px 0 #ffd75e, 2px 0 #ffd75e; opacity: 0; animation: sparkle 0.9s steps(3, end) infinite; }
.sparkles i:nth-child(1) { left: 12px; top: 9px; }
.sparkles i:nth-child(2) { left: 42px; top: 7px; animation-delay: 0.3s; }
.sparkles i:nth-child(3) { left: 46px; top: 19px; animation-delay: 0.6s; }
@keyframes sparkle { 0% { opacity: 0; transform: scale(0.5); } 40% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(0.5); } }
@keyframes sleep-z { 0% { opacity: 0; transform: translateY(6px); } 30% { opacity: 1; } 100% { opacity: 0; transform: translateY(-4px); } }
.clawd { width: 28px; height: 28px; overflow: visible; }
.clawd-body, .clawd-eyes, .clawd-arm { transform-box: fill-box; transform-origin: center; }
.clawd-feet-a, .clawd-feet-b { transform-box: fill-box; transform-origin: top; }
.running .clawd-body { animation: clawd-step 0.8s ease-in-out infinite; }
.running .clawd-arm { animation: clawd-arm-swing 0.8s ease-in-out infinite; }
.running .clawd-arm-right { animation-delay: -0.4s; }
.running .clawd-feet-a { animation: clawd-feet 0.8s steps(2, end) infinite; }
.running .clawd-feet-b { animation: clawd-feet 0.8s steps(2, end) -0.4s infinite; }
.waiting .clawd-body { animation: clawd-look 2s ease-in-out infinite; }
.waiting .clawd-arm { transform: translateY(-3px); animation: clawd-wave 1s steps(2, end) infinite; }
.resting .clawd-body { transform: translateY(1px); }
.resting .clawd-feet-a, .resting .clawd-feet-b { transform: scaleY(0.55); }
.resting .clawd-eyes { animation: clawd-rest 5s steps(1, end) infinite; }
.clawd-eyes-x { display: none; }
.celebrating .clawd-body { animation: clawd-hop 0.45s ease-out infinite; }
.celebrating .clawd-arm { transform: translateY(-5px); }
.failed .clawd-body { transform: translateY(2px) rotate(-14deg); }
.failed .clawd-eyes { display: none; }
.failed .clawd-eyes-x { display: inline; }
.failed .clawd-feet-a, .failed .clawd-feet-b { transform: scaleY(0.55); }
.codey { display: block; width: 28px; height: calc(28px * 208 / 192); background: url("/codey-spritesheet.webp") no-repeat 0 0 / 800% 900%; image-rendering: pixelated; }
.running .codey { --sprite-row: 12.5%; animation: codey-walk 1.2s steps(8, end) infinite; }
.waiting .codey { --sprite-row: 75%; animation: codey-frames 2.4s steps(6, end) infinite; }
.resting .codey { animation: codey-rest 6s steps(1, end) infinite; }
.celebrating .codey { --sprite-row: 100%; animation: codey-frames 1.2s steps(6, end) infinite; }
/* Row 5 is the failure row; column 2 shows the crossed-out eyes. */
.failed .codey { background-position: 28.5714286% 62.5%; }
@keyframes codey-rest {
  0%, 86%, 95%, 100% { background-position: 14.2857143% 0; }
  88%, 92% { background-position: 0 0; }
}
@keyframes clawd-rest { 0%, 88%, 94%, 100% { transform: scaleY(0.25); } 90%, 92% { transform: scaleY(0.06); } }
@keyframes clawd-blink {
  0%, 88%, 94%, 100% { transform: scaleY(1); }
  90%, 92% { transform: scaleY(0.12); }
}
@keyframes codey-walk {
  from { background-position: 0 var(--sprite-row); }
  to { background-position: 114.2857143% var(--sprite-row); }
}
@keyframes codey-frames {
  from { background-position: 0 var(--sprite-row); }
  to { background-position: 85.7142857% var(--sprite-row); }
}
@keyframes clawd-step {
  0%, 100% { transform: translate(-1px, 1px) rotate(-4deg) scaleY(0.96); }
  25% { transform: translateY(-3px) scaleY(1.02); }
  50% { transform: translate(1px, 1px) rotate(4deg) scaleY(0.96); }
  75% { transform: translateY(-3px) scaleY(1.02); }
}
@keyframes clawd-arm-swing { 0%, 100% { transform: translateY(1px) rotate(-30deg); } 50% { transform: translateY(-3px) rotate(30deg); } }
@keyframes clawd-hop { 0%, 100% { transform: translateY(0) scaleY(0.95); } 40% { transform: translateY(-5px) scaleY(1.04); } }
@keyframes clawd-feet { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
@keyframes clawd-wave { 0%, 100% { transform: translateY(-3px); } 50% { transform: translateY(-5px); } }
@keyframes clawd-look { 0%, 100% { transform: rotate(-6deg); } 50% { transform: rotate(6deg); } }
@media (prefers-reduced-motion: reduce) {
  .waiting .clawd-body, .waiting .clawd-arm { animation: none !important; }
  .running .clawd-body, .running .clawd-arm { animation-duration: 1.6s; }
  .running .clawd-arm-right { animation-delay: -0.8s; }
  .running .clawd-feet-a, .running .clawd-feet-b { animation-duration: 1.6s; }
  .running .clawd-feet-b { animation-delay: -0.8s; }
  .running .clawd-eyes { animation: clawd-blink 1.8s steps(1, end) infinite; }
  .waiting .clawd-eyes { animation: clawd-blink 3s steps(1, end) infinite; }
  .running .codey { animation-duration: 2.4s; }
  .waiting .codey { animation-duration: 4.8s; }
  .stage-far { animation-duration: calc(var(--stride) * 32); }
  .stage-ground { animation-duration: calc(var(--stride) * 2); }
  .alert-bubble { animation-duration: 1.6s; }
  .sleep-z i { animation-duration: 4.8s; }
}
.single-agent-card { gap: 7px; min-width: 0; grid-template-columns: minmax(0, 1fr); }
.session-model { min-width: 0; }
.session-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.session-model, .session-row, .session-health { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; }
.session-model > span:first-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
.session-effort { flex-shrink: 0; color: var(--muted); font-size: 10px; }
.session-row > span { color: var(--muted); }
.session-row strong { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.session-health { border-top: 1px solid rgba(88, 74, 56, 0.12); padding-top: 6px; font-size: 10px; color: #c2410c; }
/* One neutral line: activity is the mascot's job, and warm colors are reserved for warnings. */
.line-metric.task-label { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.task-label .task-label-heading { flex: 0 0 auto; }
.task-label .task-label-value { display: block; min-width: 0; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; -webkit-line-clamp: unset; }
.task-label.pending .task-label-value { color: var(--muted); }
.session-tokens em { margin-left: 4px; font-style: normal; font-weight: 500; color: var(--muted); }
.line-fill.danger { background: linear-gradient(90deg, #f97316, #dc2626); }
.line-fill.warn { background: linear-gradient(90deg, #f3c25b, #e08a1e); }
.metric-copy strong.warn { color: #c47a12; }
.metric-copy strong.danger { color: #dc2626; }
.threshold-mark { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: rgba(47, 42, 36, 0.45); }

.handoff-controls { display: grid; gap: 4px; min-width: 0; -webkit-app-region: no-drag; }
.handoff-button { width: 100%; min-height: 27px; padding: 4px 7px; font: inherit; font-size: 11px; border: 1px solid rgba(88, 74, 56, 0.2); border-radius: 6px; color: var(--text); background: rgba(255, 255, 255, 0.65); cursor: pointer; }
.handoff-button:hover:not(:disabled) { background: rgba(138, 162, 157, 0.25); }
.handoff-button:focus-visible { outline: 2px solid #718983; outline-offset: 2px; }
.handoff-button:disabled { opacity: 0.55; cursor: default; }
.handoff-message { font-size: 10px; line-height: 1.4; color: var(--text); opacity: 0.85; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
