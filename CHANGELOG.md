# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-10-13

### Security

- The esbuild that drizzle-kit's deprecated `@esbuild-kit` loader pulls in is forced to a
  patched 0.25 release with an npm override
  ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99): any website
  could send requests to esbuild's development server and read the responses). drizzle-kit
  moves to 0.31.11.

[0.1.2]: https://github.com/Fors-Corp/health-overview/compare/v0.1.0...v0.1.2
