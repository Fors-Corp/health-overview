import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Every Claude call must pass the spend guard in src/lib/claude.ts. A second module
// importing the SDK, or calling the API over plain fetch, would bypass the budget.
const OWNER = "lib/claude.ts";
const SRC = fileURLToPath(new URL("..", import.meta.url));

const reachesAnthropic = (source: string) =>
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@anthropic-ai\/sdk/.test(source) ||
  /api\.anthropic\.com/.test(source);

test("the detector catches every way of reaching the API", () => {
  assert.ok(reachesAnthropic(`import Anthropic from "@anthropic-ai/sdk";`));
  assert.ok(reachesAnthropic(`import type { Message } from '@anthropic-ai/sdk/resources';`));
  assert.ok(reachesAnthropic(`const sdk = await import("@anthropic-ai/sdk");`));
  assert.ok(reachesAnthropic(`const sdk = require("@anthropic-ai/sdk");`));
  assert.ok(reachesAnthropic(`await fetch("https://api.anthropic.com/v1/messages")`));
  assert.ok(!reachesAnthropic(`import { runClaude } from "@/lib/claude";`));
});

test("only src/lib/claude.ts reaches the Anthropic API", () => {
  const offenders = readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f) && !/\.test\.ts$/.test(f))
    .map((f) => relative(SRC, join(SRC, f)).split("\\").join("/"))
    .filter((f) => f !== OWNER && reachesAnthropic(readFileSync(join(SRC, f), "utf8")));
  assert.deepEqual(offenders, []);
});
