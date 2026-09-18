import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionMonitorState, type AgentSource, type MonitorResult, type MonitorSnapshot } from "./state.js";
import { JsonlTail } from "./tail.js";

type SourceFile = { path: string; kind: "log" | "hook"; source: AgentSource; sessionId: string };
type Cursor = { tail: JsonlTail; inode: number; size: number; modifiedAt: number; malformed: boolean };
type SessionEntry = {
  state: SessionMonitorState;
  cursors: Map<string, Cursor>;
  initialized: boolean;
  dirty: boolean;
  job?: Promise<void>;
  notification?: NodeJS.Timeout;
  notifiedTurn: string | null;
};
type MonitorOptions = { claudeRoot?: string; codexRoot?: string; eventRoot?: string };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export class SessionMonitorService {
  private roots: Array<{ path: string; kind: "log" | "hook"; source?: AgentSource }>;
  private files = new Map<string, SourceFile>();
  private sessions = new Map<string, SessionEntry>();
  private watchers = new Map<string, fs.FSWatcher>();
  private listeners = new Set<() => void>();
  private completions = new Set<(snapshot: MonitorSnapshot) => void>();
  private closed = false;
  private recoveryTimer?: NodeJS.Timeout;
  private startedAt = Date.now();

  constructor(options: MonitorOptions = {}) {
    const home = os.homedir();
    this.roots = [
      { path: options.claudeRoot ?? path.join(home, ".claude", "projects"), kind: "log", source: "claude" },
      { path: options.codexRoot ?? path.join(home, ".codex", "sessions"), kind: "log", source: "codex" },
      { path: options.eventRoot ?? path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "TokenUsageDashboard", "monitor"), kind: "hook" },
    ];
  }

  async start() {
    // Only the HUD-owned telemetry directory may be created.
    await fs.promises.mkdir(this.roots[2].path, { recursive: true });
    await this.discover();
    this.recoveryTimer = setInterval(() => {
      void this.discover().then(() => {
        for (const key of this.sessions.keys()) void this.refresh(key);
      });
    }, 30_000);
    this.recoveryTimer.unref();
  }

  private key(source: AgentSource, sessionId: string) { return source + ":" + sessionId; }

  private register(filePath: string, root: (typeof this.roots)[number]) {
    if (filePath.includes(path.sep + "subagents" + path.sep)) return;
    const name = path.basename(filePath);
    const match = root.kind === "hook" ? /^(claude|codex)-([a-zA-Z0-9_-]{8,128})\.events\.jsonl$/.exec(name) :
      new RegExp(root.source === "claude" ? "^(" + UUID + ")\\.jsonl$" : "^rollout-.*-(" + UUID + ")\\.jsonl$", "i").exec(name);
    if (!match) return;
    const source = root.source ?? match[1] as AgentSource;
    const sessionId = root.kind === "hook" ? match[2] : match[1];
    const isNew = !this.files.has(filePath);
    this.files.set(filePath, { path: filePath, kind: root.kind, source, sessionId });
    const key = this.key(source, sessionId);
    if (this.sessions.has(key)) void this.refresh(key);
    if (isNew) this.emit();
  }

  private async discover() {
    if (this.closed) return;
    for (const root of this.roots) {
      if (this.watchers.has(root.path)) continue;
      try {
        const watcher = fs.watch(root.path, { recursive: true }, (_event, filename) => {
          if (filename && !this.closed) this.register(path.join(root.path, filename.toString()), root);
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(root.path);
          for (const entry of this.sessions.values()) entry.state.data.readError = true;
          this.emit();
        });
        this.watchers.set(root.path, watcher);
        const names = await fs.promises.readdir(root.path, { recursive: true });
        for (const name of names) this.register(path.join(root.path, name), root);
      } catch {
        this.watchers.get(root.path)?.close();
        this.watchers.delete(root.path);
      }
    }
  }

  async get(source: AgentSource, prefix: string): Promise<MonitorResult> {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(prefix)) return { state: "pending" };
    const ids = new Set([...this.files.values()].filter(file => file.source === source && file.sessionId.startsWith(prefix)).map(file => file.sessionId));
    if (ids.size !== 1) return { state: ids.size ? "ambiguous" : "pending" };
    const sessionId = [...ids][0];
    const key = this.key(source, sessionId);
    let entry = this.sessions.get(key);
    if (!entry) {
      entry = { state: new SessionMonitorState(source, sessionId), cursors: new Map(), initialized: false, dirty: false, notifiedTurn: null };
      this.sessions.set(key, entry);
      await this.refresh(key);
    } else if (!entry.initialized) await entry.job;
    return { state: "ready", data: { ...entry.state.data } };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onComplete(listener: (snapshot: MonitorSnapshot) => void) {
    this.completions.add(listener);
    return () => { this.completions.delete(listener); };
  }

  private emit() { for (const listener of this.listeners) listener(); }

  private refresh(key: string): Promise<void> {
    const entry = this.sessions.get(key);
    if (!entry || this.closed) return Promise.resolve();
    entry.dirty = true;
    if (entry.job) return entry.job;
    entry.job = (async () => {
      while (entry.dirty && !this.closed) {
        entry.dirty = false;
        await this.readSession(key, entry);
      }
    })().finally(() => { entry.job = undefined; });
    return entry.job;
  }

  private async readSession(key: string, entry: SessionEntry) {
    const files = [...this.files.values()].filter(file => this.key(file.source, file.sessionId) === key)
      .sort((left, right) => (left.kind === "hook" ? 0 : 1) - (right.kind === "hook" ? 0 : 1));
    let readError = false;
    let rebuilt = false;
    const stats = new Map<string, fs.Stats>();
    for (const file of files) {
      try {
        const stat = await fs.promises.stat(file.path);
        if (!stat.isFile()) { readError = true; continue; }
        stats.set(file.path, stat);
        const cursor = entry.cursors.get(file.path);
        if (cursor && (stat.size < cursor.tail.offset || cursor.inode !== stat.ino ||
          (stat.size === cursor.size && stat.mtimeMs !== cursor.modifiedAt))) rebuilt = true;
      } catch { readError = true; }
    }
    if (rebuilt) {
      if (entry.notification) clearTimeout(entry.notification);
      entry.notification = undefined;
      entry.state = new SessionMonitorState(entry.state.data.source, entry.state.data.sessionId);
      entry.cursors.clear();
    }
    const before = { ...entry.state.data };
    for (const file of files) {
      const stat = stats.get(file.path);
      if (!stat) continue;
      let cursor = entry.cursors.get(file.path);
      if (!cursor) {
        cursor = { tail: new JsonlTail(), inode: stat.ino, size: stat.size, modifiedAt: stat.mtimeMs, malformed: false };
        entry.cursors.set(file.path, cursor);
      }
      try {
        const valid = await cursor.tail.read(file.path, stat.size, record => {
          if (file.kind === "hook") entry.state.acceptHook(record);
          else entry.state.acceptLog(record);
        });
        if (!valid) cursor.malformed = true;
        if (cursor.malformed) readError = true;
        cursor.size = stat.size;
        cursor.modifiedAt = stat.mtimeMs;
      } catch { readError = true; }
    }
    const data = entry.state.data;
    const rootHealthy = this.roots.filter(root => root.kind === "hook" || root.source === data.source)
      .every(root => this.watchers.has(root.path));
    data.readError = readError || !rootHealthy;
    if (!readError) data.observedAt = new Date().toISOString();
    if (entry.initialized && !rebuilt) this.checkCompletion(entry, before);
    entry.initialized = true;
    this.emit();
  }

  private checkCompletion(entry: SessionEntry, before: MonitorSnapshot) {
    const data = entry.state.data;
    if (entry.notification && (data.status !== "idle" || before.turnId !== data.turnId || data.readError)) {
      clearTimeout(entry.notification);
      entry.notification = undefined;
    }
    if (data.status !== "idle" || data.readError || !data.turnId || !data.turnEndedAt ||
      Date.parse(data.turnEndedAt) < this.startedAt || entry.notifiedTurn === data.turnId ||
      (before.status === "idle" && before.turnId === data.turnId) || entry.notification) return;
    const turnId = data.turnId;
    // Other Stop hooks may continue the turn. Allow subsequent activity to cancel the toast.
    entry.notification = setTimeout(() => {
      entry.notification = undefined;
      if (this.closed || data.status !== "idle" || data.turnId !== turnId || data.readError) return;
      entry.notifiedTurn = turnId;
      for (const listener of this.completions) listener({ ...data });
    }, 2000);
  }

  async close() {
    this.closed = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    for (const entry of this.sessions.values()) if (entry.notification) clearTimeout(entry.notification);
    await Promise.all([...this.sessions.values()].map(entry => entry.job));
    this.listeners.clear();
    this.completions.clear();
  }
}
