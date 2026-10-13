/**
 * Shared setup for the database-backed tests. Import it FIRST: it points the app's
 * lazily-built db client at the throwaway Docker database before any query runs, and
 * swaps in a fake Anthropic network so no request can ever leave the machine.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:54329/health_overview_test";

const host = new URL(TEST_DATABASE_URL).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  throw new Error(`test:db drops and recreates its schema, so it only runs locally, not on ${host}`);
}
process.env.DATABASE_URL = TEST_DATABASE_URL;
// Never a real key: if the fake network were bypassed, the API would answer 401 for free.
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
delete process.env.EXTRACTION_MODEL;
delete process.env.INSIGHTS_MODEL;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A clean schema from src/lib/db/schema.ts, exactly as `npm run db:push` would create it. */
export async function recreateSchema() {
  const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await sql`drop schema if exists public cascade`;
  await sql`create schema public`;
  await sql.end();
  execFileSync("npx", ["drizzle-kit", "push", "--force"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}

export type FakeReply = {
  status?: number;
  networkError?: boolean;
  text?: string;
  stopReason?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

type SentRequest = { url: string; body: { model: string; max_tokens: number } & Record<string, unknown> };

/** Every billable request that reached the (fake) Anthropic API, in order. */
export const sent: SentRequest[] = [];
/** Every token-count request, kept apart because counting is free. */
export const counted: SentRequest[] = [];
let reply: ((request: SentRequest) => FakeReply) | null = null;
let tokenCount: number | { status: number } = 1000;

/** Sets how the fake API answers, counts 1000 input tokens, and forgets earlier requests. */
export function anthropicAnswers(handler: (request: SentRequest) => FakeReply) {
  reply = handler;
  tokenCount = 1000;
  sent.length = 0;
  counted.length = 0;
}

/** Sets what the token-count endpoint answers, until the next anthropicAnswers(). */
export function countTokensAnswers(answer: number | { status: number }) {
  tokenCount = answer;
}

const realFetch = globalThis.fetch;
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_test" },
  });

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (!request.url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);

  const sentRequest = { url: request.url, body: JSON.parse(await request.text()) };
  if (new URL(request.url).pathname === "/v1/messages/count_tokens") {
    counted.push(sentRequest);
    return typeof tokenCount === "number"
      ? json({ input_tokens: tokenCount }, 200)
      : json({ type: "error", error: { type: "api_error", message: "fake failure" } }, tokenCount.status);
  }
  sent.push(sentRequest);
  if (!reply) throw new Error("unexpected request to the Anthropic API");
  const r = reply(sentRequest);

  if (r.networkError) throw new TypeError("fetch failed");
  if (r.status && r.status >= 400) {
    return json({ type: "error", error: { type: "api_error", message: "fake failure" } }, r.status);
  }
  return json(
    {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: r.model ?? sentRequest.body.model,
      content: [{ type: "text", text: r.text ?? "" }],
      stop_reason: r.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...r.usage,
      },
    },
    200,
  );
};
