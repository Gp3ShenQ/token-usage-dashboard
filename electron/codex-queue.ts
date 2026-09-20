import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";

function findCodexExecutable() {
  const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(item => path.isAbsolute(item))) {
    const native = path.join(directory, "codex.exe");
    if (fs.existsSync(native)) return native;
    const entry = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!fs.existsSync(entry)) continue;
    const localRequire = createRequire(entry);
    try {
      const packageFile = localRequire.resolve("@openai/codex-win32-" + process.arch + "/package.json");
      const executable = path.join(path.dirname(packageFile), "vendor", target, "bin", "codex.exe");
      if (fs.existsSync(executable)) return executable;
    } catch { /* Older npm distributions keep the binary inside the main package. */ }
    const bundled = path.resolve(entry, "..", "..", "vendor", target, "bin", "codex.exe");
    if (fs.existsSync(bundled)) return bundled;
  }
  throw new Error("找不到支援 queue 的 Codex CLI；請使用複製交接指令。");
}

export function queueCodexHandoff(sessionId: string, cwd: string, prompt: string): Promise<void> {
  if (process.platform !== "win32") return Promise.reject(new Error("此版本只支援 Windows 的 Codex 派送。"));
  return new Promise((resolve, reject) => {
    // Direct argv avoids both PowerShell profile wrappers and shell interpolation.
    execFile(findCodexExecutable(), ["queue", "--thread", sessionId, "--message", prompt, "-C", cwd],
      { cwd, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 }, (error) => {
        if (error) reject(new Error("Codex 派送失敗或未確認；請檢查本機 daemon 與原 session，不會自動重送。"));
        else resolve();
      });
  });
}
