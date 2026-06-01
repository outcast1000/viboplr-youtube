# Changelog

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
