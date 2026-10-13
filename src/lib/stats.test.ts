import { test } from "node:test";
import assert from "node:assert/strict";
import { weightPhases, type DailyPoint } from "./stats.ts";

// Synthetic readings only — real measurements never enter the repository.
const at = (day: string, weightKg: number | null): DailyPoint => ({
  day,
  t: new Date(`${day}T12:00:00Z`).getTime(),
  source: "manual_log",
  weightKg,
  bodyFatPct: null,
  skeletalMuscleMassKg: null,
  bodyFatMassKg: null,
  fatFreeMassKg: null,
});

const summary = (points: DailyPoint[]) =>
  weightPhases(points).map((p) => [p.direction, p.start.day, p.end.day, p.deltaKg, p.ongoing]);

test("splits a loss and the rebound after it into two phases", () => {
  const points = [
    at("2024-01-01", 100),
    at("2024-02-01", 96),
    at("2024-03-01", 93),
    at("2024-03-11", 90),
    at("2024-05-01", 92),
    at("2024-06-01", 96),
  ];
  assert.deepEqual(summary(points), [
    ["loss", "2024-01-01", "2024-03-11", -10, false],
    ["gain", "2024-03-11", "2024-06-01", 6, true],
  ]);
});

test("reports the rate of a phase in kg per week", () => {
  const [phase] = weightPhases([at("2024-01-01", 100), at("2024-03-11", 90)]);
  assert.equal(phase.days, 70);
  assert.equal(phase.rateKgPerWeek, -1);
});

test("a rebound smaller than the reversal stays inside the phase", () => {
  const points = [
    at("2024-01-01", 100),
    at("2024-01-20", 94),
    at("2024-01-25", 97.5),
    at("2024-02-20", 92),
    at("2024-03-20", 89),
  ];
  assert.deepEqual(summary(points), [["loss", "2024-01-01", "2024-03-20", -11, true]]);
});

test("noise that never moves far enough opens no phase", () => {
  const points = [
    at("2024-01-01", 80),
    at("2024-01-15", 82),
    at("2024-02-01", 79),
    at("2024-02-15", 83),
    at("2024-03-01", 78.5),
  ];
  assert.deepEqual(weightPhases(points), []);
});

test("a tie at the low turns on the last day at that weight", () => {
  const points = [
    at("2024-01-01", 100),
    at("2024-02-01", 90),
    at("2024-03-01", 90),
    at("2024-04-01", 96),
  ];
  assert.deepEqual(summary(points), [
    ["loss", "2024-01-01", "2024-03-01", -10, false],
    ["gain", "2024-03-01", "2024-04-01", 6, true],
  ]);
});

test("the first phase can be a gain, and days without a weight are skipped", () => {
  const points = [
    at("2024-01-01", 70),
    at("2024-01-10", null),
    at("2024-02-01", 68),
    at("2024-04-01", 75),
  ];
  assert.deepEqual(summary(points), [["gain", "2024-02-01", "2024-04-01", 7, true]]);
});

test("a move of exactly the reversal counts despite floating-point error", () => {
  // 64.1 - 59.1 is 4.999999999999993 in binary floating point.
  assert.deepEqual(summary([at("2024-01-01", 64.1), at("2024-02-01", 59.1)]), [
    ["loss", "2024-01-01", "2024-02-01", -5, true],
  ]);
});

test("fewer than two weights give no phases", () => {
  assert.deepEqual(weightPhases([]), []);
  assert.deepEqual(weightPhases([at("2024-01-01", 80), at("2024-01-02", null)]), []);
});
