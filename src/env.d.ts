/// <reference types="vite/client" />

declare global {
  interface Window {
    tokenHud?: {
      getWidgetSettings: () => Promise<{ opacity: number; refreshSeconds: number }>;
      saveWidgetSettings: (payload: Record<string, number | string>) => Promise<{ ok: true }>;
      openDashboard: () => Promise<{ ok: true }>;
      minimizeToTray: () => Promise<{ ok: true }>;
      launchAgentTerminal: (agent: "codex" | "claude") => Promise<{ ok: boolean; error?: string }>;
      setOverlayAgent: (hwnd: string, agent: "codex" | "claude") => Promise<{ ok: boolean }>;
    };
  }
}

export { };
