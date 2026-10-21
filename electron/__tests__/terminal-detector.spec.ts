import { expect, it } from "vitest";
import { isAreaCovered } from "../terminal-detector.js";

const mascot = { x: 900, y: 600, width: 120, height: 56 };

it("treats a mascot as covered only by overlapping windows above its terminal", () => {
  const browser = { zOrder: 0, bounds: { x: 0, y: 0, width: 1000, height: 700 } };
  expect(isAreaCovered(mascot, 3, [browser])).toBe(true);
  expect(isAreaCovered(mascot, 0, [{ ...browser, zOrder: 4 }])).toBe(false);
});

it("ignores windows that only touch or miss the mascot area", () => {
  const leftNeighbour = { zOrder: 0, bounds: { x: 0, y: 0, width: 900, height: 800 } };
  const above = { zOrder: 1, bounds: { x: 900, y: 0, width: 300, height: 600 } };
  expect(isAreaCovered(mascot, 5, [leftNeighbour, above])).toBe(false);
  expect(isAreaCovered(mascot, 5, [{ zOrder: 2, bounds: { x: 1019, y: 655, width: 10, height: 10 } }])).toBe(true);
});
