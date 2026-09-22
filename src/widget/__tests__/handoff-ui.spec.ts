import fs from "node:fs";
import ts from "typescript";
import { computed, nextTick, ref, watch } from "vue";
import { afterEach, expect, it, vi } from "vitest";

// Execute the real setup logic with browser/API boundaries supplied by the test.
function setup(file: string, exports: string, api: object) {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8").split('<script setup lang="ts">')[1].split("</script>")[0];
  const compiled = ts.transpileModule(source.replace(/^import .*;\r?$/gm, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function("ref", "computed", "watch", "nextTick", "onMounted", "onBeforeUnmount", "api",
    `${compiled}\nreturn { ${exports} };`)(ref, computed, watch, nextTick, () => {}, () => {}, api);
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("confirms completed records across all filtered pages rather than just the visible page", async () => {
  const records = Array.from({ length: 51 }, (_, index) => ({ id: String(index), reception: "complete" }));
  const list = vi.fn(async () => ({ records, warnings: [], total: 51 }));
  const state = setup("../../components/HandoffRecords.vue", "inventory, activeFilters, confirmCleanup, confirmation", { handoffRecords: list });
  state.inventory.value = { records: records.slice(0, 50), warnings: [], total: 51, completedCount: 51 };
  state.activeFilters.value = { source: "codex", project: "fixture" };
  await state.confirmCleanup("completed");
  expect(list).toHaveBeenCalledWith("list", undefined, undefined, { source: "codex", project: "fixture", reception: "complete" });
  expect(state.confirmation.value.records).toHaveLength(51);
});

it("retains partial cleanup results and refreshes before allowing a new selection", async () => {
  const records = Array.from({ length: 450 }, (_, index) => ({ id: String(index), source: "codex", sessionId: "fixture", digest: "digest", reception: "complete" }));
  const batches: number[] = [];
  const api = { handoffRecords: vi.fn(async (action: string, _mode: string, selection: Array<{ id: string }>) => {
    if (action === "list") return { records: records.slice(200), warnings: [] };
    batches.push(selection.length);
    if (batches.length === 2) throw new Error("連線中斷");
    return { removed: selection.map(item => item.id), failures: [] };
  }) };
  const state = setup("../../components/HandoffRecords.vue", "confirmation, handleCleanup, notice, inventory, loading", api);
  state.confirmation.value = { mode: "completed", records };
  await state.handleCleanup();
  expect(batches).toEqual([200, 200]);
  expect(state.notice.value).toContain("已清理 200 筆");
  expect(state.notice.value).toContain("200 筆結果未確認，50 筆未處理");
  expect(state.inventory.value.records).toHaveLength(250);
  expect(state.confirmation.value).toBeNull();
  expect(state.loading.value).toBe(false);
});

it("cleans more than 200 records in bounded batches and displays the total", async () => {
  const records = Array.from({ length: 201 }, (_, index) => ({ id: String(index) }));
  const batches: number[] = [];
  const state = setup("../../components/HandoffRecords.vue", "confirmation, handleCleanup, notice", {
    handoffRecords: async (action: string, _mode: string, selection: Array<{ id: string }>) => {
      if (action === "list") return { records: [], warnings: [] };
      batches.push(selection.length);
      return { removed: selection.map(item => item.id), failures: [] };
    },
  });
  state.confirmation.value = { mode: "completed", records };
  await state.handleCleanup();
  expect(batches).toEqual([200, 1]);
  expect(state.notice.value).toBe("已清理 201 筆");
});

it("recovers a failed initial status request below the Context threshold and tracks ready through completion", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    location: { search: "?overlay=1&session=11111111-1111-1111-1111-111111111111" },
    setTimeout, clearTimeout,
  });
  const handoff = vi.fn().mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ phase: "ready" }).mockResolvedValueOnce({ phase: "complete" });
  const state = setup("../WidgetApp.vue", "loadHandoffStatus, handoff, handoffNotice, showHandoffControls", { handoff });
  expect(state.showHandoffControls.value).toBe(false);
  await state.loadHandoffStatus();
  expect(state.handoffNotice.value).toBe("offline");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(state.handoff.value.phase).toBe("ready");
  expect(state.handoffNotice.value).toBe("");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(state.handoff.value.phase).toBe("complete");
  expect(vi.getTimerCount()).toBe(0);
});
