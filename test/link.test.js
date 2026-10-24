"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-bin-"));
process.env.SCRATCHPAD_BIN_DIR = dir;
const { relink, SCRIPT } = require("../lib/link");
const at = path.join(dir, "scratch");

test("a link to an older Scratchpad checkout is moved to this one", { skip: process.platform === "win32" }, () => {
  fs.symlinkSync("/home/me/.config/herdr/plugins/github/taanviir.scratchpad-115f/bin/scratch.js", at);
  assert.strictEqual(relink(), true);
  assert.strictEqual(fs.readlinkSync(at), SCRIPT);
  assert.strictEqual(relink(), false, "already ours");
  fs.unlinkSync(at);
});

test("anything that is not a Scratchpad link is left alone", { skip: process.platform === "win32" }, () => {
  assert.strictEqual(relink(), false, "no link at all is setup's job");
  fs.symlinkSync("/usr/local/bin/other-scratch", at);
  assert.strictEqual(relink(), false);
  assert.strictEqual(fs.readlinkSync(at), "/usr/local/bin/other-scratch");
  fs.unlinkSync(at);
  fs.writeFileSync(at, "#!/bin/sh\n");
  assert.strictEqual(relink(), false);
  assert.strictEqual(fs.readFileSync(at, "utf8"), "#!/bin/sh\n");
});
