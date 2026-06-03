# YouTube Search Sidebar View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a left-sidebar YouTube search view where each result can be Played or Downloaded, resolving by the exact clicked video id via `youtube://<videoId>` URIs.

**Architecture:** A new `youtube-search` sidebar item (declared in `manifest.json`) renders via `api.ui.setViewData`/`onAction`, reusing the same view-data primitives as the existing settings panel. Existing search/download/convert logic in `index.js` is refactored into shared helpers (`runYtSearch`, `downloadById`, `convertForFormat`) so the new exact-id Play/Download paths and the existing fuzzy fallback paths share one implementation with no behavior change to the latter. A pure `parseTrackTitle` helper does best-effort `Artist - Song` extraction for display.

**Tech Stack:** Plain ES (sandbox `var`/`function` style, no build step). Tests run with `node --test` against the in-repo zero-dependency harness (`test/harness/sandbox.js` + `mock-api.js`).

---

## File Structure

- **Modify `index.js`** — the entire plugin. New module state, refactors, the search view renderer, action handlers, and two new/implemented resolvers all live here (single-file plugin by host constraint).
- **Modify `manifest.json`** — add the `sidebarItems` contribution.
- **Modify `test/harness/mock-api.js`** — capture `playback.playTrack`, `playback.onResolveStreamByUri`, and the existing `downloads.onResolveByUri` already captured; add `downloads.enqueue` capture.
- **Modify `test/search.test.js`** — update existing fixtures from 3-column to 4-column `--print` output (channel added).
- **Create `test/title-parse.test.js`** — unit tests for `parseTrackTitle`.
- **Create `test/search-view.test.js`** — tests for the view action handlers and URI resolvers.
- **Modify `CHANGELOG.md`** and bump version at the end.

### Key identifiers (must stay consistent across tasks)

- Sidebar item id / view id: `"youtube-search"` (icon `"search"`).
- Actions: `"youtube-search-submit"`, `"youtube-play"`, `"youtube-download"`.
- **Host dispatch contracts** (verified in `outcast1000/viboplr`
  `src/components/pluginViews/pluginViews.tsx`): `search-input` fires
  `onAction(action, { query })`; a **selectable** `track-row-list`'s toolbar
  `actions` fire `onAction(actionId, { selectedIds: [...] })`. Rows are selected via
  checkboxes — there is no per-row action callback. The view therefore uses
  `selectable: true` and Play/Download operate on the checked set.
- URI scheme/protocol: `"youtube"` → track `path` = `"youtube://" + videoId`.
- Stream URI resolver registration: `api.playback.onResolveStreamByUri("youtube", fn)`.
- Download URI resolver registration: `api.downloads.onResolveByUri("youtube-download", fn)`.
- New functions: `runYtSearch(api, query)`, `pickBestCandidate(candidates, durationSecs, api)`, `downloadById(api, videoId)`, `convertForFormat(api, src, format, title, artistName, albumName)`, `parseTrackTitle(rawTitle, channel)`, `formatDuration(secs)`, `renderSearchView(api)`.
- Module state vars: `searchQuery` (string, init `""`), `searchResults` (array|null, init `null`), `searching` (bool, init `false`).

---

## Task 1: Add `parseTrackTitle` pure helper

**Files:**
- Modify: `index.js` (add helper near `stripRemasterSuffix`, ~line 24)
- Test: `test/title-parse.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/title-parse.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox.js");

// parseTrackTitle is internal; expose it for testing by reading it off the
// plugin module. The plugin returns { activate, deactivate }, so we instead
// test via a tiny exec: load the file and grab the function through a global
// hook. Simplest faithful approach: the sandbox preamble can't reach internals,
// so we re-require the raw source and eval the function in isolation is brittle.
// Instead, Task 1 exports parseTrackTitle on the returned object for tests.
const plugin = loadPlugin();
const parse = plugin._parseTrackTitle;

test("splits 'Artist - Song' and strips official-video tag", () => {
  const r = parse("Rick Astley - Never Gonna Give You Up (Official Music Video)", "RickAstleyVEVO");
  assert.equal(r.artist, "Rick Astley");
  assert.equal(r.title, "Never Gonna Give You Up");
});

test("keeps feat. as part of the title", () => {
  const r = parse("Daft Punk – Get Lucky ft. Pharrell", "DaftPunkVEVO");
  assert.equal(r.artist, "Daft Punk");
  assert.equal(r.title, "Get Lucky ft. Pharrell");
});

test("keeps (Remix) and (Live) — real information", () => {
  const r = parse("Artist - Song (Live)", "ch");
  assert.equal(r.title, "Song (Live)");
});

test("no separator falls back to channel as artist, cleaned title", () => {
  const r = parse("lofi hip hop radio (Official Video)", "Lofi Girl");
  assert.equal(r.artist, "Lofi Girl");
  assert.equal(r.title, "lofi hip hop radio");
});

test("splits on the FIRST separator only", () => {
  const r = parse("Artist - Album - Song", "ch");
  assert.equal(r.artist, "Artist");
  assert.equal(r.title, "Album - Song");
});

test("empty side after split falls back to channel", () => {
  const r = parse("- Song", "ch");
  assert.equal(r.artist, "ch");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/title-parse.test.js`
Expected: FAIL — `plugin._parseTrackTitle is not a function` (undefined).

- [ ] **Step 3: Implement `parseTrackTitle` and expose it**

In `index.js`, add after `stripRemasterSuffix` (~line 24):

```js
// Trailing noise tags to strip from a YouTube video title before display.
// Conservative: removes promo/quality tags but KEEPS (Remix)/(Live)/feat. —
// those carry real song information.
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
```

Then change the final return at the bottom of `index.js` to expose the helper for tests (the host ignores extra keys):

```js
return { activate: activate, deactivate: deactivate, _parseTrackTitle: parseTrackTitle };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/title-parse.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add index.js test/title-parse.test.js
git commit -m "Add parseTrackTitle helper for Artist - Song extraction"
```

---

## Task 2: Split `searchYoutube` into `runYtSearch` + `pickBestCandidate`, add channel column

**Files:**
- Modify: `index.js:140-204` (`searchYoutube`)
- Modify: `test/search.test.js` (update fixtures to 4 columns)
- Test: existing `test/search.test.js` + `test/resolve.test.js` (regression)

- [ ] **Step 1: Update existing search test fixtures to 4-column output**

The `--print` template gains a channel column: `%(id)s\t%(duration)s\t%(channel)s\t%(title)s`. Update every fixture line in `test/search.test.js` to insert a channel field between duration and title. For example change:

```js
"dQw4w9WgXcQ\t213\tRick Astley - Never Gonna Give You Up",
```
to:
```js
"dQw4w9WgXcQ\t213\tRickAstleyVEVO\tRick Astley - Never Gonna Give You Up",
```

Apply the same edit (insert a `\t<channel>` after the duration column) to ALL multi-column fixture lines in the file. Use `"ch"` as the channel where a name doesn't matter.

- [ ] **Step 2: Run tests to verify they FAIL**

Run: `node --test test/search.test.js`
Expected: FAIL — the current parser treats column index 2 as the title, so it now reads the channel as the title and the duration-match/first-result assertions still pass but title-derived ones drift; more importantly the new 4-col fixtures won't parse correctly until the parser is updated. (If they happen to still pass, Step 4 is still required for correctness.)

- [ ] **Step 3: Refactor `searchYoutube` into two functions**

Replace the body of `searchYoutube` (`index.js:140-204`) with a low-level search returning all candidates plus a separate picker. New code:

```js
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
    if (api) api.log("warn", "yt-dlp search parsed 0 valid candidates", "youtube");
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
```

- [ ] **Step 4: Run tests to verify they PASS**

Run: `node --test test/search.test.js test/resolve.test.js`
Expected: PASS — all existing tests green (fallback behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add index.js test/search.test.js
git commit -m "Split searchYoutube into runYtSearch + pickBestCandidate; add channel column"
```

---

## Task 3: Extract `downloadById` from `searchAndDownload`

**Files:**
- Modify: `index.js:351-414` (`searchAndDownload`)
- Test: existing `test/resolve.test.js` + `test/cache.test.js` (regression)

- [ ] **Step 1: Run existing tests to capture the green baseline**

Run: `node --test test/resolve.test.js test/cache.test.js`
Expected: PASS (baseline before refactor).

- [ ] **Step 2: Extract `downloadById` and rewrite `searchAndDownload` to use it**

In `index.js`, add `downloadById` before `searchAndDownload`, and rewrite `searchAndDownload` to compose search + download. The download body is moved verbatim from the existing `searchAndDownload` (cache check + yt-dlp download):

```js
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
```

- [ ] **Step 3: Run tests to verify they PASS**

Run: `node --test test/resolve.test.js test/cache.test.js`
Expected: PASS — unchanged behavior, `searchAndDownload` now delegates to `downloadById`.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "Extract downloadById from searchAndDownload"
```

---

## Task 4: Extract `convertForFormat` from the metadata download handler

**Files:**
- Modify: `index.js:480-557` (the `onResolveByMetadata` handler body)
- Test: existing `test/convert.test.js` (regression)

- [ ] **Step 1: Run existing convert tests as baseline**

Run: `node --test test/convert.test.js`
Expected: PASS (baseline).

- [ ] **Step 2: Extract `convertForFormat` and call it from the metadata handler**

Add `convertForFormat` near the other download helpers (e.g. after `resolveSource`, ~line 435). Move the probe/convert/return logic verbatim out of the `onResolveByMetadata` callback:

```js
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
    api.log("warn", "ffmpeg not available — serving original download (." + (srcExt || "?") + ") without conversion", "youtube");
  } else {
    var ext = spec.ext;
    var probe = await probeAudio(api, srcPath);
    if (probe) {
      api.log("info", "Source: " + (probe.codec || "?") + " @ " + (probe.bitrateKbps || "?") + " kb/s", "youtube");
    } else {
      api.log("warn", "Could not probe source — falling back to transcode defaults", "youtube");
    }
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
```

Then replace the inner work function of `onResolveByMetadata` (`index.js:487-552`) so it delegates:

```js
  api.downloads.onResolveByMetadata("youtube-download", async function(title, artistName, albumName, durationSecs, format) {
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
```

- [ ] **Step 3: Run tests to verify they PASS**

Run: `node --test test/convert.test.js test/resolve.test.js`
Expected: PASS — conversion behavior unchanged.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "Extract convertForFormat shared by download resolvers"
```

---

## Task 5: Extend the mock API harness for playback + enqueue

**Files:**
- Modify: `test/harness/mock-api.js`

- [ ] **Step 1: Add capture for the new API surface**

In `mock-api.js`, extend the `calls` object and the `playback`/`downloads` sections. Change the `calls` initializer (line 70) to add `playTrack` and `enqueue` arrays:

```js
  const calls = { exec: [], log: [], setViewData: [], openUrl: [], playTrack: [], enqueue: [] };
```

Extend `playback` (currently only `onStreamResolve`):

```js
    playback: {
      onStreamResolve: (id, fn) => { handlers["stream:" + id] = fn; },
      onResolveStreamByUri: (scheme, fn) => { handlers["streamuri:" + scheme] = fn; },
      playTrack: (track) => { calls.playTrack.push(track); },
      playTracks: (tracks, startIndex, context) => { calls.playTrack.push({ tracks, startIndex, context }); },
    },
```

Extend `downloads` to capture `enqueue` (keep existing registrations):

```js
    downloads: {
      onResolveByUri: (id, fn) => { handlers["uri:" + id] = fn; },
      onResolveByMetadata: (id, fn) => { handlers["meta:" + id] = fn; },
      onGetQualities: (id, fn) => { handlers["qual:" + id] = fn; },
      enqueue: async (request) => { calls.enqueue.push(request); return calls.enqueue.length; },
    },
```

- [ ] **Step 2: Verify the existing suite still loads and passes**

Run: `node --test`
Expected: PASS — all existing tests still green (additive change only).

- [ ] **Step 3: Commit**

```bash
git add test/harness/mock-api.js
git commit -m "Extend mock api harness with playTrack/onResolveStreamByUri/enqueue"
```

---

## Task 6: Add the search view renderer and `formatDuration`

**Files:**
- Modify: `index.js` (add `formatDuration` + `renderSearchView`, and module state vars at top)
- Test: `test/search-view.test.js` (create — view rendering assertions)

- [ ] **Step 1: Write the failing test**

Create `test/search-view.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

function baseApi(extra) {
  return makeApi(Object.assign({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
    ],
  }, extra || {}));
}

// Pull the last setViewData payload for a given view id.
function lastView(api, id) {
  const calls = api.calls.setViewData.filter((c) => c.id === id);
  return calls.length ? calls[calls.length - 1].data : null;
}

// Recursively find the first node of a given type in a PluginViewData tree.
function findNode(node, type) {
  if (!node || typeof node !== "object") return null;
  if (node.type === type) return node;
  const kids = node.children || node.items || [];
  for (const k of kids) {
    const hit = findNode(k, type);
    if (hit) return hit;
  }
  return null;
}

test("renders a search-input on activate", async () => {
  const api = baseApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const view = lastView(api, "youtube-search");
  assert.ok(view, "youtube-search view was set");
  assert.ok(findNode(view, "search-input"), "has a search-input");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/search-view.test.js`
Expected: FAIL — `youtube-search view was set` assertion fails (renderer not wired yet).

- [ ] **Step 3: Add module state, `formatDuration`, and `renderSearchView`**

At the top of `index.js` near the other state vars (~line 6), add:

```js
var searchQuery = "";
var searchResults = null; // array of candidates, or null before first search
var searching = false;
```

Add `formatDuration` near the path helpers (~line 38):

```js
// Seconds -> "m:ss" / "h:mm:ss" for display. Returns "" for null/NaN.
function formatDuration(secs) {
  if (secs == null || isNaN(secs)) return "";
  var s = Math.floor(secs % 60);
  var m = Math.floor((secs / 60) % 60);
  var h = Math.floor(secs / 3600);
  var mm = (h > 0 && m < 10 ? "0" : "") + m;
  var ss = (s < 10 ? "0" : "") + s;
  return (h > 0 ? h + ":" : "") + mm + ":" + ss;
}
```

Add `renderSearchView` next to `renderSettings` (~line 666):

```js
function renderSearchView(api) {
  var children = [
    {
      type: "search-input",
      placeholder: "Search YouTube…",
      action: "youtube-search-submit",
      submitOnly: true,
      value: searchQuery
    }
  ];

  if (!ytDlpVersion) {
    children.push({ type: "text", content: "yt-dlp is not installed. Open the YouTube settings panel to install it." });
  } else if (searching) {
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
        duration: formatDuration(c.durationSecs)
      });
    }
    children.push({
      type: "track-row-list",
      selectable: true,
      items: items,
      actions: [
        { id: "youtube-play", label: "Play" },
        { id: "youtube-download", label: "Download" }
      ]
    });
  } else if (searchResults && searchResults.length === 0) {
    children.push({ type: "text", content: "No results." });
  } else {
    children.push({ type: "text", content: "Search YouTube to play or download a track." });
  }

  api.ui.setViewData("youtube-search", { type: "layout", direction: "vertical", children: children });
}
```

Finally, call it once at the end of `activate` (after `renderSettings(api);`, ~line 584):

```js
  renderSearchView(api);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/search-view.test.js`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add index.js test/search-view.test.js
git commit -m "Add renderSearchView and formatDuration"
```

---

## Task 7: Wire the search submit action

**Files:**
- Modify: `index.js` (register `youtube-search-submit` in `activate`)
- Test: `test/search-view.test.js` (add submit test)

- [ ] **Step 1: Add the failing test**

Append to `test/search-view.test.js`:

```js
test("submit renders a track-row-list of ALL candidates", async () => {
  const stdout = [
    "dQw4w9WgXcQ\t213\tRickAstleyVEVO\tRick Astley - Never Gonna Give You Up",
    "abcdefghijk\t180\tSomeChannel\tSome Other Song",
  ].join("\n") + "\n";
  const api = baseApi({
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
      { match: { cmd: "yt-dlp", argsInclude: ["ytsearch"] }, result: { exitCode: 0, stdout: stdout } },
    ],
  });
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-search-submit"]({ query: "never gonna give you up" });
  const view = lastView(api, "youtube-search");
  const list = findNode(view, "track-row-list");
  assert.ok(list, "rendered a track-row-list");
  assert.equal(list.selectable, true, "list is selectable");
  assert.equal(list.items.length, 2, "shows all candidates");
  assert.equal(list.items[0].title, "Never Gonna Give You Up");
  assert.equal(list.items[0].subtitle, "Rick Astley");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/search-view.test.js`
Expected: FAIL — `api._handlers["action:youtube-search-submit"]` is undefined.

- [ ] **Step 3: Register the action in `activate`**

The host dispatches `search-input` submits as `onAction(action, { query })`, so the
handler reads `data.query`. Add alongside the other `api.ui.onAction` registrations
(~line 559):

```js
  api.ui.onAction("youtube-search-submit", async function(data) {
    searchQuery = data && typeof data.query === "string" ? data.query : "";
    if (!searchQuery.trim()) { searchResults = null; renderSearchView(api); return; }
    if (!ytDlpVersion) { renderSearchView(api); return; }
    searching = true;
    renderSearchView(api);
    try {
      searchResults = await runYtSearch(api, searchQuery);
    } catch (e) {
      api.log("error", "Search failed: " + (e && e.message ? e.message : e), "youtube");
      searchResults = [];
    }
    searching = false;
    renderSearchView(api);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/search-view.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add index.js test/search-view.test.js
git commit -m "Wire youtube-search-submit action"
```

---

## Task 8: Wire Play and Download toolbar actions (selectable mode)

**Files:**
- Modify: `index.js` (register `youtube-play` and `youtube-download` in `activate`)
- Test: `test/search-view.test.js` (add action tests)

The toolbar actions of a **selectable** `track-row-list` are dispatched by the host
as `onAction(actionId, { selectedIds: [...] })` (verified in `pluginViews.tsx`,
toolbar `onClick={() => onAction?.(a.id, { selectedIds: Array.from(selected) })}`).
Each handler maps the selected videoIds back to candidates in `searchResults` to
recover title/channel, plays the whole set via `playTracks`, and enqueues one
download per id.

- [ ] **Step 1: Add the failing tests**

Append to `test/search-view.test.js`:

```js
function searchApi() {
  return baseApi({
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
      { match: { cmd: "yt-dlp", argsInclude: ["ytsearch"] }, result: { exitCode: 0,
        stdout: [
          "dQw4w9WgXcQ\t213\tRickAstleyVEVO\tRick Astley - Never Gonna Give You Up",
          "abcdefghijk\t180\tSomeChannel\tArtist Two - Song Two",
        ].join("\n") + "\n" } },
    ],
  });
}

test("youtube-play builds youtube:// PluginTracks and calls playTracks", async () => {
  const api = searchApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-search-submit"]({ query: "rick astley" });
  await api._handlers["action:youtube-play"]({ selectedIds: ["dQw4w9WgXcQ"] });
  assert.equal(api.calls.playTrack.length, 1, "playTracks recorded once");
  const rec = api.calls.playTrack[0];
  // mock records playTracks as { tracks, startIndex, context }
  assert.equal(rec.startIndex, 0);
  assert.equal(rec.tracks.length, 1);
  const t = rec.tracks[0];
  assert.equal(t.path, "youtube://dQw4w9WgXcQ");
  assert.equal(t.title, "Never Gonna Give You Up");
  assert.equal(t.artist_name, "Rick Astley");
  assert.equal(t.duration_secs, 213);
});

test("youtube-download enqueues once per selected id with the youtube:// uri", async () => {
  const api = searchApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-search-submit"]({ query: "rick astley" });
  await api._handlers["action:youtube-download"]({ selectedIds: ["dQw4w9WgXcQ", "abcdefghijk"] });
  assert.equal(api.calls.enqueue.length, 2);
  const req = api.calls.enqueue[0];
  assert.equal(req.uri, "youtube://dQw4w9WgXcQ");
  assert.equal(req.provider, "youtube-download");
  assert.equal(req.title, "Never Gonna Give You Up");
  assert.equal(req.artistName, "Rick Astley");
});

test("actions ignore empty / unknown selections without throwing", async () => {
  const api = searchApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-search-submit"]({ query: "rick astley" });
  await api._handlers["action:youtube-play"]({ selectedIds: [] });
  await api._handlers["action:youtube-download"]({ selectedIds: ["zzzzzzzzzzz"] });
  assert.equal(api.calls.playTrack.length, 0);
  assert.equal(api.calls.enqueue.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/search-view.test.js`
Expected: FAIL — `action:youtube-play` / `action:youtube-download` handlers undefined.

- [ ] **Step 3: Register the toolbar actions in `activate`**

Add after the submit action. A shared lookup + selection mapper keeps them DRY:

```js
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
    var tracks = [];
    for (var i = 0; i < chosen.length; i++) {
      var c = chosen[i];
      var parsed = parseTrackTitle(c.title, c.channel);
      tracks.push({
        title: parsed.title || c.title || c.videoId,
        artist_name: parsed.artist || c.channel || null,
        duration_secs: c.durationSecs != null ? c.durationSecs : null,
        path: "youtube://" + c.videoId
      });
    }
    api.playback.playTracks(tracks, 0);
  });

  api.ui.onAction("youtube-download", function(data) {
    var chosen = selectedResults(data);
    for (var i = 0; i < chosen.length; i++) {
      var c = chosen[i];
      var parsed = parseTrackTitle(c.title, c.channel);
      api.downloads.enqueue({
        title: parsed.title || c.title || c.videoId,
        artistName: parsed.artist || c.channel || null,
        uri: "youtube://" + c.videoId,
        provider: "youtube-download"
      });
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/search-view.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add index.js test/search-view.test.js
git commit -m "Wire Play and Download toolbar actions (selectable mode)"
```

---

## Task 9: Implement the exact-id URI resolvers (stream + download)

**Files:**
- Modify: `index.js` (new `onResolveStreamByUri`; replace the `onResolveByUri` stub at lines 466-469)
- Test: `test/search-view.test.js` (add resolver tests)

- [ ] **Step 1: Add the failing tests**

Append to `test/search-view.test.js`:

```js
function resolverApi() {
  return makeApi({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
      { match: { cmd: "yt-dlp", argsInclude: ["bestaudio"] }, result: (cmd, args) => {
          const oIdx = args.indexOf("-o");
          const id = args[oIdx + 1].replace(/\..*$/, "");
          return { exitCode: 0, stdout: "/mock-plugin-data/cache/" + id + ".webm\n" };
        } },
      { match: { cmd: "ffmpeg", argsInclude: ["-c:a"] }, result: { exitCode: 0, stdout: "" } },
    ],
  });
}

test("stream URI resolver downloads the exact id WITHOUT searching", async () => {
  const api = resolverApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const url = await api._handlers["streamuri:youtube"]("dQw4w9WgXcQ");
  assert.equal(url, "file:///mock-plugin-data/cache/dQw4w9WgXcQ.webm");
  // no ytsearch was ever run
  const searched = api.calls.exec.some((e) => e.args.join(" ").includes("ytsearch"));
  assert.equal(searched, false, "must not search — resolves by exact id");
});

test("download URI resolver resolves the exact id and returns a file url", async () => {
  const api = resolverApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const res = await api._handlers["uri:youtube-download"]("youtube://dQw4w9WgXcQ", "aac");
  assert.ok(res && res.url && res.url.startsWith("file://"), "returns a file url");
  const searched = api.calls.exec.some((e) => e.args.join(" ").includes("ytsearch"));
  assert.equal(searched, false, "must not search — resolves by exact id");
});

test("download URI resolver returns null for a malformed uri", async () => {
  const api = resolverApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const res = await api._handlers["uri:youtube-download"]("youtube://not-a-valid-id!!", "aac");
  assert.equal(res, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/search-view.test.js`
Expected: FAIL — `streamuri:youtube` handler undefined; the `uri:youtube-download` stub currently returns `null` for the valid case (so the first download assertion fails).

- [ ] **Step 3: Implement both resolvers**

Add a small id parser near `watchUrl` (~line 97):

```js
// Parse a youtube://<videoId> URI. Returns the 11-char id or null.
function parseYoutubeUri(uri) {
  if (!uri || uri.indexOf("youtube://") !== 0) return null;
  var id = uri.substring("youtube://".length);
  return VIDEO_ID_RE.test(id) ? id : null;
}
```

Register the stream URI resolver in `activate`, right after the existing `onStreamResolve` registration (~line 464):

```js
  api.playback.onResolveStreamByUri("youtube", async function(videoId, quality) {
    if (!ytDlpVersion) {
      api.log("warn", "Stream URI resolve skipped — yt-dlp not available", "youtube");
      return null;
    }
    if (!VIDEO_ID_RE.test(videoId)) {
      api.log("warn", "Stream URI resolve: invalid video id " + videoId, "youtube");
      return null;
    }
    try {
      var src = await resolveSource2(api, function() { return downloadById(api, videoId); });
      return src ? "file://" + src.filePath : null;
    } catch (e) {
      api.log("error", "Stream URI resolve failed: " + (e && e.message ? e.message : e), "youtube");
      return null;
    }
  });
```

Replace the `onResolveByUri` stub (`index.js:466-469`) with:

```js
  api.downloads.onResolveByUri("youtube-download", async function(uri, format) {
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
      return await resolveSource2(api, function() { return downloadById(api, videoId); }, function(src) {
        return convertForFormat(api, src, format, src.videoTitle || videoId, null, null);
      });
    } catch (e) {
      console.error("[youtube] download URI resolve failed:", e, e.stack || "");
      return null;
    }
  });
```

`resolveSource` currently couples search+download+work. Add a sibling that takes a producer function so the URI paths reuse the same in-flight/cleanup protection. Add it right after `resolveSource` (~line 435):

```js
// Like resolveSource but the source is produced by `produce()` (e.g. downloadById
// for an exact id) instead of searchAndDownload. `work` is optional — when omitted
// the src object itself is returned (used by the stream URI resolver).
async function resolveSource2(api, produce, work) {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/search-view.test.js`
Expected: PASS — 8 tests (1 render + 1 submit + 3 actions + 3 resolvers).

- [ ] **Step 5: Run the FULL suite**

Run: `node --test`
Expected: PASS — all suites green (search, resolve, cache, convert, sandbox, mock-api, title-parse, search-view).

- [ ] **Step 6: Commit**

```bash
git add index.js test/search-view.test.js
git commit -m "Implement exact-id youtube:// stream and download URI resolvers"
```

---

## Task 10: Declare the sidebar item in the manifest

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: Add the `sidebarItems` contribution**

In `manifest.json`, add to the `contributes` object (alongside the existing `streamResolvers`, `downloadProviders`, `settingsPanel`):

```json
    "sidebarItems": [
      { "id": "youtube-search", "label": "YouTube", "icon": "search" }
    ],
```

Place it before `settingsPanel` so the JSON stays valid (mind the trailing comma — `settingsPanel` follows it).

- [ ] **Step 2: Verify the manifest is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest OK')"`
Expected: `manifest OK`

- [ ] **Step 3: Run the full suite (sanity)**

Run: `node --test`
Expected: PASS — all suites green.

- [ ] **Step 4: Commit**

```bash
git add manifest.json
git commit -m "Declare youtube-search sidebar item"
```

---

## Task 11: Changelog + version bump

**Files:**
- Modify: `CHANGELOG.md`
- Run: `scripts/bump.sh minor`

- [ ] **Step 1: Add a changelog entry**

Add a new top section to `CHANGELOG.md` (above the current top entry). Use the next minor version (this is a feature, not a fix). If current is `1.0.3`, the new version is `1.1.0`:

```markdown
## v1.1.0

- Add a **YouTube search** sidebar view: search YouTube and Play or Download any
  result directly. Play/Download target the exact selected video (via
  `youtube://<id>`), not a fuzzy metadata re-search.
- Best-effort `Artist - Song` parsing of result titles for cleaner display.
- Internal: shared `runYtSearch`/`downloadById`/`convertForFormat` helpers now back
  both the fuzzy fallback paths and the new exact-id paths.
```

- [ ] **Step 2: Bump the version**

Run: `bash scripts/bump.sh minor`
Expected: `manifest.json` version updated to `1.1.0` (the script bumps the manifest version).

Verify:
Run: `node -e "console.log(require('./manifest.json').version)"`
Expected: `1.1.0`

- [ ] **Step 3: Run the full suite one final time**

Run: `node --test`
Expected: PASS — all suites green.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md manifest.json
git commit -m "Changelog and version bump for search view (v1.1.0)"
```

---

## Notes for the executor

- **Single-file plugin:** all logic lives in `index.js`; do not split it into modules (the host loads exactly one file). Match the existing `var`/`function` style.
- **The `_parseTrackTitle` export** (Task 1) is a test seam. The host ignores extra keys on the returned object, so it is harmless in production. Keep it.
- **Behavior preservation is the bar for Tasks 2–4:** the existing `search.test.js`/`resolve.test.js`/`cache.test.js`/`convert.test.js` must stay green. If a refactor breaks them, the refactor is wrong — do not edit those tests to pass (except the deliberate 4-column fixture update in Task 2 Step 1).
- **`bump.sh` behavior:** if `scripts/bump.sh minor` does something other than set the manifest version (inspect it first), fall back to editing `manifest.json`'s `version` field directly to `1.1.0`.
- **Do not touch** the release/CI flow or `scripts/package.sh`; releasing is a separate, manual step per `CLAUDE.md`.
