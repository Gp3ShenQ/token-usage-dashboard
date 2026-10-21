<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, type MonitorResult, type WidgetResponse } from "@/api";
import { statusLabels, formatTurnClock } from "./monitor-display";

type AgentKind = "codex" | "claude";

// A click-through mascot pinned to a terminal's bottom-right corner, one per terminal.
const searchParams = new URLSearchParams(window.location.search);
const currentAgent: AgentKind = searchParams.get("agent") === "claude" ? "claude" : "codex";
const sessionPrefix = searchParams.get("session") ?? "";

const QUOTA_DANGER_PERCENT = 80;
const QUOTA_REFRESH_MS = 60_000;
const monitorResult = ref<MonitorResult>({ state: "pending" });
const widget = ref<WidgetResponse | null>(null);
const connected = ref(false);
const lastMessageAt = ref(0);
const now = ref(Date.now());
let stream: EventSource | null = null;
let clockTimer: number | null = null;
let quotaTimer: number | null = null;
let disposed = false;

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
  // Claude stays silent when it stops, so the mascot chimes the moment its turn ends or needs input.
  if (currentAgent === "claude" && previous === "running" && (next === "resting" || next === "waiting")) {
    playChime(next === "resting" ? [660, 880] : [880, 880]);
  }
});

let audioContext: AudioContext | null = null;
function playChime(frequencies: number[]) {
  try {
    audioContext ??= new AudioContext();
    const start = audioContext.currentTime + 0.02;
    frequencies.forEach((frequency, index) => {
      const at = start + index * 0.16;
      const oscillator = audioContext!.createOscillator();
      const gain = audioContext!.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      oscillator.connect(gain).connect(audioContext!.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.4);
    });
  } catch { /* A missing audio device must not break the mascot. */ }
}
const stageState = computed(() => celebrating.value ? "celebrating" : mascotState.value);
const statusText = computed(() => {
  if (!sessionPrefix) return "未綁定";
  if (monitorResult.value.state === "ambiguous") return "識別不唯一";
  if (!live.value) return "連線中斷";
  if (!monitor.value) return "等待資料";
  if (monitor.value.readError) return "狀態未確認";
  return statusLabels[monitor.value.status];
});
const titleText = currentAgent === "codex" ? "Codex" : "Claude";
const turnClock = computed(() => formatTurnClock(monitor.value, live.value ? now.value : lastMessageAt.value));
const showTurnClock = computed(() => stageState.value === "running" || stageState.value === "waiting");
const sweating = computed(() => (widget.value?.[currentAgent].fiveHourPercent ?? 0) > QUOTA_DANGER_PERCENT &&
  ["running", "waiting", "celebrating"].includes(stageState.value));

function connectMonitor() {
  if (!sessionPrefix) return;
  stream = api.monitorStream(currentAgent, sessionPrefix);
  stream.onmessage = (event) => {
    try {
      monitorResult.value = JSON.parse(event.data) as MonitorResult;
      connected.value = true;
      lastMessageAt.value = Date.now();
    } catch { connected.value = false; }
  };
  stream.onerror = () => { connected.value = false; };
}

async function loadQuota() {
  try {
    const next = await api.widget();
    if (!disposed) widget.value = next;
  } catch { /* Sweat is decorative; keep the last known quota. */ }
}

function startClock() {
  now.value = Date.now();
  if (!clockTimer) clockTimer = window.setInterval(() => { now.value = Date.now(); }, 1000);
}

// Hidden mascots skip the per-second clock and resync as soon as they are shown again.
function handleVisibility() {
  if (!document.hidden) return startClock();
  if (clockTimer) window.clearInterval(clockTimer);
  clockTimer = null;
}

onMounted(() => {
  connectMonitor();
  startClock();
  document.addEventListener("visibilitychange", handleVisibility);
  void loadQuota();
  quotaTimer = window.setInterval(() => void loadQuota(), QUOTA_REFRESH_MS);
});

onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener("visibilitychange", handleVisibility);
  stream?.close();
  if (celebrateTimer) window.clearTimeout(celebrateTimer);
  if (clockTimer) window.clearInterval(clockTimer);
  if (quotaTimer) window.clearInterval(quotaTimer);
  void audioContext?.close();
});
</script>

<template>
  <div class="mascot-shell" :class="[currentAgent, stageState]" role="img" :aria-label="`${titleText} ${statusText}`" :title="`${titleText}：${statusText}`">
    <span class="mascot-box">
      <span class="stage-far" aria-hidden="true"></span>
      <span class="stage-ground" aria-hidden="true"></span>
      <span v-if="showTurnClock" class="mascot-timer">{{ turnClock }}</span>
      <span class="mascot-actor">
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
    </span>
  </div>
</template>

<style scoped>
@font-face { font-family: "Silkscreen"; src: url("/fonts/Silkscreen-Regular.ttf") format("truetype"); font-display: block; }
/* The window is transparent and click-through; only the mascot and its effects are drawn over the terminal. */
.mascot-shell { position: fixed; inset: 0; display: flex; align-items: flex-end; justify-content: flex-end; overflow: hidden; pointer-events: none; user-select: none; }
.mascot-shell.unavailable .mascot-box { opacity: 0.5; }
/* The scene is zoomed so the pixel art reads at a glance; its ends fade out so it blends into the terminal. */
.mascot-box { --stride: 0.8s; position: relative; flex: 0 0 auto; width: 181px; height: 40px; zoom: 1.25; overflow: hidden; image-rendering: pixelated;
  background: linear-gradient(rgba(191, 224, 236, 0.78), rgba(230, 242, 223, 0.72));
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 23%, #000 87%, transparent); mask-image: linear-gradient(90deg, transparent, #000 23%, #000 87%, transparent); }
/* Effects are positioned on a 60 × 40 grid around the mascot, which stands near the right end of the scene. */
.mascot-actor { position: absolute; right: 16px; bottom: 0; width: 60px; height: 40px; }
/* Pixel scenery scrolls past the mascot while it works and freezes into a night scene while idle. */
.mascot-box::before { content: ""; position: absolute; inset: 0; opacity: 0; transition: opacity 0.6s ease;
  background: radial-gradient(1px 1px at 30% 22%, #fff 99%, transparent), radial-gradient(1px 1px at 62% 12%, #fff 99%, transparent),
    radial-gradient(1px 1px at 84% 34%, #fff 99%, transparent), linear-gradient(#27304a, #46506c); }
.mascot-shell.codex .mascot-box { --stride: 1.2s; }
.mascot-shell.resting .mascot-box::before { opacity: 0.8; }
/* --stride is one walk cycle; the ground moves one 16px tile per cycle so feet do not slide. */
/* Slightly translucent scenery softens the scene without letting the dark terminal turn day into night. */
.stage-far, .stage-ground { position: absolute; left: 0; right: 0; opacity: 0.85; background-repeat: repeat-x; transition: filter 0.6s ease; }
.stage-far { bottom: 8px; height: 24px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 12' shape-rendering='crispEdges'%3E%3Cpath fill='%23fff' fill-opacity='.8' d='M21 2h4v1h2v1h-8V3h2z'/%3E%3Cpath fill='%2385ad82' fill-opacity='.6' d='M0 12V9h3V8h3V7h4v1h2v1h3v3zM18 12v-2h3V9h5v1h3v1h3v1z'/%3E%3C/svg%3E");
  background-size: 64px 24px; animation: stage-scroll-far calc(var(--stride) * 16) linear infinite paused; }
.stage-ground { bottom: 0; height: 8px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 4' shape-rendering='crispEdges'%3E%3Cpath fill='%2379a957' d='M0 0h8v1H0z'/%3E%3Cpath fill='%23a6cf74' d='M2 0h2v1H2z'/%3E%3Cpath fill='%239c7650' d='M0 1h8v3H0z'/%3E%3Cpath fill='%237a5636' d='M1 2h1v1H1zM5 1h1v1H5zM6 3h1v1H6zM3 3h1v1H3z'/%3E%3C/svg%3E");
  background-size: 16px 8px; animation: stage-scroll-ground var(--stride) linear infinite paused; }
.mascot-shell.running .stage-far, .mascot-shell.running .stage-ground { animation-play-state: running; }
.mascot-shell.resting .stage-far, .mascot-shell.resting .stage-ground { filter: brightness(0.55) saturate(0.7); }
.mascot-shell.failed .mascot-box { background: linear-gradient(rgba(180, 180, 180, 0.78), rgba(214, 214, 214, 0.72)); }
.mascot-shell.failed .stage-far, .mascot-shell.failed .stage-ground { filter: grayscale(1) brightness(0.95); }
@keyframes stage-scroll-far { to { background-position-x: -64px; } }
@keyframes stage-scroll-ground { to { background-position-x: -16px; } }
.mascot-timer { position: absolute; left: 46px; top: 7px; z-index: 1; font: 400 8px/1 "Silkscreen", ui-monospace, monospace; font-variant-numeric: tabular-nums;
  --timer-outline: #fffaf2; text-shadow: 1px 0 var(--timer-outline), -1px 0 var(--timer-outline), 0 1px var(--timer-outline), 0 -1px var(--timer-outline), 1px 1px var(--timer-outline); }
.mascot-shell.claude .mascot-timer { color: #c4613f; }
.mascot-shell.codex .mascot-timer { color: #3d5fd9; }
.sweat-drop { position: absolute; left: 9px; top: 9px; width: 2px; height: 3px; background: #7cc4f0; box-shadow: 0 -1px 0 -0.5px #7cc4f0, 0 0 0 1px rgba(47, 42, 36, 0.35); animation: sweat-drip 1.1s ease-in infinite; }
@keyframes sweat-drip { 0% { opacity: 0; transform: translateY(0); } 20% { opacity: 1; } 100% { opacity: 0; transform: translateY(8px); } }
.agent-mascot { position: absolute; left: 14px; bottom: 4px; display: inline-flex; width: 28px; height: 31px; align-items: flex-end; justify-content: center; }
/* Outlined so the effects stay legible on both light and dark terminal themes. */
.sleep-z { position: absolute; left: 40px; top: 6px; display: flex; gap: 1px; font: 700 8px/1 ui-monospace, Consolas, monospace; color: #e4e9ff;
  text-shadow: 1px 0 #1f2740, -1px 0 #1f2740, 0 1px #1f2740, 0 -1px #1f2740; }
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
</style>
