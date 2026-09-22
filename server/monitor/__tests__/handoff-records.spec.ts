import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { HandoffService, registerHandoffRoutes, type HandoffReceipt, type HandoffStatus } from "../handoff.js";
import { SessionMonitorState } from "../state.js";

const target = { source: "codex" as const, sessionId: "12345678-1111-2222-3333-444444444444" };
const cleanups: Array<() => Promise<unknown>> = [];

it("filters and pages records without duplicating entries across pages", async () => {
  const { service, job, root } = await fixture();
  for (let index = 0; index < 52; index++) {
    const id = randomUUID();
    await fs.writeFile(path.join(root, `handoff-${id}.request.json`), JSON.stringify({ ...job, id,
      source: "claude", cwd: path.join(root, "paged-project"), reportPath: path.join(root, `handoff-${id}.json`) }));
  }
  const first = await service.listRecords({ source: "claude", project: "paged-project", reception: "pending", page: 1 });
  const second = await service.listRecords({ source: "claude", project: "paged-project", reception: "pending", page: 2 });
  expect(first.total).toBe(52);
  expect(first.records).toHaveLength(50);
  expect(second.records).toHaveLength(2);
  expect(new Set([...first.records, ...second.records].map(record => record.id)).size).toBe(52);
  expect((await service.listRecords({ source: "claude", page: 100 })).page).toBe(2);
  expect((await service.listRecords({ source: "codex" })).records).toHaveLength(1);
  await expect(service.listRecords({ page: 0 })).rejects.toThrow("無效");
});

it("reuses unchanged report inspection but invalidates it when a receipt arrives", async () => {
  const { service, report, receipt, job } = await fixture();
  await report();
  await service.listRecords();
  const readFile = vi.spyOn(fs, "readFile");
  expect((await service.listRecords()).records[0].reception).toBe("awaiting");
  expect(readFile.mock.calls.filter(([file]) => file === job.reportPath)).toHaveLength(0);
  await receipt();
  expect((await service.listRecords()).records[0].reception).toBe("received");
  expect(readFile.mock.calls.some(([file]) => file === job.reportPath)).toBe(true);
  await fs.unlink(job.reportPath);
  expect((await service.listRecords()).records[0].reception).toBe("complete");
});
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hud-records-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const dispatch = vi.fn(async () => undefined);
  const state = new SessionMonitorState(target.source, target.sessionId);
  Object.assign(state.data, { cwd: root, status: "idle" });
  const options = { root, token: "fixture-token", dispatch,
    getSession: async () => ({ state: "ready" as const, data: state.data }) };
  const service = new HandoffService(options);
  cleanups.push(() => service.close());
  const job = await service.prepare(target, "manual");
  const receiptPath = path.join(root, `handoff-${job.id}.receipt.json`);
  const metadataPath = path.join(root, `${target.source}-${target.sessionId}.request.json`);
  async function report() {
    await fs.writeFile(job.reportPath, JSON.stringify({ version: 1, handoffId: job.id, ...target, cwd: root,
      generatedAt: new Date().toISOString(), goal: "fixture", completed: [], changedFiles: [],
      verification: { passed: [], pending: [], failures: [] }, unfinished: [], cautions: [], next: [] }));
    await service.status(target);
    return { ...target, id: job.id, digest: job.digest! };
  }
  async function receipt(overrides: Partial<HandoffReceipt> = {}) {
    await fs.writeFile(receiptPath, JSON.stringify({ version: 1, handoffId: job.id, ...target, cwd: root,
      sha256: job.digest, receivedAt: new Date().toISOString(), receiverSessionId: null, deletion: "pending", ...overrides }));
  }
  return { root, options, service, job, report, receipt, receiptPath, metadataPath, dispatch };
}

it("tracks waiting, received, removal and restored completion without treating receipt claims as file deletion", async () => {
  const { service, report, receipt, job, options } = await fixture();
  await report();
  expect((await service.listRecords()).records[0].reception).toBe("awaiting");
  await receipt({ deletion: "deleted" });
  expect(await service.status(target)).toMatchObject({ phase: "received" });
  expect((await service.listRecords()).records[0]).toMatchObject({ reception: "received", reportBytes: expect.any(Number) });
  await fs.unlink(job.reportPath);
  expect(await service.status(target)).toMatchObject({ phase: "complete" });
  await service.close();
  const restored = new HandoffService(options);
  cleanups.push(() => restored.close());
  expect((await restored.listRecords()).records[0]).toMatchObject({ reception: "complete", reportBytes: null });
});

it("stops status polling once a handoff is complete", async () => {
  const { service, report, receipt, job } = await fixture();
  await report();
  await receipt();
  await fs.unlink(job.reportPath);
  await service.status(target);
  expect((service as unknown as { timer: NodeJS.Timeout | undefined }).timer).toBeUndefined();
});

it("does not infer reception when an old report disappears without a receipt", async () => {
  const { service, report, job } = await fixture();
  const selection = await report();
  await fs.unlink(job.reportPath);
  expect(await service.status(target)).toMatchObject({ phase: "removed", message: expect.stringContaining("接收未確認") });
  expect((await service.cleanup([selection], "completed")).failures).toHaveLength(1);
  expect((await service.listRecords()).records[0].reception).toBe("missing");
});

it("retains a received report after deletion failure and excludes it from both cleanup modes", async () => {
  const { service, report, receipt, job } = await fixture();
  const selection = await report();
  await receipt({ deletion: "failed" });
  expect(await service.status(target)).toMatchObject({ phase: "received", message: expect.stringContaining("失敗") });
  for (const mode of ["completed", "unreceived"] as const) expect((await service.cleanup([selection], mode)).failures).toHaveLength(1);
  expect(await fs.readFile(job.reportPath, "utf8")).toContain(job.id);
});

it("rejects mismatched receipts and reports without deleting any managed files", async () => {
  const { service, report, receipt, job, receiptPath } = await fixture();
  const selection = await report();
  await receipt({ sha256: "0".repeat(64) });
  expect((await service.listRecords()).warnings).toHaveLength(1);
  expect((await service.cleanup([selection], "unreceived")).failures).toHaveLength(1);
  await fs.unlink(receiptPath);
  await fs.appendFile(job.reportPath, " ");
  expect((await service.cleanup([selection], "unreceived")).failures).toHaveLength(1);
  expect(await fs.stat(job.reportPath)).toBeTruthy();
});

it("checks fresh reception state before deleting a previously selected report", async () => {
  const { service, report, receipt, job } = await fixture();
  const selection = await report();
  await service.listRecords();
  await receipt();
  const result = await service.cleanup([selection], "unreceived");
  expect(result.removed).toEqual([]);
  expect(result.failures).toHaveLength(1);
  expect(await fs.stat(job.reportPath)).toBeTruthy();
});

it("deletes only the selected unreceived report and its metadata, leaving unrelated files intact", async () => {
  const { service, report, root, job, metadataPath } = await fixture();
  const selection = await report();
  await fs.writeFile(path.join(root, "unrelated.json"), "keep");
  expect(await service.cleanup([selection], "unreceived")).toEqual({ removed: [job.id], failures: [] });
  await expect(fs.stat(job.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(root, "unrelated.json"), "utf8")).toBe("keep");
  expect(await service.status(target)).toBeNull();
});

it("cleans archived completed records without deleting a newer request from the same session", async () => {
  const { service, report, receipt, job, metadataPath, receiptPath } = await fixture();
  const selection = await report();
  await receipt();
  await fs.unlink(job.reportPath);
  await service.status(target);
  const next = await service.prepare(target, "manual");
  expect((await service.listRecords()).records).toHaveLength(2);
  expect(await service.cleanup([selection], "completed")).toEqual({ removed: [job.id], failures: [] });
  expect(JSON.parse(await fs.readFile(metadataPath, "utf8")).id).toBe(next.id);
  await expect(fs.stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await service.listRecords()).records.map(record => record.id)).toEqual([next.id]);
});

it.each(["completed", "unreceived"] as const)("recovers a partial %s cleanup after restart", async mode => {
  const { service, report, receipt, job, metadataPath, options } = await fixture();
  const selection = await report();
  if (mode === "completed") { await receipt(); await fs.unlink(job.reportPath); }
  const unlink = fs.unlink.bind(fs);
  const failure = vi.spyOn(fs, "unlink").mockImplementation(async file => {
    if (file === metadataPath) throw Object.assign(new Error("file locked"), { code: "EPERM" });
    return unlink(file);
  });
  expect((await service.cleanup([selection], mode)).failures).toHaveLength(1);
  failure.mockRestore();
  await service.close();
  const restored = new HandoffService(options);
  cleanups.push(() => restored.close());
  expect((await restored.listRecords()).records[0].reception).toBe(mode === "completed" ? "complete" : "discarded");
  expect(await restored.cleanup([selection], mode)).toEqual({ removed: [job.id], failures: [] });
  expect((await restored.listRecords()).records).toEqual([]);
});

it("rejects path traversal and skips invalid metadata rather than acting on its report path", async () => {
  const { service, report, metadataPath, root } = await fixture();
  const selection = await report();
  await expect(service.cleanup([{ ...selection, id: "../outside" }], "unreceived")).rejects.toThrow("無效");
  const outside = path.join(root, "keep.json");
  await fs.writeFile(outside, "keep");
  const metadata: HandoffStatus = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, reportPath: outside }));
  expect((await service.listRecords()).warnings).toHaveLength(1);
  expect((await service.cleanup([selection], "unreceived")).failures).toHaveLength(1);
  expect(await fs.readFile(outside, "utf8")).toBe("keep");
});

it("does not dispatch or include in-flight requests in cleanup when listing records", async () => {
  const { service, metadataPath, dispatch, job, options } = await fixture();
  await service.close();
  await fs.writeFile(metadataPath, JSON.stringify({ ...job, phase: "waiting" }));
  const restored = new HandoffService(options);
  cleanups.push(() => restored.close());
  expect((await restored.listRecords()).records[0].reception).toBe("pending");
  expect(dispatch).not.toHaveBeenCalled();
  expect((await restored.cleanup([{ ...target, id: job.id, digest: "0".repeat(64) }], "completed")).failures).toHaveLength(1);
});

it("requires the capability token and explicit confirmation for cleanup API requests", async () => {
  const { service, report, options, job } = await fixture();
  const selection = await report();
  const app = Fastify();
  cleanups.push(() => app.close());
  registerHandoffRoutes(app, service, options.token);
  const payload = { action: "cleanup", mode: "unreceived", selection: [selection] };
  expect((await app.inject({ method: "POST", url: "/api/handoffs", payload: { action: "list" } })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: "/api/handoffs", payload: { ...payload, confirmed: true } })).statusCode).toBe(403);
  const headers = { "x-token-hud": options.token };
  expect((await app.inject({ method: "POST", url: "/api/handoffs", headers, payload })).statusCode).toBe(400);
  expect(await fs.stat(job.reportPath)).toBeTruthy();
  const response = await app.inject({ method: "POST", url: "/api/handoffs", headers, payload: { ...payload, confirmed: true } });
  expect(response.json().data).toEqual({ removed: [job.id], failures: [] });
});

it("rechecks report bytes after persisting cleanup intent and preserves a newly changed report", async () => {
  const { service, report, job, metadataPath } = await fixture();
  const selection = await report();
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if (to === metadataPath) await fs.appendFile(job.reportPath, " ");
  });
  expect((await service.cleanup([selection], "unreceived")).failures).toHaveLength(1);
  expect(await fs.readFile(job.reportPath, "utf8")).toContain(job.id);
});

it("rejects symbolic-link metadata before reading or deleting its target", async () => {
  const { service, report, metadataPath, job } = await fixture();
  const selection = await report();
  const lstat = fs.lstat.bind(fs);
  const metadataStat = await fs.lstat(metadataPath);
  const linkStat = Object.assign(Object.create(metadataStat), { isSymbolicLink: () => true });
  vi.spyOn(fs, "lstat").mockImplementation(((file: string) => file === metadataPath ? Promise.resolve(linkStat) : lstat(file)) as typeof fs.lstat);
  expect((await service.listRecords()).warnings).toHaveLength(1);
  expect((await service.cleanup([selection], "unreceived")).failures).toHaveLength(1);
  expect(await fs.readFile(job.reportPath, "utf8")).toContain(job.id);
});

it("includes a minimal receipt template before deletion instructions in both reception paths", async () => {
  const { service, report, receiptPath } = await fixture();
  await report();
  for (const text of [await service.prompt(target, "receive"), await service.reportContent(target)]) {
    const lines = text.split("\n");
    expect(JSON.parse(lines[1]).receiptPath).toBe(receiptPath);
    const template = JSON.parse(lines.find(line => line.startsWith('{"version":1'))!);
    expect(template).toMatchObject({ deletion: "pending", receiverSessionId: null });
    expect(template).not.toHaveProperty("goal");
    expect(text.indexOf("接收紀錄寫入成功後")).toBeGreaterThan(text.indexOf('"deletion":"pending"'));
  }
});
