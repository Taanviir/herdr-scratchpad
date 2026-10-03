"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.SCRATCHPAD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "scratchpad-"));
const store = require("../lib/store");
const { relatedTo } = require("../lib/source");

test("a note survives a round trip through the file", () => {
  const note = store.add({ text: "  check PR 169 on friday \n", folders: ["/repo"], source: { agent: "claude" } });
  assert.strictEqual(note.text, "check PR 169 on friday");
  assert.deepStrictEqual(store.get(note.id).folders, ["/repo"]);
});

test("a unique id prefix finds the note, an ambiguous one is refused", () => {
  const note = store.add({ text: "prefix" });
  assert.strictEqual(store.get(note.id.slice(0, 4)).id, note.id);
  assert.throws(() => store.get(""), /matches/);
  assert.throws(() => store.get("zzzzzz"), /no note/);
});

test("done, undo, edit and remove change only their note", () => {
  const a = store.add({ text: "a" });
  const b = store.add({ text: "b" });
  assert.ok(store.setDone(a.id).done);
  assert.strictEqual(store.setDone(a.id, false).done, null);
  store.edit(b.id, "b, but better");
  assert.strictEqual(store.get(b.id).text, "b, but better");
  assert.throws(() => store.edit(b.id, "   "), /needs some text/);
  store.remove(a.id);
  assert.throws(() => store.get(a.id), /no note/);
  assert.strictEqual(store.get(b.id).text, "b, but better");
});

test("an empty note is refused", () => {
  assert.throws(() => store.add({ text: " \n " }), /needs some text/);
});

test("a stale lock left by a dead process does not block writes", () => {
  const lock = path.join(store.home(), "notes.lock");
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.ok(store.add({ text: "after a crash" }).id);
  assert.ok(!fs.existsSync(lock));
});

test("a note filed under a folder shows in that folder and below, not above", () => {
  const note = { folders: ["/home/me/work"] };
  assert.ok(relatedTo(note, "/home/me/work"));
  assert.ok(relatedTo(note, "/home/me/work/api"));
  assert.ok(!relatedTo(note, "/home/me"));
  assert.ok(!relatedTo(note, "/home/me/workshop"));
  assert.ok(!relatedTo({ folders: [] }, "/home/me"));
  assert.ok(relatedTo({ folders: [] }, null));
});

test("each note is one line, and a broken line costs only itself", () => {
  const good = store.add({ text: "line one\nline two" });
  fs.appendFileSync(store.file(), "{not json\n");
  const lines = fs.readFileSync(store.file(), "utf8").trim().split("\n");
  assert.ok(lines.every((line) => !line.startsWith(" ")));
  assert.strictEqual(store.get(good.id).text, "line one\nline two");

  store.add({ text: "written after the damage" });
  assert.ok(fs.readFileSync(store.file(), "utf8").includes("{not json"));
});
