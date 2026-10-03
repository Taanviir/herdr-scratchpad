"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { compose } = require("../lib/brief");

test("one short note stays on one line, so it can go in as a launch argument", () => {
  const prompt = compose([{ id: "a1b2c3", text: "fix the dev guard" }]);
  assert.ok(!prompt.includes("\n"));
  assert.match(prompt, /^fix the dev guard/);
  assert.match(prompt, /scratch done a1b2c3/);
});

test("several notes become a list with their ids and where they came from", () => {
  const prompt = compose([
    { id: "aaaaaa", text: "first\nwith detail", source: { branch: "fix/x", title: "PR 169" } },
    { id: "bbbbbb", text: "second" },
  ]);
  assert.match(prompt, /- \[aaaaaa\] first\n  with detail\n  \(noted on branch fix\/x while "PR 169" was running\)/);
  assert.match(prompt, /- \[bbbbbb\] second/);
  assert.match(prompt, /scratch done <id>/);
});
