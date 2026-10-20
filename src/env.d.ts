/// <reference types="vite/client" />

declare global {
  interface Window {
    tokenHud?: {
      copyHandoffText: (text: string) => Promise<{ ok: true }>;
      getWidgetSettings: () => Promise<{ opacity: number; refreshSeconds: number }>;
      saveWidgetSettings: (payload: Record<string, number | string>) => Promise<{ ok: true }>;
      openDashboard: () => Promise<{ ok: true }>;
      minimizeToTray: () => Promise<{ ok: true }>;
      launchAgentTerminal: (agent: "codex" | "claude") => Promise<{ ok: boolean; error?: string }>;
      getTerminalSetup: () => Promise<import("../electron/terminal-setup").TerminalSetupStatus>;
      configureTerminal: () => Promise<{ ok: boolean; error?: string; status?: import("../electron/terminal-setup").TerminalSetupStatus; backupPath?: string | null }>;
      approveTerminal: (request: { hwnd: string; agent: "codex" | "claude"; sessionId: string; turnId: string }) => Promise<{ ok: boolean }>;
      setOverlayAgent: (hwnd: string, agent: "codex" | "claude") => Promise<{ ok: boolean }>;
    };
  }
}

export { };
