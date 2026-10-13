import { NextResponse } from "next/server";
import { ExtractionUnavailableError, MAX_PDF_PAGES, extractFromFile } from "@/lib/extract";

export const runtime = "nodejs";
export const maxDuration = 120;

const ACCEPTED = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

/** Below Vercel's 4.5 MB request cap, so an oversize file gets this message, not a platform error. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const UNAVAILABLE: Record<ExtractionUnavailableError["reason"], { status: number; error: string }> = {
  no_api_key: {
    status: 503,
    error:
      "Falta la clave ANTHROPIC_API_KEY. Este informe es una imagen (sin capa de texto), así que hace falta la lectura visual para interpretarlo.",
  },
  budget: {
    status: 429,
    error:
      "Se ha alcanzado el presupuesto mensual de IA. La lectura automática vuelve el mes que viene; mientras tanto puedes introducir los datos a mano.",
  },
  rate_limited: {
    status: 429,
    error:
      "Has alcanzado el máximo de lecturas automáticas de hoy. Inténtalo mañana o introduce los datos a mano.",
  },
  too_many_pages: {
    status: 413,
    error: `El PDF tiene más de ${MAX_PDF_PAGES} páginas. Sube solo las páginas del informe.`,
  },
  too_large: {
    status: 413,
    error:
      "El documento tiene demasiado contenido para leerlo automáticamente. Sube solo las páginas del informe o una foto.",
  },
  error: {
    status: 502,
    error: "No se pudo leer el informe. Inténtalo de nuevo o introduce los datos a mano.",
  },
};

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta el fichero." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "El fichero supera 4 MB. Sube una foto más ligera o solo las páginas del informe." },
      { status: 413 },
    );
  }
  if (!ACCEPTED.has(file.type)) {
    return NextResponse.json(
      { error: `Tipo no soportado: ${file.type || "desconocido"}. Usa PDF, JPEG, PNG o WebP.` },
      { status: 415 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await extractFromFile(buffer, file.type);
    return NextResponse.json({
      method: result.method,
      data: result.data,
      filename: file.name,
      sizeBytes: buffer.byteLength,
    });
  } catch (error) {
    // Only messages we authored reach the client. Upstream errors are logged server-side
    // and replaced with a generic message so internals are never exposed.
    if (error instanceof ExtractionUnavailableError) {
      const { status, error: message } = UNAVAILABLE[error.reason];
      return NextResponse.json({ error: message }, { status });
    }
    console.error("[extract] extraction failed:", error instanceof Error ? error.name : error);
    return NextResponse.json({ error: UNAVAILABLE.error.error }, { status: 502 });
  }
}
