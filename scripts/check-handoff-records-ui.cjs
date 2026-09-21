const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const Fastify = require("fastify");

let window, server, service, output;
const checks = [];
const appRoot = process.argv.includes("--packaged") ? path.resolve("release/win-unpacked/resources/app.asar") : process.cwd();
const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
const run = code => window.webContents.executeJavaScript(code);
const waitFor = expression => run(`new Promise((resolve, reject) => {
  const check = () => { if (${expression}) { observer.disconnect(); clearTimeout(timer); resolve(true); } };
  const observer = new MutationObserver(check);
  const timer = setTimeout(() => { observer.disconnect(); reject(new Error("UI state timeout")); }, 8000);
  observer.observe(document.body, {subtree:true, childList:true, attributes:true, characterData:true}); check();
})`);
const clickButton = label => run(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes(${JSON.stringify(label)})).click()`);
const waitForPaint = () => run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

async function finish(error) {
  if (output) await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ checks, error: error?.stack ?? null, appRoot }, null, 2));
  if (window && !window.isDestroyed()) window.destroy();
  await server?.close();
  await service?.close();
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), "hud-records-ui-"));
  await fs.writeFile(path.join(os.tmpdir(), "hud-records-ui-latest.txt"), output);
  const { HandoffService, registerHandoffRoutes } = await import(pathToFileURL(path.resolve("dist-electron/server/monitor/handoff.js")).href);
  const token = "fixture-token";
  const root = path.join(output, "handoffs");
  service = new HandoffService({ root, token,
    getSession: async (source, sessionId) => ({ state:"ready", data:{ source, sessionId, cwd:output, status:"idle" } }),
    dispatch: async () => { throw new Error("UI test must never dispatch"); } });
  async function makeReport(source, sessionId, received, removed) {
    const target = { source, sessionId };
    const job = await service.prepare(target, "manual");
    await fs.writeFile(job.reportPath, JSON.stringify({ version:1, handoffId:job.id, ...target, cwd:output,
      generatedAt:new Date().toISOString(), goal:"Synthetic UI fixture", completed:[], changedFiles:[],
      verification:{passed:[],pending:[],failures:[]}, unfinished:[],cautions:[],next:[] }));
    await service.status(target);
    const receipt = { version:1, handoffId:job.id, ...target, cwd:output, sha256:job.digest,
      receivedAt:new Date().toISOString(), receiverSessionId:null, deletion:removed ? "deleted" : "pending" };
    const receiptPath = path.join(root, `handoff-${job.id}.receipt.json`);
    if (received) await fs.writeFile(receiptPath, JSON.stringify(receipt));
    if (removed) await fs.unlink(job.reportPath);
    return { job, receipt, receiptPath };
  }
  const completed = await makeReport("codex", "11111111-1111-1111-1111-111111111111", true, true);
  const awaiting = await makeReport("claude", "22222222-2222-2222-2222-222222222222", false, false);
  const receiving = await makeReport("codex", "33333333-3333-3333-3333-333333333333", true, false);
  const missing = await makeReport("claude", "44444444-4444-4444-4444-444444444444", false, true);
  server = Fastify();
  let cleanupCalls = 0;
  let rejectList = false;
  server.addHook("preHandler", async (request, reply) => {
    if (request.body?.action === "cleanup") cleanupCalls++;
    if (rejectList && request.body?.action === "list") return reply.code(503).send({ok:false,error:"測試載入失敗"});
  });
  registerHandoffRoutes(server, service, token);
  server.get("/api/meta", async () => ({ok:true,data:{timezone:"Asia/Taipei",paths:{},stats:{}}}));
  const address = await server.listen({host:"127.0.0.1",port:0});
  session.defaultSession.webRequest.onBeforeRequest({urls:["http://127.0.0.1:5180/*"]}, (details, callback) => {
    callback({redirectURL:details.url.replace("http://127.0.0.1:5180", address)});
  });
  window = new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  const errors = [];
  window.webContents.on("console-message", (_event, level, message) => { if (level >= 3 && !message.includes("503")) errors.push(message); });
  const url = pathToFileURL(path.join(appRoot, "dist/index.html"));
  url.searchParams.set("handoffToken", token);
  url.hash = "/settings";
  await window.loadURL(url.href);
  await waitFor("document.querySelectorAll('[data-handoff-id]').length === 4 && document.querySelector('[aria-busy]').getAttribute('aria-busy') === 'false'");
  check("shows all four reception states without a Context gate", await run(`['等待接收','已接收，待移除','接收完成，原檔已移除','檔案已移除，接收未確認'].every(text=>document.querySelector('.handoff-records').textContent.includes(text))`));
  check("only an unreceived report is selectable", await run("document.querySelectorAll('tbody input:not(:disabled)').length === 1"));
  await clickButton("清理已完成紀錄");
  await waitFor("document.querySelector('dialog').open");
  check("completed cleanup requires confirmation", cleanupCalls === 0);
  await waitForPaint();
  await fs.writeFile(path.join(output, "confirmation.png"), await window.webContents.capturePage().then(image => image.toPNG()));
  await clickButton("取消");
  check("cancel does not delete records", cleanupCalls === 0 && (await service.listRecords()).records.length === 4);
  await clickButton("清理已完成紀錄");
  await waitFor("document.querySelector('dialog').open");
  await clickButton("確認清理");
  await waitFor("document.querySelectorAll('[data-handoff-id]').length === 3 && document.querySelector('[aria-busy]').getAttribute('aria-busy') === 'false'");
  check("confirmed cleanup removes only completed metadata and receipt", cleanupCalls === 1 && !(await fs.readdir(root)).includes(path.basename(completed.receiptPath)));
  await run("document.querySelector('tbody input:not(:disabled)').click()");
  await clickButton("刪除選取的未接收報告");
  await waitFor("document.querySelector('dialog').open");
  check("unreceived confirmation warns that content cannot be received afterwards", await run("document.querySelector('dialog').textContent.includes('刪除後無法再接收')"));
  await fs.writeFile(awaiting.receiptPath, JSON.stringify(awaiting.receipt));
  await clickButton("確認清理");
  await waitFor("!document.querySelector('dialog').open && document.querySelector('[aria-busy]').getAttribute('aria-busy') === 'false'");
  check("a receipt appearing during confirmation blocks report deletion", !!(await fs.stat(awaiting.job.reportPath)) && (await service.listRecords()).records.length === 3);
  check("partial failures are visible", await run("document.querySelector('.handoff-records').textContent.includes('不能刪除未接收報告')"));
  await fs.unlink(awaiting.receiptPath);
  await clickButton("重新整理");
  await waitFor("document.querySelector('tbody input:not(:disabled)') && document.querySelector('[aria-busy]').getAttribute('aria-busy') === 'false'");
  await run("document.querySelector('tbody input:not(:disabled)').click()");
  await clickButton("刪除選取的未接收報告");
  await waitFor("document.querySelector('dialog').open");
  await clickButton("確認清理");
  await waitFor("document.querySelectorAll('[data-handoff-id]').length === 2 && document.querySelector('[aria-busy]').getAttribute('aria-busy') === 'false'");
  check("confirmed selection deletes its report and preserves received and unconfirmed history", !(await fs.readdir(root)).includes(path.basename(awaiting.job.reportPath)) && !!(await fs.stat(receiving.job.reportPath)));
  rejectList = true;
  await clickButton("重新整理");
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('測試載入失敗')");
  check("load errors are shown and cleanup controls are disabled", await run("Array.from(document.querySelectorAll('.records-actions > button')).every(button=>button.disabled)"));
  rejectList = false;
  await clickButton("重新整理");
  await waitFor("!document.querySelector('[role=alert]') && document.querySelector('[aria-busy]').getAttribute('aria-busy') === 'false'");
  await waitForPaint();
  await fs.writeFile(path.join(output, "records.png"), await window.webContents.capturePage().then(image => image.toPNG()));
  check("no unexpected renderer errors", errors.length === 0);
  check("missing report remains unconfirmed", (await service.listRecords()).records.find(record=>record.id===missing.job.id).reception === "missing");
  await finish();
}).catch(finish);
