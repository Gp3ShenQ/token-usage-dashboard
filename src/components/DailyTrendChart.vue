<script setup lang="ts">
import { computed } from "vue";
import VChart from "vue-echarts";
import "@/components/charts";

const props = defineProps<{
  rows: Array<{ day: string; claude: number; codex: number }>;
  metric: string;
}>();

const option = computed(() => ({
  backgroundColor: "transparent",
  tooltip: {
    trigger: "axis",
  },
  legend: {
    textStyle: { color: "#e2e8f0" },
  },
  xAxis: {
    type: "category",
    data: props.rows.map((row) => row.day.slice(5)),
    axisLabel: { color: "#94a3b8" },
  },
  yAxis: {
    type: "value",
    axisLabel: { color: "#94a3b8" },
    splitLine: { lineStyle: { color: "rgba(148, 163, 184, 0.14)" } },
  },
  series: [
    {
      name: "Claude",
      type: "bar",
      stack: "tokens",
      itemStyle: { color: "#D97757" },
      data: props.rows.map((row) => row.claude),
    },
    {
      name: "Codex",
      type: "bar",
      stack: "tokens",
      itemStyle: { color: "#3B82F6" },
      data: props.rows.map((row) => row.codex),
    },
  ],
}));
</script>

<template>
  <VChart class="chart tall" :option="option" autoresize />
</template>
