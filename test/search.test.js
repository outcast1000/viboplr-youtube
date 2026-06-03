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
    "dQw4w9WgXcQ\t213\tRickAstleyVEVO\tRick Astley - Never Gonna Give You Up",
    "abcdefghijk\t180\tch\tSome Other Song",
  ].join("\n") + "\n";
  const api = apiWithSearch(stdout);
  const res = await streamResolve(api, "Never Gonna Give You Up", "Rick Astley", null);
  assert.equal(res.url, "file:///mock-plugin-data/cache/dQw4w9WgXcQ.webm");
  assert.equal(res.sourceUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("duration match within 3s picks the matching candidate, not the first", async () => {
  const stdout = [
    "aaaaaaaaaaa\t600\tch\tLive Version",     // far from target
    "bbbbbbbbbbb\t214\tch\tStudio Version",   // within 3s of 213
  ].join("\n") + "\n";
  const api = apiWithSearch(stdout);
  const res = await streamResolve(api, "Song", "Artist", 213);
  assert.equal(res.sourceUrl, "https://www.youtube.com/watch?v=bbbbbbbbbbb");
});

test("duration of 0 falls back to the first candidate", async () => {
  const stdout = [
    "aaaaaaaaaaa\t600\tch\tFirst",
    "bbbbbbbbbbb\t214\tch\tSecond",
  ].join("\n") + "\n";
  const api = apiWithSearch(stdout);
  const res = await streamResolve(api, "Song", "Artist", 0);
  assert.equal(res.sourceUrl, "https://www.youtube.com/watch?v=aaaaaaaaaaa");
});

test("tab characters in the title do not corrupt id/duration parsing", async () => {
  const stdout = "ccccccccccc\t200\tch\tTitle\twith\ttabs\n";
  const api = apiWithSearch(stdout);
  const res = await streamResolve(api, "Song", "Artist", null);
  assert.equal(res.sourceUrl, "https://www.youtube.com/watch?v=ccccccccccc");
});

test("duration 'NA' is treated as unknown and does not match", async () => {
  const stdout = [
    "ddddddddddd\tNA\tch\tUnknown Length",
    "eeeeeeeeeee\t213\tch\tExact Match",
  ].join("\n") + "\n";
  const api = apiWithSearch(stdout);
  const res = await streamResolve(api, "Song", "Artist", 213);
  assert.equal(res.sourceUrl, "https://www.youtube.com/watch?v=eeeeeeeeeee");
});

test("lines whose id is not a valid 11-char video id are skipped", async () => {
  const stdout = [
    "short\t213\tch\tBad Id",
    "fffffffffff\t213\tch\tGood Id",
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

// --- Logging / diagnostics added for SABR/403 troubleshooting ----------------

function logsMatching(api, re) {
  return api.calls.log.filter((l) => re.test(l.msg));
}

test("search logs the exact yt-dlp command it runs", async () => {
  const api = apiWithSearch("ggggggggggg\t213\tch\tThe Song\n");
  await streamResolve(api, "The Song", "Artist", null);
  const runLogs = logsMatching(api, /^Running: yt-dlp .*ytsearch7:/);
  assert.equal(runLogs.length, 1, "search command must be logged once");
});

test("download failure logs stderr and runs the verbose diagnostics probe", async () => {
  const api = makeApi({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 1 } },
      { match: { cmd: "yt-dlp", argsInclude: ["ytsearch"] }, result: { exitCode: 0, stdout: "ggggggggggg\t213\tch\tThe Song\n" } },
      // The real download fails with a 403 like YouTube's SABR experiment produces.
      { match: { cmd: "yt-dlp", argsInclude: ["bestaudio", "--no-simulate"] },
        result: { exitCode: 1, stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden" } },
      // The diagnostics re-run (-v --simulate) surfaces the underlying reason.
      { match: { cmd: "yt-dlp", argsInclude: ["-v", "--simulate"] },
        result: { exitCode: 0, stderr: "[debug] [youtube] [pot] PO Token Providers: none\n[debug] YouTube is forcing SABR streaming for this client" } },
    ],
  });
  const res = await streamResolve(api, "The Song", "Artist", 213);
  assert.equal(res, null, "a 403 download yields no playable source");

  // The raw failure is logged...
  assert.ok(logsMatching(api, /403: Forbidden/).length >= 1, "the 403 stderr must be logged");
  // ...the verbose diagnostics probe is actually invoked...
  assert.ok(api.calls.exec.some((c) => c.cmd === "yt-dlp" && c.args.includes("-v") && c.args.includes("--simulate")),
    "diagnostics probe (-v --simulate) must run on failure");
  // ...and its actionable output (PO token / SABR) reaches the log.
  assert.ok(logsMatching(api, /diagnostics/i).length >= 1, "diagnostics summary must be logged");
  assert.ok(logsMatching(api, /PO Token|SABR/i).length >= 1, "diagnostics must surface the PO-token/SABR cause");
});

test("duration fallback (no candidate within 3s) is logged as a warning", async () => {
  const stdout = [
    "aaaaaaaaaaa\t600\tch\tLive Version",   // far from 213
    "bbbbbbbbbbb\t400\tch\tAlso far",       // far from 213
  ].join("\n") + "\n";
  const api = apiWithSearch(stdout);
  await streamResolve(api, "Song", "Artist", 213);
  const warns = api.calls.log.filter((l) => l.level === "warn" && /none within ±3s/.test(l.msg));
  assert.equal(warns.length, 1, "first-result fallback must warn about the duration mismatch");
});
