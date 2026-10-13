/**
 * Spend policy for every Claude call: prices, cost arithmetic and the admit decision.
 * Dependency-free, so it is unit-tested under `node --test` and remains the one place
 * these numbers live. The ledger and the SDK are in src/lib/claude.ts.
 *
 * Money is integer micro-dollars (1e-6 USD): one call costs fractions of a cent, and
 * integer cents would round most calls to zero.
 */

/** Hard ceiling on the app's own Claude spend per calendar month (UTC). Set by Marc, 2026-10-13. */
export const MONTHLY_BUDGET_MICRO_USD = 5_000_000;

export type Feature = "narrative" | "recommendations" | "extraction";

export type FeaturePolicy = {
  model: string;
  maxTokens: number;
  /** A larger request is refused, so one oversized upload cannot use up the month. */
  maxInputTokens: number;
  timeoutMs: number;
  /** Calls in any rolling 24 hours, whatever their outcome. */
  maxCallsPerDay: number;
};

export function featurePolicy(
  feature: Feature,
  env: Readonly<Record<string, string | undefined>> = process.env,
): FeaturePolicy {
  switch (feature) {
    case "narrative":
      return {
        model: env.INSIGHTS_MODEL || "claude-sonnet-5",
        maxTokens: 2_000,
        maxInputTokens: 30_000,
        timeoutMs: 60_000,
        maxCallsPerDay: 20,
      };
    case "recommendations":
      return {
        model: "claude-opus-5-5",
        maxTokens: 8_000,
        maxInputTokens: 30_000,
        timeoutMs: 120_000,
        maxCallsPerDay: 10,
      };
    case "extraction":
      // A one- or two-page report is well under 10K input tokens.
      return {
        model: env.EXTRACTION_MODEL || "claude-opus-5",
        maxTokens: 16_000,
        maxInputTokens: 40_000,
        timeoutMs: 100_000,
        maxCallsPerDay: 20,
      };
  }
}

export type Price = { inputCentsPerMTok: number; outputCentsPerMTok: number };

const price = (inputCentsPerMTok: number, outputCentsPerMTok: number): Price => ({
  inputCentsPerMTok,
  outputCentsPerMTok,
});

/** Published first-party rates as of 2026-10-06, in integer US cents per million tokens. */
export const PRICES: Readonly<Record<string, Price>> = {
  "claude-fable-5-1": price(1000, 5000),
  "claude-fable-5": price(1000, 5000),
  "claude-opus-5-5": price(400, 2000),
  "claude-opus-5": price(500, 2500),
  "claude-opus-4-8": price(500, 2500),
  "claude-opus-4-7": price(500, 2500),
  "claude-opus-4-6": price(500, 2500),
  "claude-sonnet-5-5": price(200, 1000),
  "claude-sonnet-5": price(200, 1000),
  "claude-sonnet-4-6": price(300, 1500),
  // Haiku 5.5 doubles past 100K-token prompts; the higher tier keeps this an upper bound.
  "claude-haiku-5-5": price(50, 250),
  "claude-haiku-4-5": price(100, 500),
};

export const PRICE_CEILING: Price = price(
  Math.max(...Object.values(PRICES).map((p) => p.inputCentsPerMTok)),
  Math.max(...Object.values(PRICES).map((p) => p.outputCentsPerMTok)),
);

/** A model missing from the table is priced at the ceiling: never under-count. */
export function priceFor(model: string): Price {
  return PRICES[model] ?? PRICE_CEILING;
}

export function maxPrice(a: Price, b: Price): Price {
  return price(
    Math.max(a.inputCentsPerMTok, b.inputCentsPerMTok),
    Math.max(a.outputCentsPerMTok, b.outputCentsPerMTok),
  );
}

export type TokenCounts = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
};

/**
 * Integer micro-dollars, rounded up. Cache writes bill at 1.25× the input rate and cache
 * reads at 0.1×; everything is scaled by 100 first so the multipliers stay integers.
 */
export function costMicroUsd(tokens: TokenCounts, p: Price): number {
  const scaled =
    tokens.input * p.inputCentsPerMTok * 100 +
    tokens.cacheCreation * p.inputCentsPerMTok * 125 +
    tokens.cacheRead * p.inputCentsPerMTok * 10 +
    tokens.output * p.outputCentsPerMTok * 100;
  return Math.ceil(scaled / 10_000);
}

/**
 * Input tokens to reserve for a request the token-count endpoint measured. That count
 * covers everything the API bills (PDF text and page images, the injected output schema)
 * but is documented as an estimate, so admission adds headroom. Output is bounded
 * exactly by max_tokens; input within this headroom, and a call billed above its
 * reservation still counts in full against every later admission.
 */
export function reservedInputTokens(counted: number): number {
  return Math.ceil(counted * 1.1) + 256;
}

/** What a call can cost at most: its reserved input plus every allowed output token. */
export function worstCaseMicroUsd(policy: FeaturePolicy, inputTokens: number): number {
  return costMicroUsd(
    { input: inputTokens, output: policy.maxTokens, cacheCreation: 0, cacheRead: 0 },
    priceFor(policy.model),
  );
}

export type UsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  iterations?: readonly UsageLike[] | null;
};

const countsOf = (u: UsageLike): TokenCounts => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheCreation: u.cache_creation_input_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
});

/**
 * Tokens to bill. A response can span several attempts, listed in `iterations`; taking
 * the larger of the top-level counts and their sum, field by field, never under-counts
 * whichever way the API reports them.
 */
export function billedTokens(usage: UsageLike): TokenCounts {
  const top = countsOf(usage);
  const iterations = usage.iterations ?? [];
  if (iterations.length === 0) return top;
  const sum = iterations.map(countsOf).reduce((a, b) => ({
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
  }));
  return {
    input: Math.max(top.input, sum.input),
    output: Math.max(top.output, sum.output),
    cacheCreation: Math.max(top.cacheCreation, sum.cacheCreation),
    cacheRead: Math.max(top.cacheRead, sum.cacheRead),
  };
}

export type Admission = "ok" | "budget" | "rate_limited";

export function admit(input: {
  spentMicroUsd: number;
  reserveMicroUsd: number;
  budgetMicroUsd: number;
  callsLast24h: number;
  maxCallsPerDay: number;
}): Admission {
  if (input.callsLast24h >= input.maxCallsPerDay) return "rate_limited";
  if (input.spentMicroUsd + input.reserveMicroUsd > input.budgetMicroUsd) return "budget";
  return "ok";
}
