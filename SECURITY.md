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

## Download Integrity & Verification Model

`nanos-lint` downloads prebuilt LuaLS releases directly from upstream GitHub releases (`LuaLS/lua-language-server`) and the nanos world API annotations from the upstream `docgen-output` branch. To harden these pipelines against supply-chain tampering and unauthorized execution:

- **Strict Protocol and Host Allowlisting**: Every outbound request — the LuaLS release archive, the annotations download, the annotations commit lookup and the LuaLS latest-release lookup — must use HTTPS and stay on GitHub infrastructure (`github.com` and `githubusercontent.com`, including their subdomains such as `objects.githubusercontent.com` and `raw.githubusercontent.com`). HTTP redirects are resolved **hop by hop** in `redirect: "manual"` mode (`src/download-guard.ts`), so each hop is validated before it is contacted: a redirect to any other host, a scheme downgrade to plaintext `http://`, a target such as an internal or link-local address, a 3xx without a usable `Location` header, and a redirect chain longer than five hops are all refused. `Authorization`, `Cookie` and `Proxy-Authorization` are dropped as soon as a hop leaves the origin of the original request, mirroring the credential stripping a runtime performs when it follows a redirect itself. Every runtime download goes through this guard, including the LuaLS release archive in `src/luals/download.ts`, and the release-packaging tooling (`scripts/packaging/verify.ts`, `scripts/package-release.ts`) reuses the same guard rather than a second implementation. A refusal is logged as a warning at the default log level, an annotations download fails fast with `ERR_ANNOTATIONS_DOWNLOAD`, an archive download fails fast with `ERR_LUALS_DOWNLOAD` without retrying, and the refused response body is discarded rather than cached.
- **Archive Checksum Auditing**: Every downloaded release archive is hashed with SHA-256 in bounded memory and the digest is logged when verbose logging is enabled (`NANOS_LOG_LEVEL=info` or `--log-level info`). Upstream publishes no signed checksums, so the digest is recorded for traceability and out-of-band comparison rather than verified against a pinned value; for strict pinning, use a pre-verified local binary instead.
- **Archive Size Bounds and Timeout**: Downloads enforce a 120-second timeout and a 150 MB upper bound on the compressed archive to mitigate resource exhaustion.
- **Annotations Content Is Not Digest-Pinned**: The transport controls above cannot make annotations content trustworthy by itself, and upstream publishes no signed digest for `annotations.lua`. The cached file is accepted when it is at least 1000 bytes and matches the nanos world annotations shape, and the resolved commit id is recorded in `metadata.json` as an audit trail only. `annotations.lua` is parsed by LuaLS and never executed, so a tampered file can change which programs type-check cleanly but cannot run code. For strict pinning, supply a reviewed file with `--annotations <path>` or the `NANOS_ANNOTATIONS_PATH` environment variable.
- **Custom / Air-gapped Executables**: Users and enterprise environments with strict binary pinning or air-gapped runners can supply pre-verified local binaries via `LUALS_BIN` or `--luals-bin` (a regular file that reports its version via `--version`, including wrapper scripts), or run `nanos-lint warmup` during trusted build image construction.
