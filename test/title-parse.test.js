const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const parse = plugin._parseTrackTitle;

test("splits 'Artist - Song' and strips official-video tag", () => {
  const r = parse("Rick Astley - Never Gonna Give You Up (Official Music Video)", "RickAstleyVEVO");
  assert.equal(r.artist, "Rick Astley");
  assert.equal(r.title, "Never Gonna Give You Up");
});

test("keeps feat. as part of the title", () => {
  const r = parse("Daft Punk – Get Lucky ft. Pharrell", "DaftPunkVEVO");
  assert.equal(r.artist, "Daft Punk");
  assert.equal(r.title, "Get Lucky ft. Pharrell");
});

test("keeps (Remix) and (Live) — real information", () => {
  const r = parse("Artist - Song (Live)", "ch");
  assert.equal(r.artist, "Artist");
  assert.equal(r.title, "Song (Live)");
});

test("no separator falls back to channel as artist, cleaned title", () => {
  const r = parse("lofi hip hop radio (Official Video)", "Lofi Girl");
  assert.equal(r.artist, "Lofi Girl");
  assert.equal(r.title, "lofi hip hop radio");
});

test("splits on the FIRST separator only", () => {
  const r = parse("Artist - Album - Song", "ch");
  assert.equal(r.artist, "Artist");
  assert.equal(r.title, "Album - Song");
});

test("empty side after split falls back to channel", () => {
  const r = parse("- Song", "ch");
  assert.equal(r.artist, "ch");
});

test("handles null/empty inputs gracefully", () => {
  const r1 = parse(null, null);
  assert.equal(r1.artist, "");
  assert.equal(r1.title, "");
  const r2 = parse("", "");
  assert.equal(r2.artist, "");
  assert.equal(r2.title, "");
});
