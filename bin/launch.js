"use strict";

// Detached worker, run after the popup has closed. Two jobs: open Quick Prompt
// with notes as its prompt, or reopen the agent session a note came from.

const fs = require("node:fs");
const { run, notify, HerdrError } = require("../lib/herdr");

// The Scratchpad popup has to be gone before Herdr will open another.
const HANDOFF_DELAY_MS = 250;
const START_ATTEMPTS = 12;
const START_RETRY_MS = 400;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function handoff(request) {
  sleep(HANDOFF_DELAY_MS);
  const env = {
    QUICK_PROMPT_TEXT: request.prompt,
    QUICK_PROMPT_SOURCE: "Scratchpad",
    QUICK_PROMPT_CWD: request.cwd,
    QUICK_PROMPT_WORKSPACE: request.workspace,
    QUICK_PROMPT_PANE: request.pane,
  };
  const args = ["plugin", "pane", "open", "--plugin", "taanviir.quick-prompt", "--entrypoint", "picker"];
  for (const [key, value] of Object.entries(env)) if (value) args.push("--env", `${key}=${value}`);
  run(args);
}

// Names must match [a-z][a-z0-9_-]{0,31} and be unique among live agents.
function uniqueName(kind) {
  const res = run(["agent", "list"], { check: false });
  const taken = new Set((res.result?.agents ?? []).map((a) => a.name).filter(Boolean));
  const base = `sp-${kind}`.slice(0, 30);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

// A fresh tab may not be at its shell prompt yet, and `agent start` needs
// that, so retry briefly before giving up.
function resume({ kind, args, cwd, workspace }) {
  const tab = ["tab", "create", "--focus"];
  if (workspace) tab.push("--workspace", workspace);
  if (cwd) tab.push("--cwd", cwd);
  const pane = run(tab).result.root_pane?.pane_id;
  if (!pane) throw new HerdrError("herdr did not return a pane for the session");

  const start = ["agent", "start", uniqueName(kind), "--kind", kind, "--pane", pane, "--", ...args];
  let last = "agent did not start";
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    const res = run(start, { check: false });
    // Not idle means the session is up and showing something: that is fine.
    if (res.ok || /agent_not_ready|agent_pane_busy/i.test(`${res.code ?? ""} ${res.message}`)) return;
    last = res.message;
    if (!/pane|shell|prompt|busy|not_available/i.test(`${res.code ?? ""} ${last}`)) break;
    sleep(START_RETRY_MS);
  }
  throw new HerdrError(last);
}

const JOBS = { handoff, resume };

const file = process.argv[2];
try {
  const request = JSON.parse(fs.readFileSync(file, "utf8"));
  JOBS[request.type](request);
} catch (error) {
  notify("Scratchpad failed", error.message ?? String(error));
  process.exitCode = 1;
} finally {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}
