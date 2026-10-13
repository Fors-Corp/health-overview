import { asc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  lastText,
  parseJson,
  runClaude,
  spentThisMonthMicroUsd,
  zodOutputFormat,
  type ClaudeOutcome,
} from "@/lib/claude";
import { db, measurements } from "@/lib/db";
import { MONTHLY_BUDGET_MICRO_USD } from "@/lib/spend";
import {
  rapidSwings,
  summarise,
  toDailySeries,
  trendRateKgPerWeek,
  weightPhases,
  type DailyPoint,
  type Reading,
} from "@/lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Above the slowest policy: a 15 s token count plus the recommendations' 120 s timeout.
export const maxDuration = 150;

const DAY_MS = 86_400_000;

const n = (v: string | null) => (v === null ? null : Number(v));

const round1 = (v: number | null): number | null => (v === null ? null : Number(v.toFixed(1)));

/**
 * Fat mass in kg. The device's own figure wins when it printed one; otherwise it's
 * derived from weight × body-fat % — the same rule src/app/page.tsx uses for the charts.
 */
function fatMassKg(p: DailyPoint): number | null {
  if (p.bodyFatMassKg !== null) return p.bodyFatMassKg;
  if (p.weightKg !== null && p.bodyFatPct !== null) {
    return Number(((p.weightKg * p.bodyFatPct) / 100).toFixed(2));
  }
  return null;
}

function leanMassKg(p: DailyPoint): number | null {
  const fat = fatMassKg(p);
  if (p.weightKg === null || fat === null) return null;
  return Number((p.weightKg - fat).toFixed(2));
}

function longestGapDays(points: DailyPoint[]): number | null {
  const withWeight = points.filter((p) => p.weightKg !== null);
  if (withWeight.length < 2) return null;
  let longest = 0;
  for (let i = 1; i < withWeight.length; i++) {
    const gap = Math.round((withWeight[i].t - withWeight[i - 1].t) / DAY_MS);
    if (gap > longest) longest = gap;
  }
  return longest;
}

export type InsightsStats = {
  currentWeightKg: number | null;
  currentWeightDate: string | null;

  rateKgPerWeek90d: number | null;
  rateKgPerWeek30d: number | null;

  isPlateau: boolean;

  changeFromPeakKg: number | null;
  peakWeightKg: number | null;
  peakDate: string | null;

  changeFromLowKg: number | null;
  lowWeightKg: number | null;
  lowDate: string | null;

  bodyFat: {
    latestPct: number | null;
    latestDate: string | null;
    changeSincePreviousScanPct: number | null;
    changeSinceFirstScanPct: number | null;
    firstScanDate: string | null;
  };

  leanMass: {
    nowKg: number | null;
    atFirstScanKg: number | null;
    changeKg: number | null;
  };

  recentRapidSwings: { fromDate: string; toDate: string; deltaKg: number; days: number }[];

  /** Oldest first; the last one is the phase in progress. */
  phases: {
    direction: "loss" | "gain";
    startDate: string;
    startKg: number;
    endDate: string;
    endKg: number;
    deltaKg: number;
    days: number;
    rateKgPerWeek: number | null;
    ongoing: boolean;
  }[];

  longestGapDays: number | null;
  daysSinceLastReading: number | null;

  totalReadings: number;
};

type NarrativeUnavailable = "no_api_key" | "budget" | "rate_limited" | "error" | null;

export type InsightsResponse = {
  stats: InsightsStats;
  narrative: string | null;
  narrativeUnavailable: NarrativeUnavailable;
  /** This calendar month's Claude spend against the budget; null if the ledger is unreadable. */
  spend: { spentMicroUsd: number; budgetMicroUsd: number } | null;
};

/** Step 1 — everything here is arithmetic over src/lib/stats.ts output. No LLM involved. */
async function computeStats(): Promise<InsightsStats> {
  const rows = await db.select().from(measurements).orderBy(asc(measurements.measuredAt));

  const readings: Reading[] = rows.map((r) => ({
    measuredAt: r.measuredAt,
    source: r.source,
    weightKg: n(r.weightKg),
    bodyFatPct: n(r.bodyFatPct),
    skeletalMuscleMassKg: n(r.skeletalMuscleMassKg),
    bodyFatMassKg: n(r.bodyFatMassKg),
    fatFreeMassKg: n(r.fatFreeMassKg),
  }));

  const points = toDailySeries(readings);
  const base = summarise(points);
  const scans = points.filter((p) => p.bodyFatPct !== null);

  const { latest, peak, lowest, firstScan, latestScan } = base;
  const previousScan = scans.length >= 2 ? scans[scans.length - 2] : null;

  const daysSinceLastReading = latest ? Math.round((Date.now() - latest.t) / DAY_MS) : null;

  const leanNow = latestScan ? leanMassKg(latestScan) : null;
  const leanFirst = firstScan ? leanMassKg(firstScan) : null;

  return {
    currentWeightKg: latest?.weightKg ?? null,
    currentWeightDate: latest?.day ?? null,

    rateKgPerWeek90d: trendRateKgPerWeek(points, 90),
    rateKgPerWeek30d: trendRateKgPerWeek(points, 30),

    isPlateau: base.plateau,

    changeFromPeakKg: latest && peak ? round1(latest.weightKg! - peak.weightKg!) : null,
    peakWeightKg: peak?.weightKg ?? null,
    peakDate: peak?.day ?? null,

    changeFromLowKg: latest && lowest ? round1(latest.weightKg! - lowest.weightKg!) : null,
    lowWeightKg: lowest?.weightKg ?? null,
    lowDate: lowest?.day ?? null,

    bodyFat: {
      latestPct: latestScan?.bodyFatPct ?? null,
      latestDate: latestScan?.day ?? null,
      changeSincePreviousScanPct:
        latestScan && previousScan
          ? round1(latestScan.bodyFatPct! - previousScan.bodyFatPct!)
          : null,
      changeSinceFirstScanPct:
        latestScan && firstScan ? round1(latestScan.bodyFatPct! - firstScan.bodyFatPct!) : null,
      firstScanDate: firstScan?.day ?? null,
    },

    leanMass: {
      nowKg: leanNow,
      atFirstScanKg: leanFirst,
      changeKg: leanNow !== null && leanFirst !== null ? round1(leanNow - leanFirst) : null,
    },

    recentRapidSwings: rapidSwings(points)
      .slice(-3)
      .map((s) => ({
        fromDate: s.from.day,
        toDate: s.to.day,
        deltaKg: s.deltaKg,
        days: s.days,
      })),

    phases: weightPhases(points).map((p) => ({
      direction: p.direction,
      startDate: p.start.day,
      startKg: p.start.weightKg!,
      endDate: p.end.day,
      endKg: p.end.weightKg!,
      deltaKg: p.deltaKg,
      days: p.days,
      rateKgPerWeek: p.rateKgPerWeek,
      ongoing: p.ongoing,
    })),

    longestGapDays: longestGapDays(points),
    daysSinceLastReading,

    totalReadings: base.totalReadings,
  };
}

const NARRATIVE_SYSTEM = `Eres un asistente que interpreta en voz alta, en español, los datos ya calculados del seguimiento de composición corporal de un usuario.

Reglas estrictas:
- Dirígete al usuario en segunda persona ("has bajado...", "tu ritmo...", "llevas...").
- Interpreta tendencias (ritmo de cambio, mesetas, rachas rápidas) en español sencillo y directo.
- Un cambio rápido de peso en pocos días (definido como tal en los datos) es agua o glucógeno, nunca grasa ganada o perdida — dilo explícitamente si aparece alguno.
- NUNCA des consejo médico, NUNCA diagnostiques nada, NUNCA prescribas dietas, déficits o objetivos calóricos. No sugieras qué debería hacer el usuario a continuación.
- No inventes cifras: usa únicamente los números que se te proporcionan.
- Máximo ~120 palabras. Sin listas, un párrafo corrido, tono cercano pero neutro.`;

/**
 * Step 2 (optional) — short Spanish narrative over the numbers computed in Step 1.
 * Only the computed stats are sent, never the raw measurement rows. The result is
 * cached per exact stats, so reloading the dashboard never pays for it twice.
 */
async function generateNarrative(stats: InsightsStats) {
  const content = `Estas son las cifras ya calculadas a partir de mi historial de peso y composición corporal. Escribe la interpretación siguiendo tus reglas:\n\n${JSON.stringify(stats, null, 2)}`;
  return runClaude("narrative", {
    params: {
      system: NARRATIVE_SYSTEM,
      output_config: { effort: "low" },
      messages: [{ role: "user", content }],
    },
    read: (message) => lastText(message)?.trim() || null,
  });
}

type Unavailable = Extract<ClaudeOutcome<unknown>, { status: "unavailable" }>["reason"];

/** The stats are built here, not uploaded: a request over the size cap is our own error. */
const shownReason = (reason: Unavailable) => (reason === "too_large" ? "error" : reason);

/** Shown in the panel; null when the ledger cannot be read. */
async function spendSummary(): Promise<InsightsResponse["spend"]> {
  try {
    return {
      spentMicroUsd: await spentThisMonthMicroUsd(),
      budgetMicroUsd: MONTHLY_BUDGET_MICRO_USD,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  // Step 1 is the product: it must always succeed and always return 200.
  const stats = await computeStats();

  // Step 2 is a bonus: runClaude reports every failure as an outcome, never a throw.
  const outcome = await generateNarrative(stats);
  return NextResponse.json<InsightsResponse>({
    stats,
    narrative: outcome.status === "ok" ? outcome.value : null,
    narrativeUnavailable:
      outcome.status === "ok"
        ? null
        : outcome.status === "refused"
          ? "error"
          : shownReason(outcome.reason),
    spend: await spendSummary(),
  });
}

const RecommendationsSchema = z.object({
  recommendations: z.array(
    z.object({
      topic: z.enum(["medicion", "tendencia", "mantenimiento", "profesional"]),
      title: z.string(),
      detail: z.string(),
      basis: z.string(),
    }),
  ),
});

export type Recommendation = z.infer<typeof RecommendationsSchema>["recommendations"][number];

export type RecommendationsResponse =
  | { status: "ok"; recommendations: Recommendation[]; cached: boolean }
  | { status: "refused" }
  | { status: "unavailable"; reason: "no_api_key" | "budget" | "rate_limited" | "error" };

const RECOMMENDATIONS_SYSTEM = `Propones recomendaciones prácticas, en español, a partir de las cifras ya calculadas del historial de peso y composición corporal de un usuario.

Recibes un JSON con su peso actual, ritmos de cambio, fases de bajada y subida ("phases", de la más antigua a la más reciente; la que tiene "ongoing": true es la fase en curso), escáneres de composición, variaciones rápidas y huecos entre mediciones.

Temas ("topic"):
- "medicion": hábitos de medición — frecuencia, pesarse en las mismas condiciones, cuándo repetir un escáner de composición para ver si un cambio es grasa, músculo o agua.
- "tendencia": cómo leer sus propios datos — la fase en curso comparada con sus fases anteriores (ritmo, duración), qué parte de una variación rápida es agua o glucógeno.
- "mantenimiento": qué muestran sus datos sobre lo que pasa después de cada bajada y qué podría ayudarle a sostener un resultado.
- "profesional": cuándo comentarlo con un profesional sanitario (endocrino, nutricionista o médico de cabecera), por ejemplo ante una subida o bajada rápida y sostenida.

Límites:
- No diagnostiques. No prescribas dietas, déficits, calorías, macronutrientes, suplementos ni medicación, y no fijes un peso objetivo.
- Usa solo las cifras del JSON. En "basis" cita la cifra concreta en la que se apoya la recomendación.
- Segunda persona, tono neutro y amable: sin culpa, sin alarmismo y sin lenguaje de retos o logros.
- De 3 a 5 recomendaciones, de la más a la menos relevante. "title": una frase corta. "detail": de una a tres frases.`;

const UNAVAILABLE_STATUS = { no_api_key: 200, budget: 429, rate_limited: 429, error: 502 } as const;

/**
 * Recommendations cost an Opus call with thinking, so they are generated on request
 * rather than on every dashboard load. As with the narrative, only the computed stats
 * leave the server, and unchanged stats return the stored answer for free.
 */
export async function POST() {
  const stats = await computeStats();
  const content = `Estas son las cifras ya calculadas a partir de mi historial de peso y composición corporal:\n\n${JSON.stringify(stats, null, 2)}`;

  // No server-side fallback: each hop of a fallback chain bills its own input and output,
  // and the chain behind "default" is unpublished, so its worst case could not be booked.
  const outcome = await runClaude("recommendations", {
    params: {
      system: RECOMMENDATIONS_SYSTEM,
      output_config: { effort: "medium", format: zodOutputFormat(RecommendationsSchema) },
      messages: [{ role: "user", content }],
    },
    read: (message) => {
      const parsed = RecommendationsSchema.safeParse(parseJson(lastText(message)));
      return parsed.success && parsed.data.recommendations.length > 0
        ? parsed.data.recommendations
        : null;
    },
  });

  if (outcome.status === "ok") {
    return NextResponse.json<RecommendationsResponse>({
      status: "ok",
      recommendations: outcome.value,
      cached: outcome.cached,
    });
  }
  if (outcome.status === "refused") {
    return NextResponse.json<RecommendationsResponse>({ status: "refused" });
  }
  const reason = shownReason(outcome.reason);
  return NextResponse.json<RecommendationsResponse>(
    { status: "unavailable", reason },
    { status: UNAVAILABLE_STATUS[reason] },
  );
}
