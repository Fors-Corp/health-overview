import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";
import { lastText, parseJson, runClaude, zodOutputFormat } from "@/lib/claude";

/** InBody reports are one or two pages; anything longer is not a report. */
export const MAX_PDF_PAGES = 5;

const Segment = z.object({
  leftArm: z.number().nullable(),
  rightArm: z.number().nullable(),
  trunk: z.number().nullable(),
  leftLeg: z.number().nullable(),
  rightLeg: z.number().nullable(),
});

const HistoryRow = z.object({
  measuredAt: z.string().describe("ISO local datetime of that past test, e.g. 2025-11-05T18:47"),
  weightKg: z.number().nullable(),
  skeletalMuscleMassKg: z.number().nullable(),
  bodyFatPct: z.number().nullable(),
});

export const ExtractionSchema = z.object({
  measuredAt: z
    .string()
    .describe("ISO local datetime of THIS test from the header, e.g. 2026-09-16T12:37"),
  weightKg: z.number().nullable(),
  bodyFatPct: z.number().nullable(),
  skeletalMuscleMassKg: z.number().nullable(),
  bmi: z.number().nullable(),
  bodyFatMassKg: z.number().nullable(),
  fatFreeMassKg: z.number().nullable(),
  totalBodyWaterL: z.number().nullable(),
  proteinKg: z.number().nullable(),
  mineralsKg: z.number().nullable(),
  bmrKcal: z.number().nullable(),
  waistHipRatio: z.number().nullable(),
  visceralFatLevel: z.number().nullable(),
  segmental: z
    .object({
      leanKg: Segment.nullable(),
      leanPct: Segment.nullable(),
      fatKg: Segment.nullable(),
      fatPct: Segment.nullable(),
    })
    .nullable(),
  history: z
    .array(HistoryRow)
    .describe(
      "Every prior test shown in the bottom history chart ('Historial de Composición Corporal'), excluding this test. Empty array if absent.",
    ),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string().nullable().describe("Anything unreadable or ambiguous. Null if all clean."),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

export type ExtractionResult = {
  method: "pdf_text" | "claude_vision";
  data: Extraction;
};

const SYSTEM = `You read body-composition analysis reports (InBody 120/230/270 and similar bioimpedance devices) and return their values as structured data.

Reading rules:
- Reports are usually in Spanish. "Peso" = weight, "Masa Grasa Corporal" = body fat mass, "Masa musculoesquelética" = skeletal muscle mass, "Masa Libre de Grasa" = fat-free mass, "Agua Corporal Total" = total body water, "IMC" = BMI, "Tasa metabólica basal" = BMR, "Relación Cintura-Cadera" = waist-hip ratio, "Nivel de grasa visceral" = visceral fat level.
- Decimals use a COMMA (36,7 means 36.7). Return them as normal JSON numbers.
- Values in parentheses next to a number are the device's normal RANGE, not the measurement. Never return a range value as the measurement.
- The header carries the test date/time (e.g. "16.09.2026. 12:37" is DD.MM.YYYY) — that is measuredAt.
- Segmental panels: "Izquierdo" is the LEFT side, "Derecho" is the RIGHT side. Each segment shows kg, then %, then an evaluation word.
- The chart at the bottom ("Historial de Composición Corporal") lists PREVIOUS tests with their own dates along the x-axis. Extract every one of those into history[]. This is important — it is how earlier scans get recovered.
- Handwritten annotations are a clinician's notes, not measurements. Ignore them for values; mention them in notes.
- If a field is not present or not legible, return null. Never guess or infer a value you cannot read.`;

/**
 * Cheap path: native PDF exports carry a text layer, so the numbers can be read without
 * an API call. Scans and photos have no text layer and fall through to the model.
 * Accepted only when both a date and a weight come out — a half-parsed report is worse
 * than no parse, because it would be silently wrong.
 */
async function tryPdfText(buffer: Buffer): Promise<Extraction | null> {
  let text: string;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });
    text = Array.isArray(result.text) ? result.text.join("\n") : result.text;
  } catch {
    return null;
  }

  if (text.trim().length < 200) return null;

  const num = (re: RegExp): number | null => {
    const m = text.match(re);
    if (!m?.[1]) return null;
    const v = Number(m[1].replace(",", "."));
    return Number.isFinite(v) ? v : null;
  };

  const dateMatch = text.match(/(\d{2})[.\/-](\d{2})[.\/-](\d{4})\.?\s+(\d{1,2}):(\d{2})/);
  const weightKg = num(/Peso\s*\(kg\)\s*([\d.,]+)/i);
  if (!dateMatch || weightKg === null) return null;

  const [, dd, mm, yyyy, hh, mi] = dateMatch;
  return {
    measuredAt: `${yyyy}-${mm}-${dd}T${hh.padStart(2, "0")}:${mi}`,
    weightKg,
    bodyFatPct: num(/Grasa Corporal\s*\(%\)\s*([\d.,]+)/i),
    skeletalMuscleMassKg: num(/musculoesquel[ée]tica\s*\(kg\)\s*([\d.,]+)/i),
    bmi: num(/IMC[^\d]*\(kg\/m2?\)\s*([\d.,]+)/i),
    bodyFatMassKg: num(/Masa Grasa Corporal\s*\(kg\)\s*([\d.,]+)/i),
    fatFreeMassKg: num(/Masa Libre de Grasa\s*([\d.,]+)/i),
    totalBodyWaterL: num(/Agua Corporal Total\s*\(L\)\s*([\d.,]+)/i),
    proteinKg: num(/Prote[íi]nas\s*\(kg\)\s*([\d.,]+)/i),
    mineralsKg: num(/Minerales\s*\(kg\)\s*([\d.,]+)/i),
    bmrKcal: num(/Tasa metab[óo]lica basal\s*([\d.,]+)/i),
    waistHipRatio: num(/Relaci[óo]n Cintura-Cadera\s*([\d.,]+)/i),
    visceralFatLevel: num(/Nivel de grasa visceral\s*([\d.,]+)/i),
    segmental: null,
    history: [],
    confidence: "medium",
    notes:
      "Leído de la capa de texto del PDF; el análisis segmental y el historial no se extraen por esta vía.",
  };
}

/** Why a report could not be read; the route turns the code into a message and a status. */
export class ExtractionUnavailableError extends Error {
  readonly reason:
    | "no_api_key"
    | "budget"
    | "rate_limited"
    | "too_many_pages"
    | "too_large"
    | "error";

  constructor(reason: ExtractionUnavailableError["reason"]) {
    super(`extraction unavailable: ${reason}`);
    this.name = "ExtractionUnavailableError";
    this.reason = reason;
  }
}

const PROMPT =
  "Extract every value from this body-composition report, including all prior tests shown in the history chart at the bottom.";

async function pdfPageCount(buffer: Buffer): Promise<number | null> {
  try {
    return (await getDocumentProxy(new Uint8Array(buffer))).numPages;
  } catch {
    return null;
  }
}

async function extractWithClaude(buffer: Buffer, contentType: string): Promise<Extraction> {
  const b64 = buffer.toString("base64");

  const source =
    contentType === "application/pdf"
      ? {
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: b64,
          },
        }
      : {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: contentType as "image/jpeg" | "image/png" | "image/webp",
            data: b64,
          },
        };

  // The same file uploaded again is served from the cache instead of read again.
  const outcome = await runClaude("extraction", {
    params: {
      system: SYSTEM,
      messages: [{ role: "user", content: [source, { type: "text", text: PROMPT }] }],
      output_config: { format: zodOutputFormat(ExtractionSchema) },
    },
    read: (message) => {
      const parsed = ExtractionSchema.safeParse(parseJson(lastText(message)));
      return parsed.success ? parsed.data : null;
    },
  });

  if (outcome.status === "ok") return outcome.value;
  throw new ExtractionUnavailableError(outcome.status === "refused" ? "error" : outcome.reason);
}

export async function extractFromFile(
  buffer: Buffer,
  contentType: string,
): Promise<ExtractionResult> {
  if (contentType === "application/pdf") {
    // What a PDF costs is measured before the call; the page cap only turns away
    // documents that are clearly not a report.
    const pages = await pdfPageCount(buffer);
    if (pages !== null && pages > MAX_PDF_PAGES) {
      throw new ExtractionUnavailableError("too_many_pages");
    }
    const local = await tryPdfText(buffer);
    if (local) return { method: "pdf_text", data: local };
  }
  return { method: "claude_vision", data: await extractWithClaude(buffer, contentType) };
}
