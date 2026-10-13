# Health Overview

[![Support · 1,99 €](https://img.shields.io/badge/Support-1%2C99_%E2%82%AC-2f855a)](https://marcfors.com/donate?from=health-overview)

A personal weight and body-composition tracker. It reads InBody bioimpedance reports
straight from a PDF or a phone photo, imports Apple Health data, and charts the whole
history on one timeline.

## Why it exists

Body-composition data tends to end up scattered across clinic PDFs, a notes app, and
Apple Health, in units and languages that do not line up. This pulls the sources into a
single series so the trend is actually readable.

## Features

- **Automatic report reading.** Upload a PDF or a photo of an InBody report. A PDF with a
  text layer is parsed locally for free; scans and photos fall back to Claude vision. Every
  extraction is shown for review before anything is saved.
- **History backfill.** InBody reports print a chart of your previous tests. The extractor
  reads those too, so one upload can recover several earlier scans.
- **Apple Health import.** Streams `export.xml` in the browser — the file never leaves the
  device — and sends only a daily summary to the server.
- **Notes-log import.** Paste a weight log kept in a notes app (year headings, Spanish,
  Italian or English months, comma decimals). Each entry is shown as new, already saved or
  conflicting before anything is saved, and an entry filed under the wrong year is flagged.
- **Trend analysis.** Time-windowed moving average, kg/week rate, plateau detection, and
  flags for rapid swings that are water rather than fat.
- **Weight phases.** Splits the history into loss and regain phases, with their duration and
  rate, and shows the phase in progress.
- **Recommendations.** On request, Claude turns the computed figures — never the raw
  measurements — into a few practical recommendations, each citing the figure it rests on.
- **Segmental view.** Per-limb lean and fat mass from InBody scans.

## Stack

Next.js 16 (App Router) · React 19 · Tailwind v4 · Drizzle ORM · PostgreSQL · Anthropic SDK

## Running it locally

```bash
npm install
createdb health_overview
cp .env.example .env.local   # then fill in the values
npm run db:push              # create the tables
npm run dev
npm test                     # unit tests, on node's built-in runner
npm run db:test:up           # throwaway Postgres 18 in Docker, for:
npm run test:db              # spend-guard tests against real Postgres and a fake Claude API
```

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `AUTH_SECRET` | yes | Signs the session cookie. Generate with `openssl rand -hex 32` |
| `APP_PASSWORD` | yes | The password that opens the app. Authentication fails closed if unset |
| `ANTHROPIC_API_KEY` | no | Enables reading image-only reports, the written summary and the recommendations (which always use `claude-opus-5-5`) |
| `EXTRACTION_MODEL` | no | Defaults to `claude-opus-5` |
| `INSIGHTS_MODEL` | no | Model for the written summary. Defaults to `claude-sonnet-5` |
| `TEST_DATABASE_URL` | no | Database for `npm run test:db`. Defaults to the Docker one; must be local |

## Claude spending

Every Claude call goes through `src/lib/claude.ts`, the only module allowed to import the
SDK (a unit test fails otherwise). Before each call it measures the exact request with the
API's free token-count endpoint and refuses one over the feature's input cap, so no single
call can book more than a fifth of the month. It then books the call's worst-case cost in
the `ai_calls` ledger under a Postgres advisory lock, and refuses past **$5 a month** or a
per-feature daily cap. Each call is made once, with no SDK retries, and then settled at its
billed cost. Identical requests are answered from `ai_cache`, so reloading the dashboard or
re-uploading the same scan costs nothing. The panel shows this month's spend.

The budget and caps live in `src/lib/spend.ts`. For a limit no code can bypass, also set a
monthly spend limit on the Anthropic Console workspace that issues the key.

## Notes on data

Measurement data is personal health information. It lives in your own database and is
never committed to this repository — `.env*` and any local data files are ignored, and
`.vercelignore` keeps them out of deployments too.

## Deployment

The GitHub Actions workflow typechecks, lints, tests and builds every push, and each
push to `main` that passes is deployed to Vercel. The deploy needs `VERCEL_TOKEN`,
`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` as secrets; if any is missing, the deploy job
fails rather than skipping, so a push never looks deployed when it is not.

If this project is useful to you, you can [support it with 1,99 €](https://marcfors.com/donate?from=health-overview).
