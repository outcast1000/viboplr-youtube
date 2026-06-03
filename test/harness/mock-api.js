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
  const calls = { exec: [], log: [], setViewData: [], openUrl: [], playTrack: [], enqueue: [] };
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
      onResolveStreamByUri: (scheme, fn) => { handlers["streamuri:" + scheme] = fn; },
      playTrack: (track) => { calls.playTrack.push(track); },
      playTracks: (tracks, startIndex, context) => { calls.playTrack.push({ tracks, startIndex, context }); },
    },
    downloads: {
      onResolveByUri: (id, fn) => { handlers["uri:" + id] = fn; },
      onResolveByMetadata: (id, fn) => { handlers["meta:" + id] = fn; },
      onGetQualities: (id, fn) => { handlers["qual:" + id] = fn; },
      enqueue: async (request) => { calls.enqueue.push(request); return calls.enqueue.length; },
    },
    ui: {
      onAction: (id, fn) => { handlers["action:" + id] = fn; },
      setViewData: (id, data) => { calls.setViewData.push({ id, data }); },
    },
  };

  return api;
}

module.exports = { makeApi };
