const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Fastify = require("fastify");

let window, server, root;
let mode = "ready", configurationCount = 0, releaseConfiguration;
const checks = [];
const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
const run = code => window.webContents.executeJavaScript(code);
const waitFor = expression => run(`new Promise((resolve, reject) => {
  const check = () => { if (${expression}) { observer.disconnect(); clearTimeout(timer); resolve(); } };
  const observer = new MutationObserver(check);
  const timer = setTimeout(() => { observer.disconnect(); reject(new Error('UI timeout')); }, 8000);
  observer.observe(document.body, { subtree:true, childList:true, attributes:true, characterData:true }); check();
})`);
const click = text => run(`Array.from(document.querySelectorAll('.terminal-setup button')).find(button => button.textContent.includes(${JSON.stringify(text)})).click()`);

async function finish(error) {
  console.log(JSON.stringify({ checks, error: error?.stack ?? null }));
  if (window && !window.isDestroyed()) window.destroy();
  await server?.close();
  if (root) await fs.rm(root, { recursive:true, force:true });
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hud-terminal-ui-"));
  const { checkTerminalSetup, configureTerminal } = await import(pathToFileURL(path.resolve("dist-electron/electron/terminal-setup.js")).href);
  const options = { sourceDirectory:path.resolve("scripts"), installDirectory:path.join(root, "support") };
  const probe = async () => ({ profilePath:path.join(root, "profile.ps1"), terminalAvailable:mode !== "missing", policy:"RemoteSigned" });
  await fs.writeFile(path.join(root, "profile.ps1"), "# preserved personal configuration\n");
  ipcMain.handle("terminal:get-setup", async () => {
    if (mode === "offline") throw new Error("設定檢查失敗");
    return checkTerminalSetup(options, probe);
  });
  ipcMain.handle("terminal:configure", async () => {
    configurationCount++;
    if (mode === "failure") return { ok:false, error:"模擬寫入失敗" };
    await new Promise(resolve => { releaseConfiguration = resolve; });
    const result = await configureTerminal(options, probe);
    return { ok:result.status.ready, ...result };
  });
  server = Fastify();
  server.get("/api/meta", async (_request, reply) => reply.code(503).send({ok:false}));
  server.post("/api/handoffs", async () => ({ok:true,data:{records:[],warnings:[],total:0,completedCount:0}}));
  const address = await server.listen({host:"127.0.0.1",port:0});
  session.defaultSession.webRequest.onBeforeRequest({urls:["http://*/*", "https://*/*"]}, (details, callback) => {
    if (details.url.startsWith("http://127.0.0.1:5180/")) callback({redirectURL:details.url.replace("http://127.0.0.1:5180",address)});
    else callback({cancel:!details.url.startsWith(address + "/")});
  });
  window = new BrowserWindow({show:false,width:1100,height:900,webPreferences:{
    preload:path.resolve("dist-electron/electron/preload.cjs"),contextIsolation:true,nodeIntegration:false,
  }});
  const url = pathToFileURL(path.resolve("dist/index.html"));
  url.hash = "/settings";
  await window.loadURL(url.href);
  await waitFor("document.querySelector('.terminal-setup')?.textContent.includes('尚未完成此版本')");
  check("setup remains available when scan information fails", await run("!!Array.from(document.querySelectorAll('.terminal-setup button')).find(button => button.textContent.trim() === '設定 Terminal' && !button.disabled)"));
  check("checking alone does not write configuration", configurationCount === 0 && await fs.readFile(path.join(root, "profile.ps1"), "utf8") === "# preserved personal configuration\n");
  mode = "failure";
  await click("設定 Terminal");
  await waitFor("document.querySelector('.terminal-setup [role=alert]')?.textContent.includes('模擬寫入失敗')");
  check("write failures are visible and can be retried", await run("!Array.from(document.querySelectorAll('.terminal-setup button')).find(button => button.textContent.trim() === '設定 Terminal').disabled"));
  mode = "ready";
  await click("設定 Terminal");
  await waitFor("document.querySelector('.terminal-setup').getAttribute('aria-busy') === 'true'");
  check("configuration disables repeated clicks", await run("Array.from(document.querySelectorAll('.terminal-setup button')).every(button => button.disabled)"));
  releaseConfiguration();
  await waitFor("document.querySelector('.terminal-setup').textContent.includes('原設定已備份至')");
  check("success shows restart instructions and removes setup button", await run("document.querySelector('.terminal-setup').textContent.includes('請重新開啟 PowerShell') && !Array.from(document.querySelectorAll('.terminal-setup button')).some(button => button.textContent.trim() === '設定 Terminal')"));
  check("real installer preserves existing profile and creates one backup", (await fs.readFile(path.join(root, "profile.ps1"), "utf8")).startsWith("# preserved personal configuration\n") && (await fs.readdir(root)).filter(name => name.endsWith('.bak')).length === 1);
  mode = "missing";
  await click("重新檢查");
  await waitFor("document.querySelector('.terminal-setup').textContent.includes('找不到 Windows Terminal')");
  check("missing prerequisites do not offer profile setup", await run("!Array.from(document.querySelectorAll('.terminal-setup button')).some(button => button.textContent.trim() === '設定 Terminal')"));
  mode = "offline";
  await click("重新檢查");
  await waitFor("!!document.querySelector('.terminal-setup [role=alert]')");
  check("failed checks leave a retry button enabled", await run("!document.querySelector('.terminal-setup button').disabled"));
  mode = "ready";
  await click("重新檢查");
  await waitFor("document.querySelector('.terminal-setup').textContent.includes('Terminal 已設定完成')");
  check("retry recovers the ready status", configurationCount === 2);
  await finish();
}).catch(finish);
setTimeout(() => finish(new Error("Terminal UI check timed out")), 30000).unref();
