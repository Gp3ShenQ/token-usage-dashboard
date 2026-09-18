import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { buildClaudeSettings, buildCodexConfig, installMonitor } from "../install-monitor.mjs";

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const temp = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hud-hooks-")); directories.push(directory); return directory; };

it("preserves existing Claude hooks and status output command without duplicating installation", () => {
  const settings = { permissions: { deny: ["test"] }, hooks: { Stop: [{ hooks: [{ command: "existing" }] }] },
    statusLine: { type: "command", command: 'node "C:/test/statusline.mjs"', padding: 1 } };
  const updated = buildClaudeSettings(settings, "C:/test/hud");
  expect(updated.hooks.Stop[0]).toEqual(settings.hooks.Stop[0]);
  expect(updated.permissions).toEqual(settings.permissions);
  expect(updated.statusLine.command).toContain('"C:/test/statusline.mjs"');
  expect(updated.statusLine.padding).toBe(1);
  expect(buildClaudeSettings(updated, "C:/test/hud")).toEqual(updated);
  expect(settings.hooks.Stop).toHaveLength(1);
});

it("preserves Codex notify and native trust entries without adding trust hashes", () => {
  const before = 'notify = ["existing"]\n[hooks.state.existing]\ntrusted_hash = "unchanged"\n';
  const updated = buildCodexConfig(before, "C:/test/hud");
  expect(updated.startsWith(before)).toBe(true);
  expect(updated.match(/trusted_hash/g)).toHaveLength(1);
  expect(updated).not.toContain("bypass");
  expect(buildCodexConfig(updated, "C:/test/hud")).toBe(updated);
});

it("rejects unsupported status line commands before writing either configuration", () => {
  const home = temp();
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".codex"));
  const settings = '{"statusLine":{"command":"custom-command --flag"}}';
  const config = 'notify = ["existing"]\n';
  fs.writeFileSync(path.join(home, ".claude/settings.json"), settings);
  fs.writeFileSync(path.join(home, ".codex/config.toml"), config);
  expect(() => installMonitor({ apply: true, home })).toThrow("not a single Node script");
  expect(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8")).toBe(settings);
  expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toBe(config);
});

it("writes only telemetry and never changes a hook approval decision", () => {
  const local = temp();
  const result = spawnSync(process.execPath, ["scripts/monitor-hook.mjs", "claude"], {
    input: JSON.stringify({ session_id: "session-one", hook_event_name: "PermissionRequest", tool_name: "Bash",
      prompt: "PRIVATE_PROMPT", tool_input: { command: "PRIVATE_COMMAND" }, tool_response: "PRIVATE_OUTPUT" }),
    encoding: "utf8", env: { ...process.env, LOCALAPPDATA: local }, windowsHide: true,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("{}");
  const telemetry = fs.readFileSync(path.join(local, "TokenUsageDashboard/monitor/claude-session-one.events.jsonl"), "utf8");
  expect(telemetry).not.toContain("PRIVATE");
  expect(JSON.parse(telemetry)).toMatchObject({ event: "PermissionRequest", sessionId: "session-one" });
});

it("passes existing statusline stdout through byte for byte", () => {
  const local = temp();
  const original = path.join(local, "original.mjs");
  fs.writeFileSync(original, 'let raw=""; for await (const part of process.stdin) raw+=part; process.stdout.write("original:"+JSON.parse(raw).session_id);');
  const result = spawnSync(process.execPath, ["scripts/monitor-statusline.mjs", original], {
    input: JSON.stringify({ session_id: "session-one", model: { display_name: "Claude" }, effort: { level: "high" },
      context_window: { used_percentage: 20 }, prompt: "PRIVATE" }), encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: local }, windowsHide: true,
  });
  expect(result.stdout).toBe("original:session-one");
  const telemetry = fs.readFileSync(path.join(local, "TokenUsageDashboard/monitor/claude-session-one.events.jsonl"), "utf8");
  expect(telemetry).not.toContain("PRIVATE");
  expect(JSON.parse(telemetry).snapshot.effort.level).toBe("high");
});
