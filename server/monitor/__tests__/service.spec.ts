import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { SessionMonitorService } from "../service.js";
import { registerMonitorRoutes } from "../routes.js";
import type { MonitorSnapshot } from "../state.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
const id = "12345678-1111-2222-3333-444444444444";
const otherId = "12345678-1111-2222-3333-555555555555";
const line = (value: unknown) => JSON.stringify(value) + "\n";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hud-monitor-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const options = { claudeRoot: path.join(root, "claude"), codexRoot: path.join(root, "codex"), eventRoot: path.join(root, "events") };
  for (const directory of Object.values(options)) await fs.mkdir(directory);
  const service = new SessionMonitorService(options);
  cleanups.push(() => service.close());
  return { service, options, root };
}

async function snapshot(service: SessionMonitorService, source: "claude" | "codex" = "claude") {
  const result = await service.get(source, id);
  if (result.state !== "ready") throw new Error("Not ready: " + result.state);
  return result.data;
}

it("keeps sources isolated and rejects ambiguous session prefixes", async () => {
  const { service, options } = await fixture();
  await fs.writeFile(path.join(options.claudeRoot, id + ".jsonl"), "");
  await fs.writeFile(path.join(options.claudeRoot, otherId + ".jsonl"), "");
  await fs.writeFile(path.join(options.codexRoot, "rollout-date-" + id + ".jsonl"), "");
  await service.start();
  expect(await service.get("claude", "12345678")).toEqual({ state: "ambiguous" });
  expect((await service.get("codex", "12345678")).state).toBe("ready");
  expect(await service.get("claude", "../escape")).toEqual({ state: "pending" });
  expect(await service.get("claude", "99999999")).toEqual({ state: "pending" });
});

it("updates on append, keeps incomplete lines pending and resets truncated logs", async () => {
  const { service, options } = await fixture();
  const file = path.join(options.claudeRoot, id + ".jsonl");
  const record = (tokens: number) => ({ timestamp: new Date().toISOString(),
    message: { role: "assistant", id: "m1", model: "test", usage: { input_tokens: tokens } } });
  await fs.writeFile(file, line(record(1000)));
  await service.start();
  expect((await snapshot(service)).sessionTokens).toBe(1000);
  const appended = line(record(2000));
  await fs.appendFile(file, appended.slice(0, -1));
  await vi.waitFor(async () => expect((await snapshot(service)).observedAt).not.toBeNull());
  expect((await snapshot(service)).sessionTokens).toBe(1000);
  await fs.appendFile(file, "\n");
  await vi.waitFor(async () => expect((await snapshot(service)).sessionTokens).toBe(2000));
  await fs.writeFile(file, line(record(3)));
  await vi.waitFor(async () => expect((await snapshot(service)).sessionTokens).toBe(3));
});

it("reports malformed records and recovers after file replacement", async () => {
  const { service, options } = await fixture();
  const file = path.join(options.claudeRoot, id + ".jsonl");
  await fs.writeFile(file, "broken\n");
  await service.start();
  expect((await snapshot(service)).readError).toBe(true);
  await fs.unlink(file);
  await vi.waitFor(async () => expect((await snapshot(service)).readError).toBe(true));
  await fs.writeFile(file, "");
  await vi.waitFor(async () => expect((await snapshot(service)).readError).toBe(false));
});

it("does not notify replayed completions and emits once for a new successful turn", async () => {
  const { service, options } = await fixture();
  const file = path.join(options.eventRoot, "claude-" + id + ".events.jsonl");
  let sequence = 0;
  const event = (name: string, time: number) => ({ source: "claude", sessionId: id, event: name, eventId: String(++sequence), timestamp: new Date(time).toISOString() });
  const time = Date.now();
  await fs.writeFile(file, line(event("UserPromptSubmit", time - 2000)) + line(event("Stop", time - 1000)));
  const notifications: MonitorSnapshot[] = [];
  service.onComplete(data => notifications.push(data));
  await service.start();
  expect((await snapshot(service)).status).toBe("idle");
  expect(notifications).toEqual([]);
  await fs.appendFile(file, line(event("UserPromptSubmit", time + 10)) + line(event("Stop", time + 20)));
  await vi.waitFor(() => expect(notifications).toHaveLength(1), { timeout: 5000 });
  await fs.appendFile(file, line(event("Stop", time + 30)));
  await vi.waitFor(async () => expect((await snapshot(service)).sourceUpdatedAt).toBe(new Date(time + 30).toISOString()));
  expect(notifications[0]).toMatchObject({ source: "claude", sessionId: id, status: "idle" });
  expect(notifications).toHaveLength(1);
});

it("cancels completion when an interruption follows Stop", async () => {
  const { service, options } = await fixture();
  const file = path.join(options.eventRoot, "claude-" + id + ".events.jsonl");
  await fs.writeFile(file, "");
  await service.start();
  await snapshot(service);
  const notifications: MonitorSnapshot[] = [];
  service.onComplete(data => notifications.push(data));
  const time = Date.now();
  const event = (name: string, offset: number) => line({ source: "claude", sessionId: id, event: name, eventId: name,
    timestamp: new Date(time + offset).toISOString() });
  await fs.appendFile(file, event("UserPromptSubmit", 1) + event("Stop", 2));
  await vi.waitFor(async () => expect((await snapshot(service)).status).toBe("idle"));
  await fs.appendFile(file, event("Interrupt", 3));
  await vi.waitFor(async () => expect((await snapshot(service)).status).toBe("interrupted"));
  await fs.appendFile(file, event("UserPromptSubmit", 4).replace('"eventId":"UserPromptSubmit"', '"eventId":"next-prompt"') +
    event("Stop", 5).replace('"eventId":"Stop"', '"eventId":"next-stop"'));
  await vi.waitFor(() => expect(notifications).toHaveLength(1), { timeout: 5000 });
  expect(notifications[0].turnStartedAt).toBe(new Date(time + 4).toISOString());
});

it("serves validated snapshots and closes SSE connections during shutdown", async () => {
  const { service, options } = await fixture();
  await fs.writeFile(path.join(options.claudeRoot, id + ".jsonl"), "");
  await service.start();
  const app = Fastify();
  registerMonitorRoutes(app, service);
  cleanups.push(() => app.close());
  expect((await app.inject("/api/monitor?source=other&session=" + id)).statusCode).toBe(400);
  const response = await app.inject("/api/monitor?source=claude&session=" + id);
  expect(response.json()).toMatchObject({ ok: true, data: { state: "ready", data: { sessionId: id, source: "claude" } } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const stream = await fetch("http://127.0.0.1:" + address.port + "/api/monitor/stream?source=claude&session=" + id);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  const reader = stream.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"sessionId":"' + id + '"');
  await app.close();
  expect((await reader.read()).done).toBe(true);
});
