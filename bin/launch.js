"use strict";

// Detached worker, run after the popup has closed so it never waits on an
// agent starting. Three jobs: start an agent with notes as its brief, send
// notes to an agent already running, or reopen the session a note came from.

const fs = require("node:fs");
const store = require("../lib/store");
const { compose } = require("../lib/brief");
const { run, notify, HerdrError } = require("../lib/herdr");
const { supportsInlinePrompt } = require("../lib/agents");

const START_ATTEMPTS = 12;
const START_RETRY_MS = 400;
const READY_TIMEOUT_MS = 120000;
const READY_POLL_MS = 400;
const READY_POLLS = 40;
// Agent TUIs repaint for a moment after they report readiness, and keystrokes
// sent into that repaint are lost.
const SETTLE_MS = 900;
const DELIVERY_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 20000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function createTarget({ destination, workspace, pane, cwd }) {
  let res;
  if ((destination === "right" || destination === "down") && pane) {
    res = run(["pane", "split", pane, "--direction", destination, "--focus", ...(cwd ? ["--cwd", cwd] : [])]);
    if (res.result.pane?.pane_id) return res.result.pane.pane_id;
  } else {
    const args = ["tab", "create", "--focus"];
    if (workspace) args.push("--workspace", workspace);
    if (cwd) args.push("--cwd", cwd);
    res = run(args);
    if (res.result.root_pane?.pane_id) return res.result.root_pane.pane_id;
  }
  throw new HerdrError("herdr did not return a pane for the agent");
}

// A fresh pane may not be at its shell prompt yet, and `agent start` needs
// that, so retry briefly before giving up.
function startAgent(name, kind, pane, agentArgs) {
  const args = ["agent", "start", name, "--kind", kind, "--pane", pane];
  if (agentArgs.length) args.push("--", ...agentArgs);
  let last = "agent did not start";
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    const res = run(args, { check: false });
    if (res.ok) return { started: true, ready: true };
    last = res.message;
    // Startup reached the agent but it is not idle: a trust dialog, or an
    // inline prompt it is already working on. Either way the name is live.
    const reason = `${res.code ?? ""} ${last}`;
    if (res.code === "invalid_agent_argument") break;
    if (/agent_not_ready|agent_pane_busy/i.test(reason)) return { started: true, ready: false };
    if (!/pane|shell|prompt|busy|not_available/i.test(reason)) break;
    sleep(START_RETRY_MS);
  }
  return { started: false, message: last };
}

function agentState(name) {
  const res = run(["agent", "get", name], { check: false });
  return res.ok ? res.result?.agent ?? {} : {};
}

function waitInteractive(name) {
  for (let poll = 0; poll < READY_POLLS; poll += 1) {
    if (agentState(name).interactive_ready) return true;
    sleep(READY_POLL_MS);
  }
  return false;
}

// `agent prompt` can report success while the startup repaint eats the
// keystrokes, so check the text landed before trying again.
function deliverPrompt(name, prompt) {
  for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt += 1) {
    sleep(SETTLE_MS);
    const sent = run(["agent", "prompt", name, prompt], { check: false });
    if (sent.ok === false && !/stalled|blocked|not_ready|busy/i.test(`${sent.code ?? ""} ${sent.message}`)) return false;
    sleep(SETTLE_MS);
    const status = agentState(name).agent_status;
    if (status === "working" || status === "blocked") return true;
  }
  return false;
}

function notesFor(ids) {
  return ids.map((id) => store.get(id));
}

function markSent(notes, target) {
  for (const note of notes) {
    try {
      store.markSent(note.id, target);
    } catch { /* deleted meanwhile; the agent has it regardless */ }
  }
}

function launch(request) {
  const notes = notesFor(request.notes);
  const prompt = compose(notes);
  const { kind } = request;
  const name = uniqueName(kind);
  const pane = createTarget(request);

  // Herdr refuses a launch argument with a newline in it, so a brief of
  // several lines is typed in once the agent is up.
  const inline = !prompt.includes("\n") && supportsInlinePrompt(kind);
  let started = startAgent(name, kind, pane, inline ? [prompt] : []);
  let delivered = inline && started.started;
  if (!started.started && inline) {
    started = startAgent(name, kind, pane, []);
    delivered = false;
  }
  if (!started.started) throw new HerdrError(started.message);

  if (!delivered) {
    if (!started.ready) {
      const waited = run(["agent", "wait", name, "--until", "idle", "--timeout", String(READY_TIMEOUT_MS)], { check: false });
      if (!waited.ok) return notify("Scratchpad", `${kind} needs attention before it can take the notes.`);
    }
    if (!waitInteractive(name) || !deliverPrompt(name, prompt)) {
      return notify("Scratchpad", `${kind} did not take the notes. They are still in the scratchpad.`);
    }
  }
  markSent(notes, { agent: name, pane });
}

// A follow-up to an agent past its startup, so no repaint to dodge. Herdr
// confirms delivery by seeing the agent start on it; a busy agent queues it.
function send(request) {
  const notes = notesFor(request.notes);
  const res = run([
    "agent", "prompt", request.target, compose(notes),
    "--wait", "--until", "working", "--until", "blocked", "--timeout", String(SEND_TIMEOUT_MS),
  ], { check: false });
  if (!res.ok) return notify("Scratchpad", `${request.title} did not take the notes: ${res.message}`);
  markSent(notes, { agent: `${request.kind} · ${request.title}`, pane: request.target });
}

function resume(request) {
  const pane = createTarget(request);
  const started = startAgent(uniqueName(request.kind), request.kind, pane, request.args);
  if (!started.started) throw new HerdrError(started.message);
}

const JOBS = { launch, send, resume };

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
