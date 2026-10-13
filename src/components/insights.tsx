"use client";

import { useEffect, useState, type ReactNode } from "react";
import type {
  InsightsResponse,
  Recommendation,
  RecommendationsResponse,
} from "@/app/api/insights/route";

const LONG_GAP_DAYS = 14;

type Tone = "good" | "warning" | "neutral";

function toneColor(tone: Tone): string {
  if (tone === "good") return "var(--status-good)";
  if (tone === "warning") return "var(--status-warning)";
  return "var(--text-primary)";
}

function fmtDate(day: string | null): string {
  if (!day) return "—";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function signed(v: number | null, digits = 1): string {
  if (v === null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

function daysAgoLabel(days: number): string {
  if (days <= 0) return "Hoy";
  if (days === 1) return "Hace 1 día";
  return `Hace ${days} días`;
}

function Tile({
  label,
  value,
  unit,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <p className="text-xs font-medium text-ink-secondary">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums" style={{ color: toneColor(tone) }}>
        {value}
        {unit ? (
          <span className="ml-1 text-sm font-normal text-ink-secondary">{unit}</span>
        ) : null}
      </p>
      {detail ? <p className="mt-1 text-xs text-ink-muted">{detail}</p> : null}
    </div>
  );
}

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1 text-xs font-medium text-ink"
    >
      <span
        aria-hidden
        className="inline-block size-1.5 shrink-0 rounded-full"
        style={{ background: toneColor(tone) }}
      />
      {children}
    </span>
  );
}

function PanelShell({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Análisis"
      className="grid gap-4 rounded-xl border border-hairline bg-surface p-4 sm:p-5"
    >
      {children}
    </section>
  );
}

const TOPIC_LABEL: Record<Recommendation["topic"], string> = {
  medicion: "Medición",
  tendencia: "Tendencia",
  mantenimiento: "Mantenimiento",
  profesional: "Consulta profesional",
};

const RECOMMENDATIONS_UNAVAILABLE: Record<
  Extract<RecommendationsResponse, { status: "unavailable" }>["reason"],
  string
> = {
  no_api_key: "Configura la variable de entorno ANTHROPIC_API_KEY para activar las recomendaciones.",
  budget: "Se ha alcanzado el presupuesto mensual de IA. Las recomendaciones vuelven el mes que viene.",
  rate_limited: "Has alcanzado el máximo de recomendaciones de hoy. Vuelve a intentarlo mañana.",
  error: "No se han podido generar las recomendaciones ahora mismo. Vuelve a intentarlo más tarde.",
};

const usd = (microUsd: number) =>
  (microUsd / 1_000_000).toLocaleString("es-ES", { style: "currency", currency: "USD" });

type RecommendationsState =
  | { name: "idle" }
  | { name: "loading" }
  | { name: "done"; result: RecommendationsResponse };

function RecommendationsBody({ state }: { state: RecommendationsState }) {
  if (state.name === "idle") {
    return (
      <p className="text-sm text-ink-secondary">
        Claude revisa tus fases, ritmos y escáneres y propone de 3 a 5 recomendaciones.
      </p>
    );
  }
  if (state.name === "loading") {
    return <p className="text-sm text-ink-secondary">Analizando tu historial…</p>;
  }

  const { result } = state;
  if (result.status === "refused") {
    return (
      <p className="text-sm text-ink-secondary">
        Claude no ha generado recomendaciones con estos datos.
      </p>
    );
  }
  if (result.status === "unavailable") {
    return <p className="text-sm text-ink-secondary">{RECOMMENDATIONS_UNAVAILABLE[result.reason]}</p>;
  }

  return (
    <>
      {result.cached ? (
        <p className="text-xs text-ink-muted">
          Ya generadas para tus datos actuales; cambiarán cuando añadas mediciones.
        </p>
      ) : null}
      <ul className="grid gap-2">
      {result.recommendations.map((r) => (
        <li key={r.title} className="rounded-lg border border-hairline p-3">
          <p className="text-xs font-medium text-ink-secondary">{TOPIC_LABEL[r.topic]}</p>
          <p className="mt-0.5 text-sm font-medium text-ink">{r.title}</p>
          <p className="mt-1 text-sm leading-relaxed text-ink">{r.detail}</p>
          <p className="mt-1 text-xs text-ink-muted">Basado en: {r.basis}</p>
        </li>
      ))}
      </ul>
    </>
  );
}

function Recommendations() {
  const [state, setState] = useState<RecommendationsState>({ name: "idle" });

  async function generate() {
    setState({ name: "loading" });
    try {
      const res = await fetch("/api/insights", { method: "POST" });
      setState({ name: "done", result: (await res.json()) as RecommendationsResponse });
    } catch {
      setState({ name: "done", result: { status: "unavailable", reason: "error" } });
    }
  }

  // Once shown, the same data would only return the stored answer, so the button goes;
  // it stays for a retry after a failure, which the daily cap still bounds.
  const shown = state.name === "done" && state.result.status === "ok";

  return (
    <div className="grid gap-3 rounded-lg border border-hairline p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">Recomendaciones</h3>
        {shown ? null : (
          <button
            type="button"
            onClick={generate}
            disabled={state.name === "loading"}
            className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-page transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {state.name === "loading"
              ? "Generando…"
              : state.name === "done"
                ? "Reintentar"
                : "Generar recomendaciones"}
          </button>
        )}
      </div>
      <div aria-live="polite">
        <RecommendationsBody state={state} />
      </div>
      <p className="text-xs text-ink-muted">
        Las genera Claude a partir de tus cifras ya calculadas, no de las mediciones en bruto. No
        sustituyen el consejo de un profesional sanitario.
      </p>
    </div>
  );
}

export function InsightsPanel() {
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/insights");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as InsightsResponse;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <PanelShell>
        <h2 className="text-base font-semibold text-ink">Análisis</h2>
        <p className="text-sm text-ink-secondary">Calculando el análisis…</p>
      </PanelShell>
    );
  }

  if (failed || !data) {
    return (
      <PanelShell>
        <h2 className="text-base font-semibold text-ink">Análisis</h2>
        <p className="text-sm text-ink-secondary">
          No se ha podido cargar el análisis ahora mismo. Vuelve a intentarlo más tarde.
        </p>
      </PanelShell>
    );
  }

  const { stats, narrative, narrativeUnavailable } = data;

  const rate = stats.rateKgPerWeek30d ?? stats.rateKgPerWeek90d;
  const rateTone: Tone = rate !== null && rate < 0 ? "good" : "neutral";

  const hasSwings = stats.recentRapidSwings.length > 0;
  const longGap = stats.daysSinceLastReading !== null && stats.daysSinceLastReading > LONG_GAP_DAYS;

  return (
    <PanelShell>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">Análisis</h2>
        <div className="flex flex-wrap gap-2">
          <Badge tone="neutral">{stats.isPlateau ? "En meseta" : "Sin meseta"}</Badge>
          {hasSwings ? <Badge tone="warning">Variación rápida reciente</Badge> : null}
          {longGap ? <Badge tone="warning">Sin mediciones recientes</Badge> : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Ritmo (30 días)"
          value={stats.rateKgPerWeek30d !== null ? signed(stats.rateKgPerWeek30d) : "—"}
          unit="kg/sem"
          detail={
            stats.rateKgPerWeek90d !== null
              ? `${signed(stats.rateKgPerWeek90d)} kg/sem en 90 días`
              : undefined
          }
          tone={rateTone}
        />
        <Tile
          label="Desde el mínimo"
          value={stats.changeFromLowKg !== null ? signed(stats.changeFromLowKg) : "—"}
          unit="kg"
          detail={
            stats.lowWeightKg !== null
              ? `Mínimo ${stats.lowWeightKg.toFixed(1)} kg · ${fmtDate(stats.lowDate)}`
              : undefined
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile
          label="Última medición"
          value={fmtDate(stats.currentWeightDate)}
          detail={
            stats.daysSinceLastReading !== null ? daysAgoLabel(stats.daysSinceLastReading) : undefined
          }
          tone={longGap ? "warning" : "neutral"}
        />
        <Tile
          label="Mayor hueco"
          value={stats.longestGapDays !== null ? String(stats.longestGapDays) : "—"}
          unit="días"
          detail="Entre dos mediciones consecutivas"
        />
      </div>

      {hasSwings ? (
        <div className="rounded-lg border border-hairline p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-secondary">
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ background: "var(--status-warning)" }}
            />
            Variaciones rápidas recientes
          </p>
          <ul className="space-y-1 text-sm text-ink">
            {stats.recentRapidSwings.map((s) => (
              <li key={`${s.fromDate}-${s.toDate}`} className="tabular-nums">
                {signed(s.deltaKg)} kg en {s.days} días ({fmtDate(s.fromDate)} → {fmtDate(s.toDate)})
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-ink-muted">
            A ese ritmo es agua o glucógeno, no grasa ganada ni perdida.
          </p>
        </div>
      ) : null}

      {narrative ? (
        <div className="rounded-lg border border-hairline p-3">
          <p className="text-sm leading-relaxed text-ink">{narrative}</p>
        </div>
      ) : narrativeUnavailable === "no_api_key" ? (
        <p className="text-xs text-ink-muted">
          Configura la variable de entorno ANTHROPIC_API_KEY para activar el resumen escrito. Las
          estadísticas de arriba funcionan igual sin ella.
        </p>
      ) : narrativeUnavailable === "budget" ? (
        <p className="text-xs text-ink-muted">
          Se ha alcanzado el presupuesto mensual de IA. El resumen escrito vuelve el mes que
          viene; las estadísticas de arriba funcionan igual.
        </p>
      ) : narrativeUnavailable === "rate_limited" ? (
        <p className="text-xs text-ink-muted">
          El resumen escrito ya se ha generado muchas veces hoy. Vuelve mañana.
        </p>
      ) : narrativeUnavailable === "error" ? (
        <p className="text-xs text-ink-muted">
          No se ha podido generar el resumen escrito en este momento.
        </p>
      ) : null}

      <Recommendations />

      {data.spend ? (
        <p className="text-xs text-ink-muted">
          Gasto de IA este mes: {usd(data.spend.spentMicroUsd)} de{" "}
          {usd(data.spend.budgetMicroUsd)}. Al llegar al límite, las funciones de IA se pausan
          hasta el mes siguiente.
        </p>
      ) : null}
    </PanelShell>
  );
}
