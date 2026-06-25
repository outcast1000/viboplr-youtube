# Changelog

## v1.6.0
- **Downloads go through the host's download modal.** Selecting tracks in the
  search view now opens the host's standard download flow (via
  `api.ui.requestAction("download-tracks", …)`) instead of enqueueing silently.
  The user picks a destination and format/quality (AAC/MP3/FLAC), and gets
  per-track progress + error reporting. A single selection opens the single-track
  flow; multiple opens the batch flow.
- **Interactive download provider.** The `youtube-download` provider now
  contributes `onInteractiveSearch` (powers the modal's manual-search picker) and
  `onInteractiveResolve` (used by both the batch flow and the manual picker).
  Both resolve the **exact** video the user picked — by bare video id or
  `youtube://<id>` uri — and never re-search by metadata.
  - `onInteractiveResolve` **throws** (rather than returning `null`) on failure or
    a missing `yt-dlp`, so the host marks the track errored instead of crashing on
    a null `resolved.url`.

## v1.5.0
- **Browsable search.** The search view now requests **25 results** (was 7) so
  you can scan and pick rather than trust the top hit. (The playback fallback
  resolver keeps its small default — it only needs one duration match.)
- **Artwork for external tracks.** `buildTrack` now carries each video's
  thumbnail as `image_url`, so YouTube tracks (which have no library DB row) show
  cover art in the queue panel and the now-playing bar.
- **Cancellable search.** The Search button reads **Cancel** while a search is in
  flight; clicking it (or pressing Enter) discards the in-flight result via a
  generation token. (`yt-dlp` keeps running to completion — there's no kill
  handle — but its output is dropped.)
- **Download feedback.** Download actions now show an immediate "Downloading…"
  toast; the host toasts completion/failure on top of that.

## v1.4.0
- **Dependency handling moved to the host.** The plugin no longer detects tools,
  checks releases, or prompts to install — it only declares `binaryDependencies`
  in the manifest and reads the host's cached status via `api.system.getDependency`
  (cache-only, no network). The host now owns detection, updates, and the
  missing-required-dependency UX (a sidebar dot + Settings → Dependencies).
  - Removed: the GitHub release checks (`fetchLatestVersions`), the `--version`
    probes (`detectYtDlp`/`detectFfmpeg`), the install prompt (`require-dependency`),
    the in-view status banner, and the plugin's own Dependencies settings section.
  - **Nothing dependency-related runs during `activate()`** — status is loaded
    lazily on first use, so a slow/blocked tool check can't stall plugin startup.
  - When `yt-dlp` is missing the search view shows a slim note pointing to
    Settings → Dependencies (no install button); user actions are silent no-ops.
- Requires app **0.9.124+** (`minAppVersion`) for `api.system.getDependency`.

## v1.3.0
- Plugin now ships a **YouTube icon** (`manifest.icon` + the sidebar item icon),
  replacing the generic magnifying-glass / "Y" letter fallback in the sidebar and
  Extensions list.
- Greatly improved the **missing-dependency UX** (first-run with no `yt-dlp` /
  `ffmpeg`):
  - The Dependencies settings rows and the search-view banner now show the exact
    platform-correct install command (macOS `brew`, Windows `winget`, Linux `apt`).
  - The banner gains a one-click **Install** button, and the settings **Install**
    button now opens the host's platform-aware dependency modal (with a Copy
    button and re-check) instead of just opening a docs page in the browser.
  - User actions (search / play / queue / download) now pop the install modal when
    `yt-dlp` is missing, instead of silently doing nothing.
  - When a library track falls back to YouTube but `yt-dlp` is absent, the plugin
    nudges the user to install it **once** per session (not once per track).
  - The "Install" button / modal still requires a host that understands the
    `require-dependency` action; on older hosts the install command is still shown
    inline so the user can copy it manually.

## v1.2.0
- Restyled the search view and settings panel to match the TIDAL plugin:
  - A dependency status banner now sits atop the search view (error when `yt-dlp`
    is missing, warning when `ffmpeg` is missing, success when both are present),
    with a **Refresh** button.
  - The search box shows a visible **Search** button, and result rows carry
    icon-labeled toolbar actions (▶ Play, + Queue, ⬇ Download).
  - Clicking a result row now plays that single video.
  - Settings/install buttons adopt the shared `ds-btn` styling.
- New **Queue** action appends selected videos to the playback queue
  (`insertTracks`).

## v1.1.1
- Search results now show each video's thumbnail.

## v1.1.0
- Add a **YouTube search** sidebar view: search YouTube, then select results and
  Play or Download them from a toolbar. Play and Download target the exact selected
  video (via `youtube://<id>`), not a fuzzy metadata re-search.
- Best-effort `Artist - Song` parsing of result titles for cleaner display (strips
  promo/quality tags like "(Official Video)", keeps `feat.`/`(Remix)`/`(Live)`).
- Internal: shared `runYtSearch`/`downloadById`/`convertForFormat` helpers now back
  both the fuzzy fallback paths and the new exact-id paths.

## v1.0.3
- Downloads now prefer YouTube's m4a/AAC audio stream
  (`bestaudio[ext=m4a]/bestaudio`), falling back to the best available audio only
  when no m4a stream exists. m4a plays in every webview (including macOS
  WKWebView), avoiding Opus-in-WebM files that don't classify cleanly as audio.
- The download resolver now reports the served file's true container extension to
  the host, so saved files are named honestly (e.g. a source served without
  conversion is saved as `.webm`, not mislabeled as the requested `.m4a`).

## v1.0.2
- Richer download logging for troubleshooting playback failures: the exact
  `yt-dlp` search/download command is now logged, the chosen candidate reports
  whether it was a duration match or a top-result fallback (with a warning when no
  candidate is within ±3s of the requested track), and on a failed download the
  plugin re-runs extraction in verbose simulate mode (`-v --simulate`) to surface
  the underlying cause — PO-token availability and the SABR/GVS streaming
  experiment that drives YouTube's HTTP 403s.

## v1.0.1
- Search now runs through `yt-dlp` (`ytsearch:`) instead of scraping the results
  HTML, so it no longer breaks when YouTube changes its page markup.
- Downloads now disambiguate by track duration, matching the playback path.
- When `ffmpeg` is missing, downloads serve the original audio honestly instead of
  mislabeling it as the requested format; the quality picker only offers MP3/FLAC
  when `ffmpeg` is present.
- Fixed cache eviction so concurrent resolves can't delete each other's files, and
  the just-resolved track is protected while it plays.
- "Off (no caching)" now keeps only the current track on disk, matching its label.
- Conversion mode (remux vs re-encode) is now returned as structured data rather
  than inferred from ffmpeg argument positions.
- Parallelized startup tool detection and GitHub version lookups; startup cache
  cleanup no longer blocks resolver registration.

## v1.0.0
- Moved the plugin to its own repository with in-app auto-update.
- Resolves YouTube as a playback stream fallback and a download provider via
  `yt-dlp` (audio) and `ffmpeg` (format conversion).
- LRU disk cache keyed by video id, with a configurable size limit in settings.
