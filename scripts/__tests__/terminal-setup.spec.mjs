import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkTerminalSetup, configureTerminal } from "../../electron/terminal-setup.ts";

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture({ policy = "RemoteSigned", terminalAvailable = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-terminal-"));
  directories.push(root);
  const profilePath = path.join(root, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  const options = { sourceDirectory: path.resolve("scripts"), installDirectory: path.join(root, "user's support") };
  const probe = async () => ({ profilePath, policy, terminalAvailable });
  const writeProfile = bytes => { fs.mkdirSync(path.dirname(profilePath), { recursive: true }); fs.writeFileSync(profilePath, bytes); };
  return { options, probe, profilePath, writeProfile, root };
}

it("detects missing integration without creating profile or support files", async () => {
  const { options, probe, profilePath } = fixture();
  expect(await checkTerminalSetup(options, probe)).toMatchObject({ ready: false, canConfigure: true, profilePath });
  expect(fs.existsSync(profilePath)).toBe(false);
  expect(fs.existsSync(options.installDirectory)).toBe(false);
});

it("sets up a fresh profile with correctly quoted paths and deployed scripts", async () => {
  const { options, probe, profilePath } = fixture();
  const result = await configureTerminal(options, probe);
  expect(result.status.ready).toBe(true);
  expect(result.backupPath).toBeNull();
  expect(fs.readFileSync(profilePath, "utf8")).toContain("user''s support");
  for (const script of ["agent-wrappers.ps1", "start-agent-session.ps1", "run-agent-session.ps1"]) {
    expect(fs.readFileSync(path.join(options.installDirectory, script))).toEqual(fs.readFileSync(path.join(options.sourceDirectory, script)));
  }
  expect(await configureTerminal(options, probe)).toEqual({ status: result.status, backupPath: null });
  expect(fs.readdirSync(path.dirname(profilePath))).toEqual([path.basename(profilePath)]);
});

it.each(["utf8", "utf16le"])("preserves existing %s profile bytes and creates an exact backup", async encoding => {
  const { options, probe, profilePath, writeProfile } = fixture();
  const original = Buffer.from("\uFEFF# 個人設定\r\nfunction hello { 'world' }", encoding);
  writeProfile(original);
  const result = await configureTerminal(options, probe);
  expect(fs.readFileSync(result.backupPath)).toEqual(original);
  expect(fs.readFileSync(profilePath).subarray(0, original.length)).toEqual(original);
  const updated = fs.readFileSync(profilePath);
  await configureTerminal(options, probe);
  expect(fs.readFileSync(profilePath)).toEqual(updated);
  expect(fs.readdirSync(path.dirname(profilePath)).filter(name => name.endsWith(".bak"))).toHaveLength(1);
});

it.each(["Restricted", "AllSigned"])("reports blocked execution policy %s without changing any settings", async policy => {
  const { options, probe, profilePath } = fixture({ policy });
  expect(await checkTerminalSetup(options, probe)).toMatchObject({ ready: false, canConfigure: false });
  await expect(configureTerminal(options, probe)).rejects.toThrow(policy);
  expect(fs.existsSync(profilePath)).toBe(false);
  expect(fs.existsSync(options.installDirectory)).toBe(false);
});

it("reports missing Windows Terminal without offering installation of the profile", async () => {
  const { options, probe, profilePath } = fixture({ terminalAvailable: false });
  await expect(configureTerminal(options, probe)).rejects.toThrow("Windows Terminal");
  expect(fs.existsSync(profilePath)).toBe(false);
});

it("reports missing PowerShell without claiming setup is ready", async () => {
  const { options } = fixture();
  const status = await checkTerminalSetup(options, async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  expect(status).toMatchObject({ ready: false, canConfigure: false, profilePath: null });
  expect(status.issues.join()).toContain("PowerShell 7");
});

it("refuses incomplete managed blocks and keeps personal settings intact", async () => {
  const { options, probe, profilePath, writeProfile } = fixture();
  const original = "# personal\n# BEGIN TOKEN USAGE DASHBOARD TERMINAL\n";
  writeProfile(original);
  await expect(configureTerminal(options, probe)).rejects.toThrow("不完整");
  expect(fs.readFileSync(profilePath, "utf8")).toBe(original);
  expect(fs.existsSync(options.installDirectory)).toBe(false);
});

it("repairs missing or outdated deployed scripts without rewriting an unchanged profile", async () => {
  const { options, probe, profilePath } = fixture();
  await configureTerminal(options, probe);
  const original = fs.readFileSync(profilePath);
  fs.writeFileSync(path.join(options.installDirectory, "agent-wrappers.ps1"), "outdated");
  expect((await checkTerminalSetup(options, probe)).ready).toBe(false);
  const result = await configureTerminal(options, probe);
  expect(result.status.ready).toBe(true);
  expect(result.backupPath).toBeNull();
  expect(fs.readFileSync(profilePath)).toEqual(original);
});

it("does not modify a profile when the package lacks required scripts", async () => {
  const { options, probe, profilePath, root, writeProfile } = fixture();
  writeProfile("# personal");
  options.sourceDirectory = root;
  await expect(configureTerminal(options, probe)).rejects.toThrow("必要整合腳本");
  expect(fs.readFileSync(profilePath, "utf8")).toBe("# personal");
});

it("recognizes the existing documented profile setup without requiring migration", async () => {
  const { options, probe, profilePath, writeProfile } = fixture();
  const original = `. "${path.join(options.sourceDirectory, "agent-wrappers.ps1")}"\n`;
  writeProfile(original);
  expect((await checkTerminalSetup(options, probe)).ready).toBe(true);
  await configureTerminal(options, probe);
  expect(fs.readFileSync(profilePath, "utf8")).toBe(original);
  expect(fs.existsSync(options.installDirectory)).toBe(false);
});

it("refuses unsupported profile encoding without corrupting the original", async () => {
  const { options, probe, profilePath, writeProfile } = fixture();
  const original = Buffer.from([0x23, 0x20, 0xa4, 0xa4]);
  writeProfile(original);
  await expect(configureTerminal(options, probe)).rejects.toThrow("編碼");
  expect(fs.readFileSync(profilePath)).toEqual(original);
});
