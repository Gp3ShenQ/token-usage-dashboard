<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, type MonitorResult, type SessionContextResponse, type WidgetResponse } from "@/api";
import { formatResetAt, formatResetCountdown, formatTokenCompact } from "@/utils";
import { statusLabels, formatTurnDuration, formatEventAge } from "./monitor-display";

type AgentKind = "codex" | "claude";

// hover state for widget panel
const isHovered = ref(false);
const searchParams = new URLSearchParams(window.location.search);
const currentAgent = ref<AgentKind>(searchParams.get("agent") === "claude" ? "claude" : "codex");
const isOverlay = searchParams.get("overlay") === "1";
const sessionPrefix = searchParams.get("session") ?? "";
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
const statusText = computed(() => {
  if (!sessionPrefix) return "未綁定";
  if (monitorResult.value.state === "ambiguous") return "識別不唯一";
  if (!live.value) return "連線中斷";
  if (!monitor.value) return "等待資料";
  if (monitor.value.readError) return "狀態未確認";
  return statusLabels[monitor.value.status];
});
const turnDuration = computed(() => formatTurnDuration(monitor.value, live.value ? now.value : lastMessageAt.value));
const eventAge = computed(() => formatEventAge(monitor.value?.sourceUpdatedAt, now.value));
const healthText = computed(() => !live.value ? "即時連線中斷" : monitor.value?.readError ? "紀錄讀取異常" : quotaError.value ? "額度更新失敗" : "監測連線正常");
const tokensText = (value: number | null | undefined) => value == null ? "—" : formatTokenCompact(value);

function connectMonitor() {
  if (!sessionPrefix) return;
  stream = api.monitorStream(currentAgent.value, sessionPrefix);
  stream.onmessage = (event) => {
    try {
      monitorResult.value = JSON.parse(event.data) as MonitorResult;
      connected.value = true;
      lastMessageAt.value = Date.now();
    } catch { connected.value = false; }
  };
  stream.onerror = () => { connected.value = false; };
}

const panelStyle = computed(() => ({
  "--widget-alpha": `${fixedOpacity}`,
}));

const claudeFiveHourPercent = computed(() => Math.max(0, Math.min(100, widget.value?.claude.fiveHourPercent ?? 0)));

const claudeSevenDayPercent = computed(() => Math.max(0, Math.min(100, widget.value?.claude.sevenDayPercent ?? 0)));

const codexPrimaryResetText = computed(() => formatResetCountdown(widget.value?.codex.fiveHourResetsAt));
const codexSecondaryResetText = computed(() => formatResetCountdown(widget.value?.codex.sevenDayResetsAt));
const codexPrimaryResetAtText = computed(() => formatResetAt(widget.value?.codex.fiveHourResetsAt));
const codexSecondaryResetAtText = computed(() => formatResetAt(widget.value?.codex.sevenDayResetsAt));
const claudeFiveHourResetText = computed(() => formatResetCountdown(widget.value?.claude.fiveHourResetsAt));
const claudeSevenDayResetText = computed(() => formatResetCountdown(widget.value?.claude.sevenDayResetsAt));
const claudeFiveHourResetAtText = computed(() => formatResetAt(widget.value?.claude.fiveHourResetsAt));
const claudeSevenDayResetAtText = computed(() => formatResetAt(widget.value?.claude.sevenDayResetsAt));
const cardClass = computed(() => `${currentAgent.value}-card`);
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

onMounted(async () => {
  connectMonitor();
  clockTimer = window.setInterval(() => { now.value = Date.now(); }, 1000);
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
  stream?.close();
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
            <span class="dot" :class="currentAgent"></span>
            <strong>{{ titleText }}</strong>
          </div>
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
        <div class="session-row"><span>本輪耗時</span><strong>{{ turnDuration }}</strong></div>
        <div class="line-metric task-label" :class="taskClass">
          <span class="task-label-heading">任務</span>
          <strong class="task-label-value" :title="taskText">{{ taskText }}</strong>
        </div>

        <div class="line-metric">
          <div class="metric-copy">
            <span>{{ currentAgent === "codex" ? "5hE" : "5h" }}</span>
            <template v-if="currentAgent === 'codex'">
              <strong :class="{ danger: (widget?.codex.fiveHourPercent ?? 0) > 80 }">{{ loading || widget?.codex.fiveHourPercent == null ? "--" : `${widget.codex.fiveHourPercent.toFixed(1)}%` }}</strong>
              <span class="extra-info" :title="`重設時間：${codexPrimaryResetAtText}`">{{ loading ? "--" : codexPrimaryResetText }}</span>
            </template>
            <template v-else>
              <strong>{{ loading ? "--" : widget?.claude.fiveHourPercent == null ? "--" : `${claudeFiveHourPercent.toFixed(1)}%` }}</strong>
              <span class="extra-info" :title="`重設時間：${claudeFiveHourResetAtText}`">{{ loading ? "--" : claudeFiveHourResetText }}</span>
            </template>
          </div>
          <div class="line-track" :class="currentAgent">
            <div
              class="line-fill"
              :class="[currentAgent, { danger: currentAgent === 'codex' && (widget?.codex.fiveHourPercent ?? 0) > 80 }]"
              :style="{ width: `${currentAgent === 'codex' ? (widget?.codex.fiveHourPercent ?? 0) : claudeFiveHourPercent}%` }"
            ></div>
          </div>
        </div>

        <div class="line-metric">
          <div class="metric-copy">
            <span>7d</span>
            <template v-if="currentAgent === 'codex'">
              <strong>{{ loading || widget?.codex.sevenDayPercent == null ? "--" : `${widget.codex.sevenDayPercent.toFixed(1)}%` }}</strong>
              <span class="extra-info" :title="`重設時間：${codexSecondaryResetAtText}`">{{ loading ? "--" : codexSecondaryResetText }}</span>
            </template>
            <template v-else>
              <strong>{{ loading ? "--" : widget?.claude.sevenDayPercent == null ? "--" : `${claudeSevenDayPercent.toFixed(1)}%` }}</strong>
              <span class="extra-info" :title="`重設時間：${claudeSevenDayResetAtText}`">{{ loading ? "--" : claudeSevenDayResetText }}</span>
            </template>
          </div>
          <div class="line-track" :class="currentAgent">
            <div
              class="line-fill alt"
              :class="currentAgent"
              :style="{ width: `${currentAgent === 'codex' ? (widget?.codex.sevenDayPercent ?? 0) : claudeSevenDayPercent}%` }"
            ></div>
          </div>
        </div>

        <div class="line-metric session-context">
          <div class="metric-copy"><span>{{ currentAgent === "codex" ? "Context ≈" : "Context" }}</span><strong>{{ monitor?.contextPercent == null ? "—" : monitor.contextPercent.toFixed(1) + "%" }}</strong></div>
          <div class="line-track" :class="currentAgent"><div class="line-fill" :class="currentAgent" :style="{ width: (monitor?.contextPercent ?? 0) + '%' }"></div></div>
        </div>
        <div class="session-row" :title="'累積 token：' + (monitor?.sessionTokens ?? '未知')"><span>Session tokens</span><strong>{{ tokensText(monitor?.sessionTokens) }}</strong></div>
        <div class="session-row" :title="'本輪 token：' + (monitor?.turnTokens ?? '未知')"><span>本輪增加</span><strong>{{ tokensText(monitor?.turnTokens) }}</strong></div>
        <div class="session-health"><span>{{ healthText }}</span><span>事件 {{ eventAge }}</span></div>
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
.single-agent-card { gap: 7px; min-width: 0; grid-template-columns: minmax(0, 1fr); }
.session-model { min-width: 0; }
.session-status { font-size: 10px; color: var(--muted); white-space: nowrap; }
.session-model, .session-row, .session-health { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; }
.session-model > span:first-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
.session-effort { flex-shrink: 0; color: var(--muted); font-size: 10px; }
.session-row > span { color: var(--muted); }
.session-row strong { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.session-health { border-top: 1px solid rgba(88, 74, 56, 0.12); padding-top: 6px; font-size: 9px; color: var(--muted); }
</style>
