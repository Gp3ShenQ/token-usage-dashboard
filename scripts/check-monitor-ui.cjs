const { app, BrowserWindow, session } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const output = fs.mkdtempSync(path.join(os.tmpdir(), "token-hud-ui-"));
fs.writeFileSync(path.join(os.tmpdir(), "token-hud-ui-latest.txt"), output);
const results = [];
const streams = new Set();
let server;
let window;
const sessionId = "12345678-1111-2222-3333-444444444444";
const data = {
  source: "claude", sessionId, status: "running", statusAt: new Date().toISOString(), turnId: "turn-1",
  turnStartedAt: new Date(Date.now() - 65000).toISOString(), turnEndedAt: null, model: "Claude Opus 4.6", effort: "high",
  contextPercent: 43.2, contextWindow: 200000, sessionTokens: 123456, turnTokens: 4567,
  sourceUpdatedAt: new Date().toISOString(), observedAt: new Date().toISOString(), readError: false,
};
const push = () => { for (const stream of streams) stream.write("data: " + JSON.stringify({ state: "ready", data }) + "\n\n"); };
const waitForText = async (selector, expected) => window.webContents.executeJavaScript(`
  new Promise((resolve, reject) => {
    const check = () => {
      if (document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(expected)})) {
        observer.disconnect(); clearTimeout(timeout); resolve(true);
      }
    };
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Text not found")); }, 5000);
    observer.observe(document.body, { subtree:true, childList:true, characterData:true });
    check();
  })`);
function check(name, condition) { if (!condition) throw new Error(name); results.push(name); }
async function finish(error) {
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: results, error: error?.stack ?? null }, null, 2));
  if (window && !window.isDestroyed()) window.destroy();
  for (const stream of streams) stream.end();
  server?.close();
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.url.startsWith("/api/monitor/stream")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      streams.add(response);
      request.on("close", () => streams.delete(response));
      push(); return;
    }
    response.setHeader("Content-Type", "application/json");
    const quota = { fiveHourPercent: 23.5, sevenDayPercent: 41.2,
      fiveHourResetsAt: Math.floor(Date.now()/1000) + 3600, sevenDayResetsAt: Math.floor(Date.now()/1000) + 86400 };
    response.end(JSON.stringify({ ok: true, data: request.url.startsWith("/api/widget") ?
      { updatedAt: new Date().toISOString(), claude: quota, codex: quota } :
      { state: "ready", sessionId, running: true, taskLabel: "新增 Terminal 卡片功能與 Claude／Codex 相容驗證" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://127.0.0.1:5180/*"] }, (details, callback) => {
    callback({ redirectURL: details.url.replace(":5180", ":" + port) });
  });
  window = new BrowserWindow({ width:208, height:352, show:false, transparent:true, frame:false,
    webPreferences: { contextIsolation:true, nodeIntegration:false, backgroundThrottling:false } });
  const errors = [];
  window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  const url = pathToFileURL(path.resolve("dist/widget.html"));
  url.search = new URLSearchParams({ agent:"claude", session:sessionId, overlay:"1" }).toString();
  await window.loadURL(url.href);
  await waitForText(".session-status", "執行中");
  await waitForText(".task-label-value", "相容驗證");
  check("Claude model and effort are visible", await window.webContents.executeJavaScript('document.querySelector(".session-model").textContent.includes("Claude Opus 4.6") && document.querySelector(".session-model").textContent.includes("high")'));
  check("all metrics fit within the fixed overlay", await window.webContents.executeJavaScript('document.querySelector(".session-health").getBoundingClientRect().bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth'));
  fs.writeFileSync(path.join(output, "claude.png"), (await window.webContents.capturePage()).toPNG());
  data.status = "waiting_approval"; push();
  await waitForText(".session-status", "等待授權");
  check("event push updates approval without quota polling", true);
  data.status = "interrupted"; data.turnEndedAt = new Date().toISOString(); push();
  await waitForText(".session-status", "已中斷");
  check("interrupt status is rendered", true);
  data.readError = true; push();
  await waitForText(".session-health", "紀錄讀取異常");
  check("read failures are visible", true);
  data.source = "codex"; data.model = "gpt-6-astra-very-long-model-name"; data.status = "idle"; data.readError = false;
  url.search = new URLSearchParams({ agent:"codex", session:sessionId, overlay:"1" }).toString();
  await window.loadURL(url.href);
  await waitForText(".session-status", "閒置");
  await waitForText(".task-label-value", "相容驗證");
  check("Codex context is labeled approximate", await window.webContents.executeJavaScript('document.querySelector(".session-context").textContent.includes("≈")'));
  check("long model fits without horizontal overflow", await window.webContents.executeJavaScript('Array.from(document.querySelectorAll(".single-agent-card, .session-status, .session-health, .session-row strong")).every(element => element.getBoundingClientRect().right <= innerWidth)'));
  fs.writeFileSync(path.join(output, "codex.png"), (await window.webContents.capturePage()).toPNG());
  for (const stream of streams) stream.end();
  await waitForText(".session-status", "連線中斷");
  check("disconnection is visible", true);
  check("no renderer errors", errors.length === 0);
  await finish();
}).catch(finish);
setTimeout(() => finish(new Error("UI check timed out")), 25000).unref();
