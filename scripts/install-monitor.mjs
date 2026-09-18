import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const quote = (value) => '"' + value.replaceAll("\\", "/") + '"';
const claudeEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SessionEnd"];
const codexEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Interrupt", "SessionEnd"];
const beginMarker = "# BEGIN TOKEN USAGE DASHBOARD MONITOR";
const endMarker = "# END TOKEN USAGE DASHBOARD MONITOR";

export function buildClaudeSettings(settings, directory = scriptDirectory) {
  const result = structuredClone(settings);
  const hookCommand = "node " + quote(path.join(directory, "monitor-hook.mjs")) + " claude";
  result.hooks ??= {};
  for (const event of claudeEvents) {
    result.hooks[event] ??= [];
    if (!result.hooks[event].some(group => group.hooks?.some(hook => hook.command === hookCommand))) {
      result.hooks[event].push({ ...(event === "SessionStart" ? { matcher: "startup|resume|clear" } : {}), hooks: [{ type: "command", command: hookCommand, timeout: 3 }] });
    }
  }
  const wrapper = path.join(directory, "monitor-statusline.mjs").replaceAll("\\", "/");
  const current = result.statusLine?.command;
  if (typeof current === "string" && current.includes(wrapper)) return result;
  if (current) {
    const match = /^node\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*$/.exec(current);
    if (!match) throw new Error("Existing Claude statusLine is not a single Node script; it was not changed.");
    result.statusLine = { ...result.statusLine, type: "command", command: "node " + quote(wrapper) + " " + quote(match[1] ?? match[2] ?? match[3]) };
  } else result.statusLine = { type: "command", command: "node " + quote(wrapper) };
  return result;
}

export function buildCodexConfig(config, directory = scriptDirectory) {
  const command = "node " + quote(path.join(directory, "monitor-hook.mjs")) + " codex";
  const block = beginMarker + "\n" + codexEvents.map(event =>
    "[[hooks." + event + "]]\n" +
    (event === "SessionStart" ? 'matcher = "startup|resume|clear"\n' : "") +
    "[[hooks." + event + ".hooks]]\n" +
    'type = "command"\ncommand = ' + JSON.stringify(command) + "\ntimeout = 3\n"
  ).join("\n") + endMarker;
  const start = config.indexOf(beginMarker);
  if (start < 0) return config.trimEnd() + "\n\n" + block + "\n";
  const end = config.indexOf(endMarker, start);
  if (end < 0) throw new Error("Incomplete monitor config block; existing Codex config was not changed.");
  return config.slice(0, start) + block + config.slice(end + endMarker.length);
}

export function installMonitor({ apply = false, home = os.homedir(), directory = scriptDirectory } = {}) {
  const claudePath = path.join(home, ".claude", "settings.json");
  const codexPath = path.join(home, ".codex", "config.toml");
  const claudeBefore = fs.readFileSync(claudePath, "utf8");
  const codexBefore = fs.readFileSync(codexPath, "utf8");
  const files = [
    { path: claudePath, before: claudeBefore, after: JSON.stringify(buildClaudeSettings(JSON.parse(claudeBefore), directory), null, 2) + "\n" },
    { path: codexPath, before: codexBefore, after: buildCodexConfig(codexBefore, directory) },
  ].filter(file => file.before !== file.after);
  if (apply) {
    // Back up both originals before the first configuration write.
    const suffix = ".token-hud-" + Date.now() + ".bak";
    for (const file of files) fs.copyFileSync(file.path, file.path + suffix, fs.constants.COPYFILE_EXCL);
    const written = [];
    try {
      for (const file of files) {
        if (fs.readFileSync(file.path, "utf8") !== file.before) throw new Error("Configuration changed during installation.");
        fs.writeFileSync(file.path, file.after, "utf8");
        written.push(file);
      }
    } catch (error) {
      for (const file of written) fs.writeFileSync(file.path, file.before, "utf8");
      throw error;
    }
  }
  return { mode: apply ? "installed" : "dry-run", changedFiles: files.map(file => file.path),
    claudeEvents, codexEvents, codexTrust: "Review the new monitor commands in Codex /hooks. Existing trust entries and notify callbacks are preserved." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(installMonitor({ apply: process.argv.includes("--apply") }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
