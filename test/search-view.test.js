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

// yt-dlp absent (exit 1); ffmpeg present. The harness's getDependency derives
// "installed" from these exec rules, so this drives the host-status reads.
function missingYtDlpApi() {
  return makeApi({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 1, stderr: "not found" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
    ],
  });
}

test("search view shows a missing-dependency note (no install/refresh button) when yt-dlp is absent", async () => {
  const api = missingYtDlpApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await plugin._loadToolStatus(api); // host status: yt-dlp not installed
  // Benign re-render (empty query) so the view reflects loaded status.
  await api._handlers["action:youtube-search-submit"]({ query: "" });
  const view = lastView(api, "youtube-search");
  const note = findNode(view, "layout").children.find((c) => c.className && c.className.includes("ds-banner--error"));
  assert.ok(note, "shows a missing-dependency note");
  assert.ok(/Settings/.test(note.content), "points the user to Settings → Dependencies");
  // The plugin no longer owns install/refresh — the host does.
  assert.equal(findNode(note, "button"), null, "no install/refresh button in the note");
});

test("plugin no longer prompts — user actions are silent no-ops when yt-dlp is missing", async () => {
  const api = missingYtDlpApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-search-submit"]({ query: "rick astley" });
  const searched = api.calls.exec.some((e) => e.args.join(" ").includes("ytsearch"));
  assert.equal(searched, false, "no search runs without yt-dlp");
  assert.equal(
    api.calls.requestAction.filter((r) => r.action === "require-dependency").length,
    0,
    "plugin does not prompt — the host owns the missing-dep UX",
  );
});

test("background stream-resolver returns null and never prompts when yt-dlp is missing", async () => {
  const api = missingYtDlpApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const r1 = await api._handlers["stream:youtube-fallback"]("Some Song", "Some Artist", null, 200);
  const r2 = await api._handlers["stream:youtube-fallback"]("Another Song", "Another Artist", null, 180);
  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(
    api.calls.requestAction.filter((r) => r.action === "require-dependency").length,
    0,
    "no install prompt — host owns it",
  );
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

test("youtube-download routes the selection through the host download modal", async () => {
  const api = searchApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-search-submit"]({ query: "rick astley" });
  await api._handlers["action:youtube-download"]({ selectedIds: ["dQw4w9WgXcQ", "abcdefghijk"] });
  // No direct enqueue — the modal owns destination/format selection + progress.
  assert.equal(api.calls.enqueue.length, 0);
  const reqs = api.calls.requestAction.filter((r) => r.action === "download-tracks");
  assert.equal(reqs.length, 1, "requested the download modal once for the whole selection");
  const p = reqs[0].payload;
  assert.equal(p.providerId, "youtube:youtube-download");
  assert.equal(p.providerName, "YouTube");
  assert.equal(p.tracks.length, 2);
  assert.equal(p.tracks[0].uri, "youtube://dQw4w9WgXcQ");
  assert.equal(p.tracks[0].title, "Never Gonna Give You Up");
  assert.equal(p.tracks[0].artist_name, "Rick Astley");
  assert.equal(p.tracks[0].durationSecs, 213);
  assert.equal(p.tracks[1].uri, "youtube://abcdefghijk");
});

test("search view requests a larger result set than the fallback resolver", async () => {
  const api = searchApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await api._handlers["action:youtube-search-submit"]({ query: "rick astley" });
  const search = api.calls.exec.find((e) => e.args.some((a) => /^ytsearch\d+:/.test(a)));
  assert.ok(search, "ran a ytsearch");
  const arg = search.args.find((a) => /^ytsearch\d+:/.test(a));
  assert.equal(arg.split(":")[0], "ytsearch25", "search view asks for 25 results");
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
  assert.equal(
    api.calls.requestAction.filter((r) => r.action === "download-tracks").length,
    0,
    "no download modal requested for an unknown selection",
  );
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

// The host's multi-track / batch download flow resolves each selected track via
// interactive-resolve, passing the track's youtube://<id> uri as the matchId.
// It must download that EXACT id, never re-search by metadata.
test("interactive resolve downloads the exact id from a youtube:// uri without searching", async () => {
  const api = resolverApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const res = await api._handlers["iresolve:youtube-download"]("youtube://dQw4w9WgXcQ", "aac");
  assert.ok(res && res.url && res.url.startsWith("file://"), "returns a file url");
  const downloaded = api.calls.exec.some((e) => e.args.join(" ").includes("dQw4w9WgXcQ"));
  assert.equal(downloaded, true, "downloaded the exact id");
  const searched = api.calls.exec.some((e) => e.args.join(" ").includes("ytsearch"));
  assert.equal(searched, false, "must not search — resolves by exact id");
});

// The manual-search picker passes a bare 11-char video id as the matchId.
test("interactive resolve accepts a bare video id (manual-search pick)", async () => {
  const api = resolverApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const res = await api._handlers["iresolve:youtube-download"]("dQw4w9WgXcQ", "aac");
  assert.ok(res && res.url && res.url.startsWith("file://"), "returns a file url");
  const searched = api.calls.exec.some((e) => e.args.join(" ").includes("ytsearch"));
  assert.equal(searched, false, "must not search — resolves by exact id");
});

// Throw (not return null) on failure so the host marks the track errored instead
// of crashing on a null `resolved.url`.
test("interactive resolve throws on an invalid match id", async () => {
  const api = resolverApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  await assert.rejects(() => api._handlers["iresolve:youtube-download"]("not-a-valid-id!!", "aac"));
});

test("interactive resolve throws when yt-dlp is unavailable", async () => {
  const api = makeApi({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 1, stderr: "not found" } },
    ],
  });
  const plugin = loadPlugin();
  await plugin.activate(api);
  await assert.rejects(() => api._handlers["iresolve:youtube-download"]("youtube://dQw4w9WgXcQ", "aac"));
});

test("interactive search returns candidates carrying the exact video id", async () => {
  const api = searchApi();
  const plugin = loadPlugin();
  await plugin.activate(api);
  const results = await api._handlers["isearch:youtube-download"]("rick astley", 10);
  assert.equal(results.length, 2);
  assert.equal(results[0].id, "dQw4w9WgXcQ", "id is the bare video id (resolved exactly later)");
  assert.equal(results[0].title, "Never Gonna Give You Up");
  assert.equal(results[0].artistName, "Rick Astley");
  assert.equal(results[0].durationSecs, 213);
  assert.match(results[0].coverUrl, /dQw4w9WgXcQ/);
});

test("interactive search returns [] when yt-dlp is unavailable", async () => {
  const api = makeApi({
    storage: { kv: { cacheMaxMb: 100 } },
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 1, stderr: "not found" } },
    ],
  });
  const plugin = loadPlugin();
  await plugin.activate(api);
  const results = await api._handlers["isearch:youtube-download"]("rick astley", 10);
  assert.deepEqual(results, []);
});

test("the Search button reads Cancel while in flight; a second submit cancels and discards the result", async () => {
  let resolveSearch;
  const api = baseApi({
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2025.01.01\n" } },
      { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 6.1\n" } },
      // ytsearch hangs until the test resolves it — simulates an in-flight search.
      { match: { cmd: "yt-dlp", argsInclude: ["ytsearch"] }, result: () => new Promise((res) => { resolveSearch = res; }) },
    ],
  });
  const plugin = loadPlugin();
  await plugin.activate(api);

  // Kick off a search without awaiting (runYtSearch hangs on the pending exec),
  // then flush microtasks so the searching=true re-render lands.
  const inFlight = api._handlers["action:youtube-search-submit"]({ query: "rage" });
  await new Promise((r) => setTimeout(r, 0));

  let input = findNode(lastView(api, "youtube-search"), "search-input");
  assert.equal(input.buttonLabel, "Cancel", "button reads Cancel while searching");
  assert.ok(findNode(lastView(api, "youtube-search"), "loading"), "shows the searching spinner");

  // A second submit while in flight is treated as Cancel.
  await api._handlers["action:youtube-search-submit"]({ query: "rage" });
  input = findNode(lastView(api, "youtube-search"), "search-input");
  assert.equal(input.buttonLabel, "Search", "button reverts to Search after cancel");
  assert.ok(!findNode(lastView(api, "youtube-search"), "loading"), "spinner cleared after cancel");

  // The orphaned search now completes — its result must be discarded (no list).
  resolveSearch({ exitCode: 0, stdout: "dQw4w9WgXcQ\t213\tCh\tArtist - Title\n" });
  await inFlight;
  assert.ok(!findNode(lastView(api, "youtube-search"), "track-row-list"), "cancelled result is discarded");
});
