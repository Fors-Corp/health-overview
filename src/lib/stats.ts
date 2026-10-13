export type Reading = {
  measuredAt: Date;
  source: string;
  weightKg: number | null;
  bodyFatPct: number | null;
  skeletalMuscleMassKg: number | null;
  bodyFatMassKg: number | null;
  fatFreeMassKg: number | null;
};

export type DailyPoint = {
  day: string;
  t: number;
  source: string;
  weightKg: number | null;
  bodyFatPct: number | null;
  skeletalMuscleMassKg: number | null;
  bodyFatMassKg: number | null;
  fatFreeMassKg: number | null;
};

const DAY_MS = 86_400_000;

/**
 * Collapses multiple same-day readings into one point.
 *
 * The rule: the most informative reading wins. An InBody scan carries fat and lean
 * mass, so a clinic day beats the home-scale entry for the same date; between two
 * equally sparse readings the later one wins. Weight-only sources never overwrite a
 * scan's composition fields.
 */
export function toDailySeries(readings: Reading[]): DailyPoint[] {
  const byDay = new Map<string, Reading[]>();
  for (const r of readings) {
    const day = r.measuredAt.toISOString().slice(0, 10);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(r);
    else byDay.set(day, [r]);
  }

  const informativeness = (r: Reading) =>
    [r.weightKg, r.bodyFatPct, r.skeletalMuscleMassKg, r.bodyFatMassKg].filter(
      (v) => v !== null,
    ).length;

  return [...byDay.entries()]
    .map(([day, group]) => {
      const winner = group.reduce((best, r) => {
        const d = informativeness(r) - informativeness(best);
        if (d !== 0) return d > 0 ? r : best;
        return r.measuredAt > best.measuredAt ? r : best;
      });
      return {
        day,
        t: new Date(`${day}T12:00:00Z`).getTime(),
        source: winner.source,
        weightKg: winner.weightKg,
        bodyFatPct: winner.bodyFatPct,
        skeletalMuscleMassKg: winner.skeletalMuscleMassKg,
        bodyFatMassKg: winner.bodyFatMassKg,
        fatFreeMassKg: winner.fatFreeMassKg,
      };
    })
    .sort((a, b) => a.t - b.t);
}

/**
 * Time-windowed mean rather than an N-point mean: the series has month-long gaps,
 * and an N-point window would average across them as if they were consecutive days.
 */
export function movingAverage(
  points: DailyPoint[],
  halfWindowDays = 21,
): { t: number; value: number }[] {
  const withWeight = points.filter((p) => p.weightKg !== null);
  const span = halfWindowDays * DAY_MS;
  return withWeight.map((p) => {
    const inWindow = withWeight.filter((q) => Math.abs(q.t - p.t) <= span);
    const mean = inWindow.reduce((s, q) => s + q.weightKg!, 0) / inWindow.length;
    return { t: p.t, value: Number(mean.toFixed(2)) };
  });
}

/** Least-squares slope over the trailing window, expressed as kg/week. */
export function trendRateKgPerWeek(points: DailyPoint[], windowDays = 90): number | null {
  const withWeight = points.filter((p) => p.weightKg !== null);
  if (withWeight.length < 2) return null;
  const cutoff = withWeight[withWeight.length - 1].t - windowDays * DAY_MS;
  const window = withWeight.filter((p) => p.t >= cutoff);
  if (window.length < 2) return null;

  const n = window.length;
  const meanT = window.reduce((s, p) => s + p.t, 0) / n;
  const meanW = window.reduce((s, p) => s + p.weightKg!, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of window) {
    num += (p.t - meanT) * (p.weightKg! - meanW);
    den += (p.t - meanT) ** 2;
  }
  if (den === 0) return null;
  return Number(((num / den) * DAY_MS * 7).toFixed(2));
}

/** Consecutive readings that moved a lot in very little time — water/measurement noise, not fat. */
export function rapidSwings(
  points: DailyPoint[],
  { maxGapDays = 10, minDeltaKg = 2 } = {},
): { from: DailyPoint; to: DailyPoint; deltaKg: number; days: number }[] {
  const withWeight = points.filter((p) => p.weightKg !== null);
  const out = [];
  for (let i = 1; i < withWeight.length; i++) {
    const from = withWeight[i - 1];
    const to = withWeight[i];
    const days = Math.round((to.t - from.t) / DAY_MS);
    const deltaKg = Number((to.weightKg! - from.weightKg!).toFixed(2));
    if (days > 0 && days <= maxGapDays && Math.abs(deltaKg) >= minDeltaKg) {
      out.push({ from, to, deltaKg, days });
    }
  }
  return out;
}

export type WeightPhase = {
  direction: "loss" | "gain";
  start: DailyPoint;
  end: DailyPoint;
  deltaKg: number;
  days: number;
  rateKgPerWeek: number | null;
  /** The last phase: its end is the most extreme reading so far, not a confirmed turn. */
  ongoing: boolean;
};

/**
 * TODO(marc): decide what counts as the weight turning around.
 *
 * Current rule: a move of 5 kg back from the lowest (or highest) point of the phase.
 * Smaller, and a holiday or a week of water retention opens a new phase; larger, and
 * real cycles merge — at 8 kg a rebound, a short dip and a second climb read as one long
 * rise. A fixed kg threshold is also a smaller share of body weight at 120 kg than at
 * 75 kg; a percentage would scale with you instead.
 */
export function phaseReversed(extremeKg: number, currentKg: number): boolean {
  // Rounded to the scale's 10 g, or 64.1 → 59.1 would be 4.9999… kg and not count.
  return Number(Math.abs(currentKg - extremeKg).toFixed(2)) >= 5;
}

function toPhase(
  direction: WeightPhase["direction"],
  start: DailyPoint,
  end: DailyPoint,
  ongoing: boolean,
): WeightPhase {
  const days = Math.round((end.t - start.t) / DAY_MS);
  const deltaKg = Number((end.weightKg! - start.weightKg!).toFixed(2));
  return {
    direction,
    start,
    end,
    deltaKg,
    days,
    rateKgPerWeek: days > 0 ? Number(((deltaKg / days) * 7).toFixed(2)) : null,
    ongoing,
  };
}

/**
 * Splits the history into alternating loss and gain phases — a zig-zag over the raw
 * readings rather than a smoothed curve, because month-long gaps would blur where the
 * turns happened. A phase only ends once the weight has moved back far enough from its
 * extreme (see phaseReversed), so a few days of water never open a new phase. Ties at
 * the extreme resolve to the later reading: the turn is the last day at the low.
 */
export function weightPhases(points: DailyPoint[]): WeightPhase[] {
  const withWeight = points.filter((p) => p.weightKg !== null);
  const phases: WeightPhase[] = [];
  if (withWeight.length < 2) return phases;

  let direction: WeightPhase["direction"] | null = null;
  let high = withWeight[0];
  let low = withWeight[0];
  let start = withWeight[0];
  let extreme = withWeight[0];

  for (const p of withWeight.slice(1)) {
    const kg = p.weightKg!;
    if (direction === null) {
      if (kg >= high.weightKg!) high = p;
      if (kg <= low.weightKg!) low = p;
      if (kg < high.weightKg! && phaseReversed(high.weightKg!, kg)) {
        direction = "loss";
        start = high;
        extreme = p;
      } else if (kg > low.weightKg! && phaseReversed(low.weightKg!, kg)) {
        direction = "gain";
        start = low;
        extreme = p;
      }
      continue;
    }

    const continues = direction === "loss" ? kg <= extreme.weightKg! : kg >= extreme.weightKg!;
    if (continues) {
      extreme = p;
    } else if (phaseReversed(extreme.weightKg!, kg)) {
      phases.push(toPhase(direction, start, extreme, false));
      direction = direction === "loss" ? "gain" : "loss";
      start = extreme;
      extreme = p;
    }
  }

  if (direction !== null) phases.push(toPhase(direction, start, extreme, true));
  return phases;
}

/**
 * TODO(marc): tune this to what a plateau actually means for you.
 *
 * Current placeholder: the trailing `windowDays` stayed inside `bandKg` of their own
 * mean, with at least `minReadings` readings to judge on. The judgement calls are
 * yours — how long is "stuck" (2 weeks? 6?), how tight is "flat" given your scale
 * varies ~0.5 kg day to day, and how many readings you need before trusting it.
 */
export function detectPlateau(
  points: DailyPoint[],
  { windowDays = 28, bandKg = 0.8, minReadings = 4 } = {},
): boolean {
  const withWeight = points.filter((p) => p.weightKg !== null);
  if (withWeight.length < minReadings) return false;
  const cutoff = withWeight[withWeight.length - 1].t - windowDays * DAY_MS;
  const window = withWeight.filter((p) => p.t >= cutoff);
  if (window.length < minReadings) return false;
  const values = window.map((p) => p.weightKg!);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.every((v) => Math.abs(v - mean) <= bandKg);
}

export function summarise(points: DailyPoint[]) {
  const withWeight = points.filter((p) => p.weightKg !== null);
  const latest = withWeight.at(-1) ?? null;
  const peak = withWeight.reduce<DailyPoint | null>(
    (best, p) => (!best || p.weightKg! > best.weightKg! ? p : best),
    null,
  );
  const lowest = withWeight.reduce<DailyPoint | null>(
    (best, p) => (!best || p.weightKg! < best.weightKg! ? p : best),
    null,
  );
  const scans = points.filter((p) => p.bodyFatPct !== null);
  return {
    latest,
    peak,
    lowest,
    latestScan: scans.at(-1) ?? null,
    firstScan: scans.at(0) ?? null,
    rateKgPerWeek: trendRateKgPerWeek(points),
    plateau: detectPlateau(points),
    totalReadings: points.length,
  };
}
