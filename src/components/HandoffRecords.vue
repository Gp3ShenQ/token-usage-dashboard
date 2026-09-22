<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { api } from "@/api";
import type { HandoffInventory, HandoffRecord, HandoffSelection, HandoffQuery } from "../../server/monitor/handoff";

const inventory = ref<HandoffInventory>({ records: [], warnings: [] });
const loading = ref(false);
const error = ref("");
const notice = ref("");
const selected = ref<string[]>([]);
const confirmation = ref<{ mode: "completed" | "unreceived"; records: HandoffRecord[] } | null>(null);
const dialog = ref<HTMLDialogElement | null>(null);
const CLEANUP_BATCH_SIZE = 200;
const page = ref(1);
const sourceFilter = ref("");
const projectFilter = ref("");
const receptionFilter = ref("");
const activeFilters = ref<HandoffQuery>({});
const pageCount = computed(() => Math.max(1, Math.ceil((inventory.value.total ?? inventory.value.records.length) / 50)));
const completed = computed(() => inventory.value.records.filter(record => record.reception === "complete"));
const completedCount = computed(() => inventory.value.completedCount ?? completed.value.length);
const canDiscard = (record: HandoffRecord) => ["awaiting", "discarded"].includes(record.reception) && !["waiting", "sending", "queued"].includes(record.phase);
const selectedRecords = computed(() => inventory.value.records.filter(record => selected.value.includes(record.id) && canDiscard(record)));
const statusText = (record: HandoffRecord) => ({
  pending: record.phase === "failed" ? "產生失敗／逾時" : "等待產生",
  awaiting: "等待接收",
  received: record.receipt?.deletion === "failed" ? "已接收，刪除失敗" : "已接收，待移除",
  complete: "接收完成，原檔已移除",
  missing: "檔案已移除，接收未確認",
  discarded: "已手動刪除，待清理紀錄",
}[record.reception]);
const dateText = (value: string) => new Date(value).toLocaleString("zh-TW");

async function loadRecords() {
  loading.value = true;
  error.value = "";
  try {
    inventory.value = await api.handoffRecords("list", undefined, undefined, { ...activeFilters.value, page: page.value }) as HandoffInventory;
    page.value = inventory.value.page ?? page.value;
    selected.value = selected.value.filter(id => inventory.value.records.some(record => record.id === id && canDiscard(record)));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "無法載入交接紀錄。";
  } finally { loading.value = false; }
}

async function handleFilter() {
  if (loading.value) return;
  activeFilters.value = {
    source: (sourceFilter.value || undefined) as HandoffQuery["source"],
    project: projectFilter.value.trim() || undefined,
    reception: (receptionFilter.value || undefined) as HandoffQuery["reception"],
  };
  page.value = 1;
  selected.value = [];
  await loadRecords();
}

async function handlePage(nextPage: number) {
  if (loading.value) return;
  page.value = nextPage;
  selected.value = [];
  await loadRecords();
}

async function confirmCleanup(mode: "completed" | "unreceived") {
  if (loading.value) return;
  let records = selectedRecords.value;
  if (mode === "completed") {
    loading.value = true;
    try {
      const result = await api.handoffRecords("list", undefined, undefined, { ...activeFilters.value, reception: "complete" }) as HandoffInventory;
      records = result.records;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "無法核對清理範圍。";
      return;
    } finally { loading.value = false; }
  }
  if (!records.length) return;
  confirmation.value = { mode, records: [...records] };
  await nextTick();
  dialog.value?.showModal();
}

function cancelCleanup() {
  if (loading.value) return;
  dialog.value?.close();
  confirmation.value = null;
}

async function handleCleanup() {
  if (!confirmation.value || loading.value) return;
  loading.value = true;
  error.value = "";
  notice.value = "";
  const selection: HandoffSelection[] = confirmation.value.records.map(record => ({
    source: record.source, sessionId: record.sessionId, id: record.id, digest: record.digest!,
  }));
  const results = { removed: [] as string[], failures: [] as Array<{ id: string; message: string }> };
  let processed = 0;
  let interrupted = "";
  try {
    for (let start = 0; start < selection.length; start += CLEANUP_BATCH_SIZE) {
      const batch = selection.slice(start, start + CLEANUP_BATCH_SIZE);
      const result = await api.handoffRecords("cleanup", confirmation.value.mode, batch) as {
        removed: string[]; failures: Array<{ id: string; message: string }>;
      };
      results.removed.push(...result.removed);
      results.failures.push(...result.failures);
      processed += batch.length;
    }
  } catch (cause) {
    const uncertain = Math.min(CLEANUP_BATCH_SIZE, selection.length - processed);
    interrupted = `；${uncertain} 筆結果未確認，${selection.length - processed - uncertain} 筆未處理。${cause instanceof Error ? cause.message : "清理請求失敗。"}`;
  }
  try {
    const failureText = results.failures.length
      ? `；${results.failures.length} 筆失敗：${results.failures.map(item => `${item.id}：${item.message}`).join("；")}`
      : "";
    notice.value = `已清理 ${results.removed.length} 筆${failureText}${interrupted}`;
    selected.value = [];
    dialog.value?.close();
    confirmation.value = null;
    await loadRecords();
  } finally { loading.value = false; }
}

onMounted(loadRecords);
</script>

<template>
  <section class="surface handoff-records" aria-labelledby="handoff-records-title" :aria-busy="loading">
    <div class="records-heading">
      <div>
        <h3 id="handoff-records-title">交接紀錄</h3>
        <p class="records-note">接收狀態由新 session 回報。這裡可隨時查看，不受 Context 門檻限制；不會自動清理。</p>
      </div>
      <button class="scan-button" type="button" :disabled="loading" @click="loadRecords">重新整理</button>
    </div>
    <div class="records-actions">
      <button class="scan-button" type="button" :disabled="loading || !completedCount || !!error" @click="confirmCleanup('completed')">清理已完成紀錄（{{ completedCount }}）</button>
      <button class="scan-button" type="button" :disabled="loading || !selectedRecords.length || !!error" @click="confirmCleanup('unreceived')">刪除選取的未接收報告（{{ selectedRecords.length }}）</button>
    </div>
    <form class="records-actions" @submit.prevent="handleFilter">
      <label>來源 <select v-model="sourceFilter" :disabled="loading"><option value="">全部</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
      <label>專案 <input v-model="projectFilter" :disabled="loading" maxlength="1000" placeholder="工作目錄關鍵字" /></label>
      <label>狀態 <select v-model="receptionFilter" :disabled="loading"><option value="">全部</option><option value="pending">等待產生／失敗</option><option value="awaiting">等待接收</option><option value="received">已接收，待移除</option><option value="complete">接收完成</option><option value="missing">接收未確認</option><option value="discarded">已手動刪除</option></select></label>
      <button class="scan-button" type="submit" :disabled="loading">套用篩選</button>
    </form>
    <p class="records-note">已完成紀錄清理涵蓋目前篩選結果的所有頁；未接收報告只選取本頁，換頁會清除選取。</p>
    <p v-if="error && !confirmation" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-for="warning in inventory.warnings" :key="warning" class="records-warning" role="alert">{{ warning }}</p>
    <p v-if="loading && !inventory.records.length" role="status">載入交接紀錄…</p>
    <p v-else-if="!inventory.records.length && !error" class="records-note">沒有符合條件的交接紀錄。</p>
    <div v-else class="records-table-wrap">
      <table>
        <caption class="records-note">未接收報告須個別選取；已接收但未移除的報告不列入清理。</caption>
        <thead><tr><th scope="col">選取</th><th scope="col">來源／專案</th><th scope="col">建立時間</th><th scope="col">狀態</th><th scope="col">報告大小</th></tr></thead>
        <tbody>
          <tr v-for="record in inventory.records" :key="record.id" :data-handoff-id="record.id">
            <td><input v-model="selected" type="checkbox" :value="record.id" :disabled="loading || !canDiscard(record)" :aria-label="`選取 ${record.source} ${record.id}`" /></td>
            <td><strong :class="record.source">{{ record.source === 'claude' ? 'Claude' : 'Codex' }}</strong><div class="record-path">{{ record.cwd }}</div><small :title="record.sessionId">{{ record.sessionId }}</small></td>
            <td>{{ dateText(record.createdAt) }}</td>
            <td><strong>{{ statusText(record) }}</strong><div v-if="record.receipt" class="records-note">接收：{{ dateText(record.receipt.receivedAt) }}<br />接收 session：{{ record.receipt.receiverSessionId ?? '未提供' }}</div><div v-else-if="record.reception === 'pending'" class="records-note">{{ record.message }}</div></td>
            <td>{{ record.reportBytes == null ? '—' : (record.reportBytes / 1024).toFixed(1) + ' KiB' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <nav class="records-actions" aria-label="交接紀錄分頁">
      <button class="scan-button" type="button" :disabled="loading || page <= 1 || !!error" @click="handlePage(page - 1)">上一頁</button>
      <span role="status">第 {{ page }} / {{ pageCount }} 頁 · 共 {{ inventory.total ?? inventory.records.length }} 筆</span>
      <button class="scan-button" type="button" :disabled="loading || page >= pageCount || !!error" @click="handlePage(page + 1)">下一頁</button>
    </nav>
    <dialog ref="dialog" aria-labelledby="cleanup-title" aria-describedby="cleanup-description" @cancel.prevent="cancelCleanup">
      <template v-if="confirmation">
        <h3 id="cleanup-title">{{ confirmation.mode === 'completed' ? '清理已完成紀錄' : '刪除未接收報告' }}</h3>
        <p id="cleanup-description">{{ confirmation.mode === 'completed' ? '將移除以下交接的請求與接收紀錄，清理後不再顯示歷史狀態。' : '以下報告尚未接收，刪除後無法再接收其內容。將一併移除對應請求紀錄。' }}</p>
        <ul><li v-for="record in confirmation.records" :key="record.id">{{ record.source }} · {{ record.cwd }} · {{ record.id }}</li></ul>
        <p v-if="error" role="alert">{{ error }}</p>
        <div class="records-actions">
          <button class="scan-button" type="button" autofocus :disabled="loading" @click="cancelCleanup">取消</button>
          <button class="scan-button" type="button" :disabled="loading" @click="handleCleanup">{{ loading ? '清理中…' : '確認清理' }}</button>
        </div>
      </template>
    </dialog>
  </section>
</template>

<style scoped>
.handoff-records { margin: 24px 0; }
.records-heading, .records-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.records-heading { justify-content: space-between; }
form.records-actions, nav.records-actions { margin-top: 12px; }
select, input:not([type="checkbox"]) { max-width: 100%; padding: 6px; border: 1px solid var(--stroke); border-radius: 6px; background: var(--bg-panel); color: var(--text); font: inherit; }
h3 { margin: 0 0 8px; }
.records-note, small { color: var(--muted); font-size: 0.85rem; overflow-wrap: anywhere; }
.records-warning, [role="alert"] { color: #9c442a; overflow-wrap: anywhere; }
.records-table-wrap { overflow-x: auto; margin-top: 18px; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
caption { text-align: left; padding-bottom: 12px; }
th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--stroke); vertical-align: top; }
td { min-width: 100px; }
td:first-child { min-width: 40px; }
.record-path { max-width: 260px; overflow-wrap: anywhere; margin: 6px 0; }
.claude { color: var(--claude); } .codex { color: var(--codex); }
button:disabled { cursor: default; opacity: 0.5; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--codex); outline-offset: 3px; }
dialog { width: min(640px, 90vw); max-height: 80vh; overflow: auto; border: 1px solid var(--stroke-strong); border-radius: 16px; padding: 24px; color: var(--text); background: var(--bg-panel); }
dialog::backdrop { background: rgba(0, 0, 0, 0.35); }
dialog li { overflow-wrap: anywhere; margin-bottom: 8px; }
</style>
