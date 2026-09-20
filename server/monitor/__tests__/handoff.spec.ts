import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { HandoffService, registerHandoffRoutes, type HandoffStatus } from "../handoff.js";
import { SessionMonitorState } from "../state.js";

const target = { source: "codex" as const, sessionId: "12345678-1111-2222-3333-444444444444" };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hud-handoff-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const state = new SessionMonitorState(target.source, target.sessionId);
  Object.assign(state.data, { cwd: root, status: "idle" });
  const dispatch = vi.fn(async () => undefined);
  const options = { root: path.join(root, "reports"), token: "fixture-token",
    getSession: async () => ({ state: "ready" as const, data: state.data }), dispatch };
  const service = new HandoffService(options);
  cleanups.push(() => service.close());
  return { service, state, dispatch, options };
}

async function writeReport(job: HandoffStatus, overrides = {}) {
  const report = { version: 1, handoffId: job.id, source: job.source, sessionId: job.sessionId, cwd: job.cwd,
    generatedAt: new Date().toISOString(), goal: "測試交接", completed: ["已核對"],
    changedFiles: [], verification: { passed: [], pending: [], failures: [] }, unfinished: [], cautions: [], next: [],
    ...overrides };
  await fs.writeFile(job.reportPath, JSON.stringify(report));
}

it("waits through work and approval, then dispatches one prompt to the exact session", async () => {
  const { service, state, dispatch } = await fixture();
  state.data.status = "running";
  const jobs = await Promise.all([service.prepare(target, "queue"), service.prepare(target, "queue")]);
  expect(jobs[0].id).toBe(jobs[1].id);
  expect((await service.status(target))?.phase).toBe("waiting");
  state.data.status = "waiting_approval";
  expect((await service.status(target))?.phase).toBe("waiting");
  expect(dispatch).not.toHaveBeenCalled();
  state.data.status = "idle";
  const results = await Promise.all([service.status(target), service.status(target)]);
  expect(results.map(result => result?.phase)).toEqual(["queued", "queued"]);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]).toEqual([target.sessionId, state.data.cwd, expect.stringContaining(JSON.stringify(jobs[0].reportPath))]);
});

it("rejects short IDs, mismatched sessions and missing working directories", async () => {
  const { service, state, dispatch } = await fixture();
  await expect(service.prepare({ ...target, sessionId: "12345678" }, "queue")).rejects.toThrow("無效");
  state.data.sessionId = "99999999-1111-2222-3333-444444444444";
  await expect(service.prepare(target, "queue")).rejects.toThrow("無法確認");
  state.data.sessionId = target.sessionId;
  state.data.cwd = undefined;
  await expect(service.prepare(target, "manual")).rejects.toThrow("無法確認");
  expect(dispatch).not.toHaveBeenCalled();
});

it("never sends Claude through Codex and produces a manual prompt for the original AI", async () => {
  const { service, state, dispatch } = await fixture();
  const claude = { ...target, source: "claude" as const };
  state.data.source = "claude";
  await expect(service.prepare(claude, "queue")).rejects.toThrow("Claude");
  const job = await service.prepare(claude, "manual");
  expect((await service.prompt(claude, "generate"))).toContain(JSON.stringify(job.reportPath));
  expect((await service.status(claude))?.phase).toBe("manual");
  expect(dispatch).not.toHaveBeenCalled();
});

it("only accepts a complete report with matching identity and supplies single-file reception instructions", async () => {
  const { service } = await fixture();
  const job = await service.prepare(target, "manual");
  await writeReport(job, { handoffId: "wrong" });
  expect((await service.status(target))?.phase).toBe("failed");
  await expect(service.prompt(target, "receive")).rejects.toThrow("尚未");
  await writeReport(job, { generatedAt: "2020-01-01T00:00:00Z" });
  expect((await service.status(target))?.phase).toBe("failed");
  await writeReport(job, { verification: null });
  expect((await service.status(target))?.phase).toBe("failed");
  await writeReport(job);
  expect((await service.status(target))?.phase).toBe("ready");
  const prompt = await service.prompt(target, "receive");
  expect(prompt).toContain(JSON.stringify(job.reportPath));
  expect(prompt).toContain("sha256");
  expect(prompt).toContain("刪除上述單一報告");
  expect(prompt).toContain("等待我的新執行指令");
  expect(await fs.readFile(job.reportPath, "utf8")).toContain(job.id);
});

it("detects changed and removed reports instead of reusing old reception instructions", async () => {
  const { service } = await fixture();
  const job = await service.prepare(target, "manual");
  await writeReport(job);
  await service.status(target);
  await writeReport(job, { goal: "被改寫" });
  await expect(service.prompt(target, "receive")).rejects.toThrow("尚未");
  await fs.unlink(job.reportPath);
  expect((await service.status(target))?.phase).toBe("removed");
  const next = await service.prepare(target, "manual");
  expect(next.id).not.toBe(job.id);
  expect(next.reportPath).not.toBe(job.reportPath);
});

it("survives restart without dispatching a pending request again", async () => {
  const { service, options, dispatch } = await fixture();
  const job = await service.prepare(target, "queue");
  await service.close();
  const restored = new HandoffService(options);
  cleanups.push(() => restored.close());
  expect((await restored.status(target))?.phase).toBe("failed");
  expect((await restored.prepare(target, "queue")).id).toBe(job.id);
  expect(dispatch).not.toHaveBeenCalled();
});

it("reports a dispatch failure without claiming report success or automatically retrying", async () => {
  const { service, dispatch } = await fixture();
  dispatch.mockRejectedValue(new Error("daemon unavailable"));
  const job = await service.prepare(target, "queue");
  expect(await service.status(target)).toMatchObject({ phase: "failed", message: "daemon unavailable" });
  expect((await service.prepare(target, "queue")).id).toBe(job.id);
  expect((await service.status(target))?.phase).toBe("failed");
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(await service.prompt(target, "generate")).toContain(JSON.stringify(job.reportPath));
});

it("stops before dispatch when the original working directory changes", async () => {
  const { service, state, dispatch } = await fixture();
  await service.prepare(target, "queue");
  state.data.cwd = path.join(state.data.cwd!, "other");
  expect((await service.status(target))?.phase).toBe("failed");
  expect(dispatch).not.toHaveBeenCalled();
});

it("requires the app capability token before reading or creating a handoff", async () => {
  const { service, options, dispatch } = await fixture();
  const app = Fastify();
  registerHandoffRoutes(app, service, options.token);
  cleanups.push(() => app.close());
  const payload = { ...target, action: "prepare", mode: "manual" };
  expect((await app.inject({ method: "POST", url: "/api/handoff", payload })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: "/api/handoff",
    headers: { "x-token-hud": options.token }, payload: { ...payload, sessionId: "../escape" } })).statusCode).toBe(400);
  const response = await app.inject({ method: "POST", url: "/api/handoff",
    headers: { "x-token-hud": options.token }, payload });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({ ...target, phase: "manual" });
  expect(dispatch).not.toHaveBeenCalled();
});

it("extracts real working directories without using a Claude subagent directory", () => {
  const state = new SessionMonitorState(target.source, target.sessionId);
  state.acceptLog({ type: "session_meta", timestamp: "2026-09-18T00:00:00Z", payload: { cwd: "C:/work/example" } });
  expect(state.data.cwd).toBe("C:/work/example");
  const claude = new SessionMonitorState("claude", target.sessionId);
  claude.acceptLog({ timestamp: "2026-09-18T00:00:00Z", cwd: "C:/work/example" });
  claude.acceptLog({ timestamp: "2026-09-18T00:01:00Z", cwd: "C:/wrong", isSidechain: true });
  expect(claude.data.cwd).toBe("C:/work/example");
});

it("times out without dispatching and still accepts a matching report that arrives late", async () => {
  const { service, dispatch } = await fixture();
  const job = await service.prepare(target, "queue");
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(job.createdAt) + 16 * 60_000);
  try {
    expect(await service.status(target)).toMatchObject({ phase: "failed", message: expect.stringContaining("逾時") });
    expect(dispatch).not.toHaveBeenCalled();
    await writeReport(job);
    expect((await service.status(target))?.phase).toBe("ready");
  } finally { clock.mockRestore(); }
});

it("reports source read failure while awaiting a report without creating a replacement request", async () => {
  const { service, state } = await fixture();
  const job = await service.prepare(target, "manual");
  state.data.readError = true;
  expect((await service.status(target))?.phase).toBe("failed");
  expect((await service.prepare(target, "manual")).id).toBe(job.id);
});

it("copies reception instructions and the complete report through the protected API without deleting the file", async () => {
  const { service, options } = await fixture();
  const job = await service.prepare(target, "manual");
  await writeReport(job, { completed: [""] });
  const emptyReportSize = (await fs.stat(job.reportPath)).size;
  await writeReport(job, { completed: ["x".repeat(256 * 1024 - emptyReportSize)] });
  const content = await fs.readFile(job.reportPath, "utf8");
  const app = Fastify();
  registerHandoffRoutes(app, service, options.token);
  cleanups.push(() => app.close());
  const payload = { ...target, action: "content" };
  expect((await app.inject({ method: "POST", url: "/api/handoff", payload })).statusCode).toBe(403);
  const response = await app.inject({ method: "POST", url: "/api/handoff",
    headers: { "x-token-hud": options.token }, payload });
  expect(response.statusCode).toBe(200);
  const copiedText: string = response.json().data;
  const metadata = JSON.parse(copiedText.split("\n")[1]);
  expect(metadata).toEqual({ path: job.reportPath, handoffId: job.id, ...target, cwd: job.cwd,
    sha256: createHash("sha256").update(content).digest("hex") });
  expect(copiedText).toContain("刪除上述單一報告");
  expect(copiedText).toContain("任一不符就停止並保留檔案");
  expect(copiedText).toContain("等待我的新執行指令");
  expect(copiedText.endsWith("\n" + content)).toBe(true);
  expect(Buffer.byteLength(content)).toBe(256 * 1024);
  expect(copiedText.length).toBeGreaterThan(256 * 1024);
  expect(copiedText.length).toBeLessThan(512 * 1024);
  expect(await fs.readFile(job.reportPath, "utf8")).toBe(content);
});

it("refuses to copy missing or modified report content", async () => {
  const { service } = await fixture();
  await expect(service.reportContent(target)).rejects.toThrow("尚未");
  const job = await service.prepare(target, "manual");
  await expect(service.reportContent(target)).rejects.toThrow("尚未");
  await writeReport(job);
  await service.status(target);
  await writeReport(job, { goal: "內容已更改" });
  await expect(service.reportContent(target)).rejects.toThrow("尚未");
  await fs.unlink(job.reportPath);
  await expect(service.reportContent(target)).rejects.toThrow("尚未");
});
