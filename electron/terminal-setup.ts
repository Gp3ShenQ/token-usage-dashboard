import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isUtf8 } from "node:buffer";

const execute = promisify(execFile);
const scriptNames = ["agent-wrappers.ps1", "start-agent-session.ps1", "run-agent-session.ps1"];
const beginMarker = "# BEGIN TOKEN USAGE DASHBOARD TERMINAL";
const endMarker = "# END TOKEN USAGE DASHBOARD TERMINAL";

export type TerminalSetupStatus = {
  ready: boolean;
  canConfigure: boolean;
  profilePath: string | null;
  issues: string[];
};

type TerminalEnvironment = { profilePath: string; terminalAvailable: boolean; policy: string };
type SetupOptions = { sourceDirectory: string; installDirectory: string };

export async function probeTerminalEnvironment(): Promise<TerminalEnvironment> {
  const { stdout } = await execute("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [pscustomobject]@{
      profilePath = [string]$PROFILE.CurrentUserCurrentHost
      terminalAvailable = [bool](Get-Command wt.exe -CommandType Application -ErrorAction SilentlyContinue)
      policy = [string](Get-ExecutionPolicy)
    } | ConvertTo-Json -Compress
  `], { windowsHide: true, timeout: 8000 });
  const environment = JSON.parse(stdout.trim());
  if (typeof environment.profilePath !== "string" || !path.isAbsolute(environment.profilePath) ||
      typeof environment.terminalAvailable !== "boolean" || typeof environment.policy !== "string") {
    throw new Error("無法取得 PowerShell 7 設定位置。");
  }
  return environment;
}

function readProfile(profilePath: string) {
  const bytes = fs.existsSync(profilePath) ? fs.readFileSync(profilePath) : Buffer.alloc(0);
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  if ((utf16 && bytes.length % 2 !== 0) || (!utf16 && (!isUtf8(bytes) || bytes.includes(0)))) {
    throw new Error("PowerShell profile 使用不支援的編碼，未修改原檔。");
  }
  return { bytes, encoding: utf16 ? "utf16le" as const : "utf8" as const,
    text: bytes.toString(utf16 ? "utf16le" : "utf8") };
}

function scriptsMatch(sourceDirectory: string, installedDirectory: string) {
  return scriptNames.every(name => {
    const installed = path.join(installedDirectory, name);
    return fs.existsSync(installed) && fs.readFileSync(installed).equals(fs.readFileSync(path.join(sourceDirectory, name)));
  });
}

function hasLegacyIntegration(text: string, sourceDirectory: string) {
  if (text.includes(beginMarker) || text.includes(endMarker)) return false;
  return text.split(/\r?\n/).some(line => {
    // Recognize the literal dot-source line documented before the setup UI existed.
    const match = /^\s*\.\s+(?:'((?:[^']|'')*)'|"([^"$`]+)")\s*(?:#.*)?$/.exec(line);
    const wrapperPath = match?.[1]?.replace(/''/g, "'") ?? match?.[2];
    return !!wrapperPath && path.isAbsolute(wrapperPath) &&
      path.basename(wrapperPath).toLowerCase() === scriptNames[0] && scriptsMatch(sourceDirectory, path.dirname(wrapperPath));
  });
}

function buildProfile(text: string, installDirectory: string) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const wrapper = path.join(installDirectory, scriptNames[0]).replace(/'/g, "''");
  const block = [beginMarker, `. '${wrapper}'`, endMarker].join(newline);
  const start = text.indexOf(beginMarker);
  const end = text.indexOf(endMarker);
  if (start < 0 && end < 0) return text + (text.endsWith("\n") || !text ? "" : newline) + block + newline;
  if (start < 0 || end < start || text.indexOf(beginMarker, start + 1) >= 0 || text.indexOf(endMarker, end + 1) >= 0) {
    throw new Error("Terminal 設定區塊不完整或重複，未修改原檔。");
  }
  return text.slice(0, start) + block + text.slice(end + endMarker.length);
}

export async function checkTerminalSetup(options: SetupOptions,
  probe = probeTerminalEnvironment): Promise<TerminalSetupStatus> {
  let profilePath: string | null = null;
  try {
    if (process.platform !== "win32") throw new Error("Terminal 整合僅支援 Windows。");
    const environment = await probe();
    profilePath = environment.profilePath;
    const issues: string[] = [];
    if (!environment.terminalAvailable) issues.push("找不到 Windows Terminal（wt.exe），請先安裝。");
    if (["Restricted", "AllSigned"].includes(environment.policy)) {
      issues.push(`PowerShell 執行原則為 ${environment.policy}，無法載入這些腳本；請先調整允許的執行原則。`);
    }
    const profile = readProfile(profilePath);
    const updated = buildProfile(profile.text, options.installDirectory);
    const scriptsReady = scriptsMatch(options.sourceDirectory, options.installDirectory);
    // Read the source even on first install, so a broken package cannot offer a working setup button.
    for (const name of scriptNames) fs.accessSync(path.join(options.sourceDirectory, name), fs.constants.R_OK);
    const canConfigure = issues.length === 0;
    if ((updated !== profile.text || !scriptsReady) && !hasLegacyIntegration(profile.text, options.sourceDirectory)) {
      issues.push("尚未完成此版本的 PowerShell Terminal 整合設定。");
    }
    return { ready: issues.length === 0, canConfigure, profilePath, issues };
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "找不到 PowerShell 7（pwsh.exe）或必要整合腳本，請確認安裝完整。"
      : error instanceof Error ? error.message : "無法檢查 Terminal 設定。";
    return { ready: false, canConfigure: false, profilePath, issues: [message] };
  }
}

export async function configureTerminal(options: SetupOptions, probe = probeTerminalEnvironment) {
  const status = await checkTerminalSetup(options, probe);
  if (status.ready) return { status, backupPath: null };
  if (!status.canConfigure || !status.profilePath) throw new Error(status.issues.join("\n"));
  const profilePath = status.profilePath;
  const profile = readProfile(profilePath);
  const after = Buffer.from(buildProfile(profile.text, options.installDirectory), profile.encoding);
  const scripts = scriptNames.map(name => ({ name, bytes: fs.readFileSync(path.join(options.sourceDirectory, name)) }));
  fs.mkdirSync(options.installDirectory, { recursive: true });
  for (const script of scripts) fs.writeFileSync(path.join(options.installDirectory, script.name), script.bytes);
  let backupPath: string | null = null;
  if (!after.equals(profile.bytes)) {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    if (fs.existsSync(profilePath)) {
      backupPath = `${profilePath}.token-hud-${randomUUID()}.bak`;
      fs.copyFileSync(profilePath, backupPath, fs.constants.COPYFILE_EXCL);
      if (!fs.readFileSync(profilePath).equals(profile.bytes)) throw new Error("Profile 已被其他程式修改，請重新檢查後再設定。");
      fs.writeFileSync(profilePath, after);
    } else {
      fs.writeFileSync(profilePath, after, { flag: "wx" });
    }
  }
  return { status: await checkTerminalSetup(options, probe), backupPath };
}
