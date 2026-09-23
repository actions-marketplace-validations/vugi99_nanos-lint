# Security Policy

## Supported Versions

| Version  | Supported          |
| -------- | ------------------ |
| >= 2.8.0 | :white_check_mark: |
| < 2.8.0  | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within `nanos-lint`, please report it responsibly:

1. **Do not open a public GitHub issue.**
2. Report it privately via [GitHub Security Advisories](https://github.com/vugi99/nanos-lint/security/advisories/new).
3. Include detailed steps to reproduce the issue, along with relevant environment details (Node.js version, OS, LuaLS version).

We take security seriously and appreciate your cooperation in disclosing issues privately so that we can patch them promptly.

## Binary Asset Integrity & Verification Model

`nanos-lint` downloads prebuilt LuaLS releases directly from upstream GitHub releases (`LuaLS/lua-language-server`). To harden this pipeline against supply-chain tampering and unauthorized execution:

- **Strict Protocol and Host Allowlisting**: Download requests and HTTP redirects are strictly enforced to HTTPS on allowlisted GitHub infrastructure (`github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`).
- **Archive Checksum Auditing**: Every downloaded release archive is hashed using SHA-256 upon receipt and logged for traceability.
- **Archive Size Bounds and Timeout**: Downloads enforce a 120-second timeout and a 150 MB upper bound to mitigate resource exhaustion.
- **Custom / Air-gapped Executables**: Users and enterprise environments with strict binary pinning or air-gapped runners can supply pre-verified local binaries via `LUALS_BIN` or `--luals-bin`, or run `nanos-lint warmup` during trusted build image construction.


