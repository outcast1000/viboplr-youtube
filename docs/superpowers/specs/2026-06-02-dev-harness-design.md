# Dev Harness Design — viboplr-youtube

**Date:** 2026-06-02
**Status:** Approved (pending implementation)

## Problem

The plugin ships as a versioned release the host app auto-updates, but there is
**no test harness and no dev sandbox** in the repo (CLAUDE.md: "No browser/Tauri
dev harness exists"). The realistic loop is symlink-into-host + manual reload.
The recent code review fixed several real bugs (duration matching on downloads,
ffmpeg-missing handling, cache eviction races, the "Off" cache mode) that could
only be verified by reading — not by running. We want **automated, CI-able tests**
that lock in those fixes and catch regressions before a tag is pushed.

## Goals

- Load the **real, unmodified `index.js`** exactly as the host runs it and assert
  its behavior.
- Cover the logic the review touched: search parsing/duration match, cache
  eviction/protection, format conversion, and the resolve paths (incl.
  ffmpeg-missing).
- Run with **zero dependencies** and in CI; gate releases on tests passing.
- Double as a **sandbox-compliance check**: catch accidental use of globals the
  host forbids (`fetch`, `require`, `Math.random`, `Date.now`, …).

## Non-Goals

- A manual/interactive runner against real `yt-dlp`/`ffmpeg` (considered and
  deferred; this spec is automated tests only).
- Mocking the host's WebView, DOM, or Tauri IPC beyond what the plugin touches.
- Any change to `index.js` behavior. The file is the system-under-test, edited
  only if a test surfaces a genuine bug.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Harness goal | Automated tests (CI-able) |
| Test tooling | Zero deps — Node 22 `node:test` + `node:assert` |
| Sandbox fidelity | Faithful: `new Function(...)` with **only** the host's frozen globals |
| Exec mocking | Match by command + arg-substring; full arg arrays recorded for precise assertions |

## Architecture

### Directory layout

```
viboplr-youtube/
├── index.js                 # unchanged — system under test
├── package.json             # NEW: { "scripts": { "test": "node --test" } }, no deps
├── test/
│   ├── harness/
│   │   ├── sandbox.js        # loadPlugin(): new Function + frozen globals
│   │   └── mock-api.js       # makeApi(config): fake bridge + recorded calls
│   ├── search.test.js
│   ├── cache.test.js
│   ├── convert.test.js
│   ├── resolve.test.js
│   └── sandbox.test.js
└── .github/workflows/
    ├── ci.yml               # NEW: node --test + node --check on push/PR
    └── release.yml          # gate release job on tests
```

### Sandbox loader (`test/harness/sandbox.js`)

`loadPlugin()`:
1. Reads `index.js` from disk as text.
2. `new Function("api", "window", "globalThis", "self", "document", code)` —
   identical to the host's invocation.
3. Calls it, passing **only the frozen globals the host allows** as the ambient
   environment: `console`, `Math`, `JSON`, `Date`, `Promise`, `Object`, `Array`,
   `String`, `Number`, `RegExp`, `Error`, `setTimeout`/`clearTimeout`,
   `setInterval`/`clearInterval`, `encodeURIComponent`/`decodeURIComponent`,
   `parseInt`/`parseFloat`/`isNaN`/`isFinite`. The five named params
   (`api`/`window`/`globalThis`/`self`/`document`) are passed as the host does.
4. Because `index.js` ends in `return { activate, deactivate }`, the function
   returns the plugin object directly.

Implementation note: a bare `new Function` body still closes over the test
process's real globals via the scope chain. To make the frozen-global guarantee
real, the loader prepends a short preamble that shadows forbidden globals
(`fetch`, `require`, `Math.random`, `Date.now`, `process`, etc.) with values that
throw on use — so reaching for them fails loudly in tests. The preamble is the
only thing wrapped around the source; the plugin source itself is byte-for-byte
unchanged. (This `Date.now`/`Math.random` shadowing is for compliance detection
only — the plugin already avoids them per CLAUDE.md.)

Each `loadPlugin()` re-evaluates the source, so module-scoped state
(`ytDlpVersion`, `cacheMaxMb`, `inFlightFiles`, `lastSourceFile`, `cleanupChain`,
`convSeq`) resets between tests with no leakage.

### Mock API bridge (`test/harness/mock-api.js`)

`makeApi(config)` returns a fake `api` plus a `calls` record for assertions.

- **`api.system.exec(cmd, args, opts)`** — the core. `config.exec` is an ordered
  list of `{ match, result }`; `match` is `{ cmd, argsInclude? }` and the first
  entry whose `cmd` equals and whose `argsInclude` substrings all appear in the
  joined args wins. `result` is `{ exitCode, stdout, stderr }` (or a function of
  `(cmd,args)` for dynamic cases). Every call is pushed to `api.calls.exec` as
  `{ cmd, args }` so tests assert *what ran* (e.g. duration in the search query;
  ffmpeg never spawned when version is null). Unmatched calls return a configured
  default (`exitCode: 1`) and are recorded.
- **`api.storage`** — KV via a `Map` (`get`/`set`). `files` backed by a plain
  object keyed by path segments: `list(path)` returns `{name,size,modifiedAt,
  isDir}` entries; `remove`/`writeText`/`getPath` mutate/read it. Tests seed the
  cache dir with controlled sizes/timestamps to drive LRU eviction.
- **`api.network.fetch(url)`** — returns `{ json: async()=>…, text: async()=>… }`
  from `config.fetch` keyed by URL substring (GitHub version lookups).
- **`api.playback` / `api.downloads`** — registration methods capture the
  callback into `api._handlers` so tests invoke handlers directly.
- **`api.ui` / `api.log` / `api.network.openUrl`** — record into arrays.

### Test flow

```js
const api = makeApi({ exec: [...], fetch: {...}, storage: {...} });
const plugin = loadPlugin();
await plugin.activate(api);
const res = await api._handlers["youtube-download"].byMetadata(
  "Title", "Artist", "Album", 213, "aac");
assert.equal(res.url, "file://…");
assert.ok(api.calls.exec.some(c => c.cmd === "ffmpeg"));   // or .every(!ffmpeg)
```

## Test Coverage (maps to review findings)

| Suite | Cases |
|---|---|
| **search** | `ytsearch --print` parses to candidates; tab-in-title preserved (`slice(2).join("\t")`); `duration=NA`→`null`; **match within 3s picks right candidate**; `durationSecs` 0/undefined → first candidate; malformed lines skipped; non-11-char ids rejected |
| **cache** | LRU evicts oldest first; **over-budget `inFlightFiles`-protected file skipped**; **`lastSourceFile` survives eviction** ("Off keeps current track"); stray non-videoId files removed; `temp/` wiped only when `wipeTemp` true; `scheduleCleanup` serializes overlapping runs |
| **convert** | `FORMATS` → correct `{mode,args,bitrate}`; copy-remux when codec matches container codec; re-encode otherwise; bitrate clamped 96–320; default 160 when probe null; unknown format → `null` |
| **resolve** | stream resolve → `file://` + `sourceUrl`; **download forwards `durationSecs` to search** (asserted via recorded exec args); **ffmpeg-missing → serves original, ffmpeg never spawned, not mislabeled**; `onGetQualities` hides mp3/flac when ffmpeg absent; convert failure falls back to source; unique temp name per request |
| **sandbox** | `loadPlugin()` succeeds with frozen globals; probing confirms `fetch`/`require` unavailable (compliance guard) |

## Running

- **Local:** `node --test` (auto-discovers `test/**/*.test.js`) or `npm test`.
- **CI:** new `ci.yml` runs `node --check index.js` + `node --test` on push/PR.
  The `release.yml` release job gains a dependency/step so a failing suite blocks
  a tag from publishing.

## Error Handling & Isolation

- Per-test fresh `loadPlugin()` + freshly constructed mocks → no shared state.
- No real network, binaries, or disk: exec/fetch/storage are all in-memory.
- Mock `exec` returns a recorded `exitCode: 1` default for unmatched commands so a
  missing stub surfaces as an assertion failure, not a silent pass.

## Risks / Notes

- The mock encodes our **understanding** of the host API shape (e.g. `exec`
  return fields, `files.list` entry fields, `getPath` returning a usable dir
  path). If the real host contract differs, tests can be green while the plugin
  misbehaves in-app. Mitigation: keep the mock minimal and matched to
  PLUGIN-API-REFERENCE.md; the manual real-binary smoke test (deferred) remains
  the final pre-release check.
- Frozen-global shadowing detects forbidden-global use but cannot perfectly
  replicate the host's frozen sandbox semantics; it is a best-effort guard.
```
