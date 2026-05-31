# Viboplr YouTube Plugin

Play and download tracks from YouTube inside Viboplr. The plugin contributes a
**stream resolver** (a playback fallback when a track has no native source) and a
**download provider**, both backed by [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
for fetching audio and [`ffmpeg`](https://ffmpeg.org/) for converting it to your
configured download format.

Plugin id: `youtube` (so an installed copy overrides the app's bundled built-in of
the same id, if any).

New to writing Viboplr plugins? See **[DEVELOPING.md](DEVELOPING.md)** for the
develop/reload/debug workflow.

## Requirements

This plugin shells out to external binaries via the host's allow-listed
`api.system.exec`:

- **`yt-dlp`** (required) — fetches the audio stream.
- **`ffmpeg`** (optional) — converts/transcodes downloads to the target format.
  Without it, downloads fall back to the source container as-is.

Both must be on the app's `PATH`. The plugin's **Settings → YouTube** panel shows
which are installed and links to their install pages.

## Install

In Viboplr: **Extensions → Install from URL** and paste this repo's URL, or it
auto-updates if already installed (the app checks `updateUrl` every 24h).

## Develop & Release

For every release: edit `index.js` / `manifest.json`, **bump `version` in
`manifest.json`**, and add a `## vX.Y.Z` section at the top of `CHANGELOG.md`.
Then publish via CI (preferred) or manually.

Bump helper: `scripts/bump.sh <patch|minor|major|X.Y.Z>` rewrites the
`manifest.json` version and prepends a `## vX.Y.Z` CHANGELOG section (with a
`TODO` to fill in). It does not commit/tag/push — review, fill in the changelog,
then release.

### Release via CI (preferred)

A GitHub Actions workflow (`.github/workflows/release.yml`) builds and publishes
the release. It verifies the `manifest.json` version matches the release version
and that the zip has `manifest.json` at its root, then attaches `youtube.zip` +
`update.json`. Two ways to trigger it:

- **Push a tag:** after committing the version bump + changelog, run
  `git tag vX.Y.Z && git push origin vX.Y.Z`.
- **Manual dispatch:** GitHub → Actions → *Release* → *Run workflow*, enter the
  version (must equal `manifest.json`). CI creates the tag for you.

### Release manually (fallback)

1. `scripts/package.sh` → produces `youtube.zip` + `update.json`.
   - The zip MUST contain `manifest.json` at its root (the script guarantees this;
     verify via the printed `unzip -l`).
2. `gh release create vX.Y.Z youtube.zip update.json --repo outcast1000/viboplr-youtube --title "vX.Y.Z" --notes-file CHANGELOG.md`

The update endpoint is the permanent
`https://github.com/outcast1000/viboplr-youtube/releases/latest/download/update.json`.
