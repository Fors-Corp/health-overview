// support.ts must load first: it repoints the database and fakes the Anthropic network.
import {
  TEST_DATABASE_URL,
  anthropicAnswers,
  countTokensAnswers,
  counted,
  recreateSchema,
  sent,
} from "./support.ts";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { aiCalls, db, measurements } from "../src/lib/db/index.ts";
import * as schema from "../src/lib/db/schema.ts";
import { reserveCall, spentThisMonthMicroUsd } from "../src/lib/claude.ts";
import {
  MONTHLY_BUDGET_MICRO_USD,
  PRICE_CEILING,
  costMicroUsd,
  featurePolicy,
  priceFor,
  reservedInputTokens,
  worstCaseMicroUsd,
  type Feature,
} from "../src/lib/spend.ts";
import { GET as getInsights, POST as postRecommendations } from "../src/app/api/insights/route.ts";
import { POST as postExtract } from "../src/app/api/extract/route.ts";

// Synthetic data only — real measurements never enter the repository.
const RECOMMENDATIONS = JSON.stringify({
  recommendations: [{ topic: "medicion", title: "Pésate igual", detail: "Detalle.", basis: "Dato." }],
});
const EXTRACTION = JSON.stringify({
  measuredAt: "2020-03-01T10:00",
  weightKg: 80,
  bodyFatPct: null,
  skeletalMuscleMassKg: null,
  bmi: null,
  bodyFatMassKg: null,
  fatFreeMassKg: null,
  totalBodyWaterL: null,
  proteinKg: null,
  mineralsKg: null,
  bmrKcal: null,
  waistHipRatio: null,
  visceralFatLevel: null,
  segmental: null,
  history: [],
  confidence: "high",
  notes: null,
});
const IMAGE = new TextEncoder().encode("not really a png, the fake API never looks");
/** The fake API's default usage: 1000 input and 200 output tokens. */
const usageCost = (model: string) =>
  costMicroUsd({ input: 1000, output: 200, cacheCreation: 0, cacheRead: 0 }, priceFor(model));

let day = 0;
async function addWeighIn() {
  day += 1;
  await db.insert(measurements).values({
    measuredAt: new Date(Date.UTC(2020, 0, day, 10)),
    source: "manual_log",
    weightKg: String(80 + (day % 7)),
  });
}

const ledger = () => db.select().from(aiCalls).orderBy(asc(aiCalls.id));

/** Spend booked by another feature, so the features under test keep their daily caps. */
async function seedSpend(
  microUsd: number,
  { status = "settled", createdAt }: { status?: string; createdAt?: ReturnType<typeof sql> } = {},
) {
  await db.insert(aiCalls).values({
    feature: "extraction",
    model: "seed",
    status,
    reservedMicroUsd: microUsd,
    costMicroUsd: status === "settled" ? microUsd : null,
    inputCentsPerMTok: 0,
    outputCentsPerMTok: 0,
    ...(createdAt ? { createdAt } : {}),
  });
}

function upload(bytes: Uint8Array<ArrayBuffer>, type: string, name = "scan") {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  return new Request("http://localhost/api/extract", { method: "POST", body: form });
}

/** A minimal, valid PDF with `pages` blank pages and no text layer. */
function blankPdf(pages: number): Uint8Array<ArrayBuffer> {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ")}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"),
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

before(recreateSchema);

beforeEach(async () => {
  await db.execute(sql`truncate ai_calls, ai_cache, measurements restart identity`);
  anthropicAnswers(() => {
    throw new Error("this test did not expect a request to the Anthropic API");
  });
  for (let i = 0; i < 3; i++) await addWeighIn();
});

after(async () => {
  await db.$client.end();
});

describe("the written summary", () => {
  test("is paid for once per data state, however often the dashboard loads", async () => {
    anthropicAnswers(() => ({ text: "Resumen de prueba." }));
    for (let i = 0; i < 5; i++) {
      const body = await (await getInsights()).json();
      assert.equal(body.narrative, "Resumen de prueba.");
    }
    assert.equal(sent.length, 1);
    assert.equal(counted.length, 1);

    const rows = await ledger();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "settled");
    assert.equal(rows[0].costMicroUsd, usageCost("claude-sonnet-5"));

    const body = await (await getInsights()).json();
    assert.deepEqual(body.spend, {
      spentMicroUsd: usageCost("claude-sonnet-5"),
      budgetMicroUsd: MONTHLY_BUDGET_MICRO_USD,
    });
  });

  test("is generated again only when the data changes", async () => {
    anthropicAnswers(() => ({ text: "Resumen." }));
    await getInsights();
    await getInsights();
    await addWeighIn();
    await getInsights();
    assert.equal(sent.length, 2);
  });
});

describe("recommendations", () => {
  test("repeated presses with unchanged data cost one call", async () => {
    anthropicAnswers(() => ({ text: RECOMMENDATIONS }));
    const first = await (await postRecommendations()).json();
    const second = await (await postRecommendations()).json();
    await postRecommendations();

    assert.equal(sent.length, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.deepEqual(second.recommendations, first.recommendations);
  });

  test("a daily cap stops spam even when every request carries new data", async () => {
    anthropicAnswers(() => ({ text: RECOMMENDATIONS }));
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) {
      await addWeighIn();
      statuses.push((await postRecommendations()).status);
    }
    const cap = featurePolicy("recommendations").maxCallsPerDay;
    assert.equal(sent.length, cap);
    assert.equal(counted.length, cap, "a capped feature does not even have the request counted");
    assert.deepEqual(statuses.slice(cap), [429, 429, 429]);
    const last = await (await postRecommendations()).json();
    assert.deepEqual(last, { status: "unavailable", reason: "rate_limited" });
  });

  test("failed calls count toward the daily cap, so an error loop is bounded too", async () => {
    anthropicAnswers(() => ({ status: 400 }));
    for (let i = 0; i < 13; i++) {
      await addWeighIn();
      await postRecommendations();
    }
    assert.equal(sent.length, featurePolicy("recommendations").maxCallsPerDay);
  });

  test("an answer served by a pricier model is charged at that model's rate", async () => {
    anthropicAnswers(() => ({ text: RECOMMENDATIONS, model: "claude-fable-5-1" }));
    await postRecommendations();
    const [row] = await ledger();
    assert.equal(row.servedModel, "claude-fable-5-1");
    assert.equal(row.costMicroUsd, usageCost("claude-fable-5-1"));
  });

  test("an unusable answer is still paid for, and not cached", async () => {
    anthropicAnswers(() => ({ text: "not json" }));
    assert.equal((await postRecommendations()).status, 502);
    await postRecommendations();
    assert.equal(sent.length, 2);
    const rows = await ledger();
    assert.deepEqual(
      rows.map((r) => [r.status, r.costMicroUsd]),
      [
        ["settled", usageCost("claude-opus-5-5")],
        ["settled", usageCost("claude-opus-5-5")],
      ],
    );
  });

  test("a refusal is paid for and not cached", async () => {
    anthropicAnswers(() => ({ text: "", stopReason: "refusal" }));
    assert.deepEqual(await (await postRecommendations()).json(), { status: "refused" });
    await postRecommendations();
    assert.equal(sent.length, 2);
    assert.ok((await ledger()).every((r) => r.status === "settled"));
  });
});

describe("every feature", () => {
  const callers: Record<Feature, () => Promise<Response>> = {
    narrative: () => getInsights(),
    recommendations: () => postRecommendations(),
    extraction: () => postExtract(upload(IMAGE, "image/png")),
  };
  const answers: Record<Feature, string> = {
    narrative: "Resumen.",
    recommendations: RECOMMENDATIONS,
    extraction: EXTRACTION,
  };

  for (const feature of Object.keys(callers) as Feature[]) {
    test(`${feature}: sends exactly what was counted, with the policy's model and limit`, async () => {
      anthropicAnswers(() => ({ text: answers[feature] }));
      await callers[feature]();
      const policy = featurePolicy(feature);

      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, "https://api.anthropic.com/v1/messages");
      assert.equal(sent[0].body.model, policy.model);
      assert.equal(sent[0].body.max_tokens, policy.maxTokens);
      assert.deepEqual({ ...counted[0].body, max_tokens: policy.maxTokens }, sent[0].body);

      const [row] = await ledger();
      assert.equal(row.reservedMicroUsd, worstCaseMicroUsd(policy, reservedInputTokens(1000)));
    });
  }
});

describe("the monthly budget", () => {
  test("refuses a call whose worst case would cross it, without calling Claude", async () => {
    await seedSpend(MONTHLY_BUDGET_MICRO_USD - 1_000);

    const res = await postRecommendations();
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { status: "unavailable", reason: "budget" });
    assert.equal((await (await getInsights()).json()).narrativeUnavailable, "budget");

    assert.equal(sent.length, 0);
    assert.equal(counted.length, 0);
    assert.equal((await ledger()).length, 1);
  });

  test("counts a call billed above its reservation at what it actually cost", async () => {
    const input = 2_450_000;
    anthropicAnswers(() => ({ text: "Resumen.", usage: { input_tokens: input } }));
    await getInsights();
    const billed = costMicroUsd(
      { input, output: 200, cacheCreation: 0, cacheRead: 0 },
      priceFor("claude-sonnet-5"),
    );
    assert.ok(billed > (await ledger())[0].reservedMicroUsd);
    assert.equal(await spentThisMonthMicroUsd(), billed);

    anthropicAnswers(() => ({ text: RECOMMENDATIONS }));
    assert.deepEqual(await (await postRecommendations()).json(), {
      status: "unavailable",
      reason: "budget",
    });
    assert.equal(sent.length, 0);
  });

  test("counts a call that never settled at its full worst case", async () => {
    await seedSpend(MONTHLY_BUDGET_MICRO_USD, { status: "pending" });
    assert.equal((await postRecommendations()).status, 429);
    assert.equal(sent.length, 0);
  });

  test("ignores spend from previous months", async () => {
    await seedSpend(MONTHLY_BUDGET_MICRO_USD * 3, {
      createdAt: sql`date_trunc('month', now()) - interval '1 hour'`,
    });
    anthropicAnswers(() => ({ text: RECOMMENDATIONS }));
    assert.equal((await postRecommendations()).status, 200);
    assert.equal(sent.length, 1);
  });

  // Repeatable read would take each transaction's snapshot before the lock is granted.
  for (const isolation of ["read committed", "repeatable read"] as const) {
    test(`cannot be overspent by concurrent requests (connections defaulting to ${isolation})`, async () => {
      const reserve = 100_000;
      await seedSpend(MONTHLY_BUDGET_MICRO_USD - Math.floor(3.5 * reserve));
      const policy = { ...featurePolicy("narrative"), maxCallsPerDay: 1_000 };
      const clients = Array.from({ length: 8 }, () =>
        postgres(TEST_DATABASE_URL, {
          max: 1,
          connection: { default_transaction_isolation: isolation },
        }),
      );
      try {
        const connections = clients.map((c) => drizzle(c, { schema }));
        const results = await Promise.all(
          Array.from({ length: 24 }, (_, i) =>
            reserveCall(connections[i % connections.length], "narrative", policy, reserve),
          ),
        );
        assert.equal(results.filter((r) => typeof r === "object").length, 3);
        assert.ok((await spentThisMonthMicroUsd()) <= MONTHLY_BUDGET_MICRO_USD);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });
  }
});

describe("failures", () => {
  test("every request is attempted exactly once: no hidden SDK retries", async () => {
    anthropicAnswers(() => ({ status: 500 }));
    assert.equal((await postRecommendations()).status, 502);
    assert.equal(sent.length, 1);
  });

  test("a server error keeps the worst case booked, since it may have been billed", async () => {
    anthropicAnswers(() => ({ status: 500 }));
    await postRecommendations();
    const [row] = await ledger();
    assert.equal(row.status, "unknown");
    assert.equal(await spentThisMonthMicroUsd(), row.reservedMicroUsd);
  });

  test("a dropped connection keeps the worst case booked", async () => {
    anthropicAnswers(() => ({ networkError: true }));
    await postRecommendations();
    const [row] = await ledger();
    assert.equal(row.status, "unknown");
    assert.ok(row.reservedMicroUsd > 0);
    assert.equal(await spentThisMonthMicroUsd(), row.reservedMicroUsd);
  });

  test("a cost that cannot be recorded keeps the worst case booked", async () => {
    // Over the integer range of input_tokens, so the settling UPDATE itself fails.
    anthropicAnswers(() => ({ text: "Resumen.", usage: { input_tokens: 3_000_000_000 } }));
    await getInsights();
    const [row] = await ledger();
    assert.equal(row.status, "pending");
    assert.equal(await spentThisMonthMicroUsd(), row.reservedMicroUsd);
  });

  test("a failed token count makes no call and books nothing", async () => {
    anthropicAnswers(() => ({ text: RECOMMENDATIONS }));
    countTokensAnswers({ status: 500 });
    assert.equal((await postRecommendations()).status, 502);
    assert.equal(sent.length, 0);
    assert.equal((await ledger()).length, 0);
  });

  test("a rejected request costs nothing", async () => {
    anthropicAnswers(() => ({ status: 400 }));
    await postRecommendations();
    const [row] = await ledger();
    assert.equal(row.status, "failed");
    assert.equal(await spentThisMonthMicroUsd(), 0);
  });

  test("without an API key nothing is called or booked", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.deepEqual(await (await postRecommendations()).json(), {
        status: "unavailable",
        reason: "no_api_key",
      });
      assert.equal((await (await getInsights()).json()).narrativeUnavailable, "no_api_key");
      assert.equal((await postExtract(upload(IMAGE, "image/png"))).status, 503);
    } finally {
      process.env.ANTHROPIC_API_KEY = key;
    }
    assert.equal(sent.length, 0);
    assert.equal(counted.length, 0);
    assert.equal((await ledger()).length, 0);
  });

  test("with no spend ledger the call is refused, never made, and the stats still load", async () => {
    await db.execute(sql`drop table ai_calls`);
    try {
      const res = await getInsights();
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.narrativeUnavailable, "error");
      assert.equal(body.spend, null);
      assert.ok(body.stats.totalReadings > 0);
      assert.equal((await postRecommendations()).status, 502);
      assert.equal(sent.length, 0);
    } finally {
      await recreateSchema();
    }
  });
});

describe("report extraction", () => {
  test("an upload over 4 MB is turned away without a call", async () => {
    const res = await postExtract(upload(new Uint8Array(4 * 1024 * 1024 + 1), "image/png"));
    assert.equal(res.status, 413);
    assert.equal(sent.length, 0);
  });

  test("a PDF longer than the page cap is turned away without a call", async () => {
    const res = await postExtract(upload(blankPdf(6), "application/pdf", "long.pdf"));
    assert.equal(res.status, 413);
    assert.equal(sent.length, 0);
  });

  test("a PDF within the page cap is read", async () => {
    anthropicAnswers(() => ({ text: EXTRACTION }));
    const res = await postExtract(upload(blankPdf(2), "application/pdf", "short.pdf"));
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
  });

  test("a document heavier than the input cap is refused before anything is booked", async () => {
    // A few pages can carry a huge compressed text layer: only the count reveals it.
    anthropicAnswers(() => ({ text: EXTRACTION }));
    countTokensAnswers(featurePolicy("extraction").maxInputTokens + 1);
    const res = await postExtract(upload(blankPdf(2), "application/pdf", "heavy.pdf"));
    assert.equal(res.status, 413);
    assert.equal(counted.length, 1);
    assert.equal(sent.length, 0);
    assert.equal((await ledger()).length, 0);
  });

  test("a document is reserved at its counted size, not at a per-page guess", async () => {
    anthropicAnswers(() => ({ text: EXTRACTION }));
    countTokensAnswers(25_000);
    await postExtract(upload(blankPdf(1), "application/pdf", "dense.pdf"));
    const [row] = await ledger();
    const policy = featurePolicy("extraction");
    assert.equal(row.reservedMicroUsd, worstCaseMicroUsd(policy, reservedInputTokens(25_000)));
  });

  test("the same image uploaded twice is read once", async () => {
    anthropicAnswers(() => ({ text: EXTRACTION }));
    const first = await postExtract(upload(IMAGE, "image/png"));
    const second = await postExtract(upload(IMAGE, "image/png"));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual((await second.json()).data, JSON.parse(EXTRACTION));
    assert.equal(sent.length, 1);
  });

  test("a model missing from the price table is charged at the most expensive rate", async () => {
    process.env.EXTRACTION_MODEL = "claude-unlisted-9";
    try {
      anthropicAnswers(() => ({ text: EXTRACTION }));
      await postExtract(upload(IMAGE, "image/png"));
      const [row] = await ledger();
      assert.equal(row.inputCentsPerMTok, PRICE_CEILING.inputCentsPerMTok);
      assert.equal(row.outputCentsPerMTok, PRICE_CEILING.outputCentsPerMTok);
      assert.equal(row.costMicroUsd, usageCost("claude-unlisted-9"));
    } finally {
      delete process.env.EXTRACTION_MODEL;
    }
  });

  test("the daily cap applies to uploads too", async () => {
    anthropicAnswers(() => ({ text: EXTRACTION }));
    const cap = featurePolicy("extraction").maxCallsPerDay;
    const statuses: number[] = [];
    for (let i = 0; i <= cap; i++) {
      const scan = new TextEncoder().encode(`scan ${i}`);
      statuses.push((await postExtract(upload(scan, "image/png"))).status);
    }
    assert.equal(sent.length, cap);
    assert.equal(statuses.at(-1), 429);
  });
});
