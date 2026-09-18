<script setup lang="ts">
import { computed } from "vue";
import VChart from "vue-echarts";
import "@/components/charts";

const props = defineProps<{
  primary: { used_percent?: number; resets_at?: number } | null;
  secondary: { used_percent?: number; resets_at?: number } | null;
}>();

const option = computed(() => ({
  series: [
    {
      type: "gauge",
      startAngle: 210,
      endAngle: -30,
      progress: { show: true, width: 18, itemStyle: { color: (props.primary?.used_percent ?? 0) > 80 ? "#ef4444" : "#3B82F6" } },
      axisLine: { lineStyle: { width: 18, color: [[1, "rgba(148, 163, 184, 0.22)"]] } },
      detail: {
        valueAnimation: true,
        formatter: (value: number) => `${value.toFixed(1)}%`,
        color: "#f8fafc",
        fontSize: 18,
      },
      data: [{ value: props.primary?.used_percent ?? 0 }],
    },
  ],
}));
</script>

<template>
  <VChart class="chart gauge" :option="option" autoresize />
</template>
