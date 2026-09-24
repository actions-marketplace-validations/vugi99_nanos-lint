# Changelog

All notable changes to `nanos-lint` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Prettier code formatting quality gate (`npm run format:check` and auto-fix `npm run format:fix`) enforcing consistent code style across all TypeScript, JSON, Markdown, and YAML files, with `eslint-config-prettier` integration to disable conflicting ESLint rules (#41).
- Dependency architecture, bundle boundaries, and license compliance quality gate (`npm run lint:deps` via `dependency-cruiser` and `.dependency-cruiser.cjs`), enforcing zero cycles, strict layer boundaries, tsdown bundle compliance, orphan detection, and MIT-compatible permissive licenses (#40).
- Docstring quality gate script (`npm run lint:docstrings` via `scripts/lint-docstrings.ts`) enforcing >= 90% function documentation coverage per file across `src/`, with comprehensive JSDoc coverage across all production modules (#38).
- Comment density quality gate script (`npm run lint:comments` via `scripts/lint-comments.ts`) enforcing <= 15% pure comment lines on files with >= 50 lines, with condensed commentary in verbose modules and exception support (#37).
- Unified quality gates npm script (`npm run gates` and alias `npm run check:all`) chaining all mandatory project quality gates in sequence, simplifying pre-commit hooks and documentation (#39).
- Hardening tests for shipped `templates/.luarc.json` (#36):
  - Unit tests in `tests/unit/config.test.ts` asserting 100% of keys in `diagnostics.severity` and `diagnostics.neededFileStatus` belong to `VALID_LUALS_DIAGNOSTIC_CODES`, merging default template emits zero dropped-key warnings, and the `$schema` URL pattern is valid.
  - Live integration test in `tests/integration/luals.test.ts` verifying the `$schema` URL is reachable (HTTP 200) and returns valid JSON.
  - Live integration test in `tests/integration/luals.test.ts` verifying that each default diagnostic severity promotion (`unused-local`, `redefined-local`, `unused-vararg`) actively triggers at `Warning` severity on live LuaLS.

### Fixed

- Cross-platform ZIP archive safety inspection (`inspectZipMembers` in `src/luals/validation.ts`) using pure-JS central directory parsing without spawning external processes (`tar` or PowerShell), fixing Linux test failures on `.zip` fixtures where GNU `tar` does not support ZIP archives (#31).
- Cross-platform LF line endings normalization in `.gitattributes` (`* text=auto eol=lf`), preventing Git checkouts on Windows runners with `core.autocrlf=true` from failing Prettier code formatting checks (#41).
- Close file descriptor in a `finally` block when `fs.readSync()` throws in `isAnnotationsValid()`, preventing descriptor leaks on I/O errors (#32, #34).
- Close file descriptor in a `finally` block when `fs.readSync()` throws during custom or environment annotations validation in `validateCustomAnnotationsPath()`.
- Drop ineffective LuaLS binary and annotations `actions/cache` step and week computation from CI workflow, which were never read or written by the isolated test suite (#29).
- Cap `annotations.lua` download size (10 MB via `MAX_ANNOTATIONS_SIZE_BYTES`) and commit JSON response (1 MB via `MAX_COMMIT_JSON_SIZE_BYTES`) before buffering in memory, rejecting over-large responses with `ERR_ANNOTATIONS_TOO_LARGE` and remediation naming `--annotations <path>` (#30).
- Bound decompressed archive size (500 MB via `MAX_DECOMPRESSED_SIZE_BYTES`) and member count (10,000 via `MAX_ARCHIVE_MEMBER_COUNT`) during LuaLS archive inspection before and after extraction, rejecting archives with symlink/hardlink members, directory escapes, or excessive members/size with `ERR_LUALS_EXTRACT` (#31).

## [2.8.1] - 2026-09-24

### Added

- Security vulnerability reporting guidelines and working `gh api` CLI examples in `AGENTS.md` specifying private GitHub Security Advisories for responsible disclosure.
- Bundled `glob@13` together with its `minimatch`, `path-scurry`, `lru-cache`, `minipass`, and `brace-expansion` dependency tree, inlined through `tsdown` so the published package keeps zero runtime dependencies while `countCheckedFiles()` gains full glob support (#27).
- Regression tests for `LUALS_BIN` / `--luals-bin` validation (#26) and for glob-based file counting, covering brace expansion, character classes, adversarial pattern budgets, unusable patterns, and symlink handling (#27).
- Differential parity test (`tests/unit/glob-parity.test.ts`) that runs the pre-#27 `countCheckedFiles()` implementation against the bundled-glob one on the same fixture tree, pinning the configs where behaviour must stay identical and documenting each intended difference (#27).

### Changed

- `countCheckedFiles()` (`src/luals/files.ts`) now walks the tree and matches `files.exclude` / `workspace.ignoreDir` patterns with the bundled `globSync()` instead of a hand-rolled recursive walk plus glob-to-regex translation: brace expansion (`{a,b}`), character classes (`[0-9]`), `?` and `**` follow standard glob semantics, patterns without a slash keep matching at any depth, and a trailing slash (`vendor/`) is treated like `vendor` (#27).
- Glob wildcards now apply to `workspace.ignoreDir` entries as well (`deep/*` previously matched nothing), and unusable pattern values (`""`, `"."`, NUL bytes, oversized strings, absolute paths, non-string JSON values) are skipped instead of throwing out of `countCheckedFiles()`. Absolute patterns are rejected everywhere on purpose: `glob` anchors them on some platforms but not others, so skipping them keeps one `.luarc.json` behaving identically on Linux, macOS and Windows (#27).
- `LUALS_BIN` and `--luals-bin` are validated instead of trusted: a path that is missing, is a directory, or is not a runnable LuaLS binary now fails with `ERR_LUALS_BIN_INVALID` naming the setting, instead of being silently ignored or failing deep inside the check run (#26). Thin wrapper scripts that report a version stay supported — the 100 KB floor for downloaded archives is not applied to user-supplied binaries.

### Fixed

- Validate `LUALS_BIN` / `options.lualsBin` by requiring a regular file whose `--version` reports a LuaLS release, with actionable remediation hints naming `LUALS_BIN` / `--luals-bin` (#26).
- Repaired the Issue #20 archive-planted symlink regression test, which aborted while extracting an intentionally fake archive before reaching the symlink guard it asserts on.
- Repaired the Issue #17 traversal regression test, which a discoverable valid LuaLS installation (such as the shared live-test fixture) could legitimately satisfy, so the poisoned `metadata.json` path was never exercised deterministically.
- Sanitize `metadata.json` `latestVersion` with `sanitizeLuaLSVersion()` and enforce cache boundary checks before resolving cached binary paths, preventing path traversal and arbitrary binary execution outside the cache tree (#17).
- Canonicalize both the extracted binary and the extraction directory before the directory-escape check, so a cache path reached through symlinks (such as macOS `os.tmpdir()` under `/var` -> `/private/var`) no longer rejects every download (#20).
- Enforce 120s timeout and stream LuaLS archive downloads directly to disk with a 150 MB upper bound, preventing indefinite process hangs and out-of-memory exhaustion; the SHA-256 audit hash reads the archive in 1 MiB chunks so the memory bound holds after the download too (#18).
- Enforce HTTPS GitHub host allowlisting on download URLs and redirects, log the downloaded archive SHA-256 digest (at `info` level, for out-of-band comparison against a locally pinned value), and document the binary verification model in `SECURITY.md` (#19).
- Harden tar extraction with `--no-same-owner --no-same-permissions` on POSIX and validate extracted binary path against symlinks and directory escapes before chmod or execution (#20).
- Prevent symlink loops and directory escapes in `countCheckedFiles` by resolving the checked root to its canonical path and never traversing symlinked directories or counting symlinked files (#21).
- Pin annotations downloads to resolved upstream commit SHAs, enforce named constant `MIN_ANNOTATIONS_SIZE_BYTES` with strict header validation against generic comments, and validate custom/env annotation paths against directories, empty files, and binary files (#24).

### Security

- Bound glob pattern complexity in `countCheckedFiles()` (#27): patterns that exceed the per-segment wildcard (max 2), total wildcard (max 12) or brace-expansion (max 256) budget are skipped with a warning, keeping the walk bounded against catastrophic regex backtracking and combinatorial brace expansion from a hostile `.luarc.json`. The budgets are conservative on purpose — matching cost grows like `C(segment length, wildcards per segment)` — and a skipped pattern only over-counts the reported file total, never under-counts it.
- Dropped security support for versions `< 2.8.1` in `SECURITY.md`.

## [2.8.0] - 2026-09-23

### Added

- Cache status and inspection command (`nanos-lint cache status`, `cache info`, and `cache-status`) with human-readable terminal output and `--json` export displaying cached LuaLS binaries, annotations commit SHA, metadata freshness, and disk usage (#14).
- Cache inspection and sizing utilities (`getCacheStatus`, `formatCacheStatusPretty`, `getDirectorySize`, `formatBytes`) exported in `src/cache-status.ts` and `src/paths.ts` (#14).
- Dedicated unit test suite `tests/unit/cache-status.test.ts` verifying disk size calculation, byte formatting, empty and populated cache reporting, and CLI subcommands (#14).
- Exported helper `listCachedLuaLSVersionDirs()` in `src/luals/cache.ts` and `countCheckedFiles()` in `src/luals/files.ts`.
- Documented `nanos-lint cache clean` subcommand in `README.md` and CLI references.
- Dedicated warmup / download CLI command (`nanos-lint warmup` and alias `download`) pre-fetching and caching both the LuaLS binary and nanos world annotations for air-gapped CI and Docker build pipelines (#13).
- Centralized typed error hierarchy in `src/errors.ts` (`NanosLintError`, `ConfigError`, `LuaLSError`, `AnnotationsError`, `CacheError`) providing structured error codes and actionable remediation hints for users and programmatic consumers (#12).
- Enhanced CLI error reporting formatting `NanosLintError` failures with clean error messages and remediation hints (`hint: ...`) without raw stack traces unless running with `--log-level=debug` or `DEBUG` (#12).
- Dedicated unit test suite `tests/unit/errors.test.ts` testing error classes, codes, call sites, and CLI formatting (#12).
- Exported validator `isAnnotationsValid()` in `src/annotations.ts` verifying file existence, minimum size (>= 1000 bytes), and valid Lua headers.
- Dedicated unit test suite `tests/unit/cache-corruption.test.ts` covering automated self-healing across corrupted annotations, malformed metadata, broken binaries, and legacy cache states.

### Changed

- Promoted `redefined-local`, `unused-local`, and `unused-vararg` diagnostics from `Hint` to `Warning` in `templates/.luarc.json`; projects running with default `--checklevel=Warning` can opt out by specifying `--checklevel=Error` or setting their severities back to `Hint` in `.luarc.json`.
- Dropped `?/init.lua` from default `runtime.path` in `templates/.luarc.json` intentionally to align with standard nanos world package layouts.
- Updated `$schema` URL in `templates/.luarc.json` and `README.md` to point to the live `LuaLS/vscode-lua` repository.
- Refined module coverage floors in `vitest.config.ts` targeting `src/luals/runner.ts`, `src/luals/cache.ts`, and `src/luals/download.ts`, while excluding zero-logic re-export shims (`src/luals.ts`, `src/luals/index.ts`).
- Aligned `diagnostics.neededFileStatus` in `mergeConfigs()` to key-merge overrides alongside `diagnostics.severity`.
- Enhanced `ERR_LUALS_CORRUPTED_CACHE` error messages in `resolveLuaLSBinary()` to include actual underlying failure causes instead of unconditionally claiming offline.
- Configured GitHub Actions CI workflow triggers on pull requests targeting `dev` while constraining `push` triggers to `master` and `main` to prevent duplicate workflow runs on PRs (`.github/workflows/ci.yml`).
- Enforced file line limits via ESLint `max-lines` (500 lines for `src/**/*.ts`, 1000 lines for `tests/**/*.ts`).
- Modularized `src/luals.ts` into `src/luals/` submodules (`version.ts`, `platform.ts`, `cache.ts`, `download.ts`, `runner.ts`, `validation.ts`, `files.ts`, and `index.ts`), retaining 100% backward-compatible exports from `src/luals.ts`.
- Automated self-healing for corrupted or malformed `metadata.json` files across LuaLS and annotations caches, automatically purging invalid JSON files on parse errors.
- Enhanced `resolveAnnotations()` to purge corrupted or 0-byte cached files and automatically fall back to bundled definitions when offline.
- Improved offline diagnostics in `resolveLuaLSBinary()` providing clear remediation hints (`nanos-lint clean-cache`) when cached binaries fail execution checks and cannot be re-downloaded.
- Enabled `noUncheckedIndexedAccess` and `noImplicitOverride` in `tsconfig.json` for safer array/dictionary index access and explicit inheritance semantics.
- Enforced async, promise safety, and strict equality guardrails in `eslint.config.mjs` (`@typescript-eslint/no-floating-promises`, `@typescript-eslint/await-thenable`, `@typescript-eslint/no-misused-promises`, `eqeqeq`, and `prefer-const`).
- Documented transitive runtime dependency `is-safe-filename` (from `env-paths@4.0.0`) in `tsdown.config.ts`, explaining why it is inlined into the zero-dependency bundle.
- Cleaned up redundant `diagnostics.globals` singletons in `templates/.luarc.json` that are already declared as global tables in `annotations.lua`.
- Configured nanos package lookup paths (`Shared/?.lua`, `Client/?.lua`, `Server/?.lua`) and mapped `"Package.Require": "require"` via `runtime.special` in `templates/.luarc.json`.
- Updated `AGENTS.md` guidelines noting that running checks manually before committing is unnecessary because the full quality suite runs automatically in the pre-commit hook.

### Fixed

- Fixed single-file diagnostic filtering in `runLuaLSCheck` (`src/luals/runner.ts`) across macOS and Windows by canonicalizing paths with `fs.realpathSync.native` to handle symlinks (such as `/var` vs `/private/var` on macOS) and 8.3 short names on Windows runner environments.
- Fixed cache status inspection in `getCacheStatus()` (`src/cache-status.ts`) by targeting `<cache>/luals` rather than `<cache>`, accurately discovering cached LuaLS copies, metadata freshness, and distinguishing valid versus corrupted binaries (#14).
- Filtered `diagnostics.severity` and `diagnostics.neededFileStatus` keys against LuaLS's 62 valid diagnostic codes in `mergeConfigs()`, automatically dropping obsolete or unrecognized keys (such as `syntax-error`) with a warning to prevent LuaLS from silently voiding the entire severity table (#22).
- Resolved circular import between `src/luals/cache.ts` and `src/luals/download.ts` by extracting `isBinaryValid()` to `src/luals/validation.ts`.
- Clamped `formatBytes()` for inputs `< 1` and handled scale promotion on boundary rounding (e.g. `1023.6` -> `"1.00 KB"`, `0.4` -> `"0 B"`).
- Consistently honored `reuseExisting: false` across all bundled, cached, and PATH fallback branches in `resolveLuaLSBinary()` and `downloadAndExtractLuaLS()`.
- Extracted `countCheckedFiles()` from `src/luals/runner.ts` to `src/luals/files.ts`, keeping `runner.ts` well under the 500-line limit.
- Fixed legacy cache path collision on Linux where `getLegacyCacheDir` resolved to the same directory as the primary cache, preventing redundant probes in `findExistingLuaLSDir` and respecting `reuseExisting: false` in `resolveLuaLSBinary`.
- Duplicate releases: pushing a release commit to `master` and its tag produced two qualifying CI runs, so the release ran twice and the second `npm publish` failed with a 409. The release job now only runs for tag-triggered CI, skips a tag whose GitHub release already exists, and skips `npm publish` when the version is already published.

### Security

- Dropped security support for versions `< 2.8.0` in `SECURITY.md`.

## [2.7.0] - 2026-09-23

### Added

- Centralized logger module (`src/logger.ts`) providing configurable log levels (`error`, `warn`, `info`, `debug`, `silent`) with default level `"warn"`.
- `-l, --log-level <level>` CLI parameter on root and `check` command and `NANOS_LOG_LEVEL` environment variable to configure the application log level.
- Custom ESLint rule `local/no-empty-catch` in `eslint.config.mjs` preventing empty or silent `catch` blocks across the codebase.
- Dedicated unit tests for the logger module (`tests/unit/logger.test.ts`) and CLI log level configuration (`tests/unit/cli.test.ts`).
- Exported helper `findExistingLuaLSDir()` in `src/luals.ts` to discover pre-installed LuaLS directories in primary cache, legacy cache, or bundled distributions.
- `reuseExisting` option in `DownloadOptions` for `downloadAndExtractLuaLS()`, enabling reuse of existing platform binaries without network download.
- Pre-packaged standalone Linux ARM64 (`nanos-lint-<version>-linux-arm64.tar.gz`) and macOS release archives (`nanos-lint-<version>-macos-arm64.tar.gz` for Apple Silicon and `nanos-lint-<version>-macos-x64.tar.gz` for Intel) bundling platform LuaLS binaries, vendored annotations, and shell launchers in `.github/workflows/release.yml`.
- `macos-latest`, `macos-26-intel`, and `ubuntu-26.04-arm` runners to the GitHub Actions CI test matrix in `.github/workflows/ci.yml`.
- Architecture-aware cache keys (`${{ runner.os }}-${{ runner.arch }}`) in `.github/workflows/ci.yml` and `action.yml` preventing cross-architecture cache collisions between x64 and arm64 runners.
- Documentation in `README.md` for standalone Linux ARM64 and macOS release distributions, `-l, --log-level` option, and `NANOS_LOG_LEVEL` environment variable.
- Weekly checking cadence for LuaLS updates in `src/luals.ts` tracking ISO week in `metadata.json` (`lastCheckedWeek`), eliminating redundant GitHub API requests on every invocation.
- Automatic cleanup helper `cleanupOldCachedLuaLSVersions()` removing older cached LuaLS version directories when a newer version is downloaded or verified.
- Dedicated unit test suite `tests/unit/luals-cache.test.ts` verifying weekly ISO week caching, metadata parsing, cache discovery, error recovery, and older version purging.
- Isolated test harness (`tests/global-setup.ts`, `tests/helpers/`): each run uses its own cache/temp tree, so tests never read or write the real `~/.cache/nanos-lint`.
- One shared LuaLS/annotations download per run in the global setup, memoized per worker, plus a counter that fails the run when LuaLS is downloaded more than once.
- `cacheDir` and `reuseExisting` options for `resolveLuaLSBinary()`, `findExistingLuaLSDir()`, and `downloadAndExtractLuaLS()`.
- `NANOS_LIVE_TESTS=0` offline test mode (no network access, coverage thresholds disabled).
- Per-file coverage floor for `src/luals.ts` in `vitest.config.ts`.
- Architecture check (ELF/Mach-O/PE header) for every bundled LuaLS binary in the release packaging step; real arm64 execution is covered by the `ubuntu-26.04-arm` CI job.
- `.gitattributes` keeping `.githooks/**` and shell scripts on LF (and `*.cmd`/`*.bat` on CRLF).
- Regression test asserting that a warm weekly cache validates exactly one binary.

### Changed

- `resolveLuaLSBinary()` checks the weekly metadata before enumerating the cache, so the warm path validates one binary instead of spawning LuaLS once per cached version.
- `--log-level=silent` now suppresses the diagnosis report and command output too; `--quiet`/`--log-level=error` still print the report and hide only progress.
- `src/logger.ts` reads only `NANOS_LOG_LEVEL`, no longer a bare `LOG_LEVEL`.
- CI matrix: dropped the 1-vCPU `ubuntu-slim` runner; Linux x64 stays covered by `ubuntu-latest`.
- Cache keys in `.github/workflows/ci.yml` and `action.yml` include the ISO week so entries refresh, and the dead restore-key prefixes were fixed.
- `action.yml` falls back to the exact released version (`npx --yes nanos-lint@2.7.0`) instead of the `^2.6.1` range.
- Tests modernized: vacuous/conditional assertions replaced, missing fixtures asserted instead of skipped, `mockClear()` between flag variants, and the `-i/--ignore` test drives the real CLI.
- `README.md` documents the test-suite variables and the shared download; the runtime environment variable table links to them.

### Removed

- 1-vCPU `ubuntu-slim` runner from the CI test matrix.

### Fixed

- Test suite hermetic: no user-cache mutation, no stray `../invalid` directory, no dependency on a pre-warmed cache.
- Single shared LuaLS download per run (previously one per test file plus a `regressions.test.ts` `beforeAll`).
- `tests/unit/regressions.test.ts` no longer degrades to "29 skipped" when its `beforeAll` fails.
- **Script injection in the release workflow**: untrusted tag values and the GitHub token now pass through `env:` instead of being interpolated into `run:` text.
- Release tag detection is end-anchored and no longer fails on commits without a release tag under `bash -e -o pipefail`.
- The release fails when the tag does not match `package.json`'s version.
- Removed the `workflow_run` `branches` filter that dropped tag-triggered CI runs.
- `id-token: write` is scoped to the npm publish job.
- Write-once `actions/cache` entries whose restore keys could never match the key they wrote.
- `--log-level=silent` is now respected by the report and command output.
- LuaLS resolution tests inject an isolated cache, and the offline-fallback test exercises the fallback download path.
- ReDoS regression budgets in `tests/unit/config.test.ts` widened to avoid CI flakes.
- Windows CI: the file-scoped diagnostic assertion normalizes path separators and case.
- **CodeQL `js/incomplete-url-substring-sanitization`**: the LuaLS request assertions in `tests/unit/luals-cache.test.ts` and the download counter in `tests/helpers/download-counter.ts` now parse URLs and compare the hostname and path instead of matching substrings.

### Security

- Hardened `.github/workflows/release.yml` against command injection: no `${{ }}` expression remains in any `run:` script text.
- Scoped `id-token: write` to the npm publish job, so the release job and its third-party actions cannot mint OIDC tokens.

## [2.6.1] - 2026-09-23

### Added

- Built-in GitHub Actions caching in `action.yml` using `actions/cache@v6` with a configurable `cache` input (default: `true`), automatically caching LuaLS binaries and annotations across runs for consumers of the action.

### Changed

- Updated fallback npx execution in `action.yml` to target `nanos-lint@^2.6.1`.

## [2.6.0] - 2026-09-23

### Security

- Dropped security support for versions `< 2.6.0` in `SECURITY.md`.

### Added

- `npm run test:coverage` script using `@vitest/coverage-v8` to enforce strict test coverage thresholds across the codebase without autoUpdate.
- Vitest global coverage thresholds: statements (85%), functions (88%), lines (85%), branches (75%).
- Comprehensive unit tests across all modules targeting previously uncovered branches in URI resolution (`types.test.ts`), CLI options & commands (`cli.test.ts`), report snippet and annotation formatting (`reporter.test.ts`), config discovery & workspace init (`config.test.ts`), platform & binary resolution (`luals-utils.test.ts`), and commit/content fetching (`annotations.test.ts`).
- `clean-cache` (and `clean` alias) CLI command to safely purge cached LuaLS binaries and annotations (`nanos-lint clean-cache`).
- Dynamic downloading and date-based cache validation for `annotations.lua` from repository `nanos-world/vscode-extension` (`docgen-output` branch), eliminating the upstream Git submodule.
- `--annotations <path>` CLI option for `check` and `init` commands to supply a custom annotations file.
- `NANOS_ANNOTATIONS_PATH` and `NANOS_ANNOTATIONS` environment variables to configure a custom annotations file.
- `GITHUB_TOKEN` environment variable support for GitHub API authentication during LuaLS and annotations resolution to avoid rate limiting.
- Automatic probing and transparent migration of legacy LuaLS cache directories (`%LOCALAPPDATA%\nanos-lint\luals` on Windows, `~/.cache/nanos-lint/luals` on macOS/Linux) from versions <= 2.2.1 to prevent unnecessary re-downloads.
- `annotations` input to GitHub Action (`action.yml`).
- Git pre-commit hook in `.githooks/pre-commit` to automatically run quality gates (`npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage`) before each commit.
- Atomic cache update transaction for annotations with automated rollback on failure.
- npm version badge in `README.md`.

### Changed

- Standardized project quality gates (`.githooks/pre-commit`, `.git/hooks/pre-commit`, `AGENTS.md`, `README.md`) and CI workflows (`.github/workflows/ci.yml`) to enforce `npm run test:coverage`.
- Standardized cross-platform application cache, config, data, and temp path resolution using `env-paths` in `src/paths.ts`.
- **Cache relocation migration note**: System cache paths now resolve to `%LOCALAPPDATA%\nanos-lint\Cache` on Windows and `~/Library/Caches/nanos-lint` on macOS (standard platform cache paths). Existing cache directories from <= 2.2.1 are automatically probed and migrated.
- `mergeConfigs()` now accepts either an `annotations.lua` file path or a directory containing `annotations.lua` for seamless backwards compatibility.
- Deprecated `getDefinitionsDir()` in favor of `getDefaultAnnotationsPath()`.
- Removed Git submodule `vendor/nanos-world-vscode-extension`, `.gitmodules`, and the periodic synchronization workflow `.github/workflows/sync-annotations.yml`.
- Standalone packaged release builds now download and bundle `annotations.lua` at build time to enable complete offline execution.
- Clarified in `README.md` that standalone binary distributions require Node.js installed on the host machine.
- Updated vulnerability reporting link in `SECURITY.md` to GitHub repository security advisories.

### Fixed

- **Annotation error reporting**: Differentiated filesystem and permission errors (`EACCES`, `ENOSPC`, etc.) from network errors in `resolveAnnotations()`, preserving the original error cause without incorrectly diagnosing a network failure.
- **Early configuration validation**: CLI `check` command now verifies the existence of any custom `--config` path before initiating annotation resolution.
- **Offline cache persistence**: Updated `lastChecked` date when falling back to existing cached annotations during offline or rate-limited sessions, avoiding repeated failing network calls.
- **Cache marker validation**: `resolveLuaLSBinary()` now strictly verifies that `.complete` exists and matches the expected version before accepting a cache hit, preventing stale or partially extracted binaries from being used.
- **Atomic promotion cleanup**: Cleans up corrupted destination directories if promotion fails in `downloadAndExtractLuaLS()`, and eliminated redundant `isBinaryValid()` subprocess execution during binary extraction.
- **Release workflow hardening**: Used `curl -fsSL` with minimum size verification in `.github/workflows/release.yml` to prevent bundling error pages into release packages.
- **Race conditions & Windows file locking (`EBUSY`/`EPERM`)**: Staged temporary downloads in `os.tmpdir()` and introduced retry backoffs (`copyFileWithRetry`) when promoting cached annotations files across concurrent multi-worker processes.
- **Integration test isolation**: Ensured annotations are pre-cached in `beforeAll` for live LuaLS test suites, and isolated `cleanCache()` operations in unit tests to prevent accidental deletion of shared cache.
- **CodeQL `js/incomplete-url-substring-sanitization`**: Replaced substring URL check in annotations unit test mocks with strict URL hostname parsing.

## [2.5.0] - 2026-09-22

### Security

- **CodeQL `js/command-line-injection`**: LuaLS version/tag strings are now validated with an allow-list before use. Values obtained from the GitHub releases API (`tag_name`) and from user supplied `--luals-version` arguments are interpolated into cache directory paths, download URLs, and the path of the executed binary, so they are rebuilt character by character (`sanitizeLuaLSVersion()`) and rejected unless they form a single safe path segment. This prevents path traversal or command injection through a crafted release tag.
- **CodeQL `js/shell-command-injection-from-environment`**: The Windows `.cmd` launcher integration test no longer puts an environment-derived absolute path on a command line interpreted by `cmd.exe`; the launcher is referenced by name and resolved through the `cwd` option.
- **CodeQL `actions/missing-workflow-permissions`**: Added an explicit least-privilege `permissions: contents: read` block to `.github/workflows/ci.yml` so the workflow token stays read-only regardless of repository/organization defaults.
- Validated the LuaLS release tag fetched in the release workflow before it is used in a shell command.
- Dropped security support for versions `< 2.5.0` in `SECURITY.md`.

### Fixed

- **CodeQL `js/polynomial-redos`**: Removed the `\/+$` regular expressions used to trim trailing slashes in `src/config.ts` and replaced them with the linear `stripTrailingSlashes()` scan, eliminating quadratic backtracking on slash-heavy input.

### Changed

- `resolveLuaLSVersion()` now throws a descriptive error for an invalid explicitly requested version instead of returning it unchanged.
- Added exported helpers `sanitizeLuaLSVersion()` (`src/luals.ts`) and `stripTrailingSlashes()` (`src/config.ts`).

## [2.4.0] - 2026-09-22

### Changed

- Replaced custom handwritten JSONC parser and comment stripper with `jsonc-parser` (`^3.3.1`).
- Configured ESM module alias in `tsdown.config.ts` for `jsonc-parser` to ensure internal implementation modules (`./impl/*`) are statically bundled, resolving Node.js bundling issues ([microsoft/node-jsonc-parser#57](https://github.com/microsoft/node-jsonc-parser/issues/57)).

### Security

- Dropped security support for versions `< 2.4.0` in `SECURITY.md`.

## [2.3.0] - 2026-09-22

### Fixed

- **Critical (Finding N0)**: Added `.nanos-lint` to `workspace.ignoreDir` and `.nanos-lint/**` to `files.exclude` in `templates/.luarc.json`, `src/config.ts`, and `initWorkspace()`, preventing LuaLS from diagnosing `.nanos-lint/annotations.lua` as workspace source code and eliminating false-positive luadoc warnings on initialized workspaces.
- **High (Finding N1)**: Made LuaLS download and extraction atomic and race-safe for concurrent cold-cache runs using unique PID/timestamp temporary directories, isolated archive downloads, cancellation of non-OK response bodies, and atomic directory promotion with conflict resolution.
- **Medium (Finding N2)**: Added self-healing cache validation and recovery via `isBinaryValid()` smoke testing and `.complete` installation markers; automatically detects, cleans up, and repairs corrupted/truncated binaries, and includes the cache directory path in error messages when LuaLS check execution fails.
- **Low**: Ensured `initWorkspace()` throws an informative error if source `annotations.lua` is missing instead of generating broken workspace configurations.

### Security

- Dropped security support for versions `< 2.3.0` in `SECURITY.md`.

## [2.2.1] - 2026-09-22

### Changed

- Configured npm Trusted Publishing using OpenID Connect (OIDC) via `id-token: write` workflow permission.
- Updated nanos world official game website URL in `README.md` to `https://nanos-world.com/`.

### Fixed

- Fixed release workflow step condition where `env.NPM_TOKEN != ''` was evaluated before step-level environment variables were initialized, migrating to tokenless OIDC authentication.

## [2.2.0] - 2026-09-22

### Added

- `--github` flag as a direct shortcut for `--format=github`.
- `--force` (`-f`) flag for the `init` command to explicitly permit overwriting an existing `.luarc.json`.
- Automated update of moving major version tags (e.g. `v2`) on GitHub release.
- CI concurrency control (`cancel-in-progress`) and caching for LuaLS binary downloads using `actions/cache@v6`.
- Portable definition scaffolding during `init`: copies `annotations.lua` to `.nanos-lint/annotations.lua` inside the target workspace.
- Formal security policy in `SECURITY.md` (supporting versions `>= 2.1.0`).
- Documentation in `README.md` for `LUALS_BIN`, `NO_COLOR`, `FORCE_COLOR`, and repeatable `--ignore`.
- Mandatory release and changelog guidelines in `AGENTS.md`.

### Changed

- Moved `commander` from `dependencies` to `devDependencies`, achieving a true zero-dependency runtime for published bundles.
- Cleaned `tsconfig.json` to target Node.js runtime exclusively (removed `DOM` library and stale configuration files).

### Fixed

- **Critical**: Prevented silent false passes by treating missing target paths and failed/crashed LuaLS subprocess runs without output as hard errors.
- **Critical**: Fixed variadic `-i, --ignore` option swallowing following positional target arguments by switching to a repeatable single-pattern option.
- **Critical**: Hardened `action.yml` to prevent script injection via shell input variables and added fallback to `npx` when `dist/` is not present.
- **High**: Fixed `--quiet` flag to suppress all `[luals]` progress output.
- **High**: Added strict choice validation for `--checklevel` and `--format` options, preventing silent false passes on invalid values.
- **High**: Added UTF-8 BOM tolerance (`\uFEFF`) when reading user `.luarc.json` configuration files.
- **High**: Prevented `init` from silently overwriting existing `.luarc.json` configurations and generating machine-specific absolute library paths.
- **High**: Fixed `--ignore` wiping out default structural exclusions (`node_modules`, `.git`, `dist`, `bin`, `vendor`, etc.).
- **Medium**: Formatted top-level CLI error messages cleanly without verbose stack traces unless `DEBUG` is set.
- **Medium**: Removed deleted temporary `outputPath` field from `CheckResult`.
- **Medium**: Added subprocess timeout (120s) and fetch retry with exponential backoff for LuaLS downloads.
- **Medium**: Aligned `countCheckedFiles` glob matching (`*.lua`, `**/*.lua`) with LuaLS exclusion semantics.
- **Low**: Fixed `fileUriToPath` handling of UNC paths, malformed percent encodings, and normalized Windows drive letter URIs on POSIX environments (Linux & macOS).
- **Low**: Escaped commas (`%2C`) in GitHub Actions annotation file paths.

## [2.1.0] - 2026-09-22

### Added

- `-i/--ignore` option with glob pattern matching for CLI and GitHub Action input (`action.yml`).
- Total count of checked files in terminal output upon passing diagnosis (`Diagnosis completed, no problems found across N files`).

### Fixed

- Applied universal two-space symbol padding across all platforms for consistent alignment in terminal output.

## [2.0.1] - 2026-09-22

### Added

- Error and warning breakdown in terminal problem summary (`N errors, M warnings across X files`).

### Fixed

- Automatic pluralization of nouns ("problem", "warning", "error", "file") in CLI report output.
- Prevented LuaLS check from hanging indefinitely when running with default positional path inside a directory containing the tool itself or a cached LuaLS binary.

## [2.0.0] - 2026-09-22

### Changed

- **Breaking**: Require Node.js `>= 24.0.0` (`engines.node: ">=24.0.0"`).
- Replaced deprecated `Command#addHelpCommand` with `Command#helpCommand` in Commander setup, enabling `@typescript-eslint/no-deprecated` rule.

### Added

- Node.js 26 to CI test matrix on Ubuntu and Windows runners.
- Submodule tracking upstream `nanos-world-vscode-extension` (`docgen-output` branch) under `vendor/nanos-world-vscode-extension`, loading `annotations.lua` directly from the submodule and removing `definitions/` directory and custom sanitizers.
- Automated daily synchronization workflow (`.github/workflows/sync-annotations.yml`) at 01:00 UTC to track upstream annotations updates.
- Direct execution detection (`isDirectExecution`) in `dist/cli.js` so it executes CLI commands immediately when invoked directly via `node`.
- Smoke tests and regression test suite for CLI entrypoints and launcher scripts.

### Fixed

- Fixed Windows batch launcher (`bin/nanos-lint.cmd`) errorlevel propagation on non-zero exit codes.
- Ensured `dist/` is compiled before running CLI integration tests in CI.

## [1.2.0] - 2026-09-22

### Changed

- Migrated bundler from `tsup` to `tsdown` (`v0.23.0`) powered by Rolldown, compiling standalone bundles targeting Node.js 24.
- Rewrote CLI argument parsing with `commander` (`v15.0.0`), supporting `check`, `init`, `download-luals`, and `version` subcommands.
- Configured `tsdown.config.ts` with `deps.alwaysBundle: ["commander"]` to maintain zero external runtime dependencies.
- Configured Dependabot with `npm` package ecosystem and pinned TypeScript < 6.1.0 to prevent peer dependency conflicts.

## [1.1.2] - 2026-09-21

### Security

- Hardened release workflow by requiring `workflow_run` events to originate from upstream `push` events (ignoring `pull_request` and preventing unauthorized fork triggers).

## [1.1.1] - 2026-09-21

### Added

- Pre-release test matrix job (Ubuntu and Windows) in release workflow before building and publishing.

### Changed

- Chained release workflow to execute upon successful completion of CI workflow via GitHub Actions `workflow_run` on `master`.

### Fixed

- Added automated detection of release tags on HEAD using `git tag --points-at`, cleanly skipping untagged runs.

## [1.1.0] - 2026-09-21

### Added

- JSONC support in `.luarc.json` configuration files (support for comments and trailing commas).
- Respect for `NO_COLOR` environment variable convention and TTY detection in reporter output.
- CLI validation for unrecognized flags and missing required options.

### Fixed

- Added 10-second timeout to GitHub API LuaLS version resolution fetch.
- Guaranteed temporary check configuration file cleanup in `finally` block.
- Escaped single quotes in PowerShell `Expand-Archive` command on Windows.
- Tightened `Diagnostic.severity` typing to `1 | 2 | 3 | 4`.

## [1.0.0] - 2026-09-21

### Added

- Initial release of `nanos-lint`.
- Lua Language Server (LuaLS) integration targeting Lua 5.4.9 for nanos world scripts.
- Automatic download and caching of platform-specific LuaLS standalone binaries (Windows x64, Linux x64, macOS).
- Built-in nanos world API definitions bundled from `nanos-world/vscode-extension`.
- CLI commands: `check`, `init`, and `download-luals`.
- Multiple report formatters: human-readable terminal output, JSON output (`--format=json`), and GitHub Actions workflow annotations (`--format=github`).
- GitHub Action composite action (`action.yml`) for automated CI linting.
- Multi-platform CI/CD release workflow for npm publishing and GitHub Releases.

### Fixed

- Normalized LuaLS file URI schemes across Windows (`file:///C:/...`) and Linux/POSIX (`file:///...`).
