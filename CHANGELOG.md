# Changelog

All notable changes to `nanos-lint` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [2.1.0] - 2026-08-01

### Added
- Complete nanos world API definitions integration from upstream vscode extension.
- Multi-platform LuaLS standalone binary download and caching.
- Formatter support for pretty terminal output, JSON output, and GitHub Actions workflow annotations.

