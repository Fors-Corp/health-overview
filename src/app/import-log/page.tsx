import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, isDatabaseConfigured, measurements } from "@/lib/db";
import { LogImporter } from "@/components/log-importer";
import { SetupNotice } from "@/components/setup-notice";

export const dynamic = "force-dynamic";

export default async function ImportLogPage() {
  if (!isDatabaseConfigured()) return <SetupNotice />;

  const rows = await db
    .select({ measuredAt: measurements.measuredAt, weightKg: measurements.weightKg })
    .from(measurements)
    .where(eq(measurements.source, "manual_log"));

  // Manual entries are stored at noon Madrid time, so the UTC date is the calendar day.
  const saved: Record<string, number> = {};
  for (const r of rows) {
    if (r.weightKg !== null) saved[r.measuredAt.toISOString().slice(0, 10)] = Number(r.weightKg);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6">
        <Link href="/" className="text-sm text-ink-secondary hover:underline">
          ← Volver
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-ink">Importar registro</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Pega tu registro de peso tal como lo llevas en notas: una línea con el año y debajo una
          línea por pesaje, como «3 de enero 90,4Kg» o «17 di gennaio 89,8 Kg (nota)». Antes de
          guardar verás qué entradas son nuevas, cuáles ya tienes y cuáles parecen estar bajo el
          año equivocado.
        </p>
      </header>
      <LogImporter saved={saved} />
    </div>
  );
}
