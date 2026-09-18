export function formatTokenCompact(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return `${value}`;
}

export function formatResetCountdown(unixSeconds: number | null | undefined) {
  if (!unixSeconds) {
    return "--";
  }

  const remainingMs = unixSeconds * 1000 - Date.now();
  if (remainingMs <= 0) {
    return "等待重設";
  }

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days} 天 ${hours} 小時`;
  }

  if (hours > 0) {
    return `${hours} 小時 ${minutes} 分`;
  }

  return `${Math.max(1, minutes)} 分`;
}

export function formatResetAt(unixSeconds: number | null | undefined) {
  if (!unixSeconds) {
    return "--";
  }

  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(unixSeconds * 1000);
}
