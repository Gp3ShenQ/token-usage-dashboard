<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { api, type ScanStatusResponse } from "@/api";

const emit = defineEmits<{ done: [] }>();
const running = ref(false);
let pollTimer: number | null = null;

const label = computed(() => (running.value ? "掃描中…" : "立即掃描"));

async function pollStatus() {
  const status: ScanStatusResponse = await api.scanStatus();
  running.value = status.running;

  if (!status.running) {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    emit("done");
  }
}

async function start() {
  if (running.value) {
    return;
  }

  const result = await api.triggerScan();
  if (!result.started && result.reason === "running") {
    running.value = true;
  } else {
    running.value = true;
  }

  await pollStatus();
  if (!pollTimer) {
    pollTimer = window.setInterval(() => void pollStatus(), 1200);
  }
}

onBeforeUnmount(() => {
  if (pollTimer) {
    window.clearInterval(pollTimer);
  }
});
</script>

<template>
  <button class="scan-button" :disabled="running" @click="start">{{ label }}</button>
</template>
