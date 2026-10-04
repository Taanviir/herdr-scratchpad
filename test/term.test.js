"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { Editor } = require("../lib/editor");

test("a paste far past the argument limit goes in whole", () => {
  const editor = new Editor("ab");
  editor.move(-1);
  const big = "x".repeat(300000);
  editor.insert(big);
  assert.strictEqual(editor.text, `a${big}b`);
  assert.strictEqual(editor.cursor, 300001);
});
