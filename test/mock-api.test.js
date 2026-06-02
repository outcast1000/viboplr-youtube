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
