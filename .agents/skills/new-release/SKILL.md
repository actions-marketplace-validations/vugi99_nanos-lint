---
name: new-release
description: Ship a new nanos-lint release from master — bump the npm version, drop security support for older versions, promote CHANGELOG Unreleased, bump the action.yml npx fallback, tag v<version>, and push.
whenToUse: Use when the user asks to ship, cut, or publish a new version/release of nanos-lint (for example "bump to 2.8.3", "release v2.9.0", "ship a new version"). Requires the target version as input.
---

# Ship a new `nanos-lint` Release

Cut a tagged release on `master`. The target version is **user input** — take it from the request (e.g. "release 2.8.3" → `VERSION=2.8.3`). If the user did not give a version, ask for one before doing anything else.

## Preconditions

1. **Resolve the version**: strip any leading `v` and validate it is exact SemVer (`X.Y.Z`). Everything below uses the bare version, while the Git tag, `action.yml`, and the CHANGELOG heading are prefixed appropriately.
2. **Verify the branch is `master`**: run `git branch --show-current` (and `git status`). If it is not `master`, **stop and report** — do not bump, tag, or push. Ask the user whether to switch to `master`; never create the tag from `dev`.
3. **Confirm the tree is clean**: uncommitted release changes are fine, but abort if there are unrelated staged/unstaged changes, or if the working tree is mid-merge/rebase.
4. **Confirm the tag does not exist yet**: `git tag -l "v$VERSION"` must be empty, and `npm view nanos-lint@$VERSION version` must not already resolve. Anchored tag handles are `vX.Y.Z`; `release.yml` requires the tag's version to equal `package.json`'s `version`.

## Steps

### 1. Bump the version with npm

```bash
npm version "$VERSION" --no-git-tag-version
```

- This updates `package.json` and `package-lock.json`. Use `--no-git-tag-version` so the commit and the `v$VERSION` tag are created once, deliberately, in steps 4–6 — after the CHANGELOG, `SECURITY.md`, and `action.yml` are all updated.
- Verify afterwards that `package.json` reports `$VERSION`.

### 2. Drop security support for `< $VERSION`

Update the Supported Versions table in `SECURITY.md` so the new version is the only supported line:

```markdown
| Version  | Supported          |
| -------- | ------------------ |
| >= X.Y.Z | :white_check_mark: |
| < X.Y.Z  | :x:                |
```

Record the drop in the CHANGELOG under the release's `### Security` heading, e.g. `- Dropped security support for versions < X.Y.Z in SECURITY.md.` (this matches how previous releases recorded it).

### 3. Update `CHANGELOG.md`

Per [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the AGENTS.md release rules:

- **Review the `## [Unreleased]` section** and confirm every change since the previous release is recorded accurately, grouped under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`.
- **Promote `Unreleased` to a version heading**: move all entries under `## [X.Y.Z] - YYYY-MM-DD` (today's date, `date -u +%Y-%m-%d`).
- **Restore an empty `## [Unreleased]` section** directly above the new version heading.
- If the release has no user-visible changes, do not invent entries — surface that to the user before tagging.

### 4. Bump the `action.yml` fallback version

Bump the pinned `npx --yes nanos-lint@<version>` fallback version in `action.yml` to `$VERSION`. This is the same instruction as the **Update the Action Fallback Version** bullet in AGENTS.md §5, and lines up with the adjacent comment:

```yaml
# Exact version: a range could run a different release than the pinned
# tag. Bump together with "version" in package.json.
npx --yes nanos-lint@X.Y.Z "${ARGS[@]}"
```

Leave the version comment in place; only the version number changes.

### 5. Commit the release

```bash
git add package.json package-lock.json CHANGELOG.md SECURITY.md action.yml
git commit -m "chore(release): v$VERSION"
```

Follow the existing `chore(release): vX.Y.Z` convention (see `git log`). The `.githooks/pre-commit` hook runs the full `npm run gates` suite, so the commit only succeeds when every quality gate passes — do not bypass it with `--no-verify`. If a gate fails, fix the underlying issue, update the CHANGELOG if needed, and retry.

Before committing for real, do a final consistency check:

- `package.json` `version` === `$VERSION` === the CHANGELOG heading === the `action.yml` npx version.
- The tag you are about to create is `v$VERSION`, which `release.yml` compares against `package.json`.

### 6. Create the tag and push

```bash
git tag -a "v$VERSION" -m "Release v$VERSION"
git push origin master
git push origin "v$VERSION"
```

- Push the commit **before** the tag so the tagged commit exists on the remote and the triggered CI/release run finds it.
- `release.yml` fires on the tag-triggered CI run: it verifies the tag matches `package.json`, builds all five standalone distributions, creates the GitHub Release with generated notes, updates the floating major tag, and publishes to npm via trusted publishing.
- Do not push tags with `--force`, and do not re-create an existing tag.

### 7. Post-Release: GitHub Marketplace Publishing

GitHub does not provide an API to publish or update actions on the GitHub Marketplace automatically, and the Marketplace strictly requires full Semantic Versioning (`MAJOR.MINOR.PATCH`, refusing floating tags like `v3`). After `release.yml` creates the GitHub Release for a release:

1. Navigate to the repository's Releases page on GitHub (`https://github.com/vugi99/nanos-lint/releases`).
2. Edit the newly created release (e.g. `v$VERSION`).
3. Check the **"Publish this Action to the GitHub Marketplace"** checkbox.
4. Save/update the release so the Marketplace catalog listing reflects the new release and displays up-to-date instructions to users (#4).

## Report Back

Summarize concisely:

- The released version and the tag pushed.
- The files changed (`package.json`, `package-lock.json`, `CHANGELOG.md`, `SECURITY.md`, `action.yml`, etc.).
- The old → new supported-versions range.
- That the `release.yml` run is triggered, and the link to it if available (`gh run list --workflow=release.yml`).
- A reminder for the admin to publish the release to GitHub Marketplace via the GitHub Releases Web UI (#4).

## Guardrails

- **Never tag or push from a branch other than `master`.** Stop and ask instead.
- **Never skip the CHANGELOG promotion** — `release.yml` enforces the tag/`package.json` match, and AGENTS.md requires the version, date, and change list to be committed before the tag.
- **Never `--no-verify`** past a failing quality gate.
- **Never force-push** the release tag or `master`.
- Issue management rules still apply: do not close issues and do not open or merge PRs unless the user explicitly asks.
