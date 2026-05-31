# CLAUDE.md — viboplr-youtube

This file orients Claude Code working in this repository.

## What this repo is

This is a **plugin for the Viboplr desktop app** — NOT a standalone application.
Viboplr is a Tauri 2 desktop music app (Rust backend + React/TypeScript frontend);
its source lives in the separate host repo **`outcast1000/viboplr`** (likely not
checked out on this machine). This repo is the **canonical source** of the YouTube
plugin and ships it as a versioned release that the host app downloads and
auto-updates. The host does **not** bundle a copy — the plugin gallery
(`outcast1000/viboplr-plugins`, index-only) is the install channel, resolving this
repo's `updateUrl` to its latest release zip.

- **Plugin id:** `youtube` (set in `manifest.json`).
- **What it does:** contributes a **stream resolver** (`youtube-fallback`) used as a
  playback fallback when a track has no native source, and a **download provider**
  (`youtube-download`). Both shell out to `yt-dlp` (audio) and `ffmpeg` (conversion)
  via the host's allow-listed `api.system.exec`. Downloads are cached on disk (LRU,
  keyed by video id) with a configurable size limit.

## The plugin runtime (host-imposed — do not assume a normal Node/browser env)

The host runs `index.js` as the body of `new Function("api", "window", "globalThis",
"self", "document", code)` inside the app's WebView. Consequences:

- The file **must end with** `return { activate, deactivate };` (deactivate optional).
  The host calls `activate(api)` on load.
- `api` (the host bridge) is the ONLY way to talk to the app. Full API reference
  lives in the host repo's `PLUGIN-API-REFERENCE.md`; pieces this plugin uses:
  `api.network.fetch` (proxied through Rust to bypass CORS — there is **no global
  `fetch`**), `api.system.exec` (allow-listed: `yt-dlp`, `ffmpeg`),
  `api.storage` (KV + nested files under the plugin's data dir),
  `api.playback.onStreamResolve`, `api.downloads.onResolveByMetadata` /
  `onResolveByUri` / `onGetQualities`, `api.ui.setViewData` (settings panel),
  `api.log(level, msg, section)`, `api.network.openUrl`.
- The sandbox is a **frozen** set of globals: `console`, `Math`, `JSON`, `Date`,
  `Promise`, `Object`, `Array`, `String`, `Number`, `RegExp`, `Error`, timers,
  `encode/decodeURIComponent`, `parseInt/parseFloat/isNaN/isFinite`. **No** `require`/
  `import`, no real DOM, no filesystem. Modern JS syntax is fine (no transpile step),
  but this file uses `var`/`function` style by convention — match it.

## Critical gotchas (have caused real bugs)

- **Manifest id vs folder name:** the host keys the plugin by the **manifest `id`**
  (`youtube`), not the directory name (`viboplr-youtube`). Keep `manifest.json`'s
  `"id": "youtube"` unchanged.
- **Release zip layout:** `youtube.zip` MUST have `manifest.json` at its ROOT (the
  host's installer does not strip a wrapper folder). `scripts/package.sh` guarantees
  this — never hand-zip a folder.
- **External binaries:** `yt-dlp`/`ffmpeg` must be on the app's `PATH`. The settings
  panel surfaces install state; resolves no-op (returning `null`) when `yt-dlp` is
  missing rather than throwing.
- **No browser/Tauri dev harness exists** for plugins. The realistic dev loop is to
  install/symlink this folder into the host app and reload. See `DEVELOPING.md`.

## How to release (this is the canonical source — no host baseline to sync)

See `README.md` → *Develop & Release*. In short:
1. Edit `index.js` / `manifest.json`; **bump the version** (`scripts/bump.sh patch|minor|major`).
2. Update `CHANGELOG.md` (top `## vX.Y.Z` section).
3. Push a tag `vX.Y.Z` (or run the *Release* GitHub Action manually) — CI builds
   `youtube.zip` + `update.json` and publishes the release. The host checks the
   permanent `releases/latest/download/update.json` every 24h.
4. If the plugin's metadata changed materially (name/description/minAppVersion),
   update its entry in the gallery index repo `outcast1000/viboplr-plugins`
   (`index.json`).

## Docs in this repo

- `README.md` — requirements, install + release flow
- `DEVELOPING.md` — plugin develop/debug workflow (sandbox, reload loop, DevTools, `api.log`)
- `CHANGELOG.md` — per-version notes (top section feeds the release notes)
