import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { queueCodexHandoff } from "./codex-queue.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, screen, clipboard } from "electron";
import { bootstrapServer } from "../server/index.js";
import { UsageDatabase } from "../server/db/database.js";
import { formatTokenCompact } from "../server/utils.js";
import { detectTerminalWindowSnapshot, type DetectedTerminalWindow } from "./terminal-detector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

let widgetWindow: BrowserWindow | null = null;
let dashboardWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backend: Awaited<ReturnType<typeof bootstrapServer>> | null = null;
let settingsDb: UsageDatabase | null = null;
let notifiedResetWindow: string | null = null;
let overlaySyncTimer: NodeJS.Timeout | null = null;
let overlaySyncRunning = false;
let overlaysPaused = false;
let lastSummaryTotal = 0;
const overlayWindows = new Map<string, BrowserWindow>();
const OVERLAY_WIDTH = 208;
const OVERLAY_HEIGHT = 448;
const handoffToken = randomUUID();
// Leave room for reception instructions alongside a report of up to 256 KiB.
const HANDOFF_CLIPBOARD_LIMIT = 512 * 1024;
const OVERLAY_MARGIN = 12;
const OVERLAY_TOP_OFFSET = 25;

type AgentKind = "codex" | "claude";

function writeStartupLog(message: string, data?: unknown) {
  try {
    const logPath = path.join(app.getPath("userData"), "startup.log");
    const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}${suffix}\n`);
  } catch {
    // Ignore logging failures while debugging startup.
  }
}

function getRendererTarget(page: "dashboard" | "widget", params?: Record<string, string>) {
  const base = isDev && devServerUrl
    ? `${devServerUrl}/${page === "dashboard" ? "" : "widget.html"}`
    : pathToFileURL(path.join(app.getAppPath(), "dist", page === "dashboard" ? "index.html" : "widget.html")).toString();
  const url = new URL(base);
  if (page === "widget") url.searchParams.set("handoffToken", handoffToken);

  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function clampToDisplay(x: number, y: number, width: number, height: number) {
  const display = screen.getDisplayMatching({ x, y, width, height });
  const { workArea } = display;
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - height);

  return {
    x: Math.min(Math.max(x, workArea.x), maxX),
    y: Math.min(Math.max(y, workArea.y), maxY),
  };
}

function clampWidgetPosition(x: number, y: number) {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 292;
  const height = 412;
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - height);

  return {
    x: Math.min(Math.max(x, workArea.x), maxX),
    y: Math.min(Math.max(y, workArea.y), maxY),
  };
}

function restoreWidgetWindow() {
  overlaysPaused = false;
  if (!overlayWindows.size) {
    writeStartupLog("restoreWidgetWindow fallback to dashboard");
    void createDashboardWindow();
    return;
  }
  for (const win of overlayWindows.values()) {
    win.showInactive();
  }
  writeStartupLog("restoreWidgetWindow executed", {
    overlayCount: overlayWindows.size,
    widgetVisible: false,
  });
}

async function createWidgetWindow() {
  const savedX = Number(settingsDb?.getSetting("widget.x") ?? 30);
  const savedY = Number(settingsDb?.getSetting("widget.y") ?? 30);
  const { x, y } = clampWidgetPosition(savedX, savedY);

  widgetWindow = new BrowserWindow({
    width: 292,
    height: 430,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  widgetWindow.setAlwaysOnTop(true, "screen-saver");
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  writeStartupLog("widget window created", { x, y });
  widgetWindow.once("ready-to-show", () => {
    writeStartupLog("widget ready-to-show");
  });
  widgetWindow.on("close", (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      widgetWindow?.hide();
    }
  });
  widgetWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    writeStartupLog("widget did-fail-load", { errorCode, errorDescription, validatedUrl });
    console.error("Widget failed to load", { errorCode, errorDescription, validatedUrl });
  });
  widgetWindow.webContents.on("render-process-gone", (_event, details) => {
    writeStartupLog("widget render-process-gone", details);
    console.error("Widget renderer exited", details);
  });
  widgetWindow.webContents.on("did-finish-load", () => {
    writeStartupLog("widget did-finish-load");
  });
  widgetWindow.on("moved", () => {
    const position = widgetWindow?.getPosition();
    if (!position || !settingsDb) {
      return;
    }
    settingsDb.setSetting("widget.x", `${position[0]}`);
    settingsDb.setSetting("widget.y", `${position[1]}`);
  });

  await widgetWindow.loadURL(getRendererTarget("widget"));
}

function getOverlayBounds(target: DetectedTerminalWindow) {
  const rawX = target.bounds.x + target.bounds.width - OVERLAY_WIDTH;
  const rawY = target.bounds.y + OVERLAY_TOP_OFFSET;
  const { x, y } = clampToDisplay(rawX, rawY, OVERLAY_WIDTH, OVERLAY_HEIGHT);

  return {
    x,
    y,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
  };
}

async function createOverlayWindow(target: DetectedTerminalWindow, shouldShow: boolean) {
  const bounds = getOverlayBounds(target);
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.once("ready-to-show", () => {
    if (shouldShow && !overlaysPaused) {
      win.showInactive();
    }
  });
  win.on("closed", () => {
    overlayWindows.delete(target.hwnd);
  });

  await win.loadURL(getRendererTarget("widget", {
    agent: target.agent,
    session: target.sessionPrefix ?? "",
    task: target.taskLabel ?? "",
    overlay: "1",
    hwnd: target.hwnd,
  }));
  if (shouldShow && !overlaysPaused) {
    win.showInactive();
  }
  return win;
}

async function syncOverlayWindows() {
  if (overlaySyncRunning || process.platform !== "win32") {
    return;
  }

  overlaySyncRunning = true;
  try {
    const snapshot = await detectTerminalWindowSnapshot();
    const { foregroundHwnd } = snapshot;
    const targets = snapshot.windows.map((target) => ({ ...target, id: target.hwnd }));
    const nextIds = new Set(targets.map((target) => target.id));

    for (const [id, win] of overlayWindows.entries()) {
      if (nextIds.has(id)) {
        continue;
      }
      overlayWindows.delete(id);
      win.close();
    }

    for (const target of targets) {
      const bounds = getOverlayBounds(target);
      const shouldShow = !overlaysPaused && target.hwnd === foregroundHwnd;
      let win = overlayWindows.get(target.id);

      if (!win) {
        win = await createOverlayWindow(target, shouldShow);
        overlayWindows.set(target.id, win);
      } else {
        win.setBounds(bounds, false);
        const currentUrl = new URL(win.webContents.getURL());
        const currentAgent = currentUrl.searchParams.get("agent");
        const currentSession = currentUrl.searchParams.get("session") ?? "";
        const currentTask = currentUrl.searchParams.get("task") ?? "";
        const nextSession = target.sessionPrefix ?? "";
        const nextTask = target.taskLabel ?? "";
        if (currentAgent !== target.agent || currentSession !== nextSession || currentTask !== nextTask) {
          await win.loadURL(getRendererTarget("widget", {
            agent: target.agent,
            session: nextSession,
            task: nextTask,
            overlay: "1",
            hwnd: target.hwnd,
          }));
        }
      }

      if (shouldShow) {
        win.showInactive();
      } else {
        win.hide();
      }
    }

    updateTrayMenu(lastSummaryTotal);
  } finally {
    overlaySyncRunning = false;
  }
}

async function createDashboardWindow() {
  if (dashboardWindow) {
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  dashboardWindow.on("closed", () => {
    dashboardWindow = null;
  });
  dashboardWindow.once("ready-to-show", () => {
    writeStartupLog("dashboard ready-to-show");
    dashboardWindow?.show();
    dashboardWindow?.focus();
  });
  dashboardWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    writeStartupLog("dashboard did-fail-load", { errorCode, errorDescription, validatedUrl });
    console.error("Dashboard failed to load", { errorCode, errorDescription, validatedUrl });
  });

  await dashboardWindow.loadURL(getRendererTarget("dashboard"));
}

function updateTrayMenu(summaryTotal = 0) {
  if (!tray) {
    return;
  }

  tray.setToolTip(`今日總用量 ${formatTokenCompact(summaryTotal)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: overlaysPaused ? "顯示監測卡片" : "隱藏監測卡片",
        click: () => {
          overlaysPaused = !overlaysPaused;
          for (const win of overlayWindows.values()) {
            if (overlaysPaused) {
              win.hide();
            } else {
              win.showInactive();
            }
          }
          if (!overlaysPaused) {
            void syncOverlayWindows();
          }
          updateTrayMenu(summaryTotal);
        },
      },
      { label: "開啟儀表板", click: () => void createDashboardWindow() },
      { label: "立即掃描", click: () => void backend?.scanner.scan() },
      { type: "separator" },
      {
        label: "結束程式",
        click: () => {
          app.isQuiting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  const icon = nativeImage
    .createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#6f8a84"/><path d="M4 10.5h8M4 7.75h5.5M4 5h8" stroke="#fff" stroke-width="1.35" stroke-linecap="round"/></svg>',
      ).toString("base64")}`,
    )
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  updateTrayMenu();
  tray.on("double-click", () => {
    restoreWidgetWindow();
  });
}

function launchAgentTerminal(agent: AgentKind) {
  const title = agent === "codex" ? "Codex" : "Claude";
  const child = spawn(
    "wt.exe",
    ["-w", "new", "new-tab", "--title", title, "--suppressApplicationTitle", "pwsh.exe", "-NoExit", "-Command", agent],
    { detached: true, stdio: "ignore", windowsHide: true },
  );

  child.unref();

  return new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function setupIpc() {
  ipcMain.on("widget:pointer", (event, interactive: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && [...overlayWindows.values()].includes(win)) {
      win.setIgnoreMouseEvents(interactive !== true, { forward: true });
    }
  });
  ipcMain.handle("handoff:copy", (event, text: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || (win !== widgetWindow && ![...overlayWindows.values()].includes(win)) ||
        typeof text !== "string" || text.length > HANDOFF_CLIPBOARD_LIMIT) throw new Error("無法複製交接指令。");
    clipboard.writeText(text);
    return { ok: true };
  });
  ipcMain.handle("widget:get-settings", async () => ({
    opacity: Number(settingsDb?.getSetting("widget.opacity") ?? 0.82),
    refreshSeconds: Number(settingsDb?.getSetting("widget.refreshSeconds") ?? 60),
  }));

  ipcMain.handle("widget:save-settings", async (_event, payload: Record<string, number | string>) => {
    for (const [key, value] of Object.entries(payload)) {
      settingsDb?.setSetting(`widget.${key}`, `${value}`);
    }
    return { ok: true };
  });

  ipcMain.handle("app:open-dashboard", async () => {
    await createDashboardWindow();
    return { ok: true };
  });

  ipcMain.handle("app:minimize-widget", async () => {
    widgetWindow?.hide();
    return { ok: true };
  });

  ipcMain.handle("terminal:launch-agent", async (_event, agent: AgentKind) => {
    if (agent !== "codex" && agent !== "claude") {
      return { ok: false, error: "Unsupported agent" };
    }

    try {
      await launchAgentTerminal(agent);
      return { ok: true };
    } catch {
      return { ok: false, error: "Windows Terminal could not be started" };
    }
  });

}

function startQuotaWatcher() {
  setInterval(() => {
    const snapshot = settingsDb?.getRateLimitSnapshot();
    const data = snapshot?.data as
      | {
        primary?: { used_percent?: number; resets_at?: number };
      }
      | undefined;

    const usedPercent = data?.primary?.used_percent ?? 0;
    const resetWindow = `${data?.primary?.resets_at ?? ""}`;

    if (usedPercent > 95 && resetWindow && resetWindow !== notifiedResetWindow) {
      notifiedResetWindow = resetWindow;
      widgetWindow?.webContents.send("widget:quota-alert");
      if (Notification.isSupported()) {
        new Notification({
          title: "Codex 額度警示",
          body: `主要額度已使用 ${usedPercent.toFixed(1)}%`,
        }).show();
      }
    }
  }, 30_000);
}

function startOverlayWatcher() {
  if (process.platform !== "win32") {
    return;
  }

  void syncOverlayWindows();
  overlaySyncTimer = setInterval(() => {
    void syncOverlayWindows();
  }, 1375);
}

async function main() {
  writeStartupLog("main start");
  settingsDb = new UsageDatabase();
  writeStartupLog("settings database ready");
  backend = await bootstrapServer({ root: path.join(app.getPath("userData"), "handoffs"), token: handoffToken, dispatch: queueCodexHandoff });
  writeStartupLog("backend ready");
  backend.monitor.onComplete((snapshot) => {
    const title = (snapshot.source === "claude" ? "Claude" : "Codex") + " 本輪回覆已結束";
    const body = "Session " + snapshot.sessionId.slice(0, 8) + " · 可返回 terminal 查看結果";
    // The portable Windows build has no installer-created Start Menu toast registration.
    if (process.platform === "win32" && tray) {
      tray.displayBalloon({ title, content: body, iconType: "info", respectQuietTime: true });
    } else if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  });
  setupIpc();
  writeStartupLog("ipc ready");
  await createWidgetWindow();
  widgetWindow?.hide();
  writeStartupLog("createWidgetWindow resolved");
  createTray();
  writeStartupLog("tray ready");
  startOverlayWatcher();
  startQuotaWatcher();
  setInterval(async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
    const summary = backend ? backend.db.getSummary(today, today) : null;
    lastSummaryTotal = summary
      ? Object.values(summary).reduce((sum, item) => sum + item.input + item.output + item.cache_read + item.cache_write, 0)
      : 0;
    updateTrayMenu(lastSummaryTotal);
  }, 60_000);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    restoreWidgetWindow();
  });
  app.whenReady().then(main);
}

app.on("before-quit", async () => {
  app.isQuiting = true;
  if (overlaySyncTimer) {
    clearInterval(overlaySyncTimer);
  }
  for (const win of overlayWindows.values()) {
    win.destroy();
  }
  await backend?.close();
  settingsDb?.close();
});

app.on("window-all-closed", () => { });

declare global {
  namespace Electron {
    interface App {
      isQuiting?: boolean;
    }
  }
}
