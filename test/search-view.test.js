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

// Collect every node of a given type (banner + body both contain text nodes).
function findAllNodes(node, type, acc) {
  acc = acc || [];
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  const kids = node.children || node.items || [];
  for (const k of kids) findAllNodes(k, type, acc);
  return acc;
}

test("renders a search-input on activate", async () => {
  const api = baseApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const view = lastView(api, "youtube-search");
  assert.ok(view, "youtube-search view was set");
  assert.ok(findNode(view, "search-input"), "has a search-input");
});

test("formatDuration formats edge cases correctly", () => {
  const fmt = loadPlugin()._formatDuration;
  assert.equal(fmt(0), "0:00");
  assert.equal(fmt(59), "0:59");
  assert.equal(fmt(60), "1:00");
  assert.equal(fmt(213), "3:33");
  assert.equal(fmt(3599), "59:59");
  assert.equal(fmt(3600), "1:00:00");
  assert.equal(fmt(3661), "1:01:01");
  assert.equal(fmt(59.9), "0:59");
  assert.equal(fmt(null), "");
  assert.equal(fmt(NaN), "");
  assert.equal(fmt(-5), "");
});

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
  assert.equal(list.items[0].imageUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
});

test("submit with no candidates shows 'No results' and clears the loading state", async () => {
  const api = baseApi({
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
      { match: { cmd: "yt-dlp", argsInclude: ["ytsearch"] }, result: { exitCode: 1, stderr: "no results" } },
    ],
  });
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-search-submit"]({ query: "asdfqwerzxcv" });
  const view = lastView(api, "youtube-search");
  assert.ok(!findNode(view, "loading"), "loading state cleared");
  assert.ok(!findNode(view, "track-row-list"), "no results list");
  const texts = findAllNodes(view, "text");
  assert.ok(texts.some((t) => t.content === "No results."), "shows 'No results.'");
});

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
  await api._handlers["action:youtube-play"]({ selectedIds: ["dQw4w9WgXcQ", "abcdefghijk"] });
  assert.equal(api.calls.playTrack.length, 1, "playTracks recorded once");
  const rec = api.calls.playTrack[0];
  assert.equal(rec.startIndex, 0);
  assert.equal(rec.tracks.length, 2, "both selected tracks included");
  const t = rec.tracks[0];
  assert.equal(t.path, "youtube://dQw4w9WgXcQ");
  assert.equal(t.title, "Never Gonna Give You Up");
  assert.equal(t.artist_name, "Rick Astley");
  assert.equal(t.duration_secs, 213);
  const t2 = rec.tracks[1];
  assert.equal(t2.path, "youtube://abcdefghijk");
  assert.equal(t2.title, "Song Two");
  assert.equal(t2.artist_name, "Artist Two");
});

test("status banner is success when both tools are present", async () => {
  const api = baseApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const view = lastView(api, "youtube-search");
  const banner = findNode(view, "layout").children.find((c) => c.className && c.className.includes("ds-banner"));
  assert.ok(banner, "has a ds-banner row");
  assert.ok(banner.className.includes("ds-banner--success"), "success variant");
  assert.ok(/Ready/.test(findNode(banner, "text").content), "ready text");
  const btn = findNode(banner, "button");
  assert.equal(btn.action, "youtube-refresh", "Refresh wired to youtube-refresh");
});

test("status banner is error when yt-dlp is missing", async () => {
  const api = makeApi({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 1, stderr: "not found" } },
    ],
  });
  const plugin = loadPlugin();
  await plugin.activate(api);
  const view = lastView(api, "youtube-search");
  const banner = findNode(view, "layout").children.find((c) => c.className && c.className.includes("ds-banner"));
  assert.ok(banner.className.includes("ds-banner--error"), "error variant");
});

function missingYtDlpApi() {
  // yt-dlp absent (exit 1); ffmpeg present. The install command shown depends on
  // the host platform (brew/winget/apt); the plugin picks it via navigator.platform.
  return makeApi({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 1, stderr: "not found" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
    ],
  });
}

test("missing-yt-dlp banner surfaces the install command and an Install button", async () => {
  const api = missingYtDlpApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const view = lastView(api, "youtube-search");
  const banner = findNode(view, "layout").children.find((c) => c.className && c.className.includes("ds-banner"));
  const text = findNode(banner, "text").content;
  // Platform-agnostic: brew/winget/apt all end in "install yt-dlp".
  assert.ok(/install yt-dlp/.test(text), "shows the platform install command: " + text);
  const installBtn = (banner.children || []).find((c) => c.type === "button" && c.action === "youtube-install-ytdlp");
  assert.ok(installBtn, "has an Install yt-dlp button");
});

test("Install button opens the host dependency modal when yt-dlp is missing", async () => {
  const api = missingYtDlpApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-install-ytdlp"]();
  assert.equal(api.calls.openUrl.length, 0, "does not just open a browser tab");
  const req = api.calls.requestAction.find((r) => r.action === "require-dependency");
  assert.ok(req, "requested the host dependency modal");
  assert.equal(req.payload.name, "yt-dlp");
  assert.equal(req.payload.feature, "YouTube");
});

test("user actions prompt the install modal instead of silently failing when yt-dlp is missing", async () => {
  const api = missingYtDlpApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  // Search submit: should not run a search; should request the modal.
  await api._handlers["action:youtube-search-submit"]({ query: "rick astley" });
  const searched = api.calls.exec.some((e) => e.args.join(" ").includes("ytsearch"));
  assert.equal(searched, false, "no search runs without yt-dlp");
  assert.ok(
    api.calls.requestAction.some((r) => r.action === "require-dependency" && r.payload.name === "yt-dlp"),
    "search-submit prompted the install modal",
  );
});

test("background stream-resolver nudges to install yt-dlp at most once", async () => {
  const api = missingYtDlpApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const r1 = await api._handlers["stream:youtube-fallback"]("Some Song", "Some Artist", null, 200);
  const r2 = await api._handlers["stream:youtube-fallback"]("Another Song", "Another Artist", null, 180);
  assert.equal(r1, null);
  assert.equal(r2, null);
  const prompts = api.calls.requestAction.filter((r) => r.action === "require-dependency");
  assert.equal(prompts.length, 1, "nudged exactly once across two fallback resolves");
});

test("track rows carry icons and a click-to-play action", async () => {
  const api = searchApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-search-submit"]({ query: "rick astley" });
  const list = findNode(lastView(api, "youtube-search"), "track-row-list");
  assert.deepEqual(list.actions.map((a) => a.id), ["youtube-play", "youtube-queue", "youtube-download"]);
  assert.ok(list.actions.every((a) => a.icon), "every toolbar action has an icon");
  assert.ok(list.items.every((it) => it.action === "youtube-play-one"), "rows click-to-play");
});

test("youtube-play-one plays just the clicked video", async () => {
  const api = searchApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-search-submit"]({ query: "rick astley" });
  await api._handlers["action:youtube-play-one"]({ itemId: "abcdefghijk" });
  assert.equal(api.calls.playTrack.length, 1);
  assert.equal(api.calls.playTrack[0].tracks.length, 1, "exactly one track");
  assert.equal(api.calls.playTrack[0].tracks[0].path, "youtube://abcdefghijk");
});

test("youtube-queue inserts selected tracks at the end of the queue", async () => {
  const api = searchApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-search-submit"]({ query: "rick astley" });
  await api._handlers["action:youtube-queue"]({ selectedIds: ["dQw4w9WgXcQ", "abcdefghijk"] });
  assert.equal(api.calls.insertTracks.length, 1, "insertTracks called once");
  const rec = api.calls.insertTracks[0];
  assert.equal(rec.position, -1, "appended to the queue");
  assert.equal(rec.tracks.length, 2);
  assert.equal(rec.tracks[0].path, "youtube://dQw4w9WgXcQ");
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

test("stream URI resolver returns null for an invalid video id", async () => {
  const api = resolverApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const url = await api._handlers["streamuri:youtube"]("not-valid!!");
  assert.equal(url, null);
  const searched = api.calls.exec.some((e) => e.args.join(" ").includes("ytsearch"));
  assert.equal(searched, false);
});

test("URI resolvers return null when yt-dlp is unavailable", async () => {
  const api = makeApi({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 1, stderr: "not found" } },
    ],
  });
  const plugin = loadPlugin();
  await plugin.activate(api);
  assert.equal(await api._handlers["streamuri:youtube"]("dQw4w9WgXcQ"), null);
  assert.equal(await api._handlers["uri:youtube-download"]("youtube://dQw4w9WgXcQ", "aac"), null);
});
