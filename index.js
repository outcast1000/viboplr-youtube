// Installed-tool status, read from the HOST on demand (never probed by this
// plugin). Used only to gate work — the host owns detection, updates, and the
// missing-required-dependency UX (sidebar dot + Settings → Dependencies).
var ytDlpVersion = null;
var ffmpegVersion = null;
// Whether tool status has been read from the host at least once this session.
// Detection is lazy and host-sourced — never run during activate().
var statusLoaded = false;
var cacheMaxMb = 100;
var searchQuery = "";
var searchResults = null; // array of candidates, or null before first search
var searching = false;
// Bumped on every search start AND on cancel; an in-flight runYtSearch compares
// its captured generation and discards its result if the value has moved on.
var searchGen = 0;

// Filenames currently being produced/consumed by an in-flight resolve. cleanupCache
// never evicts these, so a parallel download cannot delete another's just-written file.
var inFlightFiles = {};
// The most recently resolved source file. Protected from eviction so the host can keep
// reading it after the resolver returns (there is no playback-end hook). This is also what
// makes the cacheMaxMb===0 "keep only the current track" behavior work.
var lastSourceFile = null;
// Serializes cleanup runs so overlapping resolves don't double-count size or race on remove().
var cleanupChain = Promise.resolve();
// Monotonic counter for unique temp filenames (Date.now/Math.random are unavailable in the sandbox).
var convSeq = 0;

var REMASTER_SUFFIX = /\s*-\s*.*remaster.*$/i;
function stripRemasterSuffix(s) {
  if (!s) return s;
  return s.replace(REMASTER_SUFFIX, "").trim() || s;
}

// Trailing noise tags to strip from a YouTube video title before display.
// Removes parenthetical/bracketed tags containing promo/quality keywords.
// Tags with only semantic content — (Remix)/(Live)/feat. — typically survive
// because they don't match these patterns, not via explicit exclusion.
var TITLE_NOISE = [
  /\s*[\(\[][^\)\]]*official[^\)\]]*[\)\]]\s*$/i,   // (Official Music Video), [Official Audio]
  /\s*[\(\[][^\)\]]*lyric[^\)\]]*[\)\]]\s*$/i,       // (Lyrics), (Lyric Video)
  /\s*[\(\[][^\)\]]*(audio|visualizer|hd|hq|4k)[^\)\]]*[\)\]]\s*$/i,
  /\s*-\s*(official video|official audio|hd|hq|4k)\s*$/i,
  /\s+(hd|hq|4k)\s*$/i
];

function cleanTitle(s) {
  if (!s) return s;
  var prev;
  do {
    prev = s;
    for (var i = 0; i < TITLE_NOISE.length; i++) s = s.replace(TITLE_NOISE[i], "");
    s = stripRemasterSuffix(s);
    s = s.trim();
  } while (s !== prev);
  return s;
}

// Best-effort "Artist - Song" extraction. Returns { artist, title }.
// Splits on the FIRST of " - " / en-dash / em-dash; falls back to the channel
// name as artist when there is no usable separator.
function parseTrackTitle(rawTitle, channel) {
  var cleaned = cleanTitle(rawTitle) || rawTitle || "";
  var seps = [" - ", " – ", " — "];
  for (var i = 0; i < seps.length; i++) {
    var idx = cleaned.indexOf(seps[i]);
    if (idx > 0) {
      var left = cleaned.substring(0, idx).trim();
      var right = cleaned.substring(idx + seps[i].length).trim();
      if (left && right) return { artist: left, title: right };
    }
  }
  return { artist: channel || "", title: cleaned };
}

// Map a search candidate to a host PluginTrack, parsing "Artist - Song" out of
// the raw video title. Shared by the Play / Queue / row-click actions so they
// can't drift. The path is the exact-id youtube:// uri (not a fuzzy re-search).
function buildTrack(c) {
  var parsed = parseTrackTitle(c.title, c.channel);
  return {
    title: parsed.title || c.title || c.videoId,
    artist_name: parsed.artist || c.channel || null,
    duration_secs: c.durationSecs != null ? c.durationSecs : null,
    path: "youtube://" + c.videoId,
    // Carry the video thumbnail so the queue panel and now-playing bar show
    // artwork immediately, without a library image lookup (these are external
    // tracks with no DB row). thumbnailUrl is hoisted (function declaration).
    image_url: thumbnailUrl(c.videoId)
  };
}

// ---------------------------------------------------------------------------
// Small path helpers (shared so callers can't drift)
// ---------------------------------------------------------------------------
function basename(p) {
  return p.replace(/^.*[\/\\]/, "");
}
function stemOf(name) {
  var dot = name.lastIndexOf(".");
  return dot > 0 ? name.substring(0, dot) : name;
}
// Seconds -> "m:ss" / "h:mm:ss" for display. Returns "" for null/NaN/negative.
function formatDuration(secs) {
  if (secs == null || isNaN(secs) || secs < 0) return "";
  var s = Math.floor(secs % 60);
  var m = Math.floor((secs / 60) % 60);
  var h = Math.floor(secs / 3600);
  var mm = (h > 0 && m < 10 ? "0" : "") + m;
  var ss = (s < 10 ? "0" : "") + s;
  return (h > 0 ? h + ":" : "") + mm + ":" + ss;
}

// ---------------------------------------------------------------------------
// Tool status (read-only, from the host)
// ---------------------------------------------------------------------------
// The host owns dependency detection and updates. We only READ installed status
// (cache-only, no network) via api.system.getDependency, purely to decide
// whether to attempt yt-dlp/ffmpeg. We never probe (--version) and never check
// releases. `minAppVersion` requires a host that provides getDependency; the
// else-branch is a safety net (assume present, let exec fail gracefully).
async function loadToolStatus(api) {
  if (api.system && typeof api.system.getDependency === "function") {
    var results = await Promise.all([
      api.system.getDependency("yt-dlp"),
      api.system.getDependency("ffmpeg")
    ]);
    var y = results[0], f = results[1];
    ytDlpVersion = y && y.installed ? (y.version || "unknown") : null;
    ffmpegVersion = f && f.installed ? (f.version || "unknown") : null;
  } else {
    ytDlpVersion = "unknown";
    ffmpegVersion = "unknown";
  }
  statusLoaded = true;
}

// Load tool status once, on demand. Call before any code that gates on
// ytDlpVersion/ffmpegVersion. NEVER call from activate() — the host must not be
// probed for dependencies during plugin activation.
async function ensureToolStatus(api) {
  if (!statusLoaded) await loadToolStatus(api);
}

var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function watchUrl(videoId) {
  return "https://www.youtube.com/watch?v=" + videoId;
}

// Deterministic thumbnail URL for a video id (no API call). mqdefault (320x180)
// is reliably present for any public video. Loaded directly by the WebView's
// <img> tag, so it needs no network proxy.
function thumbnailUrl(videoId) {
  return "https://i.ytimg.com/vi/" + videoId + "/mqdefault.jpg";
}

// Parse a youtube://<videoId> URI. Returns the 11-char id or null.
// VIDEO_ID_RE ensures the id is exactly 11 chars [A-Za-z0-9_-], preventing
// injection/traversal when the id is later passed to yt-dlp or used in file paths.
function parseYoutubeUri(uri) {
  if (!uri || uri.indexOf("youtube://") !== 0) return null;
  var id = uri.substring("youtube://".length);
  return VIDEO_ID_RE.test(id) ? id : null;
}

// Render an exec argv as a copy-pasteable command line for logging. Quotes args
// containing whitespace so the logged line can be re-run verbatim from a shell.
function formatCmd(program, args) {
  var parts = [program];
  for (var i = 0; i < args.length; i++) {
    var a = String(args[i]);
    parts.push(/\s/.test(a) ? '"' + a + '"' : a);
  }
  return parts.join(" ");
}

// When a yt-dlp download fails, re-run extraction in verbose simulate mode to
// surface *why* — PO-token availability, the SABR/GVS streaming experiment, and
// skipped formats are emitted at extraction time, so `-v --simulate` reveals them
// without re-downloading any media. Best-effort: logs whatever it captures and
// never throws. See https://github.com/yt-dlp/yt-dlp/issues/12482 for SABR/403s.
async function logDownloadDiagnostics(api, url) {
  try {
    var diag = await api.system.exec("yt-dlp", [
      "-v", "--simulate", "-f", "bestaudio", url
    ], { cwd: null });
    var out = ((diag.stderr || "") + "\n" + (diag.stdout || "")).trim();
    // Keep only the lines that explain failures; the full -v dump is mostly noise.
    var keep = [];
    var lines = out.split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (/po.?token|sabr|gvs|skipped|missing a URL|forcing|403|forbidden|player_client|experiment/i.test(lines[i])) {
        keep.push(lines[i].trim());
      }
    }
    var summary = keep.length ? keep.join("\n") : out;
    if (summary) api.log("warn", "yt-dlp diagnostics:\n" + summary, "youtube");
  } catch (e) {
    api.log("warn", "yt-dlp diagnostics probe failed: " + (e && e.message ? e.message : e), "youtube");
  }
}

// ---------------------------------------------------------------------------
// Search via yt-dlp itself (maintained against YouTube's changes) rather than
// scraping the results HTML.
// ---------------------------------------------------------------------------

// Low-level: run `yt-dlp ytsearch` and return ALL parsed candidates:
// [{ videoId, title, channel, durationSecs }]. Returns [] on failure.
async function runYtSearch(api, query, count) {
  var n = count || 7;
  var searchArgs = [
    "ytsearch" + n + ":" + query,
    "--flat-playlist",
    "--no-warnings",
    "--print", "%(id)s\t%(duration)s\t%(channel)s\t%(title)s"
  ];
  api.log("info", "Running: " + formatCmd("yt-dlp", searchArgs), "youtube");
  var res;
  try {
    res = await api.system.exec("yt-dlp", searchArgs);
  } catch (e) {
    api.log("warn", "yt-dlp search exec failed: " + (e && e.message ? e.message : e), "youtube");
    return [];
  }
  if (res.exitCode !== 0 || !res.stdout) {
    api.log("warn", "yt-dlp search returned no results (exit " + res.exitCode + ")" +
      (res.stderr ? ": " + res.stderr.trim() : ""), "youtube");
    return [];
  }
  var lines = res.stdout.split("\n");
  var candidates = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var cols = line.split("\t");
    var videoId = cols[0];
    if (!videoId || !VIDEO_ID_RE.test(videoId)) continue;
    var durRaw = cols[1];
    var dur = durRaw && durRaw !== "NA" ? parseInt(durRaw, 10) : NaN;
    var channel = cols[2] && cols[2] !== "NA" ? cols[2] : "";
    candidates.push({
      videoId: videoId,
      title: cols.slice(3).join("\t") || null,
      channel: channel,
      durationSecs: isNaN(dur) ? null : dur
    });
  }
  return candidates;
}

// Pick the best candidate for a known target duration (fallback resolver path):
// first within ±3s of durationSecs, else the top result. Returns
// { videoId, title } or null. Behavior preserved from the old searchYoutube.
function pickBestCandidate(candidates, durationSecs, api) {
  if (!candidates || candidates.length === 0) {
    if (api) api.log("warn", "yt-dlp search parsed 0 valid candidates from output", "youtube");
    return null;
  }
  var best = candidates[0];
  var matchedByDuration = false;
  if (durationSecs != null && durationSecs > 0) {
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c].durationSecs !== null && Math.abs(candidates[c].durationSecs - durationSecs) <= 3) {
        best = candidates[c];
        matchedByDuration = true;
        break;
      }
    }
  }
  if (api) {
    if (durationSecs != null && durationSecs > 0 && !matchedByDuration) {
      api.log("warn", candidates.length + " candidate(s); none within ±3s of " + durationSecs +
        "s — falling back to top result (" + (best.durationSecs != null ? best.durationSecs + "s" : "unknown duration") + ")", "youtube");
    } else {
      api.log("info", candidates.length + " candidate(s); chose " + best.videoId +
        (matchedByDuration ? " (duration match)" : " (top result)"), "youtube");
    }
  }
  return { videoId: best.videoId, title: best.title };
}

// Back-compat wrapper used by the fallback download/stream paths.
async function searchYoutube(api, title, artistName, durationSecs) {
  var query = artistName ? title + " " + artistName : title;
  var candidates = await runYtSearch(api, query);
  return pickBestCandidate(candidates, durationSecs, api);
}

// Probe an audio file via `ffmpeg -i`. Returns { codec, bitrateKbps } or null.
async function probeAudio(api, filePath) {
  try {
    var probe = await api.system.exec("ffmpeg", ["-i", filePath, "-hide_banner"]);
    // ffmpeg exits nonzero when no output is given, but still prints stream info to stderr
    var stderr = probe.stderr || "";
    var streamLine = null;
    var lines = stderr.split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("Audio:") !== -1) { streamLine = lines[i]; break; }
    }
    if (!streamLine) return null;
    // Stream #0:0(eng): Audio: opus, 48000 Hz, stereo, fltp, 160 kb/s
    var codecMatch = streamLine.match(/Audio:\s*([a-zA-Z0-9_]+)/);
    var codec = codecMatch ? codecMatch[1].toLowerCase() : null;
    var brMatch = streamLine.match(/(\d+)\s*kb\/s/);
    var bitrateKbps = brMatch ? parseInt(brMatch[1], 10) : null;
    return { codec: codec, bitrateKbps: bitrateKbps };
  } catch (e) {
    api.log("warn", "probeAudio failed: " + (e && e.message ? e.message : e), "youtube");
    return null;
  }
}

// Format descriptor: container extension + encoder + codecs eligible for codec-copy remux.
var FORMATS = {
  aac:  { ext: "m4a", encoder: "aac", copyCodecs: ["aac"] },
  m4a:  { ext: "m4a", encoder: "aac", copyCodecs: ["aac"] },
  mp3:  { ext: "mp3", encoder: "libmp3lame", copyCodecs: ["mp3"] },
  flac: { ext: "flac", encoder: "flac", copyCodecs: ["flac"] }
};

// Decide how to convert src to target format. Returns { mode, args, bitrate } or null.
// mode is "copy" (remux, no re-encode) or "encode".
function buildConvertArgs(srcPath, destPath, fmt, probe) {
  var spec = FORMATS[fmt];
  if (!spec) return null;

  var codec = probe ? probe.codec : null;
  if (codec && spec.copyCodecs.indexOf(codec) !== -1) {
    return { mode: "copy", args: ["-i", srcPath, "-vn", "-c:a", "copy", "-y", destPath] };
  }

  if (spec.encoder === "flac") {
    return { mode: "encode", args: ["-i", srcPath, "-vn", "-c:a", "flac", "-y", destPath] };
  }
  // Re-encode, matching source bitrate (cap at 320k, floor at 96k for sanity)
  var bitrateKbps = probe && probe.bitrateKbps ? probe.bitrateKbps : 160;
  var targetKbps = Math.max(96, Math.min(320, bitrateKbps));
  return {
    mode: "encode",
    bitrate: targetKbps,
    args: ["-i", srcPath, "-vn", "-c:a", spec.encoder, "-b:a", targetKbps + "k", "-y", destPath]
  };
}

// Look up a cached download for a videoId. Returns absolute path or null.
async function findCachedDownload(api, videoId) {
  try {
    var entries = await api.storage.files.list(["cache"]);
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i].name;
      if (stemOf(name) === videoId) {
        return await api.storage.files.getPath(["cache", name]);
      }
    }
  } catch (e) {
    // Directory may not exist yet — that's fine
  }
  return null;
}

// Evict oldest cache entries when over budget. Runs serialized (see scheduleCleanup) and
// never evicts in-flight files or the most-recent source. When wipeTemp is true (startup
// only) the temp/ dir of transcoded files is also cleared — never during a resolve, since
// a just-produced transcode there may still be in use by the host.
async function cleanupCache(api, wipeTemp) {
  var maxBytes = cacheMaxMb * 1024 * 1024;
  if (wipeTemp) {
    try {
      await api.storage.files.remove(["temp"]);
    } catch (e) {
      // temp dir may not exist — that's fine
    }
  }
  var entries;
  try {
    entries = await api.storage.files.list(["cache"]);
  } catch (e) {
    // cache dir may not exist — that's fine
    return;
  }

  var validFiles = [];
  var removedStray = 0;
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry.isDir) continue;
    var name = entry.name;
    var stem = stemOf(name);
    if (!VIDEO_ID_RE.test(stem)) {
      try { await api.storage.files.remove(["cache", name]); removedStray++; } catch (e) {}
    } else {
      validFiles.push({ name: name, size: entry.size || 0, modifiedAt: entry.modifiedAt || 0 });
    }
  }

  // Sort by modifiedAt ascending (oldest first) for LRU eviction
  validFiles.sort(function(a, b) { return a.modifiedAt - b.modifiedAt; });

  var totalSize = 0;
  for (var j = 0; j < validFiles.length; j++) {
    totalSize += validFiles[j].size;
  }

  var evicted = 0;
  var idx = 0;
  while (totalSize > maxBytes && idx < validFiles.length) {
    var oldest = validFiles[idx];
    if (inFlightFiles[oldest.name] || oldest.name === lastSourceFile) {
      // Don't evict a file an active resolve is using, or the just-resolved track — skip it.
      idx++;
      continue;
    }
    try {
      await api.storage.files.remove(["cache", oldest.name]);
      evicted++;
      totalSize -= oldest.size;
    } catch (e) {}
    validFiles.splice(idx, 1);
  }

  if (removedStray > 0 || evicted > 0) {
    api.log("info", "Cache cleanup: evicted " + evicted + " file(s), removed " + removedStray + " stray file(s), " + Math.round(totalSize / 1024 / 1024) + " MB remaining", "youtube");
  }
}

function scheduleCleanup(api, wipeTemp) {
  cleanupChain = cleanupChain.then(
    function () { return cleanupCache(api, wipeTemp); },
    function () { return cleanupCache(api, wipeTemp); }
  );
  return cleanupChain;
}

// Ensure a source audio file exists on disk for an exact video id.
// Returns { filePath, videoId, videoTitle, youtubeUrl } or null.
async function downloadById(api, videoId, videoTitle) {
  var url = watchUrl(videoId);
  var cached = await findCachedDownload(api, videoId);
  if (cached) {
    api.log("info", "Using cached download: " + cached, "youtube");
    return { filePath: cached, videoId: videoId, videoTitle: videoTitle || null, youtubeUrl: url };
  }
  api.log("info", "Downloading audio via yt-dlp: " + url, "youtube");
  var filePath;
  try {
    var cacheDir = await api.storage.files.getPath(["cache"]);
    var outputTemplate = videoId + ".%(ext)s";
    var dlArgs = [
      // Prefer the m4a/AAC audio stream (plays in every webview, incl. macOS
      // WKWebView) and fall back to the best available audio (often Opus/WebM)
      // only when YouTube offers no m4a stream.
      "-f", "bestaudio[ext=m4a]/bestaudio",
      "--no-warnings",
      "--quiet",
      "--no-simulate",
      "--print", "after_move:filepath",
      "-P", cacheDir,
      "-o", outputTemplate,
      url
    ];
    api.log("info", "Running: " + formatCmd("yt-dlp", dlArgs), "youtube");
    var dlResult = await api.system.exec("yt-dlp", dlArgs, { cwd: null });
    if (dlResult.exitCode !== 0) {
      api.log("error", "yt-dlp failed (exit " + dlResult.exitCode + "): " + (dlResult.stderr || "").trim(), "youtube");
      await logDownloadDiagnostics(api, url);
      return null;
    }
    filePath = dlResult.stdout ? dlResult.stdout.trim() || null : null;
  } catch (e) {
    api.log("error", "yt-dlp exec failed: " + (e && e.message ? e.message : e), "youtube");
    return null;
  }
  if (!filePath) {
    api.log("warn", "yt-dlp returned no file path (exit 0 but no output) — likely a SABR/PO-token issue", "youtube");
    await logDownloadDiagnostics(api, url);
    return null;
  }
  api.log("info", "Downloaded to: " + filePath, "youtube");
  return { filePath: filePath, videoId: videoId, videoTitle: videoTitle || null, youtubeUrl: url };
}

// Search YouTube by metadata, then ensure the matched video is on disk.
async function searchAndDownload(api, title, artistName, durationSecs) {
  api.log("info", "Searching YouTube for: " + title + (artistName ? " — " + artistName : ""), "youtube");
  var result;
  try {
    result = await searchYoutube(api, title, artistName, durationSecs);
  } catch (e) {
    api.log("error", "YouTube search failed: " + (e && e.message ? e.message : e), "youtube");
    return null;
  }
  if (!result || !result.videoId) {
    api.log("warn", "YouTube search returned no result for: " + title, "youtube");
    return null;
  }
  api.log("info", "Matched " + (result.title || "(untitled)") + " — " + watchUrl(result.videoId), "youtube");
  return downloadById(api, result.videoId, result.title);
}

// Wraps searchAndDownload, protecting the produced file from cache eviction for the
// duration of the caller's work, and triggering serialized cleanup afterward.
async function resolveSource(api, title, artistName, durationSecs, work) {
  var src = await searchAndDownload(api, title, artistName, durationSecs);
  if (!src) return null;
  var name = basename(src.filePath);
  inFlightFiles[name] = (inFlightFiles[name] || 0) + 1;
  try {
    return await work(src);
  } finally {
    // Protect this track from eviction after we return — the host keeps reading it and
    // there is no playback-end hook. Only the source download (under cache/) qualifies.
    lastSourceFile = name;
    inFlightFiles[name]--;
    if (inFlightFiles[name] <= 0) delete inFlightFiles[name];
    scheduleCleanup(api).catch(function (e) {
      api.log("warn", "Cache cleanup failed: " + (e && e.message ? e.message : e), "youtube");
    });
  }
}

// Like resolveSource but the source is produced by `produce()` (e.g. downloadById
// for an exact id) instead of searchAndDownload. `work` is optional — when omitted
// the src object itself is returned (used by the stream URI resolver).
async function resolveSourceWith(api, produce, work) {
  var src = await produce();
  if (!src) return null;
  var name = basename(src.filePath);
  inFlightFiles[name] = (inFlightFiles[name] || 0) + 1;
  try {
    return work ? await work(src) : src;
  } finally {
    lastSourceFile = name;
    inFlightFiles[name]--;
    if (inFlightFiles[name] <= 0) delete inFlightFiles[name];
    scheduleCleanup(api).catch(function (e) {
      api.log("warn", "Cache cleanup failed: " + (e && e.message ? e.message : e), "youtube");
    });
  }
}

// Given a downloaded source file, produce the final file in the requested
// format (remux/transcode as needed) and return the host download-resolve
// result { url, headers, ext, metadata }. Shared by the metadata and URI
// download resolvers.
async function convertForFormat(api, src, format, title, artistName, albumName) {
  var srcPath = src.filePath;
  var fmt = format || "aac";
  var spec = FORMATS[fmt];
  api.log("info", "Preparing " + title + " as " + fmt, "youtube");

  var finalPath = srcPath;
  var srcExt = (srcPath.match(/\.([^.]+)$/) || [])[1];

  if (!spec) {
    api.log("warn", "Unknown target format: " + fmt + " — using source as-is", "youtube");
  } else if (!ffmpegVersion) {
    // ffmpeg is optional; without it we cannot convert. Serve the original download
    // (with its true extension) rather than mislabeling it as the requested format.
    api.log("warn", "ffmpeg not available — serving original download (." + (srcExt || "?") + ") without conversion", "youtube");
  } else {
    var ext = spec.ext;
    var probe = await probeAudio(api, srcPath);
    if (probe) {
      api.log("info", "Source: " + (probe.codec || "?") + " @ " + (probe.bitrateKbps || "?") + " kb/s", "youtube");
    } else {
      api.log("warn", "Could not probe source — falling back to transcode defaults", "youtube");
    }
    // destPath in the plugin's temp/ dir (wiped on startup); unique per request to
    // avoid two concurrent conversions clobbering the same file.
    var destName = src.videoId + "." + (convSeq++) + "." + ext;
    var destPath = await api.storage.files.writeText(["temp", destName], "");
    var conv = buildConvertArgs(srcPath, destPath, fmt, probe);
    if (!conv) {
      api.log("warn", "No conversion rule for format: " + fmt + " — using source as-is", "youtube");
    } else if (conv.mode === "copy" && srcExt === ext) {
      api.log("info", "Source already in target container — reusing without conversion", "youtube");
    } else {
      var label = conv.mode === "copy" ? "Remuxing (codec copy, no re-encode)" :
        "Transcoding to " + fmt + " @ " + (conv.bitrate ? conv.bitrate + "k" : "default");
      api.log("info", label + " -> " + destPath, "youtube");
      var ffResult = await api.system.exec("ffmpeg", conv.args);
      if (ffResult.exitCode === 0) {
        finalPath = destPath;
        api.log("info", "Conversion complete: " + destPath, "youtube");
      } else {
        api.log("error", "Conversion failed (exit " + ffResult.exitCode + "): " + (ffResult.stderr || "").trim() + " — serving source", "youtube");
      }
    }
  }

  // Tell the host the real container of the file we're serving so it names
  // the saved file honestly. finalPath is either the converted temp file
  // (target ext) or the untouched source (e.g. .webm) when conversion was
  // skipped/unavailable/failed — without this the host would name a served
  // .webm by the requested format (aac -> .m4a) and mislabel it.
  var finalExt = (finalPath.match(/\.([^.]+)$/) || [])[1];
  api.log("info", "Download resolve -> " + finalPath, "youtube");
  return {
    url: "file://" + finalPath,
    headers: null,
    ext: finalExt || undefined,
    metadata: {
      title: title,
      artist: artistName || undefined,
      album: albumName || undefined
    }
  };
}

async function activate(api) {
  var storedMax = await api.storage.get("cacheMaxMb");
  if (storedMax != null && typeof storedMax === "number") cacheMaxMb = storedMax;

  // NOTE: tool detection is intentionally NOT done here. Probing yt-dlp/ffmpeg
  // (or checking releases) during activate() blocks the host's sequential plugin
  // load. Status is loaded lazily via ensureToolStatus() on first use, and once
  // (deferred, after activation) below to populate the view.

  // Startup cleanup: wipe transcoded/temp files; keep source downloads keyed by videoId.
  // Fire-and-forget so resolver registration isn't blocked on disk I/O.
  scheduleCleanup(api, true).catch(function (e) {
    api.log("warn", "Startup cache cleanup failed: " + (e && e.message ? e.message : e), "youtube");
  });

  api.playback.onStreamResolve("youtube-fallback", async function(title, artistName, albumName, durationSecs) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) {
      // yt-dlp missing — skip cleanly. The host surfaces the missing required
      // dependency (sidebar dot + Settings → Dependencies); the plugin never prompts.
      api.log("warn", "Stream resolve skipped — yt-dlp not available", "youtube");
      return null;
    }
    title = stripRemasterSuffix(title);
    try {
      return await resolveSource(api, title, artistName, durationSecs, function (src) {
        api.log("info", "Stream resolved to: " + src.filePath, "youtube");
        return { url: "file://" + src.filePath, label: "YouTube", sourceUrl: src.youtubeUrl };
      });
    } catch (e) {
      api.log("error", "Stream resolve failed: " + (e && e.message ? e.message : e), "youtube");
      return null;
    }
  });

  api.playback.onResolveStreamByUri("youtube", async function(videoId, quality) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) {
      api.log("warn", "Stream URI resolve skipped — yt-dlp not available", "youtube");
      return null;
    }
    if (!VIDEO_ID_RE.test(videoId)) {
      api.log("warn", "Stream URI resolve: invalid video id " + videoId, "youtube");
      return null;
    }
    try {
      var src = await resolveSourceWith(api, function() { return downloadById(api, videoId); });
      return src ? "file://" + src.filePath : null;
    } catch (e) {
      api.log("error", "Stream URI resolve failed: " + (e && e.message ? e.message : e), "youtube");
      return null;
    }
  });

  api.downloads.onResolveByUri("youtube-download", async function(uri, format) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) {
      api.log("warn", "Download URI resolve skipped — yt-dlp not available", "youtube");
      return null;
    }
    var videoId = parseYoutubeUri(uri);
    if (!videoId) {
      api.log("warn", "Download URI resolve: unrecognized uri " + uri, "youtube");
      return null;
    }
    try {
      return await resolveSourceWith(api, function() { return downloadById(api, videoId); }, function(src) {
        // An id-based download carries no searched metadata; title falls back to the
        // yt-dlp videoTitle (if any) then the id, and artist/album are unknown (null).
        return convertForFormat(api, src, format, src.videoTitle || videoId, null, null);
      });
    } catch (e) {
      console.error("[youtube] download URI resolve failed:", e, e.stack || "");
      return null;
    }
  });

  api.downloads.onGetQualities("youtube-download", function() {
    var qualities = [{ value: "aac", label: "AAC (matches source bitrate)" }];
    if (ffmpegVersion) {
      qualities.push({ value: "mp3", label: "MP3 (matches source bitrate)" });
      qualities.push({ value: "flac", label: "FLAC (lossless re-encode)" });
    }
    return qualities;
  });

  api.downloads.onResolveByMetadata("youtube-download", async function(title, artistName, albumName, durationSecs, format) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) {
      api.log("warn", "Download resolve skipped — yt-dlp not available", "youtube");
      return null;
    }
    title = stripRemasterSuffix(title);
    try {
      return await resolveSource(api, title, artistName, durationSecs, function (src) {
        return convertForFormat(api, src, format, title, artistName, albumName);
      });
    } catch (e) {
      console.error("[youtube] download resolve failed:", e, e.stack || "");
      return null;
    }
  });

  // Interactive search — powers the host download modal's manual-search picker.
  // Reuses the same yt-dlp search the sidebar view uses; results carry the exact
  // video id so the matching resolve downloads precisely what the user picked.
  api.downloads.onInteractiveSearch("youtube-download", async function(query, limit) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) return [];
    var candidates = await runYtSearch(api, query, limit || 10);
    var out = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var parsed = parseTrackTitle(c.title, c.channel);
      out.push({
        id: c.videoId, // bare 11-char id — resolved by exact id below, never re-searched
        title: parsed.title || c.title || c.videoId,
        artistName: parsed.artist || c.channel || undefined,
        durationSecs: c.durationSecs != null ? c.durationSecs : undefined,
        coverUrl: thumbnailUrl(c.videoId)
      });
    }
    return out;
  });

  // Interactive resolve — used by BOTH the multi-track/batch download flow (the
  // host passes each selected track's youtube://<id> uri as the matchId) and the
  // manual-search picker (a bare video id). Either way we download that EXACT
  // video by id and never re-search by metadata, so the user gets precisely the
  // results they selected. Throws on failure so the host marks the track errored
  // (a null return would crash the host's `resolved.url` read).
  api.downloads.onInteractiveResolve("youtube-download", async function(matchId, format) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) throw new Error("yt-dlp not available");
    // matchId may be a bare 11-char video id (from interactive search) or a full
    // youtube://<id> uri (from the batch/confirmed download flow). Normalize to the id.
    var videoId = parseYoutubeUri(matchId) || matchId;
    if (!VIDEO_ID_RE.test(videoId)) throw new Error("Invalid YouTube match id: " + matchId);
    var result = await resolveSourceWith(api, function() { return downloadById(api, videoId); }, function(src) {
      return convertForFormat(api, src, format, src.videoTitle || videoId, null, null);
    });
    if (!result) throw new Error("Failed to download YouTube video " + videoId);
    return result;
  });

  api.ui.onAction("youtube-cache-size", async function(data) {
    var val = parseInt(data, 10);
    if (isNaN(val) || val < 0) return;
    cacheMaxMb = val;
    await api.storage.set("cacheMaxMb", val);
    renderSettings(api);
    scheduleCleanup(api).catch(console.error);
  });

  api.ui.onAction("youtube-search-submit", async function(data) {
    // While a search is in flight the button reads "Cancel" — a click/Enter then
    // cancels: bump the generation (so the in-flight result is discarded) and
    // return to the prior view. yt-dlp keeps running to completion (the plugin
    // API has no kill handle), but its output is dropped by the gen check below.
    if (searching) {
      searchGen++;
      searching = false;
      renderSearchView(api);
      return;
    }
    searchQuery = data && typeof data.query === "string" ? data.query : "";
    if (!searchQuery.trim()) { searchResults = null; renderSearchView(api); return; }
    await ensureToolStatus(api);
    if (!ytDlpVersion) { renderSearchView(api); return; }
    var gen = ++searchGen;
    searching = true;
    renderSearchView(api);
    try {
      // 25 results for the browsable search view (the fallback resolver keeps
      // its small default — it only needs enough to pick a best duration match).
      var results = await runYtSearch(api, searchQuery, 25);
      if (gen !== searchGen) return; // cancelled or superseded — discard
      searchResults = results;
    } catch (e) {
      if (gen !== searchGen) return; // cancelled — ignore the error too
      api.log("error", "Search failed: " + (e && e.message ? e.message : e), "youtube");
      searchResults = []; // renderSearchView will display "No results."
    }
    searching = false;
    renderSearchView(api);
  });

  function findResult(videoId) {
    if (!searchResults) return null;
    for (var i = 0; i < searchResults.length; i++) {
      if (searchResults[i].videoId === videoId) return searchResults[i];
    }
    return null;
  }

  // Map a { selectedIds } payload to the matching candidates (skips unknown ids).
  function selectedResults(data) {
    var ids = data && data.selectedIds ? data.selectedIds : [];
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var c = findResult(ids[i]);
      if (c) out.push(c);
    }
    return out;
  }

  api.ui.onAction("youtube-play", function(data) {
    var chosen = selectedResults(data);
    if (chosen.length === 0) return;
    if (!ytDlpVersion) return;
    var tracks = [];
    for (var i = 0; i < chosen.length; i++) tracks.push(buildTrack(chosen[i]));
    api.playback.playTracks(tracks, 0);
  });

  api.ui.onAction("youtube-queue", function(data) {
    var chosen = selectedResults(data);
    if (chosen.length === 0) return;
    if (!ytDlpVersion) return;
    var tracks = [];
    for (var i = 0; i < chosen.length; i++) tracks.push(buildTrack(chosen[i]));
    api.playback.insertTracks(tracks, -1);
  });

  // Click-to-play a single row. The host sends the row's id (a bare videoId) as
  // data.itemId; resolve it against the current results and play just that one.
  api.ui.onAction("youtube-play-one", function(data) {
    var id = data && data.itemId;
    if (!id) return;
    if (!ytDlpVersion) return;
    var c = findResult(id);
    if (!c) return;
    api.playback.playTracks([buildTrack(c)], 0);
  });

  api.ui.onAction("youtube-download", function(data) {
    var chosen = selectedResults(data);
    if (chosen.length === 0) return;
    if (!ytDlpVersion) {
      api.ui.showNotification("yt-dlp isn't installed — can't download. See Settings → Dependencies.");
      return;
    }
    // Route through the host's standard download modal instead of enqueueing
    // directly, so the user gets a say: destination + format/quality (AAC/MP3/
    // FLAC via onGetQualities) selection, and per-track progress + error
    // reporting. A single selection opens the single-track flow (configured by
    // its youtube:// uri); multiple opens the batch flow. The providerId is
    // namespaced "<pluginId>:<providerId>" — how the host keys download providers.
    var tracks = [];
    for (var i = 0; i < chosen.length; i++) {
      var t = buildTrack(chosen[i]);
      tracks.push({
        title: t.title,
        artist_name: t.artist_name,
        album_title: null,
        uri: t.path, // youtube://<videoId>
        durationSecs: t.duration_secs
      });
    }
    api.ui.requestAction("download-tracks", {
      providerId: "youtube:youtube-download",
      providerName: "YouTube",
      tracks: tracks
    });
  });

  renderSettings(api);
  renderSearchView(api);

  // Populate dependency status shortly AFTER activation (next tick), not during
  // it — so the view reflects real status without blocking the plugin load.
  // Reads the host's cached status (no GitHub, no version checking here).
  setTimeout(function() {
    ensureToolStatus(api).then(function() {
      renderSettings(api);
      renderSearchView(api);
    });
  }, 0);
}

// Plugin settings: just the cache control. Dependency status/install lives in
// the host's Settings → Dependencies (the plugin no longer owns that UX).
function renderSettings(api) {
  api.ui.setViewData("youtube-settings", {
    type: "layout",
    direction: "vertical",
    children: [
      {
        type: "section",
        title: "Cache",
        children: [
          {
            type: "settings-row",
            label: "Cache size limit",
            description: cacheMaxMb === 0 ? "Only the current track is kept on disk" : cacheMaxMb + " MB",
            control: {
              type: "select",
              action: "youtube-cache-size",
              value: String(cacheMaxMb),
              options: [
                { value: "0", label: "Off (no caching)" },
                { value: "50", label: "50 MB" },
                { value: "100", label: "100 MB" },
                { value: "200", label: "200 MB" },
                { value: "500", label: "500 MB" },
                { value: "1000", label: "1 GB" }
              ]
            }
          }
        ]
      }
    ]
  });
}

// A slim, informational note when yt-dlp is missing — no install button and no
// recheck. Installing/updating is the host's job (sidebar dot + Settings →
// Dependencies); this just explains why search/play does nothing. Returns null
// when status is unknown or yt-dlp is present.
function makeMissingDepNote() {
  if (!statusLoaded || ytDlpVersion) return null;
  return {
    type: "text",
    className: "ds-banner ds-banner--error",
    content: "yt-dlp isn't installed. Install it from Settings → Dependencies to use YouTube."
  };
}

function renderSearchView(api) {
  var children = [];
  var note = makeMissingDepNote();
  if (note) children.push(note);
  children.push({
    type: "search-input",
    placeholder: "Search YouTube...",
    action: "youtube-search-submit",
    value: searchQuery,
    buttonLabel: searching ? "Cancel" : "Search"
  });

  if (searching) {
    children.push({ type: "loading", message: "Searching YouTube…" });
  } else if (searchResults && searchResults.length > 0) {
    var items = [];
    for (var i = 0; i < searchResults.length; i++) {
      var c = searchResults[i];
      var parsed = parseTrackTitle(c.title, c.channel);
      items.push({
        id: c.videoId,
        title: parsed.title || c.title || c.videoId,
        subtitle: parsed.artist || c.channel || "",
        duration: formatDuration(c.durationSecs),
        imageUrl: thumbnailUrl(c.videoId),
        action: "youtube-play-one"
      });
    }
    children.push({
      type: "track-row-list",
      selectable: true,
      items: items,
      actions: [
        { id: "youtube-play", label: "Play", icon: "▶" },
        { id: "youtube-queue", label: "Queue", icon: "+" },
        { id: "youtube-download", label: "Download", icon: "⬇" }
      ]
    });
  } else if (searchResults && searchResults.length === 0) {
    children.push({ type: "text", content: "No results.", className: "ds-empty" });
  } else {
    children.push({ type: "text", content: "Search YouTube to play or download a track.", className: "ds-empty" });
  }

  api.ui.setViewData("youtube-search", { type: "layout", direction: "vertical", children: children });
}

function deactivate() {
  ytDlpVersion = null;
  ffmpegVersion = null;
  statusLoaded = false;
  inFlightFiles = {};
  lastSourceFile = null;
  searchQuery = "";
  searchResults = null;
  searching = false;
  searchGen = 0;
}

return { activate: activate, deactivate: deactivate, _parseTrackTitle: parseTrackTitle, _formatDuration: formatDuration, _loadToolStatus: loadToolStatus };
