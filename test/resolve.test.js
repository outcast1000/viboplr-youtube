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
  // ffmpeg may be spawned once for `-version` detection in activate(), but must
  // NEVER be spawned to convert (the -c:a call) when it is unavailable.
  assert.ok(!api.calls.exec.some((c) => c.cmd === "ffmpeg" && c.args.includes("-c:a")), "ffmpeg must not be spawned to convert");
  // metadata reflects the request, but the file is the honest original (.webm)
  assert.equal(res.metadata.title, "The Song");
});

test("ffmpeg conversion failure falls back to the source file", async () => {
  const api = downloadApi({ ffmpeg: true, ffmpegConvertExit: 1 });
  const res = await downloadResolve(api, "aac");
  assert.equal(res.url, "file:///mock-plugin-data/cache/ggggggggggg.webm");
  // Distinguish this from the ffmpeg-missing case: conversion must have been
  // ATTEMPTED (and failed), not skipped — otherwise both reach the same URL.
  assert.ok(api.calls.exec.some((c) => c.cmd === "ffmpeg" && c.args.includes("-c:a")),
    "conversion must have been attempted");
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
