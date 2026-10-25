"use strict";

const test = require("node:test");
const assert = require("node:assert");

// The worker with Herdr answering each call from `replies`, in order.
function worker(replies) {
  const calls = [];
  const herdr = require.resolve("../lib/shared/herdr");
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
const tab = { ok: true, result: { tab: { tab_id: "w1:t4" }, root_pane: { pane_id: "w1:p2" } } };

test("a session reopened into a shell still starting is retried until it takes", () => {
  const { jobs, calls } = worker([tab, busy, busy, { ok: true, result: {} }]);
  jobs.resume({ kind: "claude", args: ["--resume", "abc"], cwd: "/repo" });
  const starts = calls.filter((args) => args[1] === "start");
  assert.strictEqual(starts.length, 3);
  assert.strictEqual(starts[0][2], "sp-claude-w1-p2", "named after its pane, with no agent list");
  assert.ok(!calls.some((args) => args[1] === "list"));
});

test("a session that is up but not idle counts as started", () => {
  const { jobs, calls } = worker([tab, { ok: false, code: "agent_not_ready", message: "trust dialog" }]);
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

test("a session still loading when the wait runs out counts as started", () => {
  const { jobs, calls } = worker([tab, { ok: false, code: "timeout", message: "timed out" }]);
  jobs.resume({ kind: "codex", args: ["resume", "abc"] });
  assert.strictEqual(calls.filter((args) => args[1] === "start").length, 1);
  assert.ok(!calls.some((args) => args[0] === "tab" && args[1] === "close"));
});

test("a session that never starts closes the tab made for it", () => {
  const { jobs, calls } = worker([tab, { ok: false, code: "agent_exited", message: "claude exited" }]);
  assert.throws(() => jobs.resume({ kind: "claude", args: ["--resume", "abc"] }), /claude exited/);
  assert.deepStrictEqual(calls.at(-1), ["tab", "close", "w1:t4"]);
});
