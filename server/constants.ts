import os from "node:os";
import path from "node:path";
import { app } from "electron";

export const API_PORT = 5180;
export const API_HOST = "127.0.0.1";
export const APP_TIMEZONE = "Asia/Taipei";
const userHome = os.homedir();

export const CLAUDE_GLOB = path.join(userHome, ".claude", "projects", "**", "*.jsonl");
export const CLAUDE_STATUS_SNAPSHOT = path.join(userHome, ".claude", "statusline-snapshot.json");
export const CODEX_GLOB = path.join(userHome, ".codex", "sessions", "**", "*.jsonl");
export const CLAUDE_SESSIONS_DIR = path.join(userHome, ".claude", "sessions");
export const CODEX_SESSION_INDEX = path.join(userHome, ".codex", "session_index.jsonl");
export const SESSION_TASK_LABEL_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(userHome, "AppData", "Local"),
  "TokenUsageDashboard",
  "session-bindings",
);

export function getDatabasePath() {
  if (app.isPackaged) {
    return path.join(app.getPath("userData"), "usage.db");
  }

  return path.resolve(process.cwd(), "data", "usage.db");
}
