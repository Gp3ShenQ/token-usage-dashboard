<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, type DailyRow, type ModelRow, type ProjectRow, type RateLimitPayload, type SummaryResponse, type WidgetResponse } from "@/api";
import DailyTrendChart from "@/components/DailyTrendChart.vue";
import DateRangePicker from "@/components/DateRangePicker.vue";
import ModelDonut from "@/components/ModelDonut.vue";
import RateLimitGauge from "@/components/RateLimitGauge.vue";
import ScanButton from "@/components/ScanButton.vue";
import StatCard from "@/components/StatCard.vue";
import { useRangeStore } from "@/stores/range";
import { formatResetAt, formatResetCountdown, formatTokenCompact } from "@/utils";

const range = useRangeStore();
const metric = ref<"total" | "input" | "output" | "cache">("total");
const loading = ref(false);
const summary = ref<SummaryResponse | null>(null);
const daily = ref<DailyRow[]>([]);
const models = ref<ModelRow[]>([]);
const projects = ref<ProjectRow[]>([]);
const rateLimit = ref<RateLimitPayload | null>(null);
const widget = ref<WidgetResponse | null>(null);

const claudeTotal = computed(() => {
  const row = summary.value?.bySource?.claude;
  return row ? row.input + row.output + row.cache_read + row.cache_write : 0;
});

const codexTotal = computed(() => {
  const row = summary.value?.bySource?.codex;
  return row ? row.input + row.output + row.cache_read + row.cache_write : 0;
});

const fiveHourEquivalentResetCountdown = computed(() => formatResetCountdown(rateLimit.value?.fiveHourEquivalent?.resets_at));
const sevenDayResetCountdown = computed(() => formatResetCountdown(rateLimit.value?.sevenDay?.resets_at));
const fiveHourEquivalentResetAt = computed(() => formatResetAt(rateLimit.value?.fiveHourEquivalent?.resets_at));
const sevenDayResetAt = computed(() => formatResetAt(rateLimit.value?.sevenDay?.resets_at));
const claudeFiveHourPercent = computed(() => widget.value?.claude.fiveHourPercent ?? null);
const claudeSevenDayPercent = computed(() => widget.value?.claude.sevenDayPercent ?? null);
const claudeFiveHourResetCountdown = computed(() => formatResetCountdown(widget.value?.claude.fiveHourResetsAt));
const claudeSevenDayResetCountdown = computed(() => formatResetCountdown(widget.value?.claude.sevenDayResetsAt));
const claudeFiveHourResetAt = computed(() => formatResetAt(widget.value?.claude.fiveHourResetsAt));
const claudeSevenDayResetAt = computed(() => formatResetAt(widget.value?.claude.sevenDayResetsAt));

async function load() {
  loading.value = true;
  const [summaryData, dailyData, modelData, projectData, rateLimitData, widgetData] = await Promise.all([
    api.summary(range.from, range.to),
    api.daily(range.from, range.to, metric.value),
    api.models(range.from, range.to),
    api.projects(range.from, range.to),
    api.rateLimit(),
    api.widget(),
  ]);

  summary.value = summaryData;
  daily.value = dailyData;
  models.value = modelData;
  projects.value = projectData.slice(0, 5);
  rateLimit.value = rateLimitData;
  widget.value = widgetData;
  loading.value = false;
}

watch(() => [range.from, range.to, metric.value], () => void load(), { deep: true });
onMounted(() => void load());
</script>

<template>
  <section class="page">
    <header class="page-header hero-header">
      <div>
        <p class="eyebrow">總覽</p>
        <h2>Claude 與 Codex 的用量總覽</h2>
        <p class="hero-copy">集中查看近期用量、上下文壓力與額度週期。</p>
      </div>
      <div class="header-actions">
        <DateRangePicker />
        <ScanButton @done="load" />
      </div>
    </header>

    <div class="stat-grid">
      <StatCard title="總 Token 數" :value="formatTokenCompact(summary?.total ?? 0)" :sub-value="`較前一區間 ${summary?.prevDelta?.percent ?? 0}%`" />
      <StatCard title="Claude" tone="claude" :value="formatTokenCompact(claudeTotal)" sub-value="輸入 + 輸出 + 快取" />
      <StatCard title="Codex" tone="codex" :value="formatTokenCompact(codexTotal)" sub-value="輸入 + 輸出 + 快取" />
      <article class="surface gauge-card">
        <div class="surface-head">
          <p>Codex 5hE 額度</p>
          <span>{{ rateLimit?.fiveHourEquivalent?.used_percent == null ? "--" : `${rateLimit.fiveHourEquivalent.used_percent.toFixed(1)}%` }}</span>
        </div>
        <RateLimitGauge :primary="rateLimit?.fiveHourEquivalent ?? null" :secondary="rateLimit?.sevenDay ?? null" />
        <div class="quota-reset-meta">
          <p :title="`重設時間：${fiveHourEquivalentResetAt}`">5hE 重設：{{ fiveHourEquivalentResetCountdown }}</p>
          <p :title="`重設時間：${sevenDayResetAt}`">7 日重設：{{ sevenDayResetCountdown }}</p>
        </div>
      </article>
    </div>

    <div class="panel-grid">
      <section class="surface">
        <div class="surface-head">
          <p>每日趨勢</p>
          <div class="range-pills compact">
            <button :class="{ active: metric === 'total' }" @click="metric = 'total'">總量</button>
            <button :class="{ active: metric === 'input' }" @click="metric = 'input'">輸入</button>
            <button :class="{ active: metric === 'output' }" @click="metric = 'output'">輸出</button>
            <button :class="{ active: metric === 'cache' }" @click="metric = 'cache'">快取</button>
          </div>
        </div>
        <DailyTrendChart :rows="daily" :metric="metric" />
      </section>

      <section class="surface">
        <div class="surface-head">
          <p>Claude 額度狀態</p>
        </div>
        <div class="claude-status-grid">
          <!--
          <div class="claude-status-row">
            <span>Context</span>
            <strong>{{ claudeContextPercent.toFixed(1) }}%</strong>
          </div>
          <div class="quota-bar">
            <div class="quota-fill" :style="{ width: `${claudeContextPercent}%` }"></div>
          </div>
          -->
          <div class="claude-status-row">
            <span>5h</span>
            <strong>{{ claudeFiveHourPercent == null ? "--" : `${claudeFiveHourPercent.toFixed(1)}%` }}</strong>
            <span :title="`重設時間：${claudeFiveHourResetAt}`">{{ claudeFiveHourResetCountdown }}</span>
          </div>
          <div class="quota-bar">
            <div class="quota-fill" :style="{ width: `${claudeFiveHourPercent ?? 0}%` }"></div>
          </div>
          <div class="claude-status-row">
            <span>7d</span>
            <strong>{{ claudeSevenDayPercent == null ? "--" : `${claudeSevenDayPercent.toFixed(1)}%` }}</strong>
            <span :title="`重設時間：${claudeSevenDayResetAt}`">{{ claudeSevenDayResetCountdown }}</span>
          </div>
          <div class="quota-bar">
            <div class="quota-fill" :style="{ width: `${claudeSevenDayPercent ?? 0}%` }"></div>
          </div>
        </div>
      </section>

      <section class="surface split-surface">
        <div>
          <div class="surface-head">
            <p>模型用量占比</p>
          </div>
          <ModelDonut :rows="models" />
        </div>
        <div class="model-table">
          <div v-for="row in models" :key="`${row.model}-${row.source}`" class="model-row">
            <span>{{ row.model }}</span>
            <span>{{ row.source }}</span>
            <strong>{{ formatTokenCompact(row.total) }}</strong>
          </div>
        </div>
      </section>
    </div>

    <section class="surface">
      <div class="surface-head">
        <p>Claude 專案用量</p>
      </div>
      <div v-if="projects.length" class="project-list">
        <div v-for="project in projects" :key="project.projectDisplay" class="project-row">
          <span>{{ project.projectDisplay }}</span>
          <strong>{{ formatTokenCompact(project.total) }}</strong>
        </div>
      </div>
      <p v-else class="empty-state">這個區間沒有 Claude 專案用量資料。</p>
    </section>

    <p v-if="loading" class="loading-note">正在更新資料…</p>
  </section>
</template>
