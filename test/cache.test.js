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
        // stem "stray" (5 chars) genuinely fails VIDEO_ID_RE (needs exactly 11).
        // NOTE: avoid names like "not-a-video.tmp" whose stem is coincidentally an
        // 11-char [A-Za-z0-9_-] string — that would MATCH the id regex and not be stray.
        { name: "stray.tmp", size: 1 * MB, modifiedAt: 1 },
        { name: ID_A + ".webm", size: 1 * MB, modifiedAt: 2 },
      ] },
    },
    exec: baseExec(),
  });
  await activate(api);
  await setCacheLimitMb(api, 100);
  const remaining = cacheNames(api);
  assert.ok(!remaining.includes("stray.tmp"), "stray removed");
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

test("the just-resolved track (lastSourceFile) survives eviction even at limit 0", async () => {
  // Seed two cached files. A stream resolve whose search hits ID_A makes ID_A the
  // cache-hit source, so the plugin sets lastSourceFile = "aaaaaaaaaaa.webm". Then
  // dropping the limit to 0 must evict everything EXCEPT that protected file.
  // This guards the index.js eviction protection (`oldest.name === lastSourceFile`):
  // remove that guard and this test fails (ID_A would be evicted too).
  const api = makeApi({
    storage: {
      kv: { cacheMaxMb: 100 },
      files: { cache: [
        { name: ID_A + ".webm", size: 1 * MB, modifiedAt: 1 },
        { name: ID_B + ".webm", size: 1 * MB, modifiedAt: 2 },
      ] },
    },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
      // search resolves to ID_A, which is already in cache → cache hit, no download
      { match: { cmd: "yt-dlp", argsInclude: ["ytsearch"] }, result: { exitCode: 0, stdout: ID_A + "\t213\tCh\tSong\n" } },
    ],
  });
  await activate(api);
  // Resolve a track → cache hit on ID_A → lastSourceFile := "aaaaaaaaaaa.webm"
  const res = await api._handlers["stream:youtube-fallback"]("Song", "Artist", null, 213);
  await flush();
  assert.ok(res && res.url.endsWith(ID_A + ".webm"), "resolve should hit the ID_A cache file");
  await setCacheLimitMb(api, 0);
  const remaining = cacheNames(api);
  assert.deepEqual(remaining, [ID_A + ".webm"], "only the protected last-source survives");
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
