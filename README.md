# nanos-lint

[![CI](https://github.com/vugi99/nanos-lint/actions/workflows/ci.yml/badge.svg)](https://github.com/vugi99/nanos-lint/actions/workflows/ci.yml)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org/)
[![Lua Version](https://img.shields.io/badge/Lua-5.4.9-blue.svg)](https://www.lua.org/manual/5.4/)
[![LuaLS Version](https://img.shields.io/badge/LuaLS-3.19.1-brightgreen.svg)](https://github.com/LuaLS/lua-language-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A dedicated, fast linter and type-checker for **[nanos world](https://nanos.world)** Lua scripts powered by the **[Lua Language Server (LuaLS)](https://github.com/LuaLS/lua-language-server)**.

---

## Features

- **Accurate nanos world Type Checking**: Bundles verified nanos world API annotations (Lua 5.4.9).
- **Zero-Install Local CLI**: Run directly via `npx nanos-lint [path]` without installing anything.
- **Native GitHub Action**: Use `vugi99/nanos-lint` directly in CI workflows with inline GitHub PR annotations.
- **Workspace Config Merging**: Fully respects local `.luarc.json` files, merging your project globals and disabled diagnostics on top of the nanos API.
- **Cross-Platform**: Works on **Windows x64** and **Linux amd64** (plus macOS). Automatically downloads and caches platform LuaLS binaries.
- **Modern Node.js Runtime**: Built targeting Node.js (>= 24) with zero runtime dependencies.

---

## Requirements

- **Node.js**: `>= 24.0.0` (required for npm/npx CLI usage; standalone release bundles include all dependencies)

---

## Quick Start

### 1. Run via `npx` (No installation needed)

Check the current directory:
```bash
npx nanos-lint
```

Check a specific directory or file:
```bash
npx nanos-lint check ./my-package
npx nanos-lint check ./my-package/Server/Index.lua
```

### 2. Global Installation

```bash
npm install -g nanos-lint

# Then use anywhere
nanos-lint check .
```

### 3. Setup VS Code / Neovim IntelliSense

To configure autocompletion, type annotations, and diagnostics in your local editor:
```bash
npx nanos-lint init
```
This generates a `.luarc.json` file in your workspace pointing to the nanos world definitions and schemas.

---

## GitHub Actions Integration

Add `nanos-lint` to your repository's workflow (e.g. `.github/workflows/lint.yml`):

```yaml
name: Lint Lua Scripts

on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7

      - name: Lint nanos world Lua scripts
        uses: vugi99/nanos-lint@v2
        with:
          path: '.'
          checklevel: 'Warning'
```

### Action Inputs

| Input | Description | Default |
| :--- | :--- | :--- |
| `path` | Path to workspace directory or Lua file to check | `.` |
| `checklevel` | Minimum severity to report (`Error`, `Warning`, `Information`, `Hint`) | `Warning` |
| `config` | Path to a custom `.luarc.json` configuration file | `""` |
| `luals-version` | Version of `lua-language-server` to use | `latest` |
| `fail-on-error` | Fail the workflow step if diagnostics are found | `true` |
| `quiet` | Suppress progress messages | `false` |

When running inside GitHub Actions, `nanos-lint` automatically outputs **workflow annotations** (`::error` / `::warning`) that appear inline on PR diffs.

---

## CLI Reference

```
nanos-lint [command] [options] [path]

COMMANDS:
  check [path]             Check a workspace or Lua file (default)
  init [path]              Scaffold a .luarc.json configuration in the workspace
  download-luals [version] Download and cache the LuaLS binary
  help, --help, -h         Show help message
  version, --version, -v   Show version information

OPTIONS:
  --checklevel=<level>     Minimum diagnostic level: Error, Warning, Information, Hint (default: Warning)
  --config=<path>          Path to custom .luarc.json configuration file
  --format=<format>        Output format: pretty, json, github (default: pretty)
  --luals-version=<ver>    Version of LuaLS to use (default: latest)
  --no-fail                Do not exit with code 1 if diagnostics are found
  --quiet                  Suppress progress output
```

---

## Workspace Configuration (`.luarc.json`)

If your project already has a `.luarc.json`, `nanos-lint` automatically merges it. Your custom settings (e.g., custom globals, disabled diagnostics, additional libraries) are retained, while nanos world definitions are injected in `workspace.library`:

```json
{
  "$schema": "https://raw.githubusercontent.com/LuaLS/lua-language-server/master/setting/schema.json",
  "diagnostics": {
    "disable": [
      "lowercase-global"
    ],
    "globals": [
      "MyCustomGlobal"
    ]
  }
}
```

---

## Standalone Binary Distributions (Offline / CD)

For environments without Node.js, pre-packaged release bundles containing the compiled `lua-language-server` binary and nanos-lint wrapper are available on the [Releases](https://github.com/vugi99/nanos-lint/releases) page:

- `nanos-lint-<version>-windows-x64.zip`
- `nanos-lint-<version>-linux-x64.tar.gz`

Simply extract the archive and run `./nanos-lint` (Linux) or `nanos-lint.cmd` (Windows).

---

## Development

```bash
# Clone with submodules
git clone --recursive https://github.com/vugi99/nanos-lint.git
cd nanos-lint

# Install dependencies
npm install

# Update annotations submodule from upstream
git submodule update --remote --merge

# Run ESLint
npm run lint

# Run type check
npm run typecheck

# Run Vitest test suite (unit + live LuaLS integration tests)
npm test

# Build distribution bundle
npm run build
```

See [AGENTS.md](AGENTS.md) for development philosophy and quality gate requirements.

---

## License

[MIT](LICENSE)
