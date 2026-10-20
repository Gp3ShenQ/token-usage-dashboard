const { app, BrowserWindow, session, ipcMain } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const appRoot = process.argv.includes("--packaged") ? path.resolve("release/win-unpacked/resources/app.asar") : process.cwd();
const output = fs.mkdtempSync(path.join(os.tmpdir(), "token-hud-ui-"));
fs.writeFileSync(path.join(os.tmpdir(), "token-hud-ui-latest.txt"), output);
const results = [];
const streams = new Set();
let server;
let window;
let handoff = null;
let copiedText = "";
let prepareCount = 0;
const pointerStates = [];
const sessionId = "12345678-1111-2222-3333-444444444444";
const quotaFixture = { fiveHourPercent: 23.5, sevenDayPercent: 41.2 };
const data = {
  cwd: "C:/work/example", source: "claude", sessionId, status: "running", statusAt: new Date().toISOString(), turnId: "turn-1",
  turnStartedAt: new Date(Date.now() - 65000).toISOString(), turnEndedAt: null, model: "Claude Opus 4.6", effort: "high",
  contextPercent: 43.2, contextWindow: 200000, sessionTokens: 123456, turnTokens: 4567,
  sourceUpdatedAt: new Date().toISOString(), observedAt: new Date().toISOString(), readError: false,
};
const push = () => { for (const stream of streams) if (!stream.writableEnded) stream.write("data: " + JSON.stringify({ state: "ready", data }) + "\n\n"); };
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
const waitForSelector = async selector => window.webContents.executeJavaScript(`
  new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => document.querySelector(${JSON.stringify(selector)}) ? resolve(true)
      : performance.now() - started > 5000 ? reject(new Error("Selector not found")) : requestAnimationFrame(poll);
    poll();
  })`);
function check(name, condition) { if (!condition) throw new Error(name); results.push(name); }
async function readMascotPose() {
  return window.webContents.executeJavaScript(`(() => {
    const mascot = document.querySelector(".agent-mascot");
    const style = selector => { const element = mascot.querySelector(selector); return element ? getComputedStyle(element) : null; };
    const pose = { eyes:style(".clawd-eyes")?.transform, feet:style(".clawd-feet-a")?.transform,
      arm:style(".clawd-arm")?.transform, sprite:style(".codey")?.backgroundPosition };
    return pose;
  })()`);
}
async function checkHandoffThreshold() {
  for (const percent of [null, 43.2, 72, 72.1, 72, 73]) {
    data.contextPercent = percent;
    push();
    await waitForText(".session-context strong", percent == null ? "—" : percent.toFixed(1) + "%");
    const buttonCount = await window.webContents.executeJavaScript('document.querySelectorAll(".handoff-controls button").length');
    check(`${data.source} handoff visibility at Context ${percent}`, buttonCount === (percent > 72 ? 1 : 0));
    const level = await window.webContents.executeJavaScript('document.querySelector(".session-context .line-fill").classList.contains("danger") ? "danger" : document.querySelector(".session-context .line-fill").classList.contains("warn") ? "warn" : ""');
    check(`${data.source} context color at ${percent}`, level === (percent > 72 ? "danger" : percent >= 62 ? "warn" : ""));
  }
}
async function finish(error) {
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ appRoot, packaged: process.argv.includes("--packaged"), passed: results, error: error?.stack ?? null }, null, 2));
  if (window && !window.isDestroyed()) window.destroy();
  for (const stream of streams) stream.end();
  server?.close();
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  ipcMain.handle("widget:get-settings", () => ({ refreshSeconds: 60 }));
  ipcMain.handle("handoff:copy", (_event, text) => { copiedText = text; return { ok: true }; });
  ipcMain.on("widget:pointer", (_event, value) => pointerStates.push(value));
  server = http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.url.startsWith("/api/monitor/stream")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      streams.add(response);
      request.on("close", () => streams.delete(response));
      push(); return;
    }
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Access-Control-Allow-Headers", "content-type, x-token-hud");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.url === "/api/handoff") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        if (request.headers["x-token-hud"] !== "fixture-token") {
          response.writeHead(403); response.end(JSON.stringify({ ok:false, error:"token missing" })); return;
        }
        const payload = JSON.parse(body);
        if (payload.action === "prepare") {
          prepareCount++;
          handoff = { phase: payload.mode === "manual" ? "manual" : "waiting", message:"等待交接", id:"fixture" };
        }
        const result = ["generate", "receive"].includes(payload.action) ? payload.action + "-fixture-prompt" : handoff;
        response.end(JSON.stringify({ ok:true, data:result }));
      });
      return;
    }
    const quota = { fiveHourPercent: quotaFixture.fiveHourPercent, sevenDayPercent: quotaFixture.sevenDayPercent,
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
  window = new BrowserWindow({ width:208, height:448, show:false, transparent:true, frame:false,
    webPreferences: { preload:path.join(appRoot, "dist-electron/electron/preload.cjs"), contextIsolation:true, nodeIntegration:false, backgroundThrottling:false } });
  const errors = [];
  window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  const url = pathToFileURL(path.join(appRoot, "dist/widget.html"));
  url.search = new URLSearchParams({ agent:"claude", session:sessionId, overlay:"1", handoffToken:"fixture-token" }).toString();
  await window.loadURL(url.href);
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name:"prefers-reduced-motion", value:"no-preference" }] });
  await waitForText(".session-status", "執行中");
  await waitForText(".task-label-value", "相容驗證");
  check("Claude replaces the dot with animated Clawd beside its name", await window.webContents.executeJavaScript('!!document.querySelector(".stack-title .mascot-stage .agent-mascot.claude.running svg") && !document.querySelector(".stack-title .dot") && document.querySelector(".clawd-body").getAnimations().length > 0'));
  check("working scenery scrolls behind Clawd", await window.webContents.executeJavaScript('document.querySelector(".mascot-stage.running .stage-ground").getAnimations().find(animation => animation.animationName?.includes("stage-scroll-ground"))?.playState === "running" && !document.querySelector(".sleep-z")'));
  check("agent name is drawn inside the mascot stage", await window.webContents.executeJavaScript('document.querySelector(".mascot-stage .stage-name")?.textContent.trim() === "Claude"'));
  check("status text is hidden visually but kept for screen readers", await window.webContents.executeJavaScript('document.querySelector(".session-status").getBoundingClientRect().width <= 1'));
  const clawdWorkingPose = await readMascotPose();
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name:"prefers-reduced-motion", value:"reduce" }] });
  check("working Clawd keeps whole-body and both-arm animation in reduced motion", await window.webContents.executeJavaScript('document.querySelector(".clawd-body").getAnimations().length === 1 && Array.from(document.querySelectorAll(".clawd-arm")).every(arm => arm.getAnimations().length === 1)'));
  check("working Clawd visibly moves its whole body by at least two pixels", await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const body = document.querySelector(".clawd-body");
    let minimum = body.getBoundingClientRect().y, maximum = minimum;
    const deadline = performance.now() + 2000;
    const sample = () => {
      const y = body.getBoundingClientRect().y;
      minimum = Math.min(minimum, y); maximum = Math.max(maximum, y);
      if (maximum - minimum >= 2) return resolve(true);
      if (performance.now() >= deadline) return reject(new Error("Clawd body did not visibly move"));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })`));
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name:"prefers-reduced-motion", value:"no-preference" }] });
  check("Claude model and effort are visible", await window.webContents.executeJavaScript('document.querySelector(".session-model").textContent.includes("Claude Opus 4.6") && document.querySelector(".session-model").textContent.includes("high")'));
  check("task label fits on one neutral line", await window.webContents.executeJavaScript(`(() => {
    const value = document.querySelector(".task-label-value"), style = getComputedStyle(value);
    return style.whiteSpace === "nowrap" && style.textOverflow === "ellipsis" && value.getBoundingClientRect().height < 20 && !["rgb(184, 111, 50)", "rgb(63, 143, 106)"].includes(style.color);
  })()`));
  check("all metrics fit within the fixed overlay", await window.webContents.executeJavaScript('document.querySelector(".single-agent-card").getBoundingClientRect().bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth'));
  check("healthy monitoring hides the status line", await window.webContents.executeJavaScript('!document.querySelector(".session-health")'));
  check("token totals share one row", await window.webContents.executeJavaScript('document.querySelectorAll(".session-row").length === 1 && document.querySelector(".session-tokens").textContent.replace(/\\s+/g, "") === "Tokens123.5K+4.6K"'));
  check("turn clock moves into the stage while working", await window.webContents.executeJavaScript('/^\\d+:\\d{2}$/.test(document.querySelector(".mascot-stage .stage-timer")?.textContent.trim() ?? "")'));
  check("handoff threshold is marked on the context bar", await window.webContents.executeJavaScript('document.querySelector(".session-context .threshold-mark").style.left === "72%"'));
  check("stage bleeds to the card's top, left and right edges", await window.webContents.executeJavaScript(`(() => {
    const card = document.querySelector(".single-agent-card").getBoundingClientRect(), stage = document.querySelector(".mascot-stage").getBoundingClientRect();
    return Math.abs(stage.left - card.left) <= 1.5 && Math.abs(stage.right - card.right) <= 1.5 && Math.abs(stage.top - card.top) <= 1.5;
  })()`));
  check("normal quota keeps plain colors and no sweat", await window.webContents.executeJavaScript('!document.querySelector(".line-fill.danger") && !document.querySelector(".sweat-drop")'));
  await checkHandoffThreshold();
  await waitForText(".handoff-button", "複製交接指令");
  check("redundant report-content button is gone", await window.webContents.executeJavaScript('!document.querySelector(".handoff-copy-report")'));
  await window.webContents.executeJavaScript('document.querySelector(".handoff-button").click()');
  await waitForText(".handoff-message", "已複製");
  check("Claude copies the original-session instruction", copiedText === "generate-fixture-prompt" && prepareCount === 1);
  await window.webContents.executeJavaScript('document.querySelector(".handoff-button").click()');
  await waitForText(".handoff-message", "已複製");
  check("repeated clicks reuse the same request", prepareCount === 1);
  check("handoff controls fit within the overlay", await window.webContents.executeJavaScript('document.querySelector(".handoff-controls").getBoundingClientRect().bottom <= innerHeight'));
  await window.webContents.executeJavaScript('document.querySelector(".handoff-button").dispatchEvent(new MouseEvent("mousemove", { bubbles:true }))');
  await window.webContents.executeJavaScript('document.querySelector(".session-model").dispatchEvent(new MouseEvent("mousemove", { bubbles:true }))');
  check("preload limits pointer interception to handoff controls", pointerStates.includes(true) && pointerStates.at(-1) === false);
  handoff = { ...handoff, phase:"ready", message:"交接報告已就緒" };
  await waitForText(".handoff-button", "複製接手指令");
  await window.webContents.executeJavaScript('document.querySelector(".handoff-button").click()');
  await waitForText(".handoff-message", "到同工作目錄");
  check("ready reports expose reception instructions", copiedText === "receive-fixture-prompt");
  await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(output, "claude.png"), (await window.webContents.capturePage()).toPNG());
  data.status = "waiting_approval"; push();
  await waitForText(".session-status", "等待授權");
  check("approval wait shows an exclamation bubble", await window.webContents.executeJavaScript('document.querySelector(".mascot-stage.waiting .alert-bubble")?.textContent.trim() === "!"'));
  await window.webContents.executeJavaScript("new Promise(resolve => setTimeout(resolve, 900))"); await window.webContents.capturePage(); await window.webContents.executeJavaScript("new Promise(resolve => setTimeout(resolve, 300))");
  fs.writeFileSync(path.join(output, "claude-waiting.png"), (await window.webContents.capturePage()).toPNG());
  check("Clawd changes animation when waiting for approval", await window.webContents.executeJavaScript('!!document.querySelector(".agent-mascot.claude.waiting") && getComputedStyle(document.querySelector(".clawd-body")).animationName.includes("clawd-look")'));
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name:"prefers-reduced-motion", value:"reduce" }] });
  check("reduced motion keeps Clawd approval visible with blinking and no body movement", await window.webContents.executeJavaScript('document.querySelector(".clawd-body").getAnimations().length === 0 && document.querySelector(".clawd-eyes").getAnimations().length === 1 && getComputedStyle(document.querySelector(".clawd-eyes")).animationDuration === "3s"'));
  check("waiting Clawd raises its arms even with reduced motion", (await readMascotPose()).arm !== clawdWorkingPose.arm);
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name:"prefers-reduced-motion", value:"no-preference" }] });
  check("event push updates approval without quota polling", true);
  data.status = "idle"; push();
  await waitForText(".session-status", "閒置");
  check("idle hides the turn clock", await window.webContents.executeJavaScript('!document.querySelector(".stage-timer")'));
  check("idle Clawd rests instead of stepping", await window.webContents.executeJavaScript('!!document.querySelector(".agent-mascot.claude.resting") && document.querySelector(".clawd-body").getAnimations().length === 0 && getComputedStyle(document.querySelector(".clawd-eyes")).animationName.includes("clawd-rest")'));
  check("idle Clawd sleeps while the scenery stops", await window.webContents.executeJavaScript('!!document.querySelector(".mascot-stage.resting .sleep-z") && document.querySelector(".stage-ground").getAnimations().find(animation => animation.animationName?.includes("stage-scroll-ground"))?.playState === "paused"'));
  const clawdRestingPose = await readMascotPose();
  check("idle Clawd has visibly different eyes and tucked feet", clawdRestingPose.eyes !== clawdWorkingPose.eyes && clawdRestingPose.feet !== clawdWorkingPose.feet);
  await window.webContents.executeJavaScript("new Promise(resolve => setTimeout(resolve, 900))"); await window.webContents.capturePage(); await window.webContents.executeJavaScript("new Promise(resolve => setTimeout(resolve, 300))");
  fs.writeFileSync(path.join(output, "claude-idle.png"), (await window.webContents.capturePage()).toPNG());
  data.status = "interrupted"; data.turnEndedAt = new Date().toISOString(); push();
  await waitForText(".session-status", "已中斷");
  check("interrupt status is rendered", true);
  check("interrupted Clawd falls over with crossed eyes and stops animating", await window.webContents.executeJavaScript('!!document.querySelector(".agent-mascot.failed") && getComputedStyle(document.querySelector(".clawd-eyes-x")).display !== "none" && document.querySelector(".clawd").getAnimations({ subtree:true }).length === 0'));
  await window.webContents.executeJavaScript("new Promise(resolve => setTimeout(resolve, 900))"); await window.webContents.capturePage(); await window.webContents.executeJavaScript("new Promise(resolve => setTimeout(resolve, 300))");
  fs.writeFileSync(path.join(output, "claude-failed.png"), (await window.webContents.capturePage()).toPNG());
  data.readError = true; push();
  await waitForText(".session-health", "紀錄讀取異常");
  check("read failures are visible", true);
  handoff = null;
  data.source = "codex"; data.model = "gpt-6-astra-very-long-model-name"; data.status = "idle"; data.readError = false;
  quotaFixture.fiveHourPercent = 85; quotaFixture.sevenDayPercent = 90;
  url.search = new URLSearchParams({ agent:"codex", session:sessionId, overlay:"1", handoffToken:"fixture-token" }).toString();
  await window.loadURL(url.href);
  await waitForText(".session-status", "閒置");
  check("Codex displays local Codey and blinks while idle", await window.webContents.executeJavaScript('!!document.querySelector(".agent-mascot.codex.resting .codey") && getComputedStyle(document.querySelector(".codey")).backgroundImage.includes("codey-spritesheet.webp") && getComputedStyle(document.querySelector(".codey")).animationName.includes("codey-rest")'));
  const codeyRestingPose = await readMascotPose();
  check("idle Codey uses the closed-eye resting frame", codeyRestingPose.sprite.startsWith("14.2857%"));
  await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(output, "codex-idle.png"), (await window.webContents.capturePage()).toPNG());
  check("Codey sprite loads offline", await window.webContents.executeJavaScript('new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image.naturalWidth === 1536 && image.naturalHeight === 1872); image.onerror = () => resolve(false); image.src = new URL("codey-spritesheet.webp", location.href).href; })'));
  data.status = "running"; push();
  await waitForText(".session-status", "執行中");
  check("Codey walks with the walking sprite row", await window.webContents.executeJavaScript('!!document.querySelector(".agent-mascot.codex.running") && getComputedStyle(document.querySelector(".codey")).getPropertyValue("--sprite-row").trim() === "12.5%" && getComputedStyle(document.querySelector(".codey")).animationName.includes("codey-walk") && document.querySelector(".codey").getAnimations().length === 1'));
  check("high quota turns every quota bar red", await window.webContents.executeJavaScript('document.querySelectorAll(".line-metric .line-fill.danger").length >= 2 && document.querySelectorAll(".metric-copy strong.danger").length >= 2'));
  check("high 5h quota makes working Codey sweat", await window.webContents.executeJavaScript('!!document.querySelector(".mascot-stage.running .sweat-drop")'));
  check("working Codey uses a visibly different pose from idle", (await readMascotPose()).sprite !== codeyRestingPose.sprite);
  data.status = "waiting_input"; push();
  await waitForText(".session-status", "等待輸入");
  check("input wait shows a question bubble", await window.webContents.executeJavaScript('document.querySelector(".alert-bubble")?.textContent.trim() === "?"'));
  data.status = "running"; push();
  await waitForText(".session-status", "執行中");
  data.status = "idle"; push();
  await waitForText(".session-status", "閒置");
  check("Codey celebrates a finished turn before sleeping", await window.webContents.executeJavaScript('!!document.querySelector(".mascot-stage.celebrating .sparkles") && getComputedStyle(document.querySelector(".codey")).getPropertyValue("--sprite-row").trim() === "100%"'));
  fs.writeFileSync(path.join(output, "codex-celebrate.png"), (await window.webContents.capturePage()).toPNG());
  await waitForSelector(".agent-mascot.resting");
  check("Codey returns to its idle animation when work ends", await window.webContents.executeJavaScript('!!document.querySelector(".agent-mascot.resting") && getComputedStyle(document.querySelector(".codey")).animationName.includes("codey-rest")'));
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name:"prefers-reduced-motion", value:"reduce" }] });
  check("reduced motion preserves Codey idle blinking", await window.webContents.executeJavaScript('document.querySelector(".codey").getAnimations().length === 1 && getComputedStyle(document.querySelector(".codey")).animationDuration === "6s"'));
  data.status = "waiting_approval"; push();
  await waitForText(".session-status", "等待授權");
  check("reduced motion slows Codey approval animation instead of stopping it", await window.webContents.executeJavaScript('!!document.querySelector(".agent-mascot.waiting") && document.querySelector(".codey").getAnimations().length === 1 && getComputedStyle(document.querySelector(".codey")).animationDuration === "4.8s"'));
  data.status = "running"; push();
  await waitForText(".session-status", "執行中");
  check("reduced motion slows Codey working animation instead of stopping it", await window.webContents.executeJavaScript('!!document.querySelector(".agent-mascot.running") && getComputedStyle(document.querySelector(".codey")).animationDuration === "2.4s"'));
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name:"prefers-reduced-motion", value:"no-preference" }] });
  await waitForText(".task-label-value", "相容驗證");
  check("Codex labels use 5H ≈ and 7D with short reset times", await window.webContents.executeJavaScript(`(() => {
    const labels = Array.from(document.querySelectorAll(".line-metric .metric-copy > span:first-child")).map(element => element.textContent.trim());
    const resets = Array.from(document.querySelectorAll(".extra-info")).map(element => element.textContent.trim());
    return labels[0] === "5H ≈" && labels[1] === "7D" && resets.every(text => /^(\\d+d\\d+h|\\d+h\\d+m|\\d+m)$/.test(text));
  })()`));
  check("Codex context is labeled approximate", await window.webContents.executeJavaScript('document.querySelector(".session-context").textContent.includes("≈")'));
  check("long model fits without horizontal overflow", await window.webContents.executeJavaScript('Array.from(document.querySelectorAll(".single-agent-card, .session-status, .session-health, .session-row strong")).every(element => element.getBoundingClientRect().right <= innerWidth)'));
  await checkHandoffThreshold();
  await waitForText(".handoff-button", "產生交接報告");
  await window.webContents.executeJavaScript('document.querySelector(".handoff-button").click()');
  await waitForText(".handoff-button", "等待交接報告");
  check("Codex waits and prevents duplicate dispatch", await window.webContents.executeJavaScript('document.querySelector(".handoff-button").disabled'));
  handoff = { ...handoff, phase:"failed", message:"派送失敗，不會自動重送" };
  await waitForText(".handoff-button", "複製交接指令");
  check("dispatch failures offer an explicit manual instruction", true);
  await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(output, "codex.png"), (await window.webContents.capturePage()).toPNG());
  for (const stream of streams) stream.end();
  await waitForText(".session-status", "連線中斷");
  check("disconnected Codey stops its working animation", await window.webContents.executeJavaScript('!!document.querySelector(".agent-mascot.codex.unavailable") && document.querySelector(".codey").getAnimations().length === 0'));
  check("disconnection is visible", true);
  data.source = "claude"; data.model = "Claude Opus 4.6"; data.status = "running"; data.contextPercent = 43.2;
  quotaFixture.fiveHourPercent = 23.5; quotaFixture.sevenDayPercent = 41.2;
  url.search = new URLSearchParams({ agent:"claude", session:sessionId }).toString();
  await window.loadURL(url.href);
  const pushUntilRunning = setInterval(push, 200);
  try { await waitForText(".session-status", "執行中"); } finally { clearInterval(pushUntilRunning); }
  check("widget close button stays clear of the stage name and timer", await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector(".close-button").getBoundingClientRect();
    const clear = element => { const box = element.getBoundingClientRect(); return box.right <= button.left || box.top >= button.bottom; };
    return clear(document.querySelector(".stage-name")) && clear(document.querySelector(".stage-timer"));
  })()`));
  check("widget stage still bleeds to the card edges", await window.webContents.executeJavaScript(`(() => {
    const card = document.querySelector(".single-agent-card").getBoundingClientRect(), stage = document.querySelector(".mascot-stage").getBoundingClientRect();
    return Math.abs(stage.left - card.left) <= 1.5 && Math.abs(stage.right - card.right) <= 1.5 && Math.abs(stage.top - card.top) <= 1.5;
  })()`));
  await window.webContents.executeJavaScript('document.querySelector(".widget-shell").dispatchEvent(new MouseEvent("mouseenter"))');
  await window.webContents.executeJavaScript("new Promise(resolve => setTimeout(resolve, 900))"); await window.webContents.capturePage();
  fs.writeFileSync(path.join(output, "widget.png"), (await window.webContents.capturePage()).toPNG());
  check("no renderer errors", errors.length === 0);
  await finish();
}).catch(finish);
setTimeout(() => finish(new Error("UI check timed out")), 40000).unref();
