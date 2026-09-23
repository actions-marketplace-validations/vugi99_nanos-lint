# Agent Guidelines for `nanos-lint`

This document outlines the architectural principles, codebase structure, development philosophy, and mandatory quality gates for any AI agent or contributor working on this repository.

---

## 1. Project Overview & Tech Stack

`nanos-lint` is a dedicated linter and type-checker for **nanos world** Lua scripts (Lua 5.4.9), powered by the **Lua Language Server (LuaLS)**.

- **Runtime**: Node.js (>=24)
- **Language**: TypeScript 6 (ES2022 / NodeNext modules)
- **Bundler**: `tsdown` 0.23 (powered by Rolldown, compiles `src/` to a standalone `dist/` targeting Node.js 24 with zero runtime dependencies)
- **Testing**: `vitest` 5 (unit tests and live LuaLS integration tests)
- **Linting & Code Quality**: `eslint` 10 (flat config `eslint.config.mjs` with `typescript-eslint`)
- **API Definitions**: Upstream repository `https://github.com/nanos-world/vscode-extension` (`docgen-output` branch), loaded via bundled `annotations.lua` or dynamic date-based user cache

---

## 2. Core Philosophy

1. **Zero-Dependency Runtime for End Users**:
   - The compiled package published to npm and packaged in release bundles must not require any external runtime `node_modules`. All utility functions must rely on Node.js built-ins (`node:fs`, `node:path`, `node:child_process`, `node:os`, `node:util`).
2. **First-Class Cross-Platform Support**:
   - Must execute identically on **Windows x64**, **Linux (x64, arm64)**, and **macOS (Apple Silicon arm64, Intel x64)**.
   - Paths inside `.luarc.json` and URI schemes must be properly normalized (forward slashes, handling of Windows drive letters like `C:/`).
   - LuaLS binary downloading and extraction must use cross-platform extraction (`tar` with PowerShell `Expand-Archive` fallback on Windows).
3. **Respect Workspace Configurations**:
   - `nanos-lint` must never overwrite or ignore user workspace `.luarc.json` configurations.
   - When a user provides custom settings or disabled diagnostics, `src/config.ts` merges them on top of the base template while ensuring nanos world annotations are included in `workspace.library`.

---

## 3. Repository Layout

```
nanos-lint/
├── .github/workflows/       # CI, CD Release, and Annotations Sync workflows
├── .githooks/               # Git hooks (pre-commit quality gates)
├── action.yml               # GitHub Action composite definition
├── bin/nanos-lint.js        # Executable CLI entrypoint (#!/usr/bin/env node)
├── templates/               # Default base .luarc.json template (Lua 5.4, globals)
├── src/
│   ├── types.ts             # Type definitions
│   ├── config.ts            # Configuration discovery, merging, and init
│   ├── luals.ts             # Binary download, caching, and execution manager
│   ├── reporter.ts          # Terminal pretty, JSON, and GitHub Actions annotation formatters
│   ├── cli.ts               # CLI command-line parser
│   └── index.ts             # Public programmatic exports
├── tests/
│   ├── pass/                # Valid nanos world Lua fixtures (must pass with 0 errors)
│   ├── fail/                # Invalid Lua fixtures (must produce expected diagnostics)
│   ├── unit/                # Vitest unit tests
│   └── integration/         # Vitest integration tests with live LuaLS execution
├── AGENTS.md                # This guideline document
├── CHANGELOG.md             # Keep a Changelog 1.1.0 version history
├── README.md                # User-facing documentation
└── SECURITY.md              # Security policy and reporting instructions
```

---

## 4. Mandatory Quality Gates for Agents

Whenever you make any changes to this repository, **you must execute and pass all of the following commands before completing your work**:

```bash
# 1. Lint the codebase (must have 0 errors and 0 warnings)
npm run lint

# 2. Type-check TypeScript (must produce 0 type errors)
npm run typecheck

# 3. Build distribution bundle
npm run build

# 4. Run all Vitest unit and live LuaLS integration tests with coverage thresholds (must be 100% passing)
npm run test:coverage
```

These quality gates are automated in `.githooks/pre-commit` (configured via `git config core.hooksPath .githooks`), running on every `git commit`.

If any of the above commands fail or emit warnings, investigate and fix them before responding to the user.

Additionally, whenever you make changes to the codebase, **you must update `CHANGELOG.md`** under the `## [Unreleased]` section with concise bullet points categorized under standard Keep a Changelog headings (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`).

---

## 5. Releases & Changelog Maintenance

### Continuous Maintenance (After Every Change)
- **Always update `CHANGELOG.md` after making changes**: Any modification to the codebase (features, bug fixes, performance improvements, documentation, CI workflows, or internal tooling) must be documented in `CHANGELOG.md` under the `## [Unreleased]` section before completing your work.
- **Standardized Categories**: Group changes strictly under Keep a Changelog 1.1.0 categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`.

### Release Preparation & Publishing
Whenever preparing or publishing a new tagged release or cutting a new version:
- **Review and verify `CHANGELOG.md`**: Check that all unreleased changes since the previous release are accurately recorded under `## [Unreleased]`.
- **Promote Unreleased to Version Header**: Move all unreleased changes under a new version heading strictly adhering to [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (e.g. `## [X.Y.Z] - YYYY-MM-DD`), and restore an empty `## [Unreleased]` section above it.
- **Pre-Release Requirement**: Record and commit the target version number, release date, and comprehensive list of changes in `CHANGELOG.md` before creating or pushing the release tag.


