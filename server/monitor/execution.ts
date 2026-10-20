import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type ClaudeShellExecution = { sessionId: string; startedAt: string };
const execFileAsync = promisify(execFile);
const SCRIPT = String.raw`
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'claude.exe' OR Name = 'bash.exe'")
$executions = @(foreach ($agent in $processes) {
  if ($agent.Name -ne 'claude.exe') { continue }
  $session = [regex]::Match($agent.CommandLine, '(?i)(?:--session-id|--resume|-r)\s+"?([0-9a-f-]{36})\b')
  if (-not $session.Success) { continue }
  foreach ($child in $processes) {
    if ($child.Name -eq 'bash.exe' -and $child.ParentProcessId -eq $agent.ProcessId -and
        $child.CommandLine -notmatch 'monitor-(hook|statusline)\.mjs') {
      [pscustomobject]@{ sessionId=$session.Groups[1].Value.ToLower(); startedAt=$child.CreationDate.ToUniversalTime().ToString('o') }
    }
  }
})
ConvertTo-Json -InputObject $executions -Compress
`;

export async function readClaudeShellExecutions(): Promise<ClaudeShellExecution[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 });
    const records: unknown = JSON.parse(stdout);
    if (!Array.isArray(records)) return [];
    return records.filter((record): record is ClaudeShellExecution => record &&
      typeof record.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(record.sessionId) &&
      typeof record.startedAt === "string" && Number.isFinite(Date.parse(record.startedAt)));
  } catch { return []; }
}
