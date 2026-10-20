<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, type MetaResponse } from "@/api";
import HandoffRecords from "@/components/HandoffRecords.vue";

const meta = ref<MetaResponse | null>(null);
const launchingAgent = ref<"codex" | "claude" | null>(null);
const launchError = ref("");
const terminalSetup = ref<Awaited<ReturnType<NonNullable<Window["tokenHud"]>["getTerminalSetup"]>> | null>(null);
const checkingTerminal = ref(false);
const configuringTerminal = ref(false);
const terminalError = ref("");
const terminalNotice = ref("");

async function loadTerminalSetup() {
  checkingTerminal.value = true;
  terminalError.value = "";
  try {
    if (!window.tokenHud) throw new Error("請使用桌面版檢查 Terminal 設定。");
    terminalSetup.value = await window.tokenHud.getTerminalSetup();
  } catch (error) {
    terminalSetup.value = null;
    terminalError.value = error instanceof Error ? error.message : "無法檢查 Terminal 設定。";
  } finally {
    checkingTerminal.value = false;
  }
}

async function handleConfigureTerminal() {
  if (configuringTerminal.value) return;
  configuringTerminal.value = true;
  terminalError.value = "";
  terminalNotice.value = "";
  try {
    const result = await window.tokenHud?.configureTerminal();
    if (result?.status) terminalSetup.value = result.status;
    if (!result?.ok) throw new Error(result?.error ?? result?.status?.issues.join("\n") ?? "Terminal 設定失敗。");
    terminalNotice.value = "設定完成。請重新開啟 PowerShell，再啟動 Codex 或 Claude。" +
      (result.backupPath ? ` 原設定已備份至：${result.backupPath}` : "");
  } catch (error) {
    terminalError.value = error instanceof Error ? error.message : "Terminal 設定失敗。";
  } finally {
    configuringTerminal.value = false;
  }
}

async function launchAgent(agent: "codex" | "claude") {
  launchingAgent.value = agent;
  launchError.value = "";
  try {
    const result = await window.tokenHud?.launchAgentTerminal(agent);
    if (!result?.ok) launchError.value = result?.error ?? "Unable to start Windows Terminal";
  } catch {
    launchError.value = "無法開啟 Windows Terminal，請確認環境設定。";
  } finally {
    launchingAgent.value = null;
  }
}

onMounted(() => {
  void loadTerminalSetup();
  void api.meta().then(result => { meta.value = result; }).catch(() => { /* Terminal setup remains available when scan information fails. */ });
});
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div>
        <p class="eyebrow">設定</p>
        <h2>執行環境與掃描資訊</h2>
      </div>
    </header>

    <section class="surface terminal-setup" aria-labelledby="terminal-setup-title" :aria-busy="checkingTerminal || configuringTerminal">
      <h3 id="terminal-setup-title" class="surface-title">Terminal 整合設定</h3>
      <p role="status" aria-live="polite">
        {{ checkingTerminal ? "正在檢查 Terminal 設定…" : terminalSetup?.ready ? "Terminal 已設定完成" : "Terminal 尚未就緒，監測卡片可能無法出現。" }}
      </p>
      <ul v-if="terminalSetup?.issues.length">
        <li v-for="issue in terminalSetup.issues" :key="issue">{{ issue }}</li>
      </ul>
      <p v-if="terminalSetup?.profilePath">PowerShell 7 profile：<code>{{ terminalSetup.profilePath }}</code></p>
      <p v-if="terminalSetup?.canConfigure && !terminalSetup.ready">點擊後會備份既有 profile，加入 Terminal 整合設定並安裝必要腳本。原本內容會保留，之後開啟的新 PowerShell 才會生效。</p>
      <div class="terminal-launch-actions">
        <button v-if="terminalSetup?.canConfigure && !terminalSetup.ready" type="button" class="scan-button"
          :disabled="checkingTerminal || configuringTerminal" @click="handleConfigureTerminal">
          {{ configuringTerminal ? "正在設定…" : "設定 Terminal" }}
        </button>
        <button type="button" class="scan-button" :disabled="checkingTerminal || configuringTerminal" @click="loadTerminalSetup">重新檢查</button>
      </div>
      <p v-if="terminalError" class="terminal-launch-error" role="alert">{{ terminalError }}</p>
      <p v-if="terminalNotice" role="status">{{ terminalNotice }}</p>
    </section>

    <HandoffRecords />
    <div class="surface settings-grid">
      <article>
        <p class="surface-title">開啟已標記的終端</p>
        <p>以固定分頁標題開啟，讓小視窗在重開後仍能辨識代理。</p>
        <div class="terminal-launch-actions">
          <button type="button" class="scan-button" :disabled="launchingAgent !== null || !terminalSetup?.ready" @click="launchAgent('codex')">
            {{ launchingAgent === "codex" ? "正在開啟…" : "開啟 Codex" }}
          </button>
          <button type="button" class="scan-button" :disabled="launchingAgent !== null || !terminalSetup?.ready" @click="launchAgent('claude')">
            {{ launchingAgent === "claude" ? "正在開啟…" : "開啟 Claude" }}
          </button>
        </div>
        <p v-if="launchError" class="terminal-launch-error">{{ launchError }}</p>
      </article>
      <article>
        <p class="surface-title">唯讀記錄檔路徑</p>
        <code>{{ meta?.paths?.claude ?? "~/.claude/projects/**/*.jsonl" }}</code>
        <code>{{ meta?.paths?.codex ?? "~/.codex/sessions/**/*.jsonl" }}</code>
      </article>
      <article>
        <p class="surface-title">索引統計</p>
        <p>時區：{{ meta?.timezone ?? "Asia/Taipei" }}</p>
        <p>已索引檔案：{{ meta?.stats?.indexedFiles ?? 0 }}</p>
        <p>最新用量事件：{{ meta?.stats?.latestUsage ?? "無" }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.terminal-setup { margin-bottom: 20px; }
.terminal-setup p, .terminal-setup li { line-height: 1.6; overflow-wrap: anywhere; }
.terminal-setup code { white-space: normal; }
.terminal-launch-actions button:disabled { opacity: .55; cursor: wait; }
</style>
