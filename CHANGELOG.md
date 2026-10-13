# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.1]: https://github.com/Fors-Corp/health-overview/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Fors-Corp/health-overview/compare/v0.1.0...v0.2.0
