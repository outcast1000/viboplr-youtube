# Match YouTube plugin UI to the TIDAL plugin

Date: 2026-06-04

## Goal

Restyle the YouTube plugin's **search view** and **settings panel** so they match
the visual language of the TIDAL plugin (`outcast1000/viboplr-tidal`). No tabs —
YouTube search returns only videos, so a single results list is correct.

## Reference

TIDAL's `renderSearchView`/`renderSettings` (in `viboplr-tidal/index.js`) establish
the target style:
- A colored `ds-banner` health/status row at the top of the search view, with a
  small secondary button.
- A `search-input` with a visible `buttonLabel: "Search"`.
- A `track-row-list` whose toolbar actions carry icons (`▶`, `+`, `⬇`) and whose
  rows are individually clickable (`action` per row).
- Empty/prompt text carries `className: "ds-empty"`.
- Settings buttons carry `ds-btn ds-btn--sm ds-btn--{secondary,accent}` classes.

## Search view changes (`renderSearchView`)

### 1. Status banner

A horizontal `ds-banner` layout reflecting tool availability, with a "Refresh"
button (`ds-btn ds-btn--sm ds-btn--secondary`, action `youtube-refresh`):

| State | Banner class | Text |
| --- | --- | --- |
| `checking` | `ds-banner` (neutral) | "Checking dependencies…" |
| `yt-dlp` missing | `ds-banner ds-banner--error` | "yt-dlp is not installed — open YouTube settings to install it" |
| `yt-dlp` ok, `ffmpeg` missing | `ds-banner ds-banner--warning` | "ffmpeg not installed — downloads are served without conversion" |
| both present | `ds-banner ds-banner--success` | "Ready — yt-dlp <ver>, ffmpeg <ver>" |

### 2. Search input

Switch from `submitOnly` to TIDAL's style:
`{ type: "search-input", placeholder: "Search YouTube...", action: "youtube-search-submit", value: searchQuery, buttonLabel: "Search" }`.

### 3. Results list

`track-row-list` gains icon-labeled toolbar actions and per-row click-to-play:
- Toolbar: `{ ▶ Play → youtube-play }`, `{ + Queue → youtube-queue }`,
  `{ ⬇ Download → youtube-download }`.
- Each row: `action: "youtube-play-one"` (plays that single video).
- Result item ids stay the bare `videoId` (existing `findResult` lookup unchanged).

### 4. Empty / prompt states

Add `className: "ds-empty"` to the "No results." text and the initial
"Search YouTube to play or download a track." text. The `yt-dlp`-missing case is
now covered by the banner, so the inline "not installed" text is removed.

## New actions

- `youtube-queue` — same candidate→track mapping as `youtube-play`, but calls
  `api.playback.insertTracks(tracks, -1)` to append to the queue.
- `youtube-play-one` — reads `data.itemId` (a bare videoId), looks it up via
  `findResult`, builds one track, and calls `api.playback.playTracks([track], 0)`.

To avoid duplicating the candidate→track mapping three ways
(`youtube-play`, `youtube-queue`, `youtube-play-one`), extract a small
`buildTrack(candidate)` helper from the existing `youtube-play` body.

## Settings panel changes (`renderSettings` / `makeToolRow`)

Structure already matches TIDAL (sections + settings-rows). Only add button
styling classes:
- Tool-row install buttons: `ds-btn ds-btn--sm` plus `ds-btn--accent` (Install) or
  `ds-btn--secondary` (Installation Page).
- The footer Refresh button: `ds-btn ds-btn--sm ds-btn--secondary`.

## Out of scope

- No tabs, no detail (album/artist) views — not applicable to YouTube video search.
- No background health-check polling. The banner reflects the existing on-demand
  `detectTools` state; "Refresh" re-runs `checkTools` as it does today.

## Versioning

`scripts/bump.sh minor` → **v1.2.0**, with a matching `CHANGELOG.md` entry.

## Risk / assumption

`api.playback.insertTracks(tracks, -1)` accepts `youtube://<id>` track paths the
same way `playTracks` does (TIDAL uses both identically). User confirmed including
Queue.
