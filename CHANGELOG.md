# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-13

### Added

- Claude spend guard: every Claude call books its worst-case cost in a new `ai_calls`
  ledger before it is made, and is refused past $5 a month or a per-feature daily cap
  (summary 20, recommendations 10, report reading 20). The input side of that worst case
  is measured with the API's free token count, so a PDF's text layer is priced as well
  as its page images. Calls settle at their billed cost; an outcome that is unknown keeps
  its worst case.
- A request over its feature's input cap (40,000 tokens for a report) is refused, so one
  upload can never book more than a fifth of the month.
- Identical Claude requests are answered from a new `ai_cache` table, so dashboard
  reloads, repeated presses and re-uploaded scans cost nothing.
- The analysis panel shows this month's Claude spend against the budget.
- `npm run test:db` runs the spend-guard tests against Postgres 18 in Docker
  (`npm run db:test:up`) with a fake Claude API.

### Changed

- Claude requests are attempted once (no SDK retries) with an explicit timeout.
- Report uploads are limited to 4 MB and PDFs to 5 pages.
- The written summary may use up to 2,000 output tokens instead of 600, so adaptive
  thinking can no longer cut it short.
- Recommendations are capped at 8,000 output tokens instead of 16,000. Once shown, the
  button is hidden, since unchanged data would only return the stored answer.
- Recommendations no longer use server-side refusal fallback: each hop of a fallback
  chain bills its own input and output, so its cost could not be bounded in advance.

## [0.2.1] - 2026-10-13

### Security

- The esbuild that drizzle-kit's deprecated `@esbuild-kit` loader pulls in is forced to a
  patched 0.25 release with an npm override
  ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99): any website
  could send requests to esbuild's development server and read the responses). drizzle-kit
  moves to 0.31.11.

## [0.2.0] - 2026-10-13

### Added

- Weight phases: the history is split into alternating loss and regain phases, each with
  its duration and kg/week rate, and the dashboard shows the phase in progress.
- Recommendations: on request, Claude Opus 5.5 turns the computed figures into three to
  five recommendations, each citing the figure it rests on. Only computed figures are sent,
  never raw measurements. Needs `ANTHROPIC_API_KEY`.
- Notes-log import at `/import-log`: paste a free-text weight log, review which entries are
  new, already saved or conflicting, and correct entries filed under the wrong year before
  saving.
- `npm test` runs the unit tests on Node's built-in test runner.

[0.3.0]: https://github.com/Fors-Corp/health-overview/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Fors-Corp/health-overview/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Fors-Corp/health-overview/compare/v0.1.0...v0.2.0
