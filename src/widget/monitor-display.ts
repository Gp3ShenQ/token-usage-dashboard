import type { MonitorSnapshot, RunStatus } from "../../server/monitor/state";

export const statusLabels: Record<RunStatus, string> = {
  unknown: "狀態未知", running: "執行中", waiting_input: "等待輸入", waiting_approval: "等待授權",
  idle: "閒置", interrupted: "已中斷", error: "發生錯誤", ended: "已結束",
};

export function formatTurnDuration(snapshot: MonitorSnapshot | null, now: number) {
  if (!snapshot?.turnStartedAt) return "—";
  const end = snapshot.turnEndedAt ? Date.parse(snapshot.turnEndedAt) : now;
  const seconds = Math.max(0, Math.floor((end - Date.parse(snapshot.turnStartedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours > 0 ? hours + "時 " + minutes + "分 " + seconds % 60 + "秒" : minutes + "分 " + seconds % 60 + "秒";
}

export function formatEventAge(timestamp: string | null | undefined, now: number) {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "尚無事件";
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (seconds < 60) return seconds + "秒前";
  if (seconds < 3600) return Math.floor(seconds / 60) + "分前";
  return Math.floor(seconds / 3600) + "小時前";
}
