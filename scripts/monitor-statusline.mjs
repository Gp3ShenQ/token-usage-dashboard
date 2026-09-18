import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
try {
  const input = JSON.parse(raw);
  if (typeof input.session_id === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(input.session_id)) {
    const directory = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "TokenUsageDashboard", "monitor");
    fs.mkdirSync(directory, { recursive: true });
    const record = {
      source: "claude", sessionId: input.session_id, event: "StatusLine", eventId: randomUUID(),
      timestamp: new Date().toISOString(), transcriptPath: input.transcript_path,
      snapshot: {
        session_id: input.session_id,
        model: { id: input.model?.id, display_name: input.model?.display_name },
        effort: { level: input.effort?.level },
        context_window: { context_window_size: input.context_window?.context_window_size, used_percentage: input.context_window?.used_percentage },
      },
    };
    // Append compact telemetry only; keep the existing status line output unchanged.
    fs.appendFileSync(path.join(directory, "claude-" + input.session_id + ".events.jsonl"), JSON.stringify(record) + "\n");
  }
} catch {}
const original = process.argv[2];
if (original) {
  const result = spawnSync(process.execPath, [original], { input: raw, encoding: "utf8", windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 0;
}
