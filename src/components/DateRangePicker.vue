<script setup lang="ts">
import { computed } from "vue";
import { useRangeStore } from "@/stores/range";

const store = useRangeStore();
const from = computed({
  get: () => store.from,
  set: (value: string) => store.setCustom(value, store.to),
});
const to = computed({
  get: () => store.to,
  set: (value: string) => store.setCustom(store.from, value),
});
</script>

<template>
  <div class="range-picker">
    <div class="range-pills">
      <button :class="{ active: store.preset === 'today' }" @click="store.setPreset('today')">今日</button>
      <button :class="{ active: store.preset === '7d' }" @click="store.setPreset('7d')">近 7 日</button>
      <button :class="{ active: store.preset === '30d' }" @click="store.setPreset('30d')">近 30 日</button>
    </div>
    <label><span>起日</span><input v-model="from" type="date" /></label>
    <label><span>迄日</span><input v-model="to" type="date" /></label>
  </div>
</template>
