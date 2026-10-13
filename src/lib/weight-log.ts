/**
 * Parses a weight log kept as free text in a notes app:
 *
 *   2026
 *   3 de enero 90,4Kg
 *   17 di gennaio 89,8 Kg (nota libre)
 *
 * A bare four-digit line sets the year for the lines below it. Months may be in Spanish,
 * Italian or English, with "de"/"di" or nothing before them, and decimals may use a comma.
 * Pure and dependency-free so it runs in the browser and under `node --test`; it returns
 * codes, never copy — the page owns the wording.
 */

export type LogEntry = {
  /** 1-based line number in the pasted text. */
  line: number;
  /** YYYY-MM-DD, exactly as written. */
  date: string;
  weightKg: number;
  note: string | null;
  /** Breaks the log's date order — usually filed under the wrong year heading. */
  outOfOrder: boolean;
  /** The same day one year later, when that fits between its neighbours and is not future. */
  suggestedDate: string | null;
  /** A later line in the log has the same date, so that line is the one to keep. */
  superseded: boolean;
};

export type LogIssue = {
  line: number;
  text: string;
  code: "no_year" | "unknown_month" | "invalid_date" | "future_date" | "out_of_range" | "unparsed";
};

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  gennaio: 1, febbraio: 2, aprile: 4, maggio: 5, giugno: 6, luglio: 7,
  settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  // A mixed spelling that turns up in real logs.
  septembre: 9,
};

// Mirrors the bounds POST /api/measurements/manual enforces.
const MIN_KG = 20;
const MAX_KG = 400;

const YEAR_LINE = /^(\d{4}):?$/;
const ENTRY_LINE = /^(\d{1,2})\s+(?:(?:de|di|del|of)\s+)?(\p{L}+)\s+(\d{1,3}(?:[.,]\d+)?)\s*kg\b(.*)$/iu;

function isoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

function nextYear(date: string): string | null {
  const [y, m, d] = date.split("-").map(Number);
  return isoDate(y + 1, m, d);
}

function parseNote(rest: string): string | null {
  const trimmed = rest.trim();
  // Only a single wrapping group is unwrapped: "(a) y (b)" stays as written.
  const inner = /^\(([^()]*)\)$/.exec(trimmed)?.[1] ?? trimmed;
  return inner.trim() || null;
}

/**
 * A log is written in date order, so the entries that break it are the ones to question.
 * Keeping the longest run already in order — rather than flagging everything below the
 * latest date seen — means one mistyped date is flagged on its own instead of taking
 * every later entry with it. Between equally long runs the earlier lines are trusted: a
 * log grows at the bottom, so the newest lines are the likeliest to sit under the wrong
 * year heading.
 */
function flagOutOfOrder(entries: LogEntry[], today: string) {
  const n = entries.length;
  const runLength = new Array<number>(n).fill(1);
  const previous = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (entries[j].date <= entries[i].date && runLength[j] + 1 > runLength[i]) {
        runLength[i] = runLength[j] + 1;
        previous[i] = j;
      }
    }
  }

  const inOrder = new Set<number>();
  for (let i = runLength.indexOf(Math.max(...runLength)); i !== -1; i = previous[i]) {
    inOrder.add(i);
  }

  let before: string | null = null;
  for (let i = 0; i < n; i++) {
    const entry = entries[i];
    if (inOrder.has(i)) {
      before = entry.date;
      continue;
    }
    entry.outOfOrder = true;

    let after: string | null = null;
    for (let k = i + 1; k < n && after === null; k++) {
      if (inOrder.has(k)) after = entries[k].date;
    }
    const shifted = nextYear(entry.date);
    if (
      shifted !== null &&
      shifted <= today &&
      (before === null || shifted >= before) &&
      (after === null || shifted <= after)
    ) {
      entry.suggestedDate = shifted;
    }
  }
}

/** `today` is YYYY-MM-DD; no suggestion ever lands after it. */
export function parseWeightLog(
  text: string,
  today: string,
): { entries: LogEntry[]; issues: LogIssue[] } {
  const entries: LogEntry[] = [];
  const issues: LogIssue[] = [];
  let year: number | null = null;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const content = raw.trim();
    // Titles and blank lines carry no digits; anything with a digit is meant as data.
    if (!/\d/.test(content)) return;

    const yearMatch = YEAR_LINE.exec(content);
    if (yearMatch) {
      year = Number(yearMatch[1]);
      return;
    }

    const m = ENTRY_LINE.exec(content);
    if (!m) return issues.push({ line, text: content, code: "unparsed" });
    if (year === null) return issues.push({ line, text: content, code: "no_year" });

    const monthName = m[2].toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    const month = MONTHS[monthName];
    if (month === undefined) return issues.push({ line, text: content, code: "unknown_month" });

    const date = isoDate(year, month, Number(m[1]));
    if (date === null) return issues.push({ line, text: content, code: "invalid_date" });
    if (date > today) return issues.push({ line, text: content, code: "future_date" });

    const weightKg = Number(m[3].replace(",", "."));
    if (weightKg < MIN_KG || weightKg > MAX_KG) {
      return issues.push({ line, text: content, code: "out_of_range" });
    }

    entries.push({
      line,
      date,
      weightKg,
      note: parseNote(m[4]),
      outOfOrder: false,
      suggestedDate: null,
      superseded: false,
    });
  });

  flagOutOfOrder(entries, today);

  const seenBelow = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    entries[i].superseded = seenBelow.has(entries[i].date);
    seenBelow.add(entries[i].date);
  }

  return { entries, issues };
}
