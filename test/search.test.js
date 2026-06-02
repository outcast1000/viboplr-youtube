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
