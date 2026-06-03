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
      { match: { cmd: "yt-dlp", argsInclude: ["ytsearch"] }, result: { exitCode: 0, stdout: "jjjjjjjjjjj\t213\tCh\tSong\n" } },
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
