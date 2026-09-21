<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, type MetaResponse } from "@/api";
import HandoffRecords from "@/components/HandoffRecords.vue";

const meta = ref<MetaResponse | null>(null);
const launchingAgent = ref<"codex" | "claude" | null>(null);
const launchError = ref("");

async function launchAgent(agent: "codex" | "claude") {
  launchingAgent.value = agent;
  launchError.value = "";
  const result = await window.tokenHud?.launchAgentTerminal(agent);
  if (!result?.ok) {
    launchError.value = result?.error ?? "Unable to start Windows Terminal";
  }
  launchingAgent.value = null;
}

onMounted(async () => {
  meta.value = await api.meta();
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

    <HandoffRecords />
    <div class="surface settings-grid">
      <article>
        <p class="surface-title">開啟已標記的終端</p>
        <p>以固定分頁標題開啟，讓小視窗在重開後仍能辨識代理。</p>
        <div class="terminal-launch-actions">
          <button type="button" class="scan-button" :disabled="launchingAgent !== null" @click="launchAgent('codex')">
            {{ launchingAgent === "codex" ? "正在開啟…" : "開啟 Codex" }}
          </button>
          <button type="button" class="scan-button" :disabled="launchingAgent !== null" @click="launchAgent('claude')">
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
