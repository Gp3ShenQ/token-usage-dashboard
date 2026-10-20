import { expect, it } from "vitest";
import { SessionMonitorState } from "../../../server/monitor/state";
import { formatEventAge, formatResetShort, formatTurnClock } from "../monitor-display";

it("freezes elapsed duration for finished and interrupted turns", () => {
  const snapshot = new SessionMonitorState("claude", "session-one").data;
  snapshot.turnStartedAt = "2026-09-18T00:00:00Z";
  expect(formatTurnClock(snapshot, Date.parse("2026-09-18T00:01:05Z"))).toBe("1:05");
  expect(formatTurnClock(snapshot, Date.parse("2026-09-18T01:02:03Z"))).toBe("1:02:03");
  snapshot.turnEndedAt = "2026-09-18T00:00:20Z";
  expect(formatTurnClock(snapshot, Date.parse("2026-09-18T04:00:00Z"))).toBe("0:20");
  expect(formatTurnClock(null, Date.now())).toBe("—");
});

it("keeps reset countdowns short enough for one metric row", () => {
  const now = Date.parse("2026-09-18T00:00:00Z");
  const at = (minutes: number) => now / 1000 + minutes * 60;
  expect(formatResetShort(null, now)).toBe("--");
  expect(formatResetShort(at(-1), now)).toBe("等待重設");
  expect(formatResetShort(at(0.5), now)).toBe("1m");
  expect(formatResetShort(at(59), now)).toBe("59m");
  expect(formatResetShort(at(23 * 60 + 59), now)).toBe("23h59m");
  expect(formatResetShort(at(2 * 1440 + 3 * 60 + 10), now)).toBe("2d3h");
});

it("shows unavailable or future event times without negative ages", () => {
  expect(formatEventAge(null, Date.now())).toBe("尚無事件");
  expect(formatEventAge("invalid", Date.now())).toBe("尚無事件");
  expect(formatEventAge("2026-09-18T00:00:00Z", Date.parse("2026-09-17T00:00:00Z"))).toBe("0秒前");
});
