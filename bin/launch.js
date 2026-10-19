"use strict";

// Detached worker, run after the popup has closed. Two jobs: open Quick Prompt
// with notes as its prompt, or reopen the agent session a note came from.

const fs = require("node:fs");
const { run, notify, HerdrError } = require("../lib/herdr");

// The Scratchpad popup has to be gone before Herdr will open another, and
// Herdr says ui_busy until it is.
const HANDOFF_ATTEMPTS = 20;
const HANDOFF_RETRY_MS = 50;
const START_ATTEMPTS = 12;
const START_RETRY_MS = 400;
const START_TIMEOUT_MS = 15000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function handoff(request) {
  const env = {
    QUICK_PROMPT_TEXT: request.prompt,
    QUICK_PROMPT_SOURCE: "Scratchpad",
    QUICK_PROMPT_CWD: request.cwd,
    QUICK_PROMPT_WORKSPACE: request.workspace,
    QUICK_PROMPT_PANE: request.pane,
  };
  const args = ["plugin", "pane", "open", "--plugin", "taanviir.quick-prompt", "--entrypoint", "picker"];
  for (const [key, value] of Object.entries(env)) if (value) args.push("--env", `${key}=${value}`);
  for (let attempt = 1; ; attempt += 1) {
    const res = run(args, { check: false });
    if (res.ok) return;
    if (res.code !== "ui_busy" || attempt === HANDOFF_ATTEMPTS) throw new HerdrError(res.message);
    sleep(HANDOFF_RETRY_MS);
  }
}

// Names must match [a-z][a-z0-9_-]{0,31} and be unique among live agents. The
// pane is unique already, so no lookup is needed and two launches cannot race.
const agentName = (kind, pane) => `sp-${kind}-${pane}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);

// A fresh tab may not be at its shell prompt yet, and `agent start` needs
// that, so retry briefly before giving up. A tab whose session never started
// is closed again.
function resume({ kind, args, cwd, workspace }) {
  const tab = ["tab", "create", "--focus"];
  if (workspace) tab.push("--workspace", workspace);
  if (cwd) tab.push("--cwd", cwd);
  const { result } = run(tab);
  const pane = result.root_pane?.pane_id;
  if (!pane) throw new HerdrError("herdr did not return a pane for the session");

  const start = ["agent", "start", agentName(kind, pane), "--kind", kind, "--pane", pane, "--timeout", String(START_TIMEOUT_MS), "--", ...args];
  let last = "agent did not start";
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    const res = run(start, { check: false });
    // Not idle, or not ready in time, means the session is up and showing
    // something: that is fine. A busy pane is a shell still starting.
    if (res.ok || res.code === "timeout" || /agent_not_ready/i.test(`${res.code ?? ""} ${res.message}`)) return;
    last = res.message;
    if (!/pane|shell|prompt|busy|not_available/i.test(`${res.code ?? ""} ${last}`)) break;
    sleep(START_RETRY_MS);
  }
  if (result.tab?.tab_id) run(["tab", "close", result.tab.tab_id], { check: false });
  throw new HerdrError(last);
}

const JOBS = { handoff, resume };

function main(file) {
  try {
    const request = JSON.parse(fs.readFileSync(file, "utf8"));
    JOBS[request.type](request);
  } catch (error) {
    notify("Scratchpad failed", error.message ?? String(error));
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

if (require.main === module) main(process.argv[2]);

module.exports = JOBS;
