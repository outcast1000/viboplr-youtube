# Changelog

## v1.0.0
- Moved the plugin to its own repository with in-app auto-update.
- Resolves YouTube as a playback stream fallback and a download provider via
  `yt-dlp` (audio) and `ffmpeg` (format conversion).
- LRU disk cache keyed by video id, with a configurable size limit in settings.
