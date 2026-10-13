import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MONTHLY_BUDGET_MICRO_USD,
  PRICES,
  PRICE_CEILING,
  admit,
  billedTokens,
  costMicroUsd,
  featurePolicy,
  priceFor,
  reservedInputTokens,
  worstCaseMicroUsd,
  type Feature,
} from "./spend.ts";

const tokens = (input: number, output: number, cacheCreation = 0, cacheRead = 0) => ({
  input,
  output,
  cacheCreation,
  cacheRead,
});

test("the budget is $5 a month", () => {
  assert.equal(MONTHLY_BUDGET_MICRO_USD, 5_000_000);
});

test("a listed model is priced from the table", () => {
  assert.deepEqual(priceFor("claude-sonnet-5"), { inputCentsPerMTok: 200, outputCentsPerMTok: 1000 });
});

test("a model missing from the table is priced at the most expensive rate", () => {
  assert.deepEqual(priceFor("claude-unlisted-9"), PRICE_CEILING);
  for (const p of Object.values(PRICES)) {
    assert.ok(p.inputCentsPerMTok <= PRICE_CEILING.inputCentsPerMTok);
    assert.ok(p.outputCentsPerMTok <= PRICE_CEILING.outputCentsPerMTok);
  }
});

test("cost is tokens × rate, in micro-dollars", () => {
  // 1000 × $2/MTok + 200 × $10/MTok = $0.002 + $0.002
  assert.equal(costMicroUsd(tokens(1000, 200), priceFor("claude-sonnet-5")), 4000);
});

test("cache writes cost 1.25× input and cache reads 0.1×", () => {
  const p = priceFor("claude-opus-5-5"); // $4 input
  assert.equal(costMicroUsd(tokens(0, 0, 1000, 0), p), 5000);
  assert.equal(costMicroUsd(tokens(0, 0, 0, 1000), p), 400);
});

test("a fraction of a micro-dollar rounds up, never down to free", () => {
  assert.equal(costMicroUsd(tokens(1, 0), priceFor("claude-haiku-5-5")), 1);
});

test("the reserved input is above the API's token count, which is only an estimate", () => {
  assert.ok(reservedInputTokens(0) > 0);
  for (const counted of [1, 1000, 40_000]) {
    assert.ok(reservedInputTokens(counted) >= counted * 1.1);
  }
});

test("no single call can book more than a fifth of the month", () => {
  for (const feature of ["narrative", "recommendations", "extraction"] satisfies Feature[]) {
    const policy = featurePolicy(feature, {});
    const largest = worstCaseMicroUsd(policy, reservedInputTokens(policy.maxInputTokens));
    assert.ok(largest <= MONTHLY_BUDGET_MICRO_USD / 5, `${feature}: ${largest}`);
  }
});

test("the worst case covers the whole reserved input and every output token", () => {
  const policy = featurePolicy("narrative", {});
  assert.equal(
    worstCaseMicroUsd(policy, 5000),
    costMicroUsd(tokens(5000, policy.maxTokens), priceFor(policy.model)),
  );
});

test("an unlisted model chosen through the environment reserves at the ceiling", () => {
  const policy = featurePolicy("extraction", { EXTRACTION_MODEL: "claude-unlisted-9" });
  assert.equal(policy.model, "claude-unlisted-9");
  assert.equal(worstCaseMicroUsd(policy, 1000), costMicroUsd(tokens(1000, policy.maxTokens), PRICE_CEILING));
});

test("an empty model variable falls back to the default", () => {
  assert.equal(featurePolicy("narrative", { INSIGHTS_MODEL: "" }).model, "claude-sonnet-5");
});

test("billed tokens use the top-level usage when there are no iterations", () => {
  assert.deepEqual(billedTokens({ input_tokens: 10, output_tokens: 5 }), tokens(10, 5));
});

test("billed tokens never under-count a response spread over several attempts", () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 10,
    iterations: [
      { input_tokens: 100, output_tokens: 40 },
      { input_tokens: 100, output_tokens: 50 },
    ],
  };
  assert.deepEqual(billedTokens(usage), tokens(200, 90));
  assert.deepEqual(
    billedTokens({ input_tokens: 500, output_tokens: 500, iterations: [{ input_tokens: 1, output_tokens: 1 }] }),
    tokens(500, 500),
  );
});

const base = {
  spentMicroUsd: 0,
  reserveMicroUsd: 100,
  budgetMicroUsd: 1_000,
  callsLast24h: 0,
  maxCallsPerDay: 10,
};

test("a call that fits the budget and the daily cap is admitted", () => {
  assert.equal(admit(base), "ok");
  assert.equal(admit({ ...base, spentMicroUsd: 900 }), "ok");
  assert.equal(admit({ ...base, callsLast24h: 9 }), "ok");
});

test("a call whose worst case would cross the budget is refused", () => {
  assert.equal(admit({ ...base, spentMicroUsd: 901 }), "budget");
  assert.equal(admit({ ...base, spentMicroUsd: 5_000 }), "budget");
});

test("the daily cap applies even with budget to spare", () => {
  assert.equal(admit({ ...base, callsLast24h: 10 }), "rate_limited");
  assert.equal(admit({ ...base, callsLast24h: 10, spentMicroUsd: 5_000 }), "rate_limited");
});
