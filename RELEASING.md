# RELEASING — how to cut a release of the YouTube plugin

A step-by-step runbook for shipping a new version of this plugin. This repo is the
**canonical source** — there's no host baseline to sync. Cutting a release means
publishing a GitHub Release that attaches two files:

- **`youtube.zip`** — the installable plugin (`manifest.json` + `index.js`, with
  `manifest.json` at the ZIP **root**).
- **`update.json`** — the small manifest the host polls to detect new versions.

The host app reaches these at the permanent "latest" URLs:

- `https://github.com/outcast1000/viboplr-youtube/releases/latest/download/update.json`
- `https://github.com/outcast1000/viboplr-youtube/releases/latest/download/youtube.zip`

The host checks `update.json` every ~24h (it's wired via `manifest.json`'s
`updateUrl`), so a published release auto-updates installed copies.

---

## The mental model

A release is just **a git tag `vX.Y.Z` + a GitHub Release carrying the two
artifacts**. There are three invariants that must all hold, or the release is
broken:

1. **`manifest.json`'s `version` equals the release version** (`X.Y.Z`, no `v`).
2. **The tag is `vX.Y.Z`** (with the `v`).
3. **`youtube.zip` has `manifest.json` at its root** (no wrapper folder — the
   host's installer does not strip one).

CI enforces #1 and #3 and fails loudly otherwise. When you release manually you
are responsible for all three. `scripts/package.sh` guarantees #3 for you.

---

## Preferred path: bump → commit → tag → let CI publish

This is what "cut a release" normally means here. CI (`.github/workflows/release.yml`)
does the building and publishing; you just prepare the version and push a tag.

### 1. Make your code/manifest changes
Edit `index.js` / `manifest.json` as needed and make sure tests pass locally:

```bash
node --check index.js   # syntax gate
node --test             # test suite
```

(These are the exact two commands CI runs as a release gate.)

### 2. Bump the version
```bash
scripts/bump.sh patch      # 1.5.0 -> 1.5.1
# or: scripts/bump.sh minor # 1.5.0 -> 1.6.0
# or: scripts/bump.sh major # 1.5.0 -> 2.0.0
# or: scripts/bump.sh 1.5.1 # set an explicit version
```

This rewrites `version` in `manifest.json` and prepends a `## vX.Y.Z` section to
`CHANGELOG.md` with a `TODO` placeholder. It does **not** commit, tag, or push.

### 3. Write the changelog
Edit the new `## vX.Y.Z` section at the top of `CHANGELOG.md` — replace the
`TODO` with real notes. This matters beyond bookkeeping:

- `scripts/package.sh` copies the **top-most `## ` section** into `update.json`'s
  `changelog` field (what the host shows users).
- The whole `CHANGELOG.md` is used as the GitHub Release notes (`--notes-file`).

### 4. Commit
```bash
git add manifest.json CHANGELOG.md index.js
git commit -m "Release vX.Y.Z"
```

### 5. Tag and push — this triggers CI
```bash
git tag vX.Y.Z
git push origin main vX.Y.Z
```

Pushing a `v*` tag fires the **Release** workflow, which:
1. Runs `node --check index.js` and `node --test` (gate).
2. Resolves the version from the tag (`refs/tags/vX.Y.Z` → `X.Y.Z`).
3. **Verifies `manifest.json` version == release version** — fails if you forgot
   to bump.
4. Runs `scripts/package.sh` to build `youtube.zip` + `update.json`.
5. **Verifies the zip has `manifest.json` at its root.**
6. `gh release create vX.Y.Z youtube.zip update.json --title "vX.Y.Z" --notes-file CHANGELOG.md`.

When the workflow is green, the release exists and the "latest" URLs resolve to
the new artifacts.

### Alternative trigger: manual dispatch (still CI)
If you don't want to push a tag yourself: **GitHub → Actions → Release → Run
workflow**, enter the version (must equal `manifest.json`'s `version`). CI creates
the tag for you and publishes. Same invariants apply.

---

## Fallback path: fully manual (no CI)

Use this only if CI is unavailable. You replicate what the workflow does, by hand.
Requires the [`gh` CLI](https://cli.github.com/) authenticated for
`outcast1000/viboplr-youtube`, plus `node`, `zip`, `unzip`.

### 1. Prepare exactly as in the preferred path
Do steps 1–4 above (changes → `scripts/bump.sh` → write changelog → commit). The
working tree must have `manifest.json`'s `version` already set to the target
`X.Y.Z`.

### 2. (Recommended) run the same gate CI runs
```bash
node --check index.js
node --test
```

### 3. Build the artifacts
```bash
scripts/package.sh
```
This produces, in the repo root:
- `youtube.zip` — `zip -q youtube.zip manifest.json index.js` (so `manifest.json`
  is at the root). It prints `unzip -l youtube.zip` — **confirm `manifest.json`
  appears with no directory prefix.**
- `update.json` — `{ version, file, minAppVersion?, changelog? }`, where `file`
  points at the permanent `releases/latest/download/youtube.zip` URL and
  `changelog` is the top `## ` section of `CHANGELOG.md`.

> Never hand-zip the folder — that produces a wrapper directory and the host
> installer will fail to find `manifest.json`. Always use `scripts/package.sh`.

### 4. Tag the commit
```bash
git tag vX.Y.Z
git push origin main vX.Y.Z
```

### 5. Create the release with both artifacts
```bash
gh release create vX.Y.Z youtube.zip update.json \
  --repo outcast1000/viboplr-youtube \
  --title "vX.Y.Z" \
  --notes-file CHANGELOG.md
```
(`scripts/package.sh` prints this exact command at the end for convenience.)

`youtube.zip` and `update.json` are build outputs — they're git-ignored and live
only on the Release, not in the repo. You can delete the local copies afterward.

---

## After releasing

- **Verify the live endpoints** resolve to the new version:
  ```bash
  curl -sL https://github.com/outcast1000/viboplr-youtube/releases/latest/download/update.json
  ```
  The `version` should be your new `X.Y.Z`.
- **Update the gallery index only if metadata changed materially** (name,
  description, `minAppVersion`): edit `index.json` in
  `outcast1000/viboplr-plugins`. Routine version bumps do **not** need this — the
  gallery resolves `updateUrl` to the latest release dynamically.

---

## Quick reference

| Thing | Value |
| --- | --- |
| Plugin id (do not change) | `youtube` (in `manifest.json`) |
| Version to bump | `manifest.json` → `version` (use `scripts/bump.sh`) |
| Tag format | `vX.Y.Z` (with `v`); manifest version is `X.Y.Z` (no `v`) |
| Build command | `scripts/package.sh` → `youtube.zip` + `update.json` |
| Publish command | `gh release create vX.Y.Z youtube.zip update.json --repo outcast1000/viboplr-youtube --title "vX.Y.Z" --notes-file CHANGELOG.md` |
| CI workflow | `.github/workflows/release.yml` (trigger: push `v*` tag, or manual dispatch) |
| Release gate | `node --check index.js` && `node --test` |
| Update endpoint | `.../releases/latest/download/update.json` |

## Common failure modes

- **CI "manifest version does not match release version":** you tagged/dispatched
  `vX.Y.Z` but `manifest.json` still says the old version. Run `scripts/bump.sh`,
  commit, re-tag.
- **Host won't install the zip:** `manifest.json` isn't at the zip root — you
  hand-zipped instead of using `scripts/package.sh`.
- **Tag already exists:** delete it (`git tag -d vX.Y.Z && git push origin :vX.Y.Z`)
  or bump to a new version. CHANGELOG/`bump.sh` also refuse to reuse a version that
  already has a `## vX.Y.Z` section.
- **Users don't see the update:** the host polls ~every 24h; it's not instant.
  Confirm the `latest/download/update.json` endpoint shows the new version.
