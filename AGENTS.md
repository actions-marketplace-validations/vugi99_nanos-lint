# Agent Guidelines for `nanos-lint`

This document outlines the architectural principles, codebase structure, development philosophy, and mandatory quality gates for any AI agent or contributor working on this repository.

---

## 1. Project Overview & Tech Stack

`nanos-lint` is a dedicated linter and type-checker for **nanos world** Lua scripts (Lua 5.4.9), powered by the **Lua Language Server (LuaLS)**.

- **Runtime**: Node.js (>=20)
- **Language**: TypeScript 6 (ES2022 / NodeNext modules)
- **Bundler**: `tsdown` 0.23 (powered by Rolldown, compiles `src/` to a standalone `dist/` targeting Node.js 24 with zero runtime dependencies)
- **Testing**: `vitest` 5 (unit tests and live LuaLS integration tests)
- **Linting & Code Quality**: `eslint` 10 (flat config `eslint.config.mjs` with `typescript-eslint`)
- **API Definitions**: Upstream submodule tracking `https://github.com/nanos-world/vscode-extension` (`docgen-output` branch), loaded directly via `vendor/nanos-world-vscode-extension/annotations.lua`

---

## 2. Core Philosophy

1. **Zero-Dependency Runtime for End Users**:
   - The compiled package published to npm and packaged in release bundles must not require any external runtime `node_modules`. All utility functions must rely on Node.js built-ins (`node:fs`, `node:path`, `node:child_process`, `node:os`, `node:util`).
2. **First-Class Cross-Platform Support**:
   - Must execute identically on **Windows x64** and **Linux amd64** (plus macOS).
   - Paths inside `.luarc.json` and URI schemes must be properly normalized (forward slashes, handling of Windows drive letters like `C:/`).
   - LuaLS binary downloading and extraction must use cross-platform extraction (`tar` with PowerShell `Expand-Archive` fallback on Windows).
3. **Respect Workspace Configurations**:
   - `nanos-lint` must never overwrite or ignore user workspace `.luarc.json` configurations.
   - When a user provides custom settings or disabled diagnostics, `src/config.ts` merges them on top of the base template while ensuring `vendor/nanos-world-vscode-extension` annotations are included in `workspace.library`.

---

## 3. Repository Layout

```
nanos-lint/
├── .github/workflows/       # CI, CD Release, and Annotations Sync workflows
├── action.yml               # GitHub Action composite definition
├── bin/nanos-lint.js        # Executable CLI entrypoint (#!/usr/bin/env node)
├── templates/               # Default base .luarc.json template (Lua 5.4, globals)
├── vendor/                  # Submodule for upstream nanos-world vscode-extension
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
└── README.md                # User-facing documentation
```

---

## 4. Mandatory Quality Gates for Agents

Whenever you make any changes to this repository, **you must execute and pass all of the following commands before completing your work**:

```bash
# 1. Lint the codebase (must have 0 errors and 0 warnings)
npm run lint

# 2. Type-check TypeScript (must produce 0 type errors)
npm run typecheck

# 3. Run all Vitest unit and live LuaLS integration tests (must be 100% passing)
npm test

# 4. Build distribution bundle
npm run build
```

If any of the above commands fail or emit warnings, investigate and fix them before responding to the user.

