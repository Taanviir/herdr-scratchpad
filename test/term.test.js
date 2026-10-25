"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { Editor } = require("../lib/shared/editor");

test("a paste far past the argument limit goes in whole", () => {
  const editor = new Editor("ab");
  editor.move(-1);
  const big = "x".repeat(300000);
  editor.insert(big);
  assert.strictEqual(editor.text, `a${big}b`);
  assert.strictEqual(editor.cursor, 300001);
});

test("a word that runs past the edge moves down whole, and only a word wider than the row is cut", () => {
  const typing = new Editor("fix the login bug");
  assert.deepStrictEqual(typing.layout(10).rows, ["fix the ", "login bug"]);
  assert.deepStrictEqual(typing.layout(10).caret, { row: 1, col: 9 });
  assert.deepStrictEqual(new Editor("supercalifragilistic").layout(8).rows, ["supercal", "ifragili", "stic"]);
});
