# Changelog

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
