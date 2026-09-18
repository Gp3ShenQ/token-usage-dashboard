<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { api, type SessionTask, type SessionDay } from "@/api";
import DateRangePicker from "@/components/DateRangePicker.vue";
import StatCard from "@/components/StatCard.vue";
import { useRangeStore } from "@/stores/range";
import { formatTokenCompact } from "@/utils";

const range = useRangeStore();
const sessions = ref<SessionTask[]>([]);
const query = ref("");
const project = ref("");
const model = ref("");
const sort = ref("total");
const page = ref(1);
const pageSize = 50;
const loading = ref(false);
const error = ref("");
const selected = ref<SessionTask | null>(null);
const daily = ref<SessionDay[]>([]);
const detailLoading = ref(false);
const detailError = ref("");
let listRequest: AbortController | undefined;
let detailRequest: AbortController | undefined;

const projects = computed(() => [...new Set(sessions.value.map((row) => row.project).filter((value): value is string => !!value))].sort());
const models = computed(() => [...new Set(sessions.value.flatMap((row) => row.models))].sort());
const filtered = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  return sessions.value.filter((row) =>
    (!project.value || row.project === project.value)
    && (!model.value || row.models.includes(model.value))
    && (!keyword || [row.taskLabel, row.sessionId, row.project, ...row.models].join(" ").toLocaleLowerCase().includes(keyword)),
  ).sort((left, right) => {
    const order = sort.value === "recent" ? right.lastTs.localeCompare(left.lastTs) : right.total - left.total;
    return order || left.source.localeCompare(right.source) || left.sessionId.localeCompare(right.sessionId);
  });
});
const totals = computed(() => filtered.value.reduce((result, row) => {
  result[row.source] += row.total;
  return result;
}, { claude: 0, codex: 0 }));
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)));
const visibleRows = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const maxDaily = computed(() => Math.max(1, ...daily.value.map((row) => row.total)));
const timestamp = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const formatTime = (value: string) => timestamp.format(new Date(value));
const fullNumber = (value: number) => value.toLocaleString("zh-TW");

function closeDetail() {
  detailRequest?.abort();
  selected.value = null;
  daily.value = [];
  detailError.value = "";
  detailLoading.value = false;
}

async function loadSessions() {
  listRequest?.abort();
  const request = new AbortController();
  listRequest = request;
  page.value = 1;
  closeDetail();
  loading.value = true;
  error.value = "";
  sessions.value = [];
  try {
    const rows = await api.sessions(range.from, range.to, request.signal);
    if (request.signal.aborted) return;
    sessions.value = rows;
    if (!projects.value.includes(project.value)) project.value = "";
    if (!models.value.includes(model.value)) model.value = "";
  } catch (cause) {
    if (!request.signal.aborted) error.value = cause instanceof Error ? cause.message : "無法載入任務資料。";
  } finally {
    if (!request.signal.aborted) loading.value = false;
  }
}

async function loadDetail(row: SessionTask) {
  detailRequest?.abort();
  const request = new AbortController();
  detailRequest = request;
  selected.value = row;
  daily.value = [];
  detailError.value = "";
  detailLoading.value = true;
  try {
    const rows = await api.sessionDaily(row.source, row.sessionId, range.from, range.to, request.signal);
    if (!request.signal.aborted) daily.value = rows;
  } catch (cause) {
    if (!request.signal.aborted) detailError.value = cause instanceof Error ? cause.message : "無法載入每日用量。";
  } finally {
    if (!request.signal.aborted) detailLoading.value = false;
  }
}

function clearFilters() {
  query.value = "";
  project.value = "";
  model.value = "";
}
watch([query, project, model, sort], () => { page.value = 1; closeDetail(); });
watch(() => [range.from, range.to], () => { page.value = 1; void loadSessions(); }, { immediate: true });
onBeforeUnmount(() => { listRequest?.abort(); detailRequest?.abort(); });
</script>

<template>
  <section class="page sessions-page">
    <header class="page-header hero-header">
      <div>
        <p class="eyebrow">任務分析</p>
        <h2>任務排行與搜尋</h2>
        <p class="hero-copy">找出用量最高的任務，回查 Claude 與 Codex 的歷史 Session。</p>
      </div>
      <div class="header-actions">
        <DateRangePicker />
        <button class="scan-button" :disabled="loading" @click="loadSessions">重新整理</button>
      </div>
    </header>

    <div class="stat-grid task-stats">
      <StatCard title="符合條件的任務" :value="loading || error ? '—' : String(filtered.length)" sub-value="每個 Session 分開統計" />
      <StatCard title="Claude" tone="claude" :value="loading || error ? '—' : formatTokenCompact(totals.claude)" sub-value="所選區間 Token" />
      <StatCard title="Codex" tone="codex" :value="loading || error ? '—' : formatTokenCompact(totals.codex)" sub-value="所選區間 Token" />
    </div>

    <section class="surface task-filters" aria-label="搜尋與篩選">
      <label class="search-field">搜尋任務
        <input v-model="query" type="search" placeholder="任務名稱、Session ID、專案或模型" />
      </label>
      <label>專案
        <select v-model="project">
          <option value="">全部專案</option>
          <option v-for="name in projects" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label>模型
        <select v-model="model">
          <option value="">全部模型</option>
          <option v-for="name in models" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label>排序
        <select v-model="sort">
          <option value="total">用量最高</option>
          <option value="recent">最近活動</option>
        </select>
      </label>
      <button class="scan-button" @click="clearFilters">清除篩選</button>
      <p class="filter-note">用量與活動時間限所選日期（台北時間）；模型篩選找出使用過該模型的任務，保留任務區間總量。Codex 未索引專案的任務顯示「未記錄」。</p>
    </section>

    <section v-if="selected" class="surface task-detail" aria-label="任務每日用量">
      <div class="detail-heading">
        <div>
          <p class="eyebrow">{{ selected.source === 'claude' ? 'Claude' : 'Codex' }} · 每日用量</p>
          <h3>{{ selected.taskLabel || '未取得任務名稱' }}</h3>
          <code>{{ selected.sessionId }}</code>
        </div>
        <button class="scan-button" @click="closeDetail">關閉明細</button>
      </div>
      <p v-if="detailLoading" role="status">正在載入每日用量…</p>
      <div v-else-if="detailError" role="alert">
        <p>{{ detailError }}</p>
        <button class="scan-button" @click="loadDetail(selected)">重試明細</button>
      </div>
      <template v-else>
        <p class="filter-note">僅列出有用量事件的日期；完整數字可停留查看。</p>
        <div v-for="day in daily" :key="day.day" class="daily-row">
          <span>{{ day.day }}</span>
          <div class="daily-track"><div :class="selected.source" :style="{ width: `${day.total / maxDaily * 100}%` }"></div></div>
          <strong :title="fullNumber(day.total)">{{ formatTokenCompact(day.total) }}</strong>
        </div>
        <p v-if="!daily.length" class="empty-state">這個區間沒有每日用量。</p>
      </template>
    </section>

    <section class="surface task-results" aria-label="歷史任務" :aria-busy="loading">
      <p v-if="loading" role="status">正在載入任務與用量…</p>
      <div v-else-if="error" role="alert">
        <p>{{ error }}</p>
        <button class="scan-button" @click="loadSessions">重試</button>
      </div>
      <template v-else>
        <p class="filter-note">點選任務查看每日用量。名稱缺失時保留 Session ID；Token 合計沿用總覽的輸入＋輸出＋快取口徑。</p>
        <div v-if="!filtered.length" class="empty-state">
          <p>{{ sessions.length ? '沒有符合搜尋條件的任務。' : '這個區間沒有已索引的任務，請調整日期或從總覽重新掃描。' }}</p>
          <button v-if="sessions.length" class="scan-button" @click="clearFilters">清除篩選</button>
          <RouterLink v-else to="/">前往總覽</RouterLink>
        </div>
        <template v-else>
          <div class="table-scroll">
            <table>
              <caption class="table-caption">所選區間的 Session 用量（每頁 50 筆）</caption>
              <thead><tr>
                <th scope="col">{{ sort === 'total' ? '排行' : '序號' }}</th><th scope="col">任務／Session</th>
                <th scope="col">來源</th><th scope="col">專案／模型</th><th scope="col">區間活動</th>
                <th scope="col" class="number">輸入</th><th scope="col" class="number">輸出</th>
                <th scope="col" class="number">快取讀／寫</th><th scope="col" class="number">總 Token</th>
              </tr></thead>
              <tbody><tr v-for="(row, index) in visibleRows" :key="`${row.source}:${row.sessionId}`">
                <td>{{ (page - 1) * pageSize + index + 1 }}</td>
                <td class="task-name">
                  <button class="task-link" :aria-expanded="selected?.source === row.source && selected?.sessionId === row.sessionId" @click="loadDetail(row)">{{ row.taskLabel || '未取得任務名稱' }}</button>
                  <code>{{ row.sessionId }}</code>
                </td>
                <td><span class="source-label" :class="row.source">{{ row.source === 'claude' ? 'Claude' : 'Codex' }}</span></td>
                <td class="task-project"><span>{{ row.project || '未記錄' }}</span><small>{{ row.models.join('、') }}</small></td>
                <td class="task-time"><time :datetime="row.firstTs">{{ formatTime(row.firstTs) }}</time><small>至 {{ formatTime(row.lastTs) }}</small></td>
                <td class="number" :title="fullNumber(row.input)">{{ formatTokenCompact(row.input) }}</td>
                <td class="number" :title="fullNumber(row.output)">{{ formatTokenCompact(row.output) }}</td>
                <td class="number" :title="`讀取 ${fullNumber(row.cacheRead)}／寫入 ${fullNumber(row.cacheWrite)}`">{{ formatTokenCompact(row.cacheRead) }} / {{ formatTokenCompact(row.cacheWrite) }}</td>
                <td class="number" :title="fullNumber(row.total)"><strong>{{ formatTokenCompact(row.total) }}</strong></td>
              </tr></tbody>
            </table>
          </div>
          <nav class="pagination" aria-label="任務分頁">
            <span role="status">共 {{ filtered.length }} 筆 · 第 {{ page }} / {{ pageCount }} 頁</span>
            <button class="scan-button" :disabled="page <= 1" @click="page--">上一頁</button>
            <button class="scan-button" :disabled="page >= pageCount" @click="page++">下一頁</button>
          </nav>
        </template>
      </template>
    </section>
  </section>
</template>

<style scoped>
:global(.content:has(.sessions-page)) { min-width: 0; }
.sessions-page { min-width: 0; }
.page-header { flex-wrap: wrap; justify-content: space-between; }
.task-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.task-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 16px; margin-bottom: 20px; }
.task-filters label { display: grid; gap: 8px; min-width: 140px; flex: 1; font-size: 0.9rem; }
.task-filters .search-field { flex: 2; min-width: 260px; }
.task-filters input, .task-filters select { width: 100%; min-width: 0; padding: 10px 12px; border: 1px solid var(--stroke-strong); border-radius: 8px; background: var(--bg-elevated); color: var(--text); }
.filter-note { flex-basis: 100%; margin: 0; color: var(--muted); font-size: 0.85rem; line-height: 1.7; }
.task-results > .filter-note { margin-bottom: 16px; }
.table-scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
.table-caption { text-align: left; color: var(--muted); padding: 0 0 12px; }
th, td { padding: 14px 10px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--stroke); }
th { white-space: nowrap; font-weight: 500; color: var(--muted); }
.number { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.task-name { min-width: 220px; max-width: 360px; }
.task-name code, .task-detail code { display: block; margin-top: 8px; font-size: 0.72rem; color: var(--muted); overflow-wrap: anywhere; }
.task-link { border: 0; background: none; padding: 0; color: var(--text); cursor: pointer; text-align: left; line-height: 1.5; overflow-wrap: anywhere; }
.task-link:hover { text-decoration: underline; }
.task-project { min-width: 150px; max-width: 220px; overflow-wrap: anywhere; }
small { display: block; margin-top: 6px; color: var(--muted); line-height: 1.5; }
.task-time { white-space: nowrap; }
.source-label { white-space: nowrap; font-weight: 600; }
.source-label.claude { color: var(--claude); }
.source-label.codex { color: var(--codex); }
.pagination, .detail-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.pagination { justify-content: flex-end; margin-top: 20px; }
.pagination span { margin-right: auto; color: var(--muted); font-size: 0.9rem; }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--codex); outline-offset: 3px; }
.task-detail { margin-bottom: 20px; }
.detail-heading { margin-bottom: 20px; }
.detail-heading h3 { overflow-wrap: anywhere; }
.daily-row { display: grid; grid-template-columns: 100px 1fr 90px; gap: 16px; align-items: center; margin-top: 12px; font-size: 0.9rem; }
.daily-row strong { text-align: right; }
.daily-track { height: 12px; background: var(--stroke); border-radius: 6px; overflow: hidden; }
.daily-track > div { height: 100%; min-width: 1px; }
.daily-track .claude { background: var(--claude); }
.daily-track .codex { background: var(--codex); }
.empty-state { padding: 24px 0; }
@media (max-width: 800px) {
  .task-stats { grid-template-columns: 1fr; }
  .task-filters label { min-width: 100%; }
}
</style>
