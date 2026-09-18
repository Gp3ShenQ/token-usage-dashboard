import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tokenHud", {
  getWidgetSettings: () => ipcRenderer.invoke("widget:get-settings"),
  saveWidgetSettings: (payload: Record<string, number | string>) => ipcRenderer.invoke("widget:save-settings", payload),
  openDashboard: () => ipcRenderer.invoke("app:open-dashboard"),
  minimizeToTray: () => ipcRenderer.invoke("app:minimize-widget"),
  launchAgentTerminal: (agent: "codex" | "claude") => ipcRenderer.invoke("terminal:launch-agent", agent),
});
