import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tokenHud", {
  copyHandoffText: (text: string) => ipcRenderer.invoke("handoff:copy", text),
  getWidgetSettings: () => ipcRenderer.invoke("widget:get-settings"),
  saveWidgetSettings: (payload: Record<string, number | string>) => ipcRenderer.invoke("widget:save-settings", payload),
  openDashboard: () => ipcRenderer.invoke("app:open-dashboard"),
  minimizeToTray: () => ipcRenderer.invoke("app:minimize-widget"),
  launchAgentTerminal: (agent: "codex" | "claude") => ipcRenderer.invoke("terminal:launch-agent", agent),
});

window.addEventListener("DOMContentLoaded", () => {
  if (new URLSearchParams(window.location.search).get("overlay") !== "1") return;
  let interactive = false;
  const updatePointer = (next: boolean) => {
    if (next === interactive) return;
    interactive = next;
    ipcRenderer.send("widget:pointer", interactive);
  };
  window.addEventListener("mousemove", (event) => {
    updatePointer(event.target instanceof Element && !!event.target.closest("[data-handoff-controls]"));
  });
  document.documentElement.addEventListener("mouseleave", () => updatePointer(false));
  window.addEventListener("beforeunload", () => ipcRenderer.send("widget:pointer", false));
});