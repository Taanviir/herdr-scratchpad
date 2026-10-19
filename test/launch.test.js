"use strict";

const test = require("node:test");
const assert = require("node:assert");

// The worker with Herdr answering each call from `replies`, in order.
function worker(replies) {
  const calls = [];
  const herdr = require.resolve("../lib/herdr");
  const real = require(herdr);
  require.cache[herdr].exports = {
    ...real,
    run: (args) => {
      calls.push(args);
      return replies.shift() ?? { ok: true, result: {} };
    },
  };
  delete require.cache[require.resolve("../bin/launch")];
  const jobs = require("../bin/launch");
  require.cache[herdr].exports = real;
  return { jobs, calls };
}

const busy = { ok: false, code: "agent_pane_busy", message: "pane is not at a shell prompt" };
const tab = { ok: true, result: { root_pane: { pane_id: "w1:p2" } } };
const none = { ok: true, result: { agents: [] } };

test("a session reopened into a shell still starting is retried until it takes", () => {
  const { jobs, calls } = worker([tab, none, busy, busy, { ok: true, result: {} }]);
  jobs.resume({ kind: "claude", args: ["--resume", "abc"], cwd: "/repo" });
  assert.strictEqual(calls.filter((args) => args[1] === "start").length, 3);
});

test("a session that is up but not idle counts as started", () => {
  const { jobs, calls } = worker([tab, none, { ok: false, code: "agent_not_ready", message: "trust dialog" }]);
  jobs.resume({ kind: "claude", args: ["--resume", "abc"] });
  assert.strictEqual(calls.filter((args) => args[1] === "start").length, 1);
});

test("the handoff waits only as long as the Scratchpad popup is still open", () => {
  const popupOpen = { ok: false, code: "ui_busy", message: "a popup pane is already open" };
  const { jobs, calls } = worker([popupOpen, popupOpen, { ok: true, result: {} }]);
  jobs.handoff({ prompt: "fix it", cwd: "/repo" });
  assert.strictEqual(calls.length, 3);
  assert.ok(calls[2].includes("QUICK_PROMPT_TEXT=fix it"));
});

test("a handoff Herdr refuses for another reason fails at once", () => {
  const { jobs, calls } = worker([{ ok: false, code: "plugin_disabled", message: "plugin is disabled" }]);
  assert.throws(() => jobs.handoff({ prompt: "fix it" }), /plugin is disabled/);
  assert.strictEqual(calls.length, 1);
});
