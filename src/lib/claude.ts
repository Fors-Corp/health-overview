/**
 * The only module that talks to the Anthropic API (src/lib/claude-owner.test.ts fails
 * the build otherwise). Every call goes through runClaude, which:
 *
 *   1. serves a stored result when this exact request has been answered before;
 *   2. counts the request's input tokens (free) and refuses one over the feature's cap;
 *   3. reserves the call's worst-case cost in the ai_calls ledger, under an advisory
 *      lock, refusing past the monthly budget or the feature's daily cap;
 *   4. makes ONE attempt with an explicit timeout — no SDK retries multiplying spend;
 *   5. replaces the reservation with the billed cost, or keeps the worst case when the
 *      outcome is unknown.
 *
 * Any ledger failure refuses the call: no record, no spend.
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { aiCache, aiCalls, db, type Db } from "@/lib/db";
import {
  MONTHLY_BUDGET_MICRO_USD,
  admit,
  type Admission,
  billedTokens,
  costMicroUsd,
  featurePolicy,
  maxPrice,
  priceFor,
  reservedInputTokens,
  worstCaseMicroUsd,
  type Feature,
  type FeaturePolicy,
} from "@/lib/spend";

export { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

/** Any fixed key works; every reservation just has to take the same one. */
const SPEND_LOCK_KEY = 7_316_221;
const COUNT_TIMEOUT_MS = 15_000;

/**
 * What a caller may send: only fields the token-count endpoint also takes, so every call
 * is priced on exactly what it sends. The model and output limit come from the policy.
 */
export type ClaudeParams = Pick<MessageCreateParamsNonStreaming, "system" | "messages" | "output_config">;

export type ClaudeOutcome<T> =
  | { status: "ok"; value: T; cached: boolean }
  | { status: "refused" }
  | {
      status: "unavailable";
      reason: "no_api_key" | "budget" | "rate_limited" | "too_large" | "error";
    };

/** The last text block: after a fallback, earlier blocks belong to the declined model. */
export function lastText(message: { content: readonly { type: string }[] }): string | undefined {
  const blocks = message.content.filter(
    (b): b is { type: "text"; text: string } => b.type === "text",
  );
  return blocks.at(-1)?.text;
}

/** Malformed JSON becomes undefined, which the caller's schema then rejects. */
export function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function fingerprint(parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

const errorName = (error: unknown) =>
  error instanceof Anthropic.APIError
    ? `${error.status ?? "no-status"} ${error.name}`
    : error instanceof Error
      ? error.name
      : "unknown";

const thisMonth = sql`date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`;

/** Billed cost where known; the reserved worst case for anything pending or unknown. */
const spentExpr = sql<number>`coalesce(sum(case ${aiCalls.status}
  when 'settled' then ${aiCalls.costMicroUsd}
  when 'failed' then 0
  else ${aiCalls.reservedMicroUsd} end), 0)`.mapWith(Number);

export async function spentThisMonthMicroUsd(database: Db = db): Promise<number> {
  const [row] = await database
    .select({ spent: spentExpr })
    .from(aiCalls)
    .where(gte(aiCalls.createdAt, thisMonth));
  return row?.spent ?? 0;
}

async function decide(
  database: Pick<Db, "select">,
  feature: Feature,
  policy: FeaturePolicy,
  reserveMicroUsd: number,
): Promise<Admission> {
  const [{ spent }] = await database
    .select({ spent: spentExpr })
    .from(aiCalls)
    .where(gte(aiCalls.createdAt, thisMonth));
  const [{ calls }] = await database
    .select({ calls: count() })
    .from(aiCalls)
    .where(
      and(eq(aiCalls.feature, feature), gte(aiCalls.createdAt, sql`now() - interval '24 hours'`)),
    );
  return admit({
    spentMicroUsd: spent,
    reserveMicroUsd,
    budgetMicroUsd: MONTHLY_BUDGET_MICRO_USD,
    callsLast24h: calls,
    maxCallsPerDay: policy.maxCallsPerDay,
  });
}

/**
 * Admits a call and books its worst case in one transaction. The advisory lock
 * serialises admissions across every connection and instance, so concurrent requests
 * cannot each see the same remaining budget and overspend it together.
 */
export async function reserveCall(
  database: Db,
  feature: Feature,
  policy: FeaturePolicy,
  reserveMicroUsd: number,
): Promise<{ id: number } | "budget" | "rate_limited"> {
  // Read committed, whatever the database default: under repeatable read the snapshot
  // is taken before the lock is granted, and would miss the previous holder's booking.
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SPEND_LOCK_KEY})`);
    const decision = await decide(tx, feature, policy, reserveMicroUsd);
    if (decision !== "ok") return decision;

    const p = priceFor(policy.model);
    const [row] = await tx
      .insert(aiCalls)
      .values({
        feature,
        model: policy.model,
        status: "pending",
        reservedMicroUsd: reserveMicroUsd,
        inputCentsPerMTok: p.inputCentsPerMTok,
        outputCentsPerMTok: p.outputCentsPerMTok,
      })
      .returning({ id: aiCalls.id });
    return { id: row.id };
  }, { isolationLevel: "read committed" });
}

async function settleBilled(id: number, policy: FeaturePolicy, message: Message) {
  const p = maxPrice(priceFor(policy.model), priceFor(message.model));
  const tokens = billedTokens(message.usage);
  await db
    .update(aiCalls)
    .set({
      status: "settled",
      costMicroUsd: costMicroUsd(tokens, p),
      servedModel: message.model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheCreationTokens: tokens.cacheCreation,
      cacheReadTokens: tokens.cacheRead,
      inputCentsPerMTok: p.inputCentsPerMTok,
      outputCentsPerMTok: p.outputCentsPerMTok,
    })
    .where(eq(aiCalls.id, id));
}

export async function runClaude<T>(
  feature: Feature,
  options: {
    params: ClaudeParams;
    /** Turns a response into the value, or null when it is unusable. */
    read: (message: Message) => T | null;
  },
): Promise<ClaudeOutcome<T>> {
  if (!process.env.ANTHROPIC_API_KEY) return { status: "unavailable", reason: "no_api_key" };

  const policy = featurePolicy(feature);
  const { params } = options;
  // The whole request is the key: the same request never pays twice, and a changed
  // prompt or output schema never serves an answer shaped for the old one.
  const key = fingerprint([feature, policy.model, String(policy.maxTokens), JSON.stringify(params)]);

  try {
    const [hit] = await db
      .select({ value: aiCache.value })
      .from(aiCache)
      .where(and(eq(aiCache.feature, feature), eq(aiCache.key, key)))
      .limit(1);
    if (hit) return { status: "ok", value: hit.value as T, cached: true };

    // Unlocked and against the smallest possible reservation, so it can only turn away
    // what the booking below would refuse anyway — before a capped feature or a spent
    // month pays for uploading the request again to have it counted.
    const early = await decide(db, feature, policy, worstCaseMicroUsd(policy, 0));
    if (early !== "ok") return { status: "unavailable", reason: early };
  } catch (error) {
    console.error(`[claude:${feature}] spend ledger unavailable, call refused:`, errorName(error));
    return { status: "unavailable", reason: "error" };
  }

  const client = new Anthropic({ maxRetries: 0, timeout: policy.timeoutMs });

  // Counting is free and measures exactly what create() will send. No file size bounds a
  // PDF's text layer, so nothing cheaper bounds what a document costs.
  let inputTokens: number;
  try {
    const counted = await client.messages.countTokens(
      { ...params, model: policy.model },
      { timeout: COUNT_TIMEOUT_MS },
    );
    inputTokens = counted.input_tokens;
  } catch (error) {
    console.error(`[claude:${feature}] token count failed, call refused:`, errorName(error));
    return { status: "unavailable", reason: "error" };
  }
  if (inputTokens > policy.maxInputTokens) {
    console.error(
      `[claude:${feature}] ${inputTokens} input tokens exceed the ${policy.maxInputTokens} cap, call refused`,
    );
    return { status: "unavailable", reason: "too_large" };
  }

  let reservation: Awaited<ReturnType<typeof reserveCall>>;
  try {
    reservation = await reserveCall(
      db,
      feature,
      policy,
      worstCaseMicroUsd(policy, reservedInputTokens(inputTokens)),
    );
  } catch (error) {
    console.error(`[claude:${feature}] spend ledger unavailable, call refused:`, errorName(error));
    return { status: "unavailable", reason: "error" };
  }
  if (reservation === "budget" || reservation === "rate_limited") {
    return { status: "unavailable", reason: reservation };
  }

  let message: Message;
  try {
    // The policy's limits go last, so nothing in params can raise what was reserved.
    message = await client.messages.create({
      ...params,
      model: policy.model,
      max_tokens: policy.maxTokens,
    });
  } catch (error) {
    // A 4xx is rejected before generation and is not billed. Anything else — a 5xx, a
    // timeout, a dropped connection — may have been, so the worst case stays booked.
    const rejected =
      error instanceof Anthropic.APIError &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500;
    await db
      .update(aiCalls)
      .set(rejected ? { status: "failed", costMicroUsd: 0 } : { status: "unknown" })
      .where(eq(aiCalls.id, reservation.id))
      .catch((e) => console.error(`[claude:${feature}] could not record failure:`, errorName(e)));
    console.error(`[claude:${feature}] request failed:`, errorName(error));
    return { status: "unavailable", reason: "error" };
  }

  // A pending row still counts its worst case, so a failed write here can only over-count.
  await settleBilled(reservation.id, policy, message).catch((e) =>
    console.error(`[claude:${feature}] could not settle cost:`, errorName(e)),
  );

  if (message.stop_reason === "refusal") return { status: "refused" };

  let value: T | null = null;
  if (message.stop_reason === "end_turn") {
    try {
      value = options.read(message);
    } catch {
      value = null;
    }
  }
  if (value === null) {
    console.error(`[claude:${feature}] unusable response (stop_reason ${message.stop_reason})`);
    return { status: "unavailable", reason: "error" };
  }

  await db
    .insert(aiCache)
    .values({ feature, key, value })
    .onConflictDoNothing()
    .catch((e) => console.error(`[claude:${feature}] could not cache result:`, errorName(e)));
  return { status: "ok", value, cached: false };
}
