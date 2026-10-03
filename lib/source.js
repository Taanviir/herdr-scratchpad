"use strict";

// Where a note came from: the folder it belongs to and the pane, agent and
// session that were in front of you when you wrote it.

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { run } = require("./herdr");

const LOOKUP_TIMEOUT_MS = 800;

function git(cwd, args) {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS });
  return res.status === 0 ? res.stdout.trim() : null;
}

// A note made anywhere inside a repository belongs to the repository, so
// notes from `src/` and from the root land together.
function folderFor(cwd) {
  if (!cwd) return null;
  return git(cwd, ["rev-parse", "--show-toplevel"]) ?? path.resolve(cwd);
}

const branchOf = (cwd) => (cwd ? git(cwd, ["branch", "--show-current"]) || null : null);

// A note filed under a parent directory also shows up in its children, not the
// other way round: a note about ~/work applies inside ~/work/api, but sitting
// in ~ should not list every note on the machine.
function relatedTo(note, folder) {
  if (!folder) return true;
  return (note.folders ?? []).some((f) => f === folder || folder.startsWith(`${f}${path.sep}`));
}

function paneEntry(paneId) {
  if (!paneId) return null;
  const res = run(["pane", "get", paneId], { check: false, timeout: LOOKUP_TIMEOUT_MS });
  return res.ok ? res.result.pane ?? null : null;
}

// Everything is optional: a note captured outside Herdr, or from a plain shell,
// still saves with whatever could be found.
function describe({ paneId, cwd }) {
  const pane = paneEntry(paneId);
  const where = pane?.foreground_cwd ?? pane?.cwd ?? cwd ?? null;
  const source = {
    pane: paneId ?? null,
    cwd: where,
    branch: branchOf(where),
    agent: pane?.agent ?? null,
    session: pane?.agent_session?.value ?? null,
    title: pane?.terminal_title_stripped || null,
  };
  for (const key of Object.keys(source)) if (source[key] === null) delete source[key];
  return { folder: folderFor(where), source };
}

module.exports = { folderFor, branchOf, relatedTo, describe };
