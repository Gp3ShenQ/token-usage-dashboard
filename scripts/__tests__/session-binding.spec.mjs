import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execute = promisify(execFile);
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

async function runAgentFixture({ delay = 0, ambiguous = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-session-binding-"));
  directories.push(root);
  const sessions = path.join(root, ".codex", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const sessionId = "12345678-1111-2222-3333-444444444444";
  const binding = path.join(root, "TokenUsageDashboard", "session-bindings", "1234abcd.json");
  const agent = path.join(root, "agent.cjs");
  fs.writeFileSync(agent, `
    const fs = require("node:fs");
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(path.join(sessions, "rollout-test-" + sessionId + ".jsonl"))},
        JSON.stringify({type:"session_meta", payload:{id:${JSON.stringify(sessionId)}}}) + "\\n");
      ${ambiguous ? `fs.writeFileSync(${JSON.stringify(path.join(sessions, "rollout-other.jsonl"))}, JSON.stringify({payload:{id:"other-session"}})); setTimeout(() => process.exit(0), 2000);` : `
      const check = setInterval(() => { if (fs.existsSync(${JSON.stringify(binding)})) { clearInterval(check); process.exit(0); } }, 50);
      setTimeout(() => process.exit(2), 6000);`}
    }, ${delay});
  `);
  const args = Buffer.from(JSON.stringify([`"${agent}"`])).toString("base64");
  await execute("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", path.resolve("scripts/run-agent-session.ps1"),
    "-Agent", "codex", "-ExecutablePath", process.execPath, "-TabKey", "1234abcd", "-AgentArgumentsBase64", args], {
    env: { ...process.env, USERPROFILE: root, LOCALAPPDATA: root }, windowsHide: true, timeout: 62000,
  });
  return { binding, sessionId };
}

it("binds a Codex session whose log first appears after the old 45-second cutoff", async () => {
  // This delay crosses the real regression boundary; completion waits for the binding file.
  const { binding, sessionId } = await runAgentFixture({ delay: 46000 });
  expect(JSON.parse(fs.readFileSync(binding, "utf8").replace(/^\uFEFF/, ""))).toMatchObject({ agent: "codex", sessionId });
}, 65000);

it("does not guess a binding when multiple new session logs appear", async () => {
  const { binding } = await runAgentFixture({ ambiguous: true });
  expect(fs.existsSync(binding)).toBe(false);
}, 10000);
