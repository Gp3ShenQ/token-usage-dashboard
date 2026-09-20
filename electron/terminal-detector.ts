import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AgentKind = "codex" | "claude";

export type DetectedTerminalWindow = {
  id: string;
  hwnd: string;
  pid: number;
  title: string;
  processName: string;
  agent: AgentKind;
  sessionPrefix: string | null;
  taskLabel: string | null;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type TerminalWindowSnapshot = {
  foregroundHwnd: string | null;
  windows: DetectedTerminalWindow[];
};

type SnapshotWindow = {
  hwnd: string;
  pid: number;
  title: string;
  processName: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type Snapshot = {
  foregroundHwnd?: string | null;
  windows: SnapshotWindow[];
};

const SNAPSHOT_SCRIPT = String.raw`
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class NativeMethods {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@

$terminalPattern = 'cmd\.exe|powershell\.exe|pwsh\.exe|windowsterminal\.exe|conhost\.exe'
$processMap = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $processMap[[int]$_.ProcessId] = [pscustomobject]@{
    name = [string]$_.Name
  }
}

$windows = New-Object System.Collections.Generic.List[object]

[NativeMethods]::EnumWindows({
  param($hWnd, $lParam)

  if (-not [NativeMethods]::IsWindowVisible($hWnd)) {
    return $true
  }

  $titleLength = [NativeMethods]::GetWindowTextLength($hWnd)
  if ($titleLength -le 0) {
    return $true
  }

  $titleBuffer = New-Object System.Text.StringBuilder ($titleLength + 1)
  [void][NativeMethods]::GetWindowText($hWnd, $titleBuffer, $titleBuffer.Capacity)
  $title = $titleBuffer.ToString().Trim()
  if ([string]::IsNullOrWhiteSpace($title)) {
    return $true
  }

  [uint32]$windowPid = 0
  [void][NativeMethods]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
  $windowProcessId = [int]$windowPid
  if (-not $processMap.ContainsKey($windowProcessId)) {
    return $true
  }

  $proc = $processMap[$windowProcessId]
  $processName = ([string]$proc.name).ToLowerInvariant()
  if ($processName -notmatch $terminalPattern) {
    return $true
  }

  $rect = New-Object NativeMethods+RECT
  if (-not [NativeMethods]::GetWindowRect($hWnd, [ref]$rect)) {
    return $true
  }

  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 120 -or $height -lt 80) {
    return $true
  }

  $windows.Add([pscustomobject]@{
    hwnd = ([Int64]$hWnd).ToString()
    pid = $windowProcessId
    title = $title
    processName = [string]$proc.name
    bounds = [pscustomobject]@{
      x = $rect.Left
      y = $rect.Top
      width = $width
      height = $height
    }
  })

  return $true
}, [IntPtr]::Zero) | Out-Null

[pscustomobject]@{
  foregroundHwnd = ([Int64][NativeMethods]::GetForegroundWindow()).ToString()
  windows = $windows
} | ConvertTo-Json -Compress -Depth 6
`;

const agentSessionTitlePattern = /^\s*(codex|claude)\s*[·•|:-]\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4})\b/i;
const sessionBindingsDir = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "TokenUsageDashboard", "session-bindings");

type SessionBinding = {
  agent: AgentKind;
  sessionId: string;
};

function getSessionTitle(title: string): { agent: AgentKind; sessionPrefix: string | null; taskLabel: string | null } | null {
  const match = title.match(agentSessionTitlePattern);
  if (match) {
    return {
      agent: match[1].toLowerCase() as AgentKind,
      sessionPrefix: match[2].toLowerCase(),
      taskLabel: null,
    };
  }

  // Codex updates its terminal title live as "model · cwd · task". Use this
  // title directly so switching threads is reflected without waiting for the
  // session index to be refreshed.
  const codexTitle = title.match(/^[^·]+\s·\s(?:~|[A-Za-z]:[^·]*)\s·\s(.+)$/);
  if (codexTitle) {
    return { agent: "codex", sessionPrefix: null, taskLabel: codexTitle[1].trim() || null };
  }

  return null;
}

function getSessionBinding(agent: AgentKind, tabKey: string): SessionBinding | null {
  try {
    const bindingPath = path.join(sessionBindingsDir, `${tabKey.toLowerCase()}.json`);
    const binding = JSON.parse(fs.readFileSync(bindingPath, "utf8")) as Partial<SessionBinding>;
    if (binding.agent !== agent || typeof binding.sessionId !== "string" || !/^[0-9a-f-]{8,}$/i.test(binding.sessionId)) {
      return null;
    }

    return { agent, sessionId: binding.sessionId };
  } catch {
    return null;
  }
}

export async function detectTerminalWindowSnapshot(): Promise<TerminalWindowSnapshot> {
  if (process.platform !== "win32") {
    return { foregroundHwnd: null, windows: [] };
  }

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SNAPSHOT_SCRIPT],
      { timeout: 4000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );

    const raw = stdout.trim();
    if (!raw) {
      return { foregroundHwnd: null, windows: [] };
    }

    const snapshot = JSON.parse(raw) as Snapshot;
    const windows = snapshot.windows ?? [];

    return {
      foregroundHwnd: snapshot.foregroundHwnd ?? null,
      windows: windows
      .map((window) => {
        const titleSession = getSessionTitle(window.title);
        if (!titleSession) {
          return null;
        }

        const binding = titleSession.sessionPrefix
          ? getSessionBinding(titleSession.agent, titleSession.sessionPrefix)
          : null;

        const detected: DetectedTerminalWindow = {
          ...window,
          id: `${window.hwnd}-${titleSession.agent}`,
          agent: titleSession.agent,
          sessionPrefix: binding?.sessionId.toLowerCase() ?? titleSession.sessionPrefix,
          taskLabel: titleSession.taskLabel,
        };

        return detected;
      })
      .filter((item): item is DetectedTerminalWindow => item !== null),
    };
  } catch {
    return { foregroundHwnd: null, windows: [] };
  }
}

export async function detectTerminalWindows(): Promise<DetectedTerminalWindow[]> {
  const snapshot = await detectTerminalWindowSnapshot();
  return snapshot.windows;
}
