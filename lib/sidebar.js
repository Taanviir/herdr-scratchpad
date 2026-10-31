"use strict";

// Scratchpad on Herdr's sidebar: each workspace gets `$notes`, how many open
// notes its folders have, and `$due`, the soonest date among them. They show
// wherever [ui.sidebar.spaces] rows in config.toml name them.

const path = require("node:path");
const store = require("./store");
const { relatedTo } = require("./source");
const { short } = require("./when");
const { run, spawnDetached } = require("./shared/herdr");

const SOURCE = "taanviir.scratchpad";
const WORKER = path.join(__dirname, "..", "bin", "sidebar.js");

// Every folder a workspace has a pane in.
function foldersByWorkspace(snapshot) {
  const folders = new Map();
  for (const pane of snapshot?.panes ?? []) {
    const cwd = pane.foreground_cwd ?? pane.cwd;
    if (!cwd || !pane.workspace_id) continue;
    if (!folders.has(pane.workspace_id)) folders.set(pane.workspace_id, new Set());
    folders.get(pane.workspace_id).add(cwd);
  }
  return folders;
}

// An empty value clears the token, and Herdr drops it from the row.
function tokensFor(notes, folders, now = new Date()) {
  const open = notes.filter((note) => !note.done && [...folders].some((folder) => relatedTo(note, folder)));
  const soonest = open.map((note) => note.due).filter(Boolean).sort()[0];
  return {
    notes: open.length ? `✎ ${open.length}` : "",
    due: soonest ? `◷ ${short(soonest, now)}` : "",
  };
}

// Only the workspaces whose tokens would change.
function changes(snapshot, notes, now = new Date()) {
  const folders = foldersByWorkspace(snapshot);
  return (snapshot?.workspaces ?? []).flatMap((workspace) => {
    const tokens = tokensFor(notes, folders.get(workspace.workspace_id) ?? new Set(), now);
    const current = workspace.tokens ?? {};
    const differs = Object.keys(tokens).some((name) => (current[name] ?? "") !== tokens[name]);
    return differs ? [{ workspace: workspace.workspace_id, tokens }] : [];
  });
}

function report() {
  const res = run(["api", "snapshot"], { check: false, timeout: 3000 });
  if (!res.ok) return;
  for (const { workspace, tokens } of changes(res.result.snapshot, store.readAll())) {
    const args = ["workspace", "report-metadata", workspace, "--source", SOURCE];
    for (const [name, value] of Object.entries(tokens)) args.push(...(value ? ["--token", `${name}=${value}`] : ["--clear-token", name]));
    run(args, { check: false });
  }
}

// Outside Herdr there is no sidebar to update.
function refreshSoon() {
  if (process.env.HERDR_ENV) spawnDetached(process.execPath, [WORKER]);
}

module.exports = { foldersByWorkspace, tokensFor, changes, report, refreshSoon };
