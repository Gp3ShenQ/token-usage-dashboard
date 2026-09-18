import { APP_TIMEZONE } from "./constants.js";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function toDayLocal(timestamp: string) {
  return dayFormatter.format(new Date(timestamp));
}

export function toInt(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function formatTokenCompact(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return `${value}`;
}

export function safeJsonParse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

export function projectDisplayName(projectKey: string | null) {
  if (!projectKey) {
    return "Unknown";
  }

  const decoded = projectKey.replace(/^([A-Z])--/, "$1:\\").replace(/-/g, "\\");
  return decoded;
}

export function percentChange(current: number, previous: number) {
  if (previous === 0) {
    return current === 0 ? 0 : 100;
  }

  return Number((((current - previous) / previous) * 100).toFixed(1));
}
