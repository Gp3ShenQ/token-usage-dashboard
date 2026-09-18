import { expect, it } from "vitest";
import { SessionMonitorState } from "../../../server/monitor/state";
import { formatEventAge, formatTurnDuration } from "../monitor-display";

it("freezes elapsed duration for finished and interrupted turns", () => {
  const snapshot = new SessionMonitorState("claude", "session-one").data;
  snapshot.turnStartedAt = "2026-09-18T00:00:00Z";
  expect(formatTurnDuration(snapshot, Date.parse("2026-09-18T00:01:05Z"))).toBe("1分 5秒");
  snapshot.turnEndedAt = "2026-09-18T00:00:20Z";
  expect(formatTurnDuration(snapshot, Date.parse("2026-09-18T04:00:00Z"))).toBe("0分 20秒");
  expect(formatTurnDuration(null, Date.now())).toBe("—");
});

it("shows unavailable or future event times without negative ages", () => {
  expect(formatEventAge(null, Date.now())).toBe("尚無事件");
  expect(formatEventAge("invalid", Date.now())).toBe("尚無事件");
  expect(formatEventAge("2026-09-18T00:00:00Z", Date.parse("2026-09-17T00:00:00Z"))).toBe("0秒前");
});
