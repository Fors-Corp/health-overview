import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWeightLog } from "./weight-log.ts";

// Synthetic logs only — real measurements never enter the repository.
const TODAY = "2030-01-01";
const parse = (...lines: string[]) => parseWeightLog(lines.join("\n"), TODAY);
const flags = (lines: string[], today = TODAY) =>
  parseWeightLog(lines.join("\n"), today).entries.map((e) => [
    e.line,
    e.outOfOrder,
    e.suggestedDate,
  ]);

test("reads year headings, mixed-language months, comma decimals and notes", () => {
  const { entries, issues } = parse(
    "Seguimiento peso",
    "2024",
    "3 Septiembre 90Kg",
    "1 de Octubre 88,5Kg ",
    "",
    "2025",
    "05 di Gennaio 87,25 Kg",
    "9 di febbraio 86kg ( +1,2 kg en 3 días)",
    "12 of March 85.4kg after the trip",
    "20 de Marzo 85Kg (a) y (b)",
  );

  assert.deepEqual(issues, []);
  assert.deepEqual(
    entries.map((e) => [e.line, e.date, e.weightKg, e.note]),
    [
      [3, "2024-09-03", 90, null],
      [4, "2024-10-01", 88.5, null],
      [7, "2025-01-05", 87.25, null],
      [8, "2025-02-09", 86, "+1,2 kg en 3 días"],
      [9, "2025-03-12", 85.4, "after the trip"],
      [10, "2025-03-20", 85, "(a) y (b)"],
    ],
  );
  assert.ok(entries.every((e) => !e.outOfOrder && e.suggestedDate === null && !e.superseded));
});

test("reports lines it cannot use, with their line numbers", () => {
  const { entries, issues } = parse(
    "4 de Mayo 80Kg",
    "2025",
    "3 di Frimaio 80Kg",
    "31 de Febrero 80Kg",
    "5 de Mayo 8Kg",
    "6 de Mayo ochenta",
    "7 de Mayo 80Kg",
  );

  assert.deepEqual(
    issues.map((i) => [i.line, i.code]),
    [
      [1, "no_year"],
      [3, "unknown_month"],
      [4, "invalid_date"],
      [5, "out_of_range"],
      [6, "unparsed"],
    ],
  );
  assert.deepEqual(
    entries.map((e) => e.date),
    ["2025-05-07"],
  );
});

test("flags an entry filed under last year's heading and suggests the next year", () => {
  assert.deepEqual(
    flags(["2023", "2 de Noviembre 70Kg", "8 di Aprile 71Kg", "2024", "20 di giugno 72Kg"]),
    [
      [2, false, null],
      [3, true, "2024-04-08"],
      [5, false, null],
    ],
  );
});

test("an out-of-order entry gets no suggestion when next year does not fit either", () => {
  assert.deepEqual(
    flags(["2023", "2 de Noviembre 70Kg", "8 di Aprile 71Kg", "2024", "1 de Marzo 72Kg"]),
    [
      [2, false, null],
      [3, true, null],
      [5, false, null],
    ],
  );
});

test("one mistyped date is flagged on its own, not every entry after it", () => {
  assert.deepEqual(
    flags([
      "2025",
      "5 de Enero 80Kg",
      "20 de Enero 80Kg",
      "15 de Diciembre 80Kg",
      "25 de Enero 80Kg",
      "3 de Febrero 80Kg",
    ]),
    [
      [2, false, null],
      [3, false, null],
      [4, true, null],
      [5, false, null],
      [6, false, null],
    ],
  );
});

test("reports an entry dated after today instead of reading it", () => {
  const { entries, issues } = parseWeightLog(["2023", "1 de Mayo 80Kg", "2 de Mayo 80Kg"].join("\n"), "2023-05-01");
  assert.deepEqual(entries.map((e) => e.line), [2]);
  assert.deepEqual(issues.map((i) => [i.line, i.code]), [[3, "future_date"]]);
});

test("never suggests a date after today", () => {
  assert.deepEqual(flags(["2023", "2 de Noviembre 70Kg", "8 di Aprile 71Kg"], "2023-12-01"), [
    [2, false, null],
    [3, true, null],
  ]);
});

test("a day written twice keeps the later line and is not out of order", () => {
  const { entries } = parse("2025", "1 de Mayo 80Kg", "1 de Mayo 79,8Kg");
  assert.deepEqual(
    entries.map((e) => [e.line, e.superseded, e.outOfOrder]),
    [
      [2, true, false],
      [3, false, false],
    ],
  );
});
