# Developing & Debugging a Viboplr Plugin

A practical guide to writing, running, reloading, and debugging a Viboplr
plugin. For the full method-by-method API surface, see the app's
`PLUGIN-API-REFERENCE.md`; this document is about the **workflow**.

> This repo (`spotify-browse`) is a real, non-trivial example. The smallest
> possible example is the app's bundled `audiodb` plugin (a 13-line `index.js`).

---

## 1. What a plugin is

A plugin is a folder with two required files:

```
my-plugin/
├── manifest.json   # metadata + what the plugin contributes
└── index.js        # the code
```

`index.js` is executed by the app as the body of a function and **must return an
object with an `activate` function** (and optionally `deactivate`):

```js
function activate(api) {
  // register handlers, set up UI, subscribe to events …
}
function deactivate() {
  // optional: clean up (see "Cleaning up" below)
}
return { activate: activate, deactivate: deactivate };
```

The app calls `activate(api)` once when the plugin loads. `api` is the only way
to talk to the app.

### How the code runs (and what's available)

The app runs your code via `new Function("api", "window", "globalThis", "self",
"document", code)`. There is **no build step and no transpilation** — the file
is executed as-is in the app's WebView.

- **Modern JavaScript works.** Arrow functions, `const`/`let`, template
  literals, `async`/`await`, classes — all fine. (The bundled plugins happen to
  use older `var`/`function` style by convention, but you are not required to.)
- The execution scope is a **frozen sandbox**, not the real page. Available
  globals: `console`, `Math`, `JSON`, `Date`, `Promise`, `Object`, `Array`,
  `String`, `Number`, `RegExp`, `Error`, `setTimeout`/`clearTimeout`,
  `setInterval`/`clearInterval`, `encodeURIComponent`/`decodeURIComponent`,
  `parseInt`/`parseFloat`/`isNaN`/`isFinite`.
- **Not available:** `fetch` (use `api.network.fetch`), `require`/`import`, the
  real DOM (`document`/`window` are the frozen sandbox, not the page), and file
  system access (use `api.storage.files`).

---

## 2. The minimal manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "You",
  "description": "What it does",
  "contributes": {}
}
```

- **`id`** must match the plugin's folder name and be unique. It's how the app
  keys everything (storage, overrides, logs).
- **`name`** and **`version`** are required — a manifest missing either loads
  with status **error**.
- **`version`** must be semver `X.Y.Z`.
- Optional: `minAppVersion` (blocks load with status **incompatible** if the app
  is older), `debugOnly` (hidden unless the app's debug mode is on), `icon`,
  `homepage`, `updateUrl` (for auto-update — see `README.md`).
- `contributes.*` declares what the plugin adds (information types, image
  providers, sidebar items, home shelves, context menu items, …). A plugin with
  an empty `contributes` loads fine but does nothing visible.

A `manifest.json` that isn't valid JSON is **skipped silently** (logged on the
Rust side) — if your plugin doesn't appear at all, suspect the manifest first.

---

## 3. Install your working copy into the app

Plugins load from two places:

- **Built-in (bundled):** ships inside the app. In a dev checkout these come
  from `src-tauri/plugins/`.
- **User dir:** `{app_data}/profiles/{profile}/plugins/{id}/`. On macOS that is:
  ```
  ~/Library/Application Support/com.alex.viboplr/profiles/{profile}/plugins/{id}/
  ```
  (Windows: `%APPDATA%\com.alex.viboplr\profiles\{profile}\plugins\{id}\`;
  Linux: `~/.local/share/com.alex.viboplr/profiles/{profile}/plugins/{id}/`.)

**A user-dir plugin overrides a bundled one with the same `id`.** That's exactly
how this Spotify plugin updates the built-in baseline — and it's how you test a
working copy.

The fastest dev setup is to **symlink your repo into the user plugin dir** so you
edit in one place:

```bash
# macOS, default profile, plugin id "my-plugin"
PROFILE=default
DEST="$HOME/Library/Application Support/com.alex.viboplr/profiles/$PROFILE/plugins/my-plugin"
ln -s "$(pwd)" "$DEST"     # or: cp -R . "$DEST" if you prefer a copy
```

> Find your profile name in the app (non-default profiles are shown in the window
> title). The `default` profile is used unless you launched with `--profile` or
> `VIBOPLR_PROFILE`.

If you symlink, edits to `index.js` are picked up on the next **reload** (below)
— no copying, no app restart.

---

## 4. The edit → reload loop

The app reads `index.js` fresh from disk every time the plugin loads, so you do
**not** need to rebuild or restart the app to see code changes — you just need to
trigger a reload. There is no general "reload plugin" button, so use one of:

1. **Toggle off → on in Extensions.** Open **Extensions**, disable your plugin,
   then enable it. This runs your `deactivate()` (cleanup), re-reads `index.js`,
   and runs `activate()` again. This is the normal dev loop.
2. **Reinstall from URL.** Extensions → *Install from URL* re-reads and reloads.
   (Useful when testing the published artifact rather than a local symlink.)
3. **`debugOnly` toggle trick.** If your manifest has `"debugOnly": true`,
   flipping the app's debug-mode setting reloads all plugins. Handy, but remember
   to remove `debugOnly` before release or end users won't see the plugin.

Editing `manifest.json` (e.g. changing `contributes`) also takes effect on
reload.

---

## 5. Debugging

### DevTools console — your main tool

Open the WebView DevTools with **F12** (or **Ctrl/Cmd+Shift+I**). Everything your
plugin logs via `console.log` / `console.warn` / `console.error` appears here,
and you can inspect network calls, set breakpoints in your `index.js`, etc.

- **Activation errors** are logged here as `[plugin:<id>] activation error: …`.
  If your plugin shows an **error** badge in Extensions, the actual message is in
  the console (the UI only shows the badge, not the text).
- Errors thrown inside handlers (fetch handlers, event hooks, context-menu
  actions) are also logged here as they occur.

### Persistent logs — `api.log`

```js
api.log("info",  "started sync", "my-plugin");
api.log("warn",  "no cover found for " + name, "my-plugin");
api.log("error", "fetch failed: " + e, "my-plugin");
```

`api.log(level, message, section?)` writes to the app's **file logs** under
`{app_data}/.../logs/` (the `section`, defaulting to `"frontend"`, becomes the
log target — pass your plugin id). There is **no in-app log viewer**; open the
logs folder from the app's settings ("open logs folder") or on disk. Use
`api.log` for things you want to survive past the DevTools session; use
`console.*` for fast interactive debugging.

### "My plugin isn't showing / not working" checklist

| Symptom | Likely cause | Where to look |
|---|---|---|
| Not listed at all | invalid `manifest.json`, or `debugOnly: true` with debug mode off | Rust logs / manifest; toggle debug mode |
| **error** badge | `activate()` threw, or `name`/`version` missing | DevTools console for the message |
| **incompatible** badge | `minAppVersion` newer than the app | manifest `minAppVersion` vs app version |
| **disabled** badge | not enabled | enable it in Extensions |
| Loads but does nothing | empty/incorrect `contributes`, handler not registered | confirm `activate` registers handlers; console |
| Stale behavior after editing | didn't reload | toggle off/on (section 4) |

---

## 6. Cleaning up (`deactivate`)

Every reload runs `deactivate()` (if present) before re-activating. Most `api`
registration calls **return an unsubscribe function** — keep them and call them
in `deactivate`, or your handlers accumulate across reloads (duplicate calls,
leaks):

```js
function activate(api) {
  const unsubs = [];
  unsubs.push(api.playback.onTrackStarted(function (t) { /* … */ }));
  unsubs.push(api.home.onFetchShelf("my-shelf", function (limit) { /* … */ }));
  this._unsubs = unsubs; // or hold in a module-scoped array
}
function deactivate() {
  (this._unsubs || []).forEach(function (u) { try { u(); } catch (e) {} });
}
```

The app also auto-drops a plugin's home-shelf handlers and view data on
deactivate, but anything you subscribed to (events, schedulers) is yours to
release.

---

## 7. A complete tiny plugin

`manifest.json`:
```json
{
  "id": "hello-image",
  "name": "Hello Image",
  "version": "1.0.0",
  "author": "You",
  "description": "Provides artist images from TheAudioDB",
  "contributes": { "imageProviders": [{ "entity": "artist" }] }
}
```

`index.js`:
```js
function activate(api) {
  api.imageProviders.onFetch("artist", async function (name) {
    const resp = await api.network.fetch(
      "https://theaudiodb.com/api/v1/json/2/search.php?s=" + encodeURIComponent(name)
    );
    const data = await resp.json();
    const artist = data && data.artists && data.artists[0];
    if (!artist || !artist.strArtistThumb) return { status: "not_found" };
    return { status: "ok", url: artist.strArtistThumb };
  });
  api.log("info", "hello-image activated", "hello-image");
}
return { activate: activate };
```

Drop those two files in `{app_data}/.../plugins/hello-image/`, enable it in
Extensions, open an artist with no image, and watch the DevTools console.

---

## 8. Releasing

See `README.md` → *Develop & Release*. In short: bump the version
(`scripts/bump.sh`), update `CHANGELOG.md`, push a tag — CI builds and publishes
the release, and installed copies auto-update via `updateUrl`.
