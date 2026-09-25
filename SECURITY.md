# Security Policy

## Supported Versions

| Version  | Supported          |
| -------- | ------------------ |
| >= 3.1.0 | :white_check_mark: |
| < 3.1.0  | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within `nanos-lint`, please report it responsibly:

1. **Do not open a public GitHub issue.**
2. Report it privately via [GitHub Security Advisories](https://github.com/vugi99/nanos-lint/security/advisories/new).
3. Include detailed steps to reproduce the issue, along with relevant environment details (Node.js version, OS, LuaLS version).

We take security seriously and appreciate your cooperation in disclosing issues privately so that we can patch them promptly.

## Binary Asset Integrity & Verification Model

`nanos-lint` downloads prebuilt LuaLS releases directly from upstream GitHub releases (`LuaLS/lua-language-server`). To harden this pipeline against supply-chain tampering and unauthorized execution:

- **Strict Protocol and Host Allowlisting**: Download requests and HTTP redirects must use HTTPS and stay on GitHub infrastructure (`github.com` and `githubusercontent.com`, including their subdomains such as `objects.githubusercontent.com` and `raw.githubusercontent.com`).
- **Archive Checksum Auditing**: Every downloaded release archive is hashed with SHA-256 in bounded memory and the digest is logged when verbose logging is enabled (`NANOS_LOG_LEVEL=info` or `--log-level info`). Upstream publishes no signed checksums, so the digest is recorded for traceability and out-of-band comparison rather than verified against a pinned value; for strict pinning, use a pre-verified local binary instead.
- **Archive Size Bounds and Timeout**: Downloads enforce a 120-second timeout and a 150 MB upper bound on the compressed archive to mitigate resource exhaustion.
- **Custom / Air-gapped Executables**: Users and enterprise environments with strict binary pinning or air-gapped runners can supply pre-verified local binaries via `LUALS_BIN` or `--luals-bin` (a regular file that reports its version via `--version`, including wrapper scripts), or run `nanos-lint warmup` during trusted build image construction.
