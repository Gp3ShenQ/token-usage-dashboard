import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const source = process.argv[2];
let raw = "";
let oversized = false;
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  if (!oversized) raw += chunk;
  if (raw.length > 4 * 1024 * 1024) { raw = ""; oversized = true; }
}
try {
  const input = JSON.parse(raw);
  const sessionId = input.session_id;
  if (input.agent_id || /[\\/]subagents[\\/]/.test(input.transcript_path ?? "")) throw Error("Subagent event");
  if (!["claude", "codex"].includes(source) || typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId)) throw Error("Invalid source or session");
  const directory = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "TokenUsageDashboard", "monitor");
  fs.mkdirSync(directory, { recursive: true });
  const record = {
    source, sessionId, event: input.hook_event_name === "PostToolUseFailure" && input.is_interrupt === true ? "Interrupt" : input.hook_event_name, eventId: randomUUID(), timestamp: new Date().toISOString(),
    turnId: typeof input.turn_id === "string" ? input.turn_id : undefined,
    toolName: typeof input.tool_name === "string" ? input.tool_name : undefined,
    toolUseId: typeof input.tool_use_id === "string" ? input.tool_use_id : undefined,
    model: typeof input.model === "string" ? input.model : undefined,
    transcriptPath: typeof input.transcript_path === "string" ? input.transcript_path : undefined,
  };
  fs.appendFileSync(path.join(directory, source + "-" + sessionId + ".events.jsonl"), JSON.stringify(record) + "\n");
} catch {
  // Monitoring must never affect agent decisions or interrupt a turn.
}
process.stdout.write("{}");
