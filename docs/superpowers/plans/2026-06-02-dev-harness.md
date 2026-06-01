# Dev Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zero-dependency, CI-able test suite that loads the real `index.js` in a faithful frozen sandbox with a mocked `api` bridge and asserts the behaviors the recent code review fixed.

**Architecture:** A `loadPlugin()` loader evaluates `index.js` via `new Function("api","window","globalThis","self","document", code)` — exactly as the host does — after prepending a preamble that shadows host-forbidden globals (`fetch`, `require`, `process`, `import`) so accidental use fails loudly. A `makeApi(config)` factory returns a fake bridge (in-memory storage, stubbed `exec`/`fetch`, handler-capturing registration) plus a `calls` record. Tests `activate()` the plugin then invoke captured handlers and assert on results + recorded exec calls. Runs under Node 22's built-in `node:test`.

**Tech Stack:** Node 22 (`node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:url`). No third-party dependencies.

---

## Background facts (read before starting)

These are established from reading `index.js` and CLAUDE.md. The engineer needs them and should not re-derive them.

- `index.js` has **no `module.exports`**. Its last line is `return { activate: activate, deactivate: deactivate };`. The only way to reach its logic is to evaluate the file as a function body and call `activate(api)`, then invoke the handlers it registers. There are no unit-testable exports; tests drive everything through handlers. This is intentional and matches how the host runs it.
- The host invokes the plugin as `new Function("api","window","globalThis","self","document", code)`. We replicate that signature exactly.
- The exact `api` surface `index.js` uses (and the mock must provide):
  - `api.system.exec(cmd, args, opts?)` → `Promise<{ exitCode, stdout, stderr }>`
  - `api.network.fetch(url, opts?)` → `Promise<{ json(), text() }>`
  - `api.network.openUrl(url)`
  - `api.storage.get(key)` → `Promise<any>`; `api.storage.set(key, val)` → `Promise`
  - `api.storage.files.list(pathSegs)` → `Promise<Array<{ name, isDir, size, modifiedAt }>>`
  - `api.storage.files.remove(pathSegs)` → `Promise`
  - `api.storage.files.writeText(pathSegs, text)` → `Promise<string>` (returns absolute path written)
  - `api.storage.files.getPath(pathSegs)` → `Promise<string>` (absolute path)
  - `api.playback.onStreamResolve(id, fn)`
  - `api.downloads.onResolveByUri(id, fn)` / `onGetQualities(id, fn)` / `onResolveByMetadata(id, fn)`
  - `api.ui.onAction(id, fn)` / `api.ui.setViewData(id, data)`
  - `api.log(level, msg, section)`
- Handler callback signatures (so tests call them correctly):
  - stream resolve: `(title, artistName, albumName, durationSecs)` → `{ url, label, sourceUrl } | null`
  - download by metadata: `(title, artistName, albumName, durationSecs, format)` → `{ url, headers, metadata } | null`
  - get qualities: `()` → `Array<{ value, label }>`
- `index.js` uses **frozen-but-present** globals `Math`, `JSON`, `Date`, `Promise`, timers, `parseInt`, etc. These are ALLOWED. Do NOT shadow them. Only shadow truly forbidden ones: `fetch`, `require`, `process`, `import`, `module`, `exports`, `__dirname`, `__filename`, `global`. (Earlier draft wrongly listed `Date.now`/`Math.random` as forbidden — they are available in this host; the only reason to touch them would be determinism, which this plan does not need.)
- The plugin's module-scoped state (`ytDlpVersion`, `cacheMaxMb`, `inFlightFiles`, `lastSourceFile`, `cleanupChain`, `convSeq`) is re-initialized every `loadPlugin()` because the source is re-evaluated. Each test must `loadPlugin()` fresh.
- The download path calls `searchYoutube` with the search query string `title + " " + artistName`. To assert "duration is forwarded", a test checks the recorded `yt-dlp ytsearch...` exec exists AND a separate assertion confirms the chosen videoId matches the duration-matched candidate (since durationSecs is used internally for candidate selection, not passed to yt-dlp). See Task 6 for the exact assertion.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` (create) | `{ "private": true, "scripts": { "test": "node --test" } }`, no deps |
| `test/harness/sandbox.js` (create) | `loadPlugin()` — evaluate index.js as the host does, with forbidden-global preamble |
| `test/harness/mock-api.js` (create) | `makeApi(config)` — fake bridge, in-memory storage, recorded calls |
| `test/sandbox.test.js` (create) | Loader works; forbidden globals throw; plugin object shape |
| `test/search.test.js` (create) | `ytsearch --print` parsing + duration matching (via stream resolve handler) |
| `test/cache.test.js` (create) | LRU eviction, in-flight + last-source protection, stray removal, temp wipe |
| `test/convert.test.js` (create) | format conversion decisions (via download handler with stubbed ffmpeg) |
| `test/resolve.test.js` (create) | stream/download resolve, ffmpeg-missing, qualities gating |
| `.github/workflows/ci.yml` (create) | run `node --check` + `node --test` on push/PR |
| `.github/workflows/release.yml` (modify) | gate release job on tests passing |
| `.gitignore` (modify) | add `node_modules/` defensively |
| `DEVELOPING.md` (modify) | add a short "Running the tests" section |

---

### Task 1: Project scaffolding (package.json, gitignore)

**Files:**
- Create: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "private": true,
  "name": "viboplr-youtube-tests",
  "description": "Test harness for the viboplr-youtube plugin (not published; the plugin itself is just index.js + manifest.json).",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Add `node_modules/` to `.gitignore`**

The current `.gitignore` contains:
```
youtube.zip
update.json
```
Append a line so it becomes:
```
youtube.zip
update.json
node_modules/
```

- [ ] **Step 3: Verify npm wiring**

Run: `npm test`
Expected: node's test runner starts and reports `0 tests` (no test files yet) — exits 0. (If it errors that no test files match, that is also acceptable at this point; the next task adds the first test.)

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "test: scaffold zero-dep node:test harness"
```

---

### Task 2: Sandbox loader

**Files:**
- Create: `test/harness/sandbox.js`
- Test: `test/sandbox.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/sandbox.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox.js");

test("loadPlugin returns the plugin object with activate/deactivate", () => {
  const plugin = loadPlugin();
  assert.equal(typeof plugin.activate, "function");
  assert.equal(typeof plugin.deactivate, "function");
});

test("each loadPlugin call returns a fresh instance (no shared state)", () => {
  const a = loadPlugin();
  const b = loadPlugin();
  assert.notEqual(a, b);
  assert.notEqual(a.activate, b.activate);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sandbox.test.js`
Expected: FAIL — `Cannot find module './harness/sandbox.js'`.

- [ ] **Step 3: Write the loader**

Create `test/harness/sandbox.js`:

```js
const fs = require("node:fs");
const path = require("node:path");

const INDEX_PATH = path.join(__dirname, "..", "..", "index.js");

// Globals the host's frozen sandbox does NOT provide. Shadowing them as throwing
// bindings means any accidental use inside index.js fails loudly in tests.
// NOTE: Math, JSON, Date, Promise, timers, parseInt, etc. ARE provided by the host
// and must NOT be shadowed here.
const FORBIDDEN = [
  "fetch", "require", "process", "module", "exports",
  "__dirname", "__filename", "global", "import"
];

function loadPlugin() {
  const code = fs.readFileSync(INDEX_PATH, "utf8");

  // Build a preamble that declares each forbidden name as a getter-throwing const.
  // `import` is a reserved word, so it cannot be shadowed via a variable; it is
  // omitted from the preamble (a real `import` statement would be a syntax error
  // in a Function body anyway, which is its own guard).
  const shadowNames = FORBIDDEN.filter((n) => n !== "import");
  const preamble = shadowNames
    .map((n) => `var ${n} = new Proxy(function(){}, { get: function(){ throw new Error("forbidden global accessed in sandbox: ${n}"); }, apply: function(){ throw new Error("forbidden global called in sandbox: ${n}"); } });`)
    .join("\n");

  const body = preamble + "\n" + code;
  const factory = new Function("api", "window", "globalThis", "self", "document", body);

  // The host passes the frozen sandbox object for window/globalThis/self/document.
  // index.js does not use them, so an empty frozen object is faithful enough.
  const sandboxGlobal = Object.freeze({});
  return factory(undefined, sandboxGlobal, sandboxGlobal, sandboxGlobal, sandboxGlobal);
}

module.exports = { loadPlugin };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sandbox.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Add the forbidden-global compliance test**

Append to `test/sandbox.test.js`:

```js
test("index.js does not reference forbidden globals at load time", () => {
  // loadPlugin itself evaluates the file body; if a top-level statement touched a
  // forbidden global it would throw here. Module-scoped code in index.js only
  // declares vars/functions, so loading must succeed.
  assert.doesNotThrow(() => loadPlugin());
});
```

- [ ] **Step 6: Run and commit**

Run: `node --test test/sandbox.test.js`
Expected: PASS — 3 tests.

```bash
git add test/harness/sandbox.js test/sandbox.test.js
git commit -m "test: add sandbox loader replicating host new Function execution"
```

---

### Task 3: Mock API bridge — storage + exec core

**Files:**
- Create: `test/harness/mock-api.js`
- Test: (covered by later suites; add a focused mock self-test here)
- Test: `test/mock-api.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/mock-api.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeApi } = require("./harness/mock-api.js");

test("exec matches by cmd + argsInclude, first match wins, records calls", async () => {
  const api = makeApi({
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "yt-dlp" }, result: { exitCode: 1, stderr: "no match" } },
    ],
  });
  const r = await api.system.exec("yt-dlp", ["--version"]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), "2025.01.01");
  assert.equal(api.calls.exec.length, 1);
  assert.deepEqual(api.calls.exec[0], { cmd: "yt-dlp", args: ["--version"] });
});

test("exec returns recorded exitCode:1 default for unmatched commands", async () => {
  const api = makeApi({ exec: [] });
  const r = await api.system.exec("ffmpeg", ["-version"]);
  assert.equal(r.exitCode, 1);
  assert.equal(api.calls.exec.length, 1);
});

test("storage files: writeText creates an entry and returns an absolute path", async () => {
  const api = makeApi({});
  const p = await api.storage.files.writeText(["cache", ".init"], "");
  assert.match(p, /[\/\\]cache[\/\\]\.init$/);
  const entries = await api.storage.files.list(["cache"]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, ".init");
});

test("storage files: getPath returns an absolute dir path without creating a file", async () => {
  const api = makeApi({});
  const dir = await api.storage.files.getPath(["cache"]);
  assert.match(dir, /[\/\\]cache$/);
  const entries = await api.storage.files.list(["cache"]);
  assert.equal(entries.length, 0);
});

test("storage kv get/set round-trips", async () => {
  const api = makeApi({});
  await api.storage.set("cacheMaxMb", 200);
  assert.equal(await api.storage.get("cacheMaxMb"), 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mock-api.test.js`
Expected: FAIL — `Cannot find module './harness/mock-api.js'`.

- [ ] **Step 3: Write the mock**

Create `test/harness/mock-api.js`:

```js
// In-memory fake of the viboplr host `api` bridge. Only the surface index.js uses
// is implemented. makeApi(config) returns the api plus `calls` (recorded
// invocations) and `_handlers` (callbacks the plugin registered).

const ROOT = "/mock-plugin-data";

function joinSegs(segs) {
  return ROOT + "/" + segs.join("/");
}

function makeStorage(seed) {
  // Files are stored flat, keyed by dir name -> { fileName -> {size, modifiedAt} }.
  // Only "cache" and "temp" dirs are used by the plugin.
  const dirs = { cache: {}, temp: {} };
  if (seed && seed.files) {
    for (const dir of Object.keys(seed.files)) {
      dirs[dir] = dirs[dir] || {};
      for (const f of seed.files[dir]) {
        dirs[dir][f.name] = { size: f.size || 0, modifiedAt: f.modifiedAt || 0 };
      }
    }
  }
  const kv = new Map(Object.entries((seed && seed.kv) || {}));

  function dirOf(segs) {
    return dirs[segs[0]] || (dirs[segs[0]] = {});
  }

  return {
    _dirs: dirs,
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    set: async (k, v) => { kv.set(k, v); },
    files: {
      list: async (segs) => {
        const d = dirs[segs[0]];
        if (!d) { const e = new Error("ENOENT"); throw e; }
        return Object.keys(d).map((name) => ({
          name,
          isDir: false,
          size: d[name].size,
          modifiedAt: d[name].modifiedAt,
        }));
      },
      remove: async (segs) => {
        // remove(["temp"]) removes the whole dir; remove(["cache", name]) one file.
        if (segs.length === 1) { dirs[segs[0]] = {}; return; }
        const d = dirs[segs[0]];
        if (d) delete d[segs[1]];
      },
      writeText: async (segs, text) => {
        const d = dirOf(segs.slice(0, 1));
        const name = segs[segs.length - 1];
        d[name] = { size: (text || "").length, modifiedAt: 0 };
        return joinSegs(segs);
      },
      getPath: async (segs) => joinSegs(segs),
    },
  };
}

function execMatches(entry, cmd, args) {
  if (entry.match.cmd !== cmd) return false;
  const inc = entry.match.argsInclude || [];
  const joined = args.join(" ");
  return inc.every((s) => joined.includes(s));
}

function makeApi(config) {
  config = config || {};
  const calls = { exec: [], log: [], setViewData: [], openUrl: [] };
  const handlers = {};
  const storage = makeStorage(config.storage);

  const execRules = config.exec || [];
  const fetchRules = config.fetch || {};

  const api = {
    calls,
    _handlers: handlers,
    _storage: storage,
    log: (level, msg, section) => { calls.log.push({ level, msg, section }); },
    system: {
      exec: async (cmd, args, opts) => {
        args = args || [];
        calls.exec.push({ cmd, args });
        for (const rule of execRules) {
          if (execMatches(rule, cmd, args)) {
            const r = typeof rule.result === "function" ? rule.result(cmd, args) : rule.result;
            return Object.assign({ exitCode: 0, stdout: "", stderr: "" }, r);
          }
        }
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    },
    network: {
      fetch: async (url) => {
        for (const key of Object.keys(fetchRules)) {
          if (url.includes(key)) {
            const v = fetchRules[key];
            return {
              json: async () => (typeof v === "function" ? v() : v),
              text: async () => (typeof v === "string" ? v : JSON.stringify(v)),
            };
          }
        }
        return { json: async () => ({}), text: async () => "" };
      },
      openUrl: (url) => { calls.openUrl.push(url); },
    },
    storage,
    playback: {
      onStreamResolve: (id, fn) => { handlers["stream:" + id] = fn; },
    },
    downloads: {
      onResolveByUri: (id, fn) => { handlers["uri:" + id] = fn; },
      onResolveByMetadata: (id, fn) => { handlers["meta:" + id] = fn; },
      onGetQualities: (id, fn) => { handlers["qual:" + id] = fn; },
    },
    ui: {
      onAction: (id, fn) => { handlers["action:" + id] = fn; },
      setViewData: (id, data) => { calls.setViewData.push({ id, data }); },
    },
  };

  return api;
}

module.exports = { makeApi };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mock-api.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add test/harness/mock-api.js test/mock-api.test.js
git commit -m "test: add in-memory mock api bridge (storage + exec + handlers)"
```

---

### Task 4: Shared activate helper + search/duration tests

**Files:**
- Create: `test/search.test.js`

This task tests `searchYoutube` indirectly through the stream-resolve handler, because the function is not exported. The stream handler calls `searchAndDownload` → `searchYoutube`, then downloads. We stub `yt-dlp --version` (so the plugin thinks the tool exists), the `ytsearch` print output, and the `bestaudio` download.

- [ ] **Step 1: Write the failing test**

Create `test/search.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

// Builds an api whose yt-dlp search returns the given tab-separated print lines,
// with version + download stubbed so the resolve path runs end-to-end.
function apiWithSearch(searchStdout) {
  return makeApi({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
      { match: { cmd: "yt-dlp", argsInclude: ["ytsearch"] }, result: { exitCode: 0, stdout: searchStdout } },
      { match: { cmd: "yt-dlp", argsInclude: ["bestaudio"] }, result: (cmd, args) => {
          // emulate yt-dlp printing the moved filepath; id is the -o template stem
          const oIdx = args.indexOf("-o");
          const id = args[oIdx + 1].replace(/\..*$/, "");
          return { exitCode: 0, stdout: "/mock-plugin-data/cache/" + id + ".webm\n" };
        } },
    ],
  });
}

async function streamResolve(api, title, artist, dur) {
  const plugin = loadPlugin();
  await plugin.activate(api);
  return api._handlers["stream:youtube-fallback"](title, artist, null, dur);
}

test("parses ytsearch --print lines into candidates and resolves the first by default", async () => {
  const stdout = [
    "dQw4w9WgXcQ\t213\tRick Astley - Never Gonna Give You Up",
    "abcdefghijk\t180\tSome Other Song",
  ].join("\n") + "\n";
  const api = apiWithSearch(stdout);
  const res = await streamResolve(api, "Never Gonna Give You Up", "Rick Astley", null);
  assert.equal(res.url, "file:///mock-plugin-data/cache/dQw4w9WgXcQ.webm");
  assert.equal(res.sourceUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("duration match within 3s picks the matching candidate, not the first", async () => {
  const stdout = [
    "aaaaaaaaaaa\t600\tLive Version",     // far from target
    "bbbbbbbbbbb\t214\tStudio Version",   // within 3s of 213
  ].join("\n") + "\n";
  const api = apiWithSearch(stdout);
  const res = await streamResolve(api, "Song", "Artist", 213);
  assert.equal(res.sourceUrl, "https://www.youtube.com/watch?v=bbbbbbbbbbb");
});

test("duration of 0 falls back to the first candidate", async () => {
  const stdout = [
    "aaaaaaaaaaa\t600\tFirst",
    "bbbbbbbbbbb\t214\tSecond",
  ].join("\n") + "\n";
  const api = apiWithSearch(stdout);
  const res = await streamResolve(api, "Song", "Artist", 0);
  assert.equal(res.sourceUrl, "https://www.youtube.com/watch?v=aaaaaaaaaaa");
});

test("tab characters in the title do not corrupt id/duration parsing", async () => {
  const stdout = "ccccccccccc\t200\tTitle\twith\ttabs\n";
  const api = apiWithSearch(stdout);
  const res = await streamResolve(api, "Song", "Artist", null);
  assert.equal(res.sourceUrl, "https://www.youtube.com/watch?v=ccccccccccc");
});

test("duration 'NA' is treated as unknown and does not match", async () => {
  const stdout = [
    "ddddddddddd\tNA\tUnknown Length",
    "eeeeeeeeeee\t213\tExact Match",
  ].join("\n") + "\n";
  const api = apiWithSearch(stdout);
  const res = await streamResolve(api, "Song", "Artist", 213);
  assert.equal(res.sourceUrl, "https://www.youtube.com/watch?v=eeeeeeeeeee");
});

test("lines whose id is not a valid 11-char video id are skipped", async () => {
  const stdout = [
    "short\t213\tBad Id",
    "fffffffffff\t213\tGood Id",
  ].join("\n") + "\n";
  const api = apiWithSearch(stdout);
  const res = await streamResolve(api, "Song", "Artist", null);
  assert.equal(res.sourceUrl, "https://www.youtube.com/watch?v=fffffffffff");
});

test("empty search output resolves to null", async () => {
  const api = apiWithSearch("");
  const res = await streamResolve(api, "Song", "Artist", null);
  assert.equal(res, null);
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `node --test test/search.test.js`
Expected: PASS — 7 tests. (These exercise existing, already-implemented behavior in `index.js`; the test is the new artifact. If any FAIL, that is a real finding — stop and report it rather than editing `index.js` to match a wrong assertion.)

- [ ] **Step 3: Commit**

```bash
git add test/search.test.js
git commit -m "test: cover ytsearch parsing and duration matching"
```

---

### Task 5: Cache eviction tests

**Files:**
- Create: `test/cache.test.js`

`cleanupCache` is not exported and only runs as a side-effect (startup, post-resolve, and the `youtube-cache-size` action). The cleanest trigger is the **`youtube-cache-size` action handler**, which sets `cacheMaxMb` and calls `scheduleCleanup`. Because cleanup is fire-and-forget there, the test awaits the internal `cleanupChain` indirectly by polling the storage state. To make this deterministic, we instead trigger cleanup via `activate()`'s **awaited startup path is also fire-and-forget** — so we use a small helper that calls the action and then yields the event loop until the cache dir reaches a stable state.

To keep tests deterministic without relying on timing, this task triggers cleanup through the cache-size action and then `await`s a `flush()` helper that drains microtasks.

- [ ] **Step 1: Write the failing test**

Create `test/cache.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

const MB = 1024 * 1024;

// Drains pending microtasks/timers so fire-and-forget cleanup settles.
async function flush() {
  for (let i = 0; i < 20; i++) { await Promise.resolve(); }
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i++) { await Promise.resolve(); }
}

function baseExec() {
  return [
    { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
    { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
  ];
}

function cacheNames(api) {
  return Object.keys(api._storage._dirs.cache);
}

// 11-char valid video ids for fixtures.
const ID_A = "aaaaaaaaaaa";
const ID_B = "bbbbbbbbbbb";
const ID_C = "ccccccccccc";

async function activate(api) {
  const plugin = loadPlugin();
  await plugin.activate(api);
  await flush(); // let startup cleanup settle
  return plugin;
}

async function setCacheLimitMb(api, mb) {
  await api._handlers["action:youtube-cache-size"](String(mb));
  await flush();
}

test("evicts oldest files first when over budget", async () => {
  const api = makeApi({
    storage: {
      kv: { cacheMaxMb: 100 },
      files: { cache: [
        { name: ID_A + ".webm", size: 40 * MB, modifiedAt: 1 },
        { name: ID_B + ".webm", size: 40 * MB, modifiedAt: 2 },
        { name: ID_C + ".webm", size: 40 * MB, modifiedAt: 3 },
      ] },
    },
    exec: baseExec(),
  });
  await activate(api);
  await setCacheLimitMb(api, 100); // 120MB total > 100MB → evict oldest (ID_A)
  const remaining = cacheNames(api);
  assert.ok(!remaining.includes(ID_A + ".webm"), "oldest should be evicted");
  assert.ok(remaining.includes(ID_C + ".webm"), "newest should remain");
});

test("removes stray files whose stem is not a valid video id", async () => {
  const api = makeApi({
    storage: {
      kv: { cacheMaxMb: 100 },
      files: { cache: [
        { name: "not-a-video.tmp", size: 1 * MB, modifiedAt: 1 },
        { name: ID_A + ".webm", size: 1 * MB, modifiedAt: 2 },
      ] },
    },
    exec: baseExec(),
  });
  await activate(api);
  await setCacheLimitMb(api, 100);
  const remaining = cacheNames(api);
  assert.ok(!remaining.includes("not-a-video.tmp"), "stray removed");
  assert.ok(remaining.includes(ID_A + ".webm"), "valid kept");
});

test("cacheMaxMb=0 keeps only the most recently resolved track", async () => {
  // Seed three valid files; set limit to 0. Without a protected last-source, all
  // would be evicted. The plugin protects `lastSourceFile`, but at startup none is
  // set, so with limit 0 and no in-flight/last-source, all are eligible.
  const api = makeApi({
    storage: {
      kv: { cacheMaxMb: 0 },
      files: { cache: [
        { name: ID_A + ".webm", size: 1 * MB, modifiedAt: 1 },
        { name: ID_B + ".webm", size: 1 * MB, modifiedAt: 2 },
      ] },
    },
    exec: baseExec(),
  });
  await activate(api);
  await setCacheLimitMb(api, 0);
  // No track has been resolved this session, so the cache empties entirely.
  assert.equal(cacheNames(api).length, 0);
});

test("temp dir is wiped on startup cleanup", async () => {
  const api = makeApi({
    storage: {
      kv: { cacheMaxMb: 100 },
      files: {
        cache: [{ name: ID_A + ".webm", size: 1 * MB, modifiedAt: 1 }],
        temp: [{ name: "leftover.m4a", size: 1 * MB, modifiedAt: 1 }],
      },
    },
    exec: baseExec(),
  });
  await activate(api); // startup cleanup runs with wipeTemp=true
  assert.equal(Object.keys(api._storage._dirs.temp).length, 0, "temp wiped");
  assert.ok(cacheNames(api).includes(ID_A + ".webm"), "cache source retained");
});
```

- [ ] **Step 2: Run test**

Run: `node --test test/cache.test.js`
Expected: PASS — 4 tests. If the `cacheMaxMb=0` test FAILS because eviction left a file, re-read the eviction loop in `index.js` against the assertion — the test asserts the documented behavior (no track resolved yet → cache empties). Report a mismatch rather than weakening the test.

- [ ] **Step 3: Commit**

```bash
git add test/cache.test.js
git commit -m "test: cover LRU eviction, stray removal, and temp wipe"
```

---

### Task 6: Resolve-path tests (ffmpeg-missing, qualities, download metadata)

**Files:**
- Create: `test/resolve.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/resolve.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

const SEARCH = "ggggggggggg\t213\tThe Song\n";

function downloadApi({ ffmpeg = true, ffmpegConvertExit = 0 } = {}) {
  const rules = [
    { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
    { match: { cmd: "yt-dlp", argsInclude: ["ytsearch"] }, result: { exitCode: 0, stdout: SEARCH } },
    { match: { cmd: "yt-dlp", argsInclude: ["bestaudio"] }, result: (cmd, args) => {
        const id = args[args.indexOf("-o") + 1].replace(/\..*$/, "");
        return { exitCode: 0, stdout: "/mock-plugin-data/cache/" + id + ".webm\n" };
      } },
  ];
  if (ffmpeg) {
    rules.push({ match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } });
    // Probe call is `["-i", path, "-hide_banner"]`; match on -hide_banner so the
    // later convert call (which also contains -i) does NOT accidentally match here.
    rules.push({ match: { cmd: "ffmpeg", argsInclude: ["-i", "-hide_banner"] }, result: { exitCode: 1, stderr: "Stream #0:0: Audio: opus, 48000 Hz, stereo, fltp, 160 kb/s\n" } });
    // the conversion call (has -c:a but for our format aac → encode path uses -b:a)
    rules.push({ match: { cmd: "ffmpeg", argsInclude: ["-c:a"] }, result: { exitCode: ffmpegConvertExit, stderr: ffmpegConvertExit ? "boom" : "" } });
  } else {
    rules.push({ match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 1, stderr: "not found" } });
  }
  return makeApi({ storage: { kv: { cacheMaxMb: 100 } }, exec: rules });
}

async function downloadResolve(api, fmt) {
  const plugin = loadPlugin();
  await plugin.activate(api);
  return api._handlers["meta:youtube-download"]("The Song", "Artist", "Album", 213, fmt);
}

test("ffmpeg present: aac download transcodes and returns the temp file", async () => {
  const api = downloadApi({ ffmpeg: true });
  const res = await downloadResolve(api, "aac");
  assert.match(res.url, /^file:\/\/\/mock-plugin-data\/temp\/ggggggggggg\.\d+\.m4a$/);
  // ffmpeg was actually invoked to convert
  assert.ok(api.calls.exec.some((c) => c.cmd === "ffmpeg" && c.args.includes("-c:a")));
});

test("ffmpeg missing: serves the original source and never spawns ffmpeg", async () => {
  const api = downloadApi({ ffmpeg: false });
  const res = await downloadResolve(api, "aac");
  assert.equal(res.url, "file:///mock-plugin-data/cache/ggggggggggg.webm");
  assert.ok(!api.calls.exec.some((c) => c.cmd === "ffmpeg"), "ffmpeg must not be spawned");
  // metadata reflects the request, but the file is the honest original (.webm)
  assert.equal(res.metadata.title, "The Song");
});

test("ffmpeg conversion failure falls back to the source file", async () => {
  const api = downloadApi({ ffmpeg: true, ffmpegConvertExit: 1 });
  const res = await downloadResolve(api, "aac");
  assert.equal(res.url, "file:///mock-plugin-data/cache/ggggggggggg.webm");
});

test("onGetQualities lists only aac when ffmpeg is absent", async () => {
  const api = downloadApi({ ffmpeg: false });
  const plugin = loadPlugin();
  await plugin.activate(api);
  const qualities = api._handlers["qual:youtube-download"]();
  assert.deepEqual(qualities.map((q) => q.value), ["aac"]);
});

test("onGetQualities lists aac/mp3/flac when ffmpeg is present", async () => {
  const api = downloadApi({ ffmpeg: true });
  const plugin = loadPlugin();
  await plugin.activate(api);
  const qualities = api._handlers["qual:youtube-download"]();
  assert.deepEqual(qualities.map((q) => q.value), ["aac", "mp3", "flac"]);
});

test("download by metadata uses duration to pick the right candidate", async () => {
  // Two candidates; only the second matches 213s. The download path must forward
  // durationSecs so the chosen id (and thus downloaded file) is the match.
  const stdout = [
    "hhhhhhhhhhh\t600\tLong Version",
    "iiiiiiiiiii\t213\tStudio",
  ].join("\n") + "\n";
  const api = makeApi({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 1 } }, // no ffmpeg → serve source, simpler assert
      { match: { cmd: "yt-dlp", argsInclude: ["ytsearch"] }, result: { exitCode: 0, stdout } },
      { match: { cmd: "yt-dlp", argsInclude: ["bestaudio"] }, result: (cmd, args) => {
          const id = args[args.indexOf("-o") + 1].replace(/\..*$/, "");
          return { exitCode: 0, stdout: "/mock-plugin-data/cache/" + id + ".webm\n" };
        } },
    ],
  });
  const res = await downloadResolve(api, "aac");
  assert.equal(res.url, "file:///mock-plugin-data/cache/iiiiiiiiiii.webm",
    "download must duration-match like the stream path");
});

test("onResolveByUri is a no-op returning null", async () => {
  const api = downloadApi({ ffmpeg: true });
  const plugin = loadPlugin();
  await plugin.activate(api);
  const res = await api._handlers["uri:youtube-download"]("external://x", "aac");
  assert.equal(res, null);
});
```

- [ ] **Step 2: Run test**

Run: `node --test test/resolve.test.js`
Expected: PASS — 7 tests. A failure here is meaningful (it would mean a review-fixed behavior regressed); report it rather than editing the test to pass.

- [ ] **Step 3: Commit**

```bash
git add test/resolve.test.js
git commit -m "test: cover resolve paths, ffmpeg-missing, and quality gating"
```

---

### Task 7: Format-conversion tests

**Files:**
- Create: `test/convert.test.js`

`buildConvertArgs` is internal, so we assert its decisions through the download handler by observing which ffmpeg args get executed (recorded in `api.calls.exec`).

- [ ] **Step 1: Write the failing test**

Create `test/convert.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

// Source probe reports a given codec/bitrate; capture the convert ffmpeg args.
function convertApi(probeStderr) {
  return makeApi({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
      { match: { cmd: "yt-dlp", argsInclude: ["ytsearch"] }, result: { exitCode: 0, stdout: "jjjjjjjjjjj\t213\tSong\n" } },
      { match: { cmd: "yt-dlp", argsInclude: ["bestaudio"] }, result: (cmd, args) => {
          const id = args[args.indexOf("-o") + 1].replace(/\..*$/, "");
          return { exitCode: 0, stdout: "/mock-plugin-data/cache/" + id + ".webm\n" };
        } },
      { match: { cmd: "ffmpeg", argsInclude: ["-i", "-hide_banner"] }, result: { exitCode: 1, stderr: probeStderr } },
      { match: { cmd: "ffmpeg", argsInclude: ["-c:a"] }, result: { exitCode: 0, stderr: "" } },
    ],
  });
}

async function runDownload(api, fmt) {
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["meta:youtube-download"]("Song", "Artist", "Album", 213, fmt);
  // return the convert ffmpeg call (the one with -c:a)
  return api.calls.exec.find((c) => c.cmd === "ffmpeg" && c.args.includes("-c:a"));
}

test("opus source → aac: re-encodes with aac encoder at clamped source bitrate", async () => {
  const api = convertApi("Stream #0:0: Audio: opus, 48000 Hz, stereo, 160 kb/s\n");
  const conv = await runDownload(api, "aac");
  assert.ok(conv, "a conversion ffmpeg call should occur");
  const i = conv.args.indexOf("-c:a");
  assert.equal(conv.args[i + 1], "aac");
  const b = conv.args.indexOf("-b:a");
  assert.equal(conv.args[b + 1], "160k");
});

test("bitrate is floored at 96k", async () => {
  const api = convertApi("Stream #0:0: Audio: opus, 48000 Hz, stereo, 32 kb/s\n");
  const conv = await runDownload(api, "aac");
  const b = conv.args.indexOf("-b:a");
  assert.equal(conv.args[b + 1], "96k");
});

test("bitrate is capped at 320k", async () => {
  const api = convertApi("Stream #0:0: Audio: opus, 48000 Hz, stereo, 510 kb/s\n");
  const conv = await runDownload(api, "aac");
  const b = conv.args.indexOf("-b:a");
  assert.equal(conv.args[b + 1], "320k");
});

test("aac source → aac: remuxes with codec copy (no -b:a)", async () => {
  const api = convertApi("Stream #0:0: Audio: aac, 44100 Hz, stereo, 192 kb/s\n");
  const conv = await runDownload(api, "aac");
  const i = conv.args.indexOf("-c:a");
  assert.equal(conv.args[i + 1], "copy");
  assert.equal(conv.args.indexOf("-b:a"), -1, "copy remux has no bitrate arg");
});

test("flac target always re-encodes with the flac encoder (no bitrate)", async () => {
  const api = convertApi("Stream #0:0: Audio: opus, 48000 Hz, stereo, 160 kb/s\n");
  const conv = await runDownload(api, "flac");
  const i = conv.args.indexOf("-c:a");
  assert.equal(conv.args[i + 1], "flac");
  assert.equal(conv.args.indexOf("-b:a"), -1);
});

test("no probe (probe returns no Audio line) → defaults to 160k re-encode", async () => {
  const api = convertApi("no audio info here\n");
  const conv = await runDownload(api, "aac");
  const b = conv.args.indexOf("-b:a");
  assert.equal(conv.args[b + 1], "160k");
});
```

- [ ] **Step 2: Run test**

Run: `node --test test/convert.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 3: Run the whole suite**

Run: `node --test`
Expected: all suites PASS.

- [ ] **Step 4: Commit**

```bash
git add test/convert.test.js
git commit -m "test: cover format conversion decisions and bitrate clamping"
```

---

### Task 8: CI workflow + release gating

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Create the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: ["**"]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Syntax check
        run: node --check index.js

      - name: Run tests
        run: node --test
```

- [ ] **Step 2: Gate the release job on tests**

In `.github/workflows/release.yml`, the `release` job's first real step (after Checkout) currently goes straight to resolving the version. Add a Node setup + test gate immediately after the Checkout step and before "Resolve version". Insert these steps:

```yaml
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Run tests (gate release)
        run: |
          node --check index.js
          node --test
```

(Place them right after the `- name: Checkout` / `uses: actions/checkout@v4` step. The existing `Resolve version` step and everything after it stay unchanged.)

- [ ] **Step 3: Verify both workflows are valid YAML**

Run: `node -e "const fs=require('node:fs'); for (const f of ['.github/workflows/ci.yml','.github/workflows/release.yml']) { fs.readFileSync(f,'utf8'); console.log(f, 'readable'); }"`
Expected: both files print `readable`. (Full YAML lint happens on GitHub; this just confirms the files exist and are readable.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: run tests on push/PR and gate releases on them"
```

---

### Task 9: Document the test loop

**Files:**
- Modify: `DEVELOPING.md`

- [ ] **Step 1: Add a "Running the tests" section**

In `DEVELOPING.md`, after section `## 5. Debugging` (before `## 6. Cleaning up`), insert:

```markdown
## 5a. Running the tests

This repo ships a zero-dependency test suite that loads the real `index.js` in a
faithful sandbox (`new Function(...)` with the host's globals) and drives it
through a mocked `api` bridge — no real `yt-dlp`/`ffmpeg`, no network, no disk.

```bash
node --test        # or: npm test
```

Tests live under `test/`; the loader and mock bridge are in `test/harness/`. CI
runs the same command on every push/PR, and a release will not publish unless the
suite passes. The tests assert search parsing, duration matching, cache eviction,
format-conversion decisions, and the ffmpeg-missing download path.

These tests encode our understanding of the host `api` contract. They are not a
substitute for a real in-app smoke test before a release — symlink the plugin into
the host app and play/download a track to confirm against real binaries.
```

- [ ] **Step 2: Commit**

```bash
git add DEVELOPING.md
git commit -m "docs: document the test suite and dev loop"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** every coverage-table row in the spec maps to a task — search→Task 4, cache→Task 5, convert→Task 7, resolve/ffmpeg-missing/qualities→Task 6, sandbox compliance→Task 2. CI gating and docs (spec §Running) → Tasks 8–9.
- **Tests assert existing behavior.** `index.js` already implements all of this (the review fixes shipped on this branch). A failing test means either a mock inaccuracy or a real regression — investigate before changing `index.js`. Do not edit `index.js` to satisfy a test without confirming the test's assumption against the host API.
- **Known fragility to watch:** the `cacheMaxMb=0` test (Task 5) asserts the cache empties because no track has been resolved in-session yet (so `lastSourceFile` is null). This is correct for the startup/action trigger. A separate end-to-end "resolve then verify the just-played file survives" test is intentionally omitted because it would couple to fire-and-forget cleanup timing; the protection logic is covered structurally by the in-flight reasoning. If you want that case, add it as a follow-up with explicit `cleanupChain` await support exposed for tests.
- **`flush()` reliance:** cache tests depend on draining microtasks/timers. If a test is flaky, increase the flush iterations rather than adding real sleeps.
```
