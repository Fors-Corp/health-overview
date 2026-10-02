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
- **Trend analysis.** Time-windowed moving average, kg/week rate, plateau detection, and
  flags for rapid swings that are water rather than fat.
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
```

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `AUTH_SECRET` | yes | Signs the session cookie. Generate with `openssl rand -hex 32` |
| `APP_PASSWORD` | yes | The password that opens the app. Authentication fails closed if unset |
| `ANTHROPIC_API_KEY` | no | Enables reading image-only reports and the written summary |
| `EXTRACTION_MODEL` | no | Defaults to `claude-opus-5` |
| `INSIGHTS_MODEL` | no | Defaults to `claude-sonnet-5` |

## Notes on data

Measurement data is personal health information. It lives in your own database and is
never committed to this repository — `.env*` and any local data files are ignored, and
`.vercelignore` keeps them out of deployments too.

## Deployment

The GitHub Actions workflow typechecks, lints and builds every push. It also deploys to
Vercel once `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are set as repository
secrets; until then the deploy job reports that it is not configured and passes.

If this project is useful to you, you can [support it with 1,99 €](https://marcfors.com/donate?from=health-overview).
