import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SEND_ENTER_SCRIPT = String.raw`
param([Int64]$ExpectedHwnd)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ApprovalInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
"@

if ([ApprovalInput]::GetForegroundWindow().ToInt64() -ne $ExpectedHwnd) {
  exit 2
}

$inputs = [ApprovalInput+INPUT[]]@(
  [ApprovalInput+INPUT]@{ type = 1; U = [ApprovalInput+InputUnion]@{ ki = [ApprovalInput+KEYBDINPUT]@{ wVk = 0x0D } } },
  [ApprovalInput+INPUT]@{ type = 1; U = [ApprovalInput+InputUnion]@{ ki = [ApprovalInput+KEYBDINPUT]@{ wVk = 0x0D; dwFlags = 0x0002 } } }
)

if ([ApprovalInput]::SendInput(2, $inputs, [Runtime.InteropServices.Marshal]::SizeOf([type][ApprovalInput+INPUT])) -ne 2) {
  exit 3
}
`;

export async function approveForegroundTerminal(hwnd: string): Promise<boolean> {
  if (process.platform !== "win32" || !/^-?\d+$/.test(hwnd)) return false;

  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SEND_ENTER_SCRIPT, hwnd],
      { timeout: 2000, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}
