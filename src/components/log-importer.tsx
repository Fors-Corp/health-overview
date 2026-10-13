"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parseWeightLog, type LogEntry, type LogIssue } from "@/lib/weight-log";

const ISSUE_TEXT: Record<LogIssue["code"], string> = {
  no_year: "Falta el año: añade encima una línea solo con el año, por ejemplo 2026.",
  unknown_month: "No reconozco el mes.",
  invalid_date: "Esa fecha no existe en el calendario.",
  future_date: "La fecha es posterior a hoy.",
  out_of_range: "El peso debe estar entre 20 y 400 kg.",
  unparsed: "No entiendo esta línea.",
};

type SaveResult = { kind: "saved" } | { kind: "duplicate" } | { kind: "error"; message: string };
type Row = { entry: LogEntry; date: string; include: boolean; result?: SaveResult };
type SavedStatus = { kind: "new" } | { kind: "saved" } | { kind: "differs"; kg: number };

// The same calendar the manual-entry route validates against; en-CA formats as YYYY-MM-DD.
const todayInMadrid = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());

function fmtDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function savedStatus(date: string, weightKg: number, saved: Record<string, number>): SavedStatus {
  const kg = saved[date];
  if (kg === undefined) return { kind: "new" };
  return Math.abs(kg - weightKg) < 0.005 ? { kind: "saved" } : { kind: "differs", kg };
}

function statusLabel(result: SaveResult | undefined, status: SavedStatus): string {
  if (result?.kind === "saved") return "Guardada";
  if (result?.kind === "duplicate") return "Ya existía";
  if (result?.kind === "error") return `No guardada: ${result.message}`;
  if (status.kind === "saved") return "Ya guardada";
  if (status.kind === "differs") return `Ese día ya tiene ${status.kg} kg`;
  return "Nueva";
}

async function saveRow(row: Row): Promise<SaveResult> {
  try {
    const res = await fetch("/api/measurements/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: row.date,
        weightKg: row.entry.weightKg,
        note: row.entry.note ?? undefined,
      }),
    });
    if (res.ok) return { kind: "saved" };
    if (res.status === 409) return { kind: "duplicate" };
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      issues?: { message: string }[];
    } | null;
    return {
      kind: "error",
      message: body?.issues?.[0]?.message ?? body?.error ?? `Error ${res.status}`,
    };
  } catch {
    return { kind: "error", message: "Sin conexión con el servidor." };
  }
}

export function LogImporter({ saved }: { saved: Record<string, number> }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [issues, setIssues] = useState<LogIssue[]>([]);
  const [saving, setSaving] = useState(false);

  function review() {
    const parsed = parseWeightLog(text, todayInMadrid());
    setIssues(parsed.issues);
    setRows(
      parsed.entries.map((entry) => ({
        entry,
        date: entry.date,
        include:
          !entry.outOfOrder &&
          !entry.superseded &&
          savedStatus(entry.date, entry.weightKg, saved).kind === "new",
      })),
    );
  }

  function update(line: number, change: Partial<Row>) {
    setRows((current) =>
      current?.map((r) => (r.entry.line === line ? { ...r, ...change } : r)) ?? null,
    );
  }

  async function save() {
    if (!rows) return;
    setSaving(true);
    for (const row of rows.filter((r) => r.include)) {
      const result = await saveRow(row);
      // Only a failed row stays selected: a saved or already-existing one has nothing to retry.
      update(row.entry.line, { result, include: result.kind === "error" });
    }
    setSaving(false);
    router.refresh();
  }

  const selected = rows?.filter((r) => r.include).length ?? 0;
  const newCount =
    rows?.filter((r) => savedStatus(r.date, r.entry.weightKg, saved).kind === "new").length ?? 0;
  const countResults = (kind: SaveResult["kind"]) =>
    rows?.filter((r) => r.result?.kind === kind).length ?? 0;
  const savedNow = countResults("saved");
  const failedNow = countResults("error");
  const existedNow = countResults("duplicate");

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <label htmlFor="weight-log" className="text-sm font-medium text-ink">
          Tu registro
        </label>
        <textarea
          id="weight-log"
          rows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"2026\n3 de enero 90,4Kg\n17 di gennaio 89,8 Kg (nota)"}
          className="w-full rounded-lg border border-hairline bg-surface p-3 font-mono text-sm text-ink"
        />
        <div>
          <button
            type="button"
            onClick={review}
            disabled={text.trim() === "" || saving}
            className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-page transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Revisar
          </button>
        </div>
      </div>

      {rows ? (
        <section aria-label="Revisión" className="grid gap-4">
          <p className="text-sm text-ink-secondary" aria-live="polite">
            {rows.length} entradas leídas · {newCount} nuevas
            {issues.length > 0 ? ` · ${issues.length} líneas sin entender` : ""}
            {savedNow > 0 ? ` · ${savedNow} guardadas` : ""}
            {existedNow > 0 ? ` · ${existedNow} ya existían` : ""}
            {failedNow > 0 ? ` · ${failedNow} sin guardar` : ""}
          </p>

          {issues.length > 0 ? (
            <ul className="grid gap-1 rounded-lg border border-hairline p-3 text-sm">
              {issues.map((issue) => (
                <li key={issue.line} className="text-ink">
                  <span className="text-ink-secondary">Línea {issue.line}:</span>{" "}
                  <span className="font-mono">{issue.text}</span> — {ISSUE_TEXT[issue.code]}
                </li>
              ))}
            </ul>
          ) : null}

          {rows.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-hairline bg-surface p-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline text-left text-xs text-ink-secondary">
                    <th className="py-2 pr-3 font-medium">Guardar</th>
                    <th className="py-2 pr-3 font-medium">Fecha</th>
                    <th className="py-2 pr-3 text-right font-medium">Peso</th>
                    <th className="py-2 pr-3 font-medium">Nota</th>
                    <th className="py-2 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const { entry } = row;
                    const status = savedStatus(row.date, entry.weightKg, saved);
                    const usingSuggestion = row.date !== entry.date;
                    const otherDate = usingSuggestion ? entry.date : entry.suggestedDate;
                    return (
                      <tr
                        key={entry.line}
                        className="border-b border-hairline/60 align-top last:border-0"
                      >
                        <td className="py-2 pr-3">
                          <input
                            type="checkbox"
                            checked={row.include}
                            disabled={saving}
                            onChange={(e) => update(entry.line, { include: e.target.checked })}
                            aria-label={`Guardar la entrada del ${fmtDate(row.date)}`}
                          />
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap text-ink">
                          {fmtDate(row.date)}
                        </td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums text-ink">
                          {entry.weightKg} kg
                        </td>
                        <td className="max-w-[14rem] py-2 pr-3 text-ink-secondary">
                          {entry.note ?? "—"}
                        </td>
                        <td className="py-2 text-ink">
                          {statusLabel(row.result, status)}
                          {entry.superseded ? (
                            <p className="mt-1 text-xs text-ink-secondary">
                              Hay otra línea con este día más abajo; se usa esa.
                            </p>
                          ) : null}
                          {entry.outOfOrder ? (
                            <p className="mt-1 text-xs text-ink-secondary">
                              <span
                                aria-hidden
                                className="mr-1 inline-block size-2 rounded-full"
                                style={{ background: "var(--status-warning)" }}
                              />
                              Va antes que la entrada anterior: puede que esté bajo el año
                              equivocado.
                              {otherDate ? (
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() =>
                                    update(entry.line, {
                                      date: otherDate,
                                      include:
                                        savedStatus(otherDate, entry.weightKg, saved).kind ===
                                        "new",
                                      result: undefined,
                                    })
                                  }
                                  className="ml-1 underline hover:text-ink"
                                >
                                  Usar {fmtDate(otherDate)}
                                </button>
                              ) : null}
                              {usingSuggestion && saved[entry.date] !== undefined
                                ? ` La entrada ya guardada del ${fmtDate(entry.date)} se puede borrar en Mediciones.`
                                : null}
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          <div>
            <button
              type="button"
              onClick={save}
              disabled={selected === 0 || saving}
              className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-page transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving
                ? "Guardando…"
                : `Guardar ${selected} ${selected === 1 ? "entrada" : "entradas"}`}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
