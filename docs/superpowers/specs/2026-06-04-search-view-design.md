# YouTube Search Sidebar View — Design

**Date:** 2026-06-04
**Status:** Approved (pending spec review)
**Plugin:** `youtube` (viboplr-youtube)

## Summary

Add a left-sidebar **YouTube search view** to the plugin. The user types a query and
sees a list of YouTube results. Each result has a checkbox; a **Play** / **Download**
toolbar acts on the checked rows (one or many). Both actions target the **exact
videos selected**, identified by their YouTube video id carried through a
`youtube://<videoId>` URI — not by fuzzy metadata re-search.

> **Host UI constraint (verified against `outcast1000/viboplr`
> `src/components/pluginViews/pluginViews.tsx`):** a `track-row-list` cannot render
> two buttons per row. Per-row `actions` render as a **toolbar**, and only in
> `selectable` mode, where they act on the checked selection and dispatch
> `{ selectedIds: [...] }`. The native row right-click menu only carries
> `title`/`subtitle` (no videoId), so it cannot preserve the exact id. Therefore the
> view uses **selectable mode** — the only pattern that keeps exact-id resolution for
> *both* Play and Download (and yields bulk actions for free).

Today the plugin is a *background* tool: it contributes a `youtube-fallback` stream
resolver (playback fallback for tracks with no native source) and a
`youtube-download` provider, both matching by metadata. This feature adds a
*foreground*, user-driven surface on top of code paths that already exist.

## Goals

- A `youtube-search` sidebar item that opens a plugin view.
- Search → selectable results list with a **Play** / **Download** toolbar acting on
  the checked rows (single or bulk).
- Play and Download resolve by **exact video id** (precise, not fuzzy).
- Best-effort `Artist - Song` title parsing for clean display.
- Reuse existing search/download/convert code; refactor for shared use, no behavior
  change to the existing fallback paths.
- Extend the existing zero-dependency test harness to cover the new logic.

## Non-Goals (YAGNI)

- No thumbnails, no multi-select / bulk download (possible later; see *Future*).
- No tabs merging settings into the search view — the existing `settingsPanel`
  stays exactly as-is.
- No channel-name cleanup (e.g. stripping `VEVO`).
- No changes to the existing fallback stream resolver's metadata matching.
- No playlist/album browsing — single-video search results only.

## Host API facts (verified against `outcast1000/viboplr`)

- **Sidebar contribution:** `contributes.sidebarItems: [{ id, label, icon }]`
  (precedent: `auto-tagger`). View content is driven by
  `api.ui.setViewData(viewId, data)` / `api.ui.onAction(actionId, handler)` — the
  same pair this plugin already uses for settings.
- **Play by URI:** a `PluginTrack` with `path: "youtube://<videoId>"` parses (host
  `queueEntry.ts` `parseUrlScheme`) to `{ scheme: "plugin", protocol: "youtube",
  id }`, which the host routes to a plugin's
  `api.playback.onResolveStreamByUri("youtube", handler)`. The handler returns a
  `file://` (or http) URL. `api.playback.playTracks(tracks, 0)` starts playback of
  the selected set.
- **Download by URI:** `api.downloads.enqueue({ title, uri, provider })` routes to
  the provider's `api.downloads.onResolveByUri(providerId, handler)`. The host owns
  the download queue, progress, format selection, and library import.
- `PluginTrack` fields: `path?, title, artist_name?, album_title?, duration_secs?,
  track_number?, image_url?`.
- **View action dispatch contracts** (from `pluginViews.tsx`): `search-input` fires
  `onAction(action, { query })`; a selectable `track-row-list`'s toolbar `actions`
  fire `onAction(actionId, { selectedIds: [...] })`. Row checkboxes manage selection
  internally; there is no per-row action callback in this mode.

## Architecture

The plugin file `index.js` keeps its `var`/`function` sandbox style and ends with
`return { activate, deactivate }`. New work is organized as:

### Module state (alongside existing `cacheMaxMb`, etc.)
- `searchQuery` — last submitted query (string, for the input's `value`).
- `searchResults` — array of parsed candidates currently displayed, or `null`.
- `searching` — boolean, true while a search is in flight.

### Refactors (shared, single-source-of-truth)

1. **Split `searchYoutube` into two layers.** The current function both runs the
   `yt-dlp ytsearch` and picks one best match (duration-match-then-top-result). Split:
   - `runYtSearch(api, query)` → returns the **full candidate array**
     (`[{ videoId, title, durationSecs }]`). This is the existing parse loop.
   - The fallback resolver's "pick best" logic moves to a thin wrapper that calls
     `runYtSearch` then applies the existing duration-match selection.
     **No behavior change** to the fallback path.
   - The search view calls `runYtSearch` directly and displays **all** candidates.

2. **Extract `downloadById(api, videoId)`** from the back half of
   `searchAndDownload`: cache lookup (`findCachedDownload`) → `yt-dlp` download →
   return `{ filePath, videoId, youtubeUrl }`. Then:
   - `searchAndDownload` = `searchYoutube` (best match) + `downloadById`.
   - The URI resolvers call `downloadById` **alone** — no fuzzy re-search.

3. **Extract the convert pipeline** (probe → `buildConvertArgs` → ffmpeg) from the
   metadata download handler into `convertForFormat(api, src, format, metadata)` so
   the new `onResolveByUri` download handler and the existing
   `onResolveByMetadata` handler share it.

### Title parsing — `parseTrackTitle(rawTitle, channel)` (pure, unit-tested)

Best-effort `Artist - Song` extraction layered over a safe channel fallback:

1. **Strip trailing noise** (applied repeatedly until stable):
   - Parenthetical/bracketed tags: `(Official Music Video)`, `(Official Video)`,
     `(Official Audio)`, `(Lyrics)`, `(Lyric Video)`, `(Visualizer)`, `(Audio)`,
     `(HD)`, `[Official …]`, etc.
   - Trailing bare tags: `HD`, `HQ`, `4K`, `Official Video`.
   - Reuse/compose with existing `stripRemasterSuffix`.
   - **Keep** `feat.`/`ft.` (part of the title) and **keep** `(Remix)`/`(Live)`
     (real information — removing would lose meaning). Stripping is conservative.
2. **Split on the first separator only**, trying ` - `, ` – ` (en-dash),
   ` — ` (em-dash) in order. `"Artist - Album - Song"` → artist `"Artist"`,
   title `"Album - Song"`.
3. If a separator is found **and both sides are non-empty after trim** →
   `artist_name = left`, `title = right`.
4. **Fallback** (no separator / empty side) → `artist_name = channel`,
   `title = cleaned rawTitle`.

Note: `runYtSearch` must additionally print the channel/uploader. The `--print`
template becomes `%(id)s\t%(duration)s\t%(channel)s\t%(title)s` (channel may be `NA`;
treat as empty). The parse loop is updated to read the extra column; the fallback
"pick best" wrapper ignores channel, preserving its behavior.

### View rendering — `renderSearchView(api)` (parallel to `renderSettings`)

Emits a `layout` (`direction: "vertical"`):
- `search-input` — `{ action: "youtube-search-submit", submitOnly: true,
  placeholder: "Search YouTube…", value: searchQuery }`.
- If `ytDlpVersion` is null → a `text` empty-state: "yt-dlp not installed" with a
  note to open Settings (mirrors the settings dependency state).
- Else if `searching` → a `loading` node.
- Else if `searchResults` is a non-empty array → a **selectable** `track-row-list`:
  - `selectable: true` (renders row checkboxes + a toolbar).
  - `items`: one `TrackRowItem` per candidate — `id: videoId`, `title` (parsed),
    `subtitle` (parsed artist / channel), `duration` (formatted from
    `durationSecs`).
  - `actions: [{ id: "youtube-play", label: "Play" },
    { id: "youtube-download", label: "Download" }]` — these render as toolbar
    buttons that act on the checked selection.
- Else if `searchResults` is an empty array → a `text` "No results" state.
- Else (initial) → a `text` prompt to search.

### Actions (registered in `activate`)

- `youtube-search-submit` (data `{ query }`): set `searchQuery = data.query`, set
  `searching=true`, `renderSearchView`; call `runYtSearch`; store parsed candidates
  in `searchResults`; `searching=false`; `renderSearchView`. Exec/parse failures log
  via `api.log` and render the empty/error state (never throw).
- `youtube-play` (data `{ selectedIds }`): map each id to its candidate, build a
  `PluginTrack { title, artist_name, duration_secs, path: "youtube://"+videoId }`
  per result (titles/artists via `parseTrackTitle`), call
  `api.playback.playTracks(tracks, 0)`.
- `youtube-download` (data `{ selectedIds }`): for each id build display
  title/artist via `parseTrackTitle` and call `api.downloads.enqueue({ title,
  artistName, uri: "youtube://"+videoId, provider: "youtube-download" })`.

### Resolvers (registered in `activate`)

- **New** `api.playback.onResolveStreamByUri("youtube", async (videoId) => …)`:
  no-op (`null`) if `ytDlpVersion` is null; else `resolveSourceWith`-wrapped
  `downloadById(api, videoId)` returning a bare URL string `"file://"+filePath`
  (the host's `onResolveStreamByUri` contract is `Promise<string | null>` — unlike
  the metadata `onStreamResolve`, which returns `{ url, label }`). Uses the same
  in-flight/cleanup protection as the fallback resolver.
- **Implement** `api.downloads.onResolveByUri("youtube-download", async (uri,
  format) => …)` (currently a `null` stub): parse `videoId` from
  `youtube://<id>` (validate against `VIDEO_ID_RE`); no-op if `ytDlpVersion`
  null; else `resolveSource`-wrapped `downloadById` + `convertForFormat`,
  returning the same `{ url, ext, metadata }` shape as the metadata handler.

The existing `onResolveByMetadata` download handler and `youtube-fallback` stream
resolver remain as the fuzzy fallback paths, now sharing `downloadById` /
`convertForFormat` with the precise URI paths.

## Manifest change

Add to `contributes` (leave `settingsPanel` unchanged):

```json
"sidebarItems": [
  { "id": "youtube-search", "label": "YouTube", "icon": "<chosen-from-host-set>" }
]
```

The icon is chosen from the host's icon set during implementation (e.g. `search` or
`video`); if no suitable icon exists, omit `icon` (host renders a default).

## Error handling

- All actions and resolvers no-op gracefully when `ytDlpVersion` is null; the view
  surfaces a "not installed" state with a pointer to Settings.
- `runYtSearch` / exec failures log via `api.log("warn"/"error", …, "youtube")` and
  render an empty state — never throw out of an action handler.
- URI resolvers validate the video id and return `null` on a malformed URI.
- Cache eviction protection (`resolveSource` / `inFlightFiles` / `lastSourceFile`)
  applies unchanged to the new id-based downloads.

## Testing (extend the existing zero-dependency harness)

- **`mock-api.js`:** capture `playback.playTrack`, `playback.onResolveStreamByUri`
  registration + invocation, `downloads.enqueue`, `downloads.onResolveByUri`
  registration + invocation.
- **`title-parse.test.js`** (pure): the table cases above + edge cases (no
  separator, empty side, en/em-dash, `feat.` kept, trailing-tag stripping,
  multi-separator first-split).
- **`search-view.test.js`:**
  - submit (`{ query }`) renders a selectable `track-row-list` of **all** candidates;
  - `youtube-play` (`{ selectedIds }`) builds `PluginTrack`s with
    `path: "youtube://<id>"` and parsed title/artist, and calls `playTracks`;
  - `youtube-download` (`{ selectedIds }`) calls `enqueue` once per id with the
    `youtube://<id>` uri;
  - the URI stream resolver and URI download resolver call `downloadById` for the
    exact id and **do not** run a search;
  - yt-dlp-missing renders the "not installed" state and actions no-op.
- **Regression:** existing `search.test.js` / `resolve.test.js` still pass — the
  fallback "pick best" wrapper behavior is unchanged after the `runYtSearch` split.

## Future (explicitly deferred)

- Thumbnails (`imageUrl`) on rows.
- Channel-name cleanup heuristics.
- A `card-grid` alternative layout (click=Play, context-menu=Download) if a
  non-selectable single-click UX is later preferred.
