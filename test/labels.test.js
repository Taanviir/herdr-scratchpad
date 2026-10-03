"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { labels, title, known, group, partialTag } = require("../lib/labels");

test("hashtags anywhere in a note are its labels, lowercased, once each", () => {
  assert.deepStrictEqual(labels("#Release raise the version #ci\nthen #release again"), ["release", "ci"]);
  assert.deepStrictEqual(labels("PR #169 and issue#12"), ["169"]);
  assert.deepStrictEqual(labels("no tags here"), []);
});

test("the title is the first line without its tags", () => {
  assert.strictEqual(title("#release  back up the db #ops\nmore"), "back up the db");
  assert.strictEqual(title("\n\nsecond line first"), "second line first");
  assert.strictEqual(title("#only-a-tag"), "#only-a-tag");
});

test("notes group under their first label, biggest group first, unlabelled last", () => {
  const notes = [{ text: "a" }, { text: "b #ops" }, { text: "c #release" }, { text: "d #release #ops" }];
  assert.deepStrictEqual(group(notes).map((g) => [g.name, g.notes.length]), [["release", 2], ["ops", 1], [null, 1]]);
  assert.deepStrictEqual(known(notes), ["ops", "release"]);
});

test("a tag being typed is found just before the caret", () => {
  assert.strictEqual(partialTag("fix it #rel"), "rel");
  assert.strictEqual(partialTag("#"), "");
  assert.strictEqual(partialTag("fix it #rel "), null);
  assert.strictEqual(partialTag("issue#1"), null);
});
