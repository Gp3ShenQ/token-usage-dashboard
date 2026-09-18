<script setup lang="ts">
import { computed } from "vue";
import VChart from "vue-echarts";
import "@/components/charts";

const props = defineProps<{
  rows: Array<{ model: string; source: string; total: number }>;
}>();

const option = computed(() => ({
  tooltip: { trigger: "item" },
  series: [
    {
      type: "pie",
      radius: ["48%", "74%"],
      itemStyle: { borderColor: "#0f172a", borderWidth: 3 },
      data: props.rows.map((row, index) => ({
        value: row.total,
        name: `${row.model} (${row.source})`,
        itemStyle: {
          color: row.source === "claude" ? ["#D97757", "#F6AD55", "#F97316"][index % 3] : ["#3B82F6", "#38BDF8", "#2563EB"][index % 3],
        },
      })),
      label: { color: "#e2e8f0" },
    },
  ],
}));
</script>

<template>
  <VChart class="chart" :option="option" autoresize />
</template>
