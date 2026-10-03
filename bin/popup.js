"use strict";

// The one popup. The cursor starts in the note box, because writing a note is
// what you usually came for. Below it, the notes sit grouped by label on the
// left, with the selected one in full on the right.

const fs = require("node:fs");
const path = require("node:path");
const store = require("../lib/store");
const { describe, relatedTo } = require("../lib/source");
const { Editor } = require("../lib/editor");
const { style, tint, pad, truncate, shortenPath, displayWidth } = require("../lib/ui");
const { compose } = require("../lib/brief");
const { labels, title, known, group, partialTag } = require("../lib/labels");
const { catalog } = require("../lib/agents");
const { runningAgents, matches } = require("../lib/running");
const { spawnDetached } = require("../lib/herdr");
const { readClipboard } = require("../lib/clipboard");
const { STATE_DIR, start, isNewline, isPrintable, editKey } = require("../lib/term");

const LAUNCHER = path.join(__dirname, "launch.js");
const PREFS = path.join(STATE_DIR, "prefs.json");
const DRAFT = path.join(STATE_DIR, "draft.txt");

const DESTINATIONS = [
  { id: "tab", label: "a new tab" },
  { id: "right", label: "a split on the right" },
  { id: "down", label: "a split below" },
];

// Claude Code and Codex are the agents that take a session id on the command line.
const RESUME_ARGS = {
  claude: (id) => ["--resume", id],
  codex: (id) => ["resume", id],
};

const MAX_INPUT_ROWS = 3;
const MIN_CHIPS = 5;
const SUGGESTIONS = 6;

const originPane = process.env.SCRATCHPAD_PANE;
const workspace = process.env.SCRATCHPAD_WORKSPACE;
const here = describe({ paneId: originPane, cwd: process.env.SCRATCHPAD_CWD });

const TABS = [
  here.folder && { id: "here", label: "This folder", show: (n) => !n.done && relatedTo(n, here.folder) },
  { id: "all", label: "All", show: (n) => !n.done },
  { id: "done", label: "Done", show: (n) => Boolean(n.done) },
].filter(Boolean);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeFile(file, text) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (text) fs.writeFileSync(file, text, { mode: 0o600 });
    else fs.rmSync(file, { force: true });
  } catch { /* a preference or a draft is not worth failing over */ }
}

const prefs = readJson(PREFS, {});
const agents = catalog();
const installed = agents.filter((a) => a.installed);
const chips = installed.length >= MIN_CHIPS ? installed : agents.slice(0, MIN_CHIPS);

let draft = "";
try { draft = fs.readFileSync(DRAFT, "utf8"); } catch { /* none */ }
const selection = process.env.SCRATCHPAD_SELECTION ?? "";

const state = {
  tab: 0,
  focus: "input", // input | list
  editor: new Editor(draft || selection),
  editing: null, // the note being edited in the box, instead of a new one
  stash: "", // the unsaved new note, set aside while editing
  anywhere: !here.folder,
  notes: [], // in the order the list shows them
  groups: [],
  counts: [],
  labels: [], // every label in use, for completing a half-typed one
  index: 0,
  ticked: new Set(),
  agent: Math.max(0, chips.findIndex((a) => a.kind === prefs.kind)),
  destination: Math.max(0, DESTINATIONS.findIndex((d) => d.id === prefs.destination)),
  sheet: null, // { type: "launch" } or { type: "running", agents, index, filter }
  confirmDelete: false,
  notice: draft ? "restored your draft · ctrl+u clears it" : selection ? "started from your selection" : null,
};

function reload() {
  const all = store.readAll().sort((a, b) => b.created.localeCompare(a.created));
  state.counts = TABS.map((tab) => all.filter(tab.show).length);
  state.labels = known(all);
  state.groups = group(all.filter(TABS[state.tab].show));
  state.notes = state.groups.flatMap((g) => g.notes);
  const ids = new Set(state.notes.map((n) => n.id));
  for (const id of state.ticked) if (!ids.has(id)) state.ticked.delete(id);
  state.index = Math.max(0, Math.min(state.index, state.notes.length - 1));
  if (!state.notes.length && state.focus === "list") state.focus = "input";
}

const current = () => state.notes[state.index];
const targets = () => (state.ticked.size ? state.notes.filter((n) => state.ticked.has(n.id)) : current() ? [current()] : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Where an agent for these notes starts: their own folder when they agree,
// otherwise where you opened the popup.
function launchDirectory(notes) {
  const folders = new Set(notes.map((n) => n.folders?.[0]).filter(Boolean));
  if (folders.size === 1) return [...folders][0];
  return here.folder ?? process.env.SCRATCHPAD_CWD ?? process.env.HOME;
}

function ago(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 60 / 24)}d ago`;
}

function typedTag() {
  if (state.focus !== "input") return null;
  return partialTag(state.editor.cells.slice(0, state.editor.cursor).join(""));
}

function suggestions() {
  const partial = typedTag();
  if (partial === null) return [];
  return state.labels.filter((name) => name.startsWith(partial) && name !== partial).slice(0, SUGGESTIONS);
}

/* ---------- drawing helpers ---------- */

const DOT = ` ${style.dim("·")} `;

// "key label" pairs, the key bright so the eye finds it first.
function keys(pairs) {
  return pairs.filter(Boolean).map(([key, label]) => `${style.bright(key)} ${style.dim(label)}`).join("  ");
}

function spread(left, right, width) {
  return left + " ".repeat(Math.max(1, width - displayWidth(left) - displayWidth(right))) + right;
}

// Wraps at spaces, so the preview reads like prose. A word wider than the
// column is cut by cells.
function wrapWords(text, width) {
  const out = [];
  for (const line of text.split("\n")) {
    let row = "";
    for (const word of line.split(/(?<= )/)) {
      if (row && displayWidth(row + word.trimEnd()) > width) {
        out.push(row.trimEnd());
        row = "";
      }
      if (displayWidth(word.trimEnd()) > width) {
        const pieces = new Editor(word).layout(width).rows;
        out.push(...pieces.slice(0, -1));
        row = pieces[pieces.length - 1];
      } else {
        row += word;
      }
    }
    out.push(row.trimEnd());
  }
  return out;
}

const tags = (names) => names.map((name) => tint(`#${name}`)).join(" ");
const colourTags = (line) => line.replace(/(^|\s)(#[\p{L}\p{N}][\p{L}\p{N}_-]*)/gu, (_, gap, tag) => gap + tint(tag));

/* ---------- main screen ---------- */

function tabRow(width) {
  const row = TABS.map((tab, i) => {
    const text = `${tab.label} ${state.counts[i] ?? 0}`;
    return i === state.tab ? style.selected(` ${text} `) : ` ${style.dim(text)} `;
  }).join(" ");
  return spread(row, style.dim("tab ⇄"), width);
}

function inputBlock(lines, top, width) {
  const focused = state.focus === "input";
  const marker = state.editing ? style.accent("✎ ") : style.accent("› ");
  if (state.editor.text === "") {
    lines[top] = `${marker}${style.dim(state.editing ? "" : "write a note… add #labels to group it")}`;
    return { used: 1, caret: focused ? { row: top, col: 2 } : null };
  }
  const { rows, caret } = state.editor.layout(width - 2);
  const shown = Math.min(MAX_INPUT_ROWS, rows.length);
  const first = Math.max(0, Math.min(caret.row - shown + 1, rows.length - shown));
  for (let i = 0; i < shown; i += 1) {
    const text = colourTags(rows[first + i]);
    lines[top + i] = (i === 0 ? marker : "  ") + (focused ? text : style.dim(text));
  }
  return { used: shown, caret: focused ? { row: top + caret.row - first, col: 2 + caret.col } : null };
}

// Under the box: label completions while one is being typed, otherwise where
// the note will be saved.
function inputInfo(width) {
  const found = suggestions();
  if (found.length) return `  ${tags(found)}  ${style.dim("tab completes")}`;
  if (state.editing) return style.dim(`  editing ${state.editing}`);
  const where = state.anywhere ? "anywhere" : shortenPath(here.folder, width - 40);
  const toggle = here.folder ? style.dim(` · ctrl+g ${state.anywhere ? "this folder" : "anywhere"}`) : "";
  return `  ${style.dim("saves to")} ${style.accent(where)}${toggle}`;
}

// The left column: label headings with their notes underneath.
function listLines(width) {
  const rows = [];
  let selectedRow = 0;
  for (const g of state.groups) {
    if (rows.length) rows.push("");
    const name = g.name === null ? style.dim("no label") : tint(g.name);
    rows.push(`${name} ${style.dim(`· ${g.notes.length}`)}`);
    for (const note of g.notes) {
      const selected = note === current();
      if (selected) selectedRow = rows.length;
      const marker = selected ? (state.focus === "list" ? style.accent("›") : style.dim("›")) : " ";
      const tick = state.ticked.has(note.id) ? style.accent("●") : " ";
      const text = truncate(title(note.text), width - 3);
      rows.push(`${marker}${tick} ${selected && state.focus === "list" ? style.bright(text) : text}`);
    }
  }
  return { rows, selectedRow };
}

function previewLines(note, width) {
  if (!note) return [];
  const names = labels(note.text);
  const out = [spread(names.length ? tags(names) : style.dim("no label"), style.dim(ago(note.created)), width), ""];
  for (const line of wrapWords(note.text, width)) out.push(colourTags(line));
  out.push("");

  const src = note.source ?? {};
  const from = [src.agent, src.title && `"${src.title}"`, src.branch].filter(Boolean).join(" · ");
  out.push(style.dim(from ? `from ${from}` : "written outside an agent"));
  if (TABS[state.tab].id !== "here") out.push(style.dim(`in ${note.folders?.[0] ? shortenPath(note.folders[0], width - 3) : "no folder"}`));
  for (const sent of note.sent ?? []) out.push(style.dim(`sent to ${sent.agent ?? sent.pane} ${ago(sent.at)}`));
  if (note.done) out.push(style.ok(`done ${ago(note.done)}`));
  return out;
}

function emptyLines() {
  if (TABS[state.tab].id === "done") return [style.dim("Nothing finished yet."), "", style.dim("ctrl+x on a note marks it done.")];
  return [
    style.dim("No notes here yet."),
    "",
    style.dim("Write one above and press ⏎."),
    style.dim("Add #labels to group notes, e.g. #release."),
    ...(TABS[state.tab].id === "here" ? ["", style.dim("tab shows notes from every folder.")] : []),
  ];
}

function hintRow() {
  if (state.notice) return style.warn(state.notice);
  if (state.confirmDelete) return style.warn(`ctrl+d again deletes ${plural(targets().length, "note")} · any other key keeps them`);
  if (state.focus === "input") {
    if (suggestions().length) return keys([["tab", "complete label"], ["⏎", "save"], ["esc", "close"]]);
    if (state.editing) return keys([["⏎", "save"], ["shift+⏎", "new line"], ["esc", "cancel"]]);
    return keys([["⏎", "save"], ["shift+⏎", "new line"], state.notes.length && ["↓", "notes"], ["esc", "close"]]);
  }
  const src = current()?.source ?? {};
  return keys([
    ["⏎", "edit"],
    ["space", "tick"],
    ["ctrl+n", "new agent"],
    ["ctrl+r", "send"],
    ["ctrl+x", current()?.done ? "reopen" : "done"],
    ["ctrl+d", "delete"],
    src.session && RESUME_ARGS[src.agent] && ["ctrl+o", "session"],
  ]);
}

function mainBody(width, rows) {
  const lines = new Array(rows).fill("");
  lines[0] = tabRow(width);
  const input = inputBlock(lines, 2, width);
  lines[2 + input.used] = inputInfo(width);

  const top = 2 + input.used + 2;
  const height = rows - top - 2;
  lines[top - 1] = style.dim("─".repeat(width));
  lines[rows - 2] = style.dim("─".repeat(width));
  lines[rows - 1] = hintRow();

  if (!state.notes.length) {
    emptyLines().forEach((line, i) => { if (i < height) lines[top + i] = `  ${line}`; });
    return { lines, caret: input.caret };
  }

  const leftWidth = Math.max(26, Math.min(44, Math.round(width * 0.4)));
  const rightWidth = width - leftWidth - 3;
  const list = listLines(leftWidth);
  const first = Math.max(0, Math.min(list.selectedRow - Math.floor(height / 2), list.rows.length - height));
  const preview = previewLines(current(), rightWidth);
  if (preview.length > height) preview.splice(height - 1, preview.length, style.dim("…"));

  for (let i = 0; i < height; i += 1) {
    const left = pad(truncate(list.rows[first + i] ?? "", leftWidth), leftWidth);
    lines[top + i] = `${left} ${style.dim("│")} ${preview[i] ?? ""}`;
  }
  return { lines, caret: input.caret };
}

/* ---------- start an agent ---------- */

function chipRow(width) {
  const row = chips.map((item, i) => {
    const label = i < 9 ? `${i + 1} ${item.kind}` : item.kind;
    if (i === state.agent) return style.selected(` ${label} `);
    return ` ${i < 9 ? style.dim(`${i + 1} `) : ""}${item.kind} `;
  }).join(" ");
  return spread(row, style.dim("1-9"), width);
}

function launchBody(width, rows) {
  const lines = new Array(rows).fill("");
  const notes = targets();
  lines[0] = `${style.bold("Start an agent")} ${style.dim("with")} ${style.accent(plural(notes.length, "note"))}`;
  lines[2] = chipRow(width);
  lines[3] = `${style.dim("opens in")} ${DESTINATIONS[state.destination].label} ${style.dim("(ctrl+t)")}${DOT}${shortenPath(launchDirectory(notes), width - 40)}`;
  lines[5] = style.dim(`─ the prompt it gets ${"─".repeat(Math.max(0, width - 21))}`);
  const prompt = wrapWords(compose(notes), width - 2);
  const room = rows - 9;
  prompt.slice(0, room).forEach((line, i) => { lines[6 + i] = `  ${style.dim(line)}`; });
  if (prompt.length > room) lines[6 + room] = style.dim("  …");
  lines[rows - 2] = style.dim("─".repeat(width));
  lines[rows - 1] = keys([["⏎", "start"], ["1-9", "agent"], ["ctrl+t", "where"], ["esc", "back"]]);
  return { lines };
}

function onLaunchKey(chunk, key) {
  const digit = /^\x1b?([1-9])$/.exec(chunk ?? "");
  if (digit && Number(digit[1]) <= chips.length) state.agent = Number(digit[1]) - 1;
  else if (key.name === "left") state.agent = (state.agent - 1 + chips.length) % chips.length;
  else if (key.name === "right" || key.name === "tab") state.agent = (state.agent + 1) % chips.length;
  else if (key.ctrl && key.name === "t") state.destination = (state.destination + 1) % DESTINATIONS.length;
  else if (key.name === "return") launch();
}

/* ---------- send to a running agent ---------- */

function runningMatches() {
  const { agents: list, filter } = state.sheet;
  return filter ? list.filter((a) => matches(a, filter)) : list;
}

// Agents working in the notes' folder first, then running.js's order: the
// ones waiting on you before the busy ones.
function openRunning() {
  const folder = launchDirectory(targets());
  const near = (a) => a.cwd === folder || a.cwd.startsWith(`${folder}${path.sep}`);
  const list = runningAgents().sort((a, b) => Number(near(b)) - Number(near(a)));
  if (!list.length) {
    state.notice = "no agents running · ctrl+n starts one";
    return;
  }
  state.sheet = { type: "running", agents: list, index: 0, filter: "" };
}

function runningBody(width, rows) {
  const lines = new Array(rows).fill("");
  const { filter, index } = state.sheet;
  const list = runningMatches();
  lines[0] = `${style.bold("Send")} ${style.accent(plural(targets().length, "note"))} ${style.bold("to a running agent")}`;
  lines[2] = `${style.accent("/")} ${filter}${filter ? "" : style.dim("type to filter")}`;
  const room = rows - 6;
  const first = Math.max(0, Math.min(index - room + 1, list.length - room));
  for (let i = 0; i < room && first + i < list.length; i += 1) {
    const agent = list[first + i];
    const active = first + i === index;
    const status = agent.status === "working" ? style.warn(agent.status) : agent.status === "blocked" ? style.dim(agent.status) : style.ok(agent.status);
    const right = `${pad(status, 9)} ${pad(style.dim(shortenPath(agent.cwd, 26)), 26)}`;
    const label = truncate(`${agent.kind} · ${agent.title}`, width - displayWidth(right) - 4);
    lines[4 + i] = `${active ? style.accent("›") : " "} ${pad(active ? style.bright(label) : label, width - displayWidth(right) - 2)}${right}`;
  }
  if (!list.length) lines[4] = style.dim("  no running agents match");
  lines[rows - 2] = style.dim("─".repeat(width));
  lines[rows - 1] = state.notice ? style.warn(state.notice) : keys([["⏎", "send"], ["↑↓", "pick"], ["esc", "back"]]) + style.dim("   a busy agent gets it after its turn");
  return { lines, caret: { row: 2, col: 2 + displayWidth(filter) } };
}

function onRunningKey(chunk, key) {
  const sheet = state.sheet;
  const list = runningMatches();
  if (key.name === "up") sheet.index = Math.max(0, sheet.index - 1);
  else if (key.name === "down") sheet.index = Math.min(list.length - 1, sheet.index + 1);
  else if (key.name === "backspace") sheet.filter = sheet.filter.slice(0, -1);
  else if (key.name === "return") {
    const agent = list[sheet.index];
    if (!agent) return;
    if (agent.status === "blocked") {
      state.notice = "that agent is waiting on a question; answer it first";
      return;
    }
    dispatch({ type: "send", target: agent.target, title: agent.title, kind: agent.kind, notes: targets().map((n) => n.id) });
  } else if (isPrintable(chunk, key)) {
    sheet.filter += chunk;
    sheet.index = 0;
  }
}

/* ---------- keys on the main screen ---------- */

function onInputKey(chunk, key) {
  if (key.name === "tab" && !key.shift && suggestions().length) {
    state.editor.insert(`${suggestions()[0].slice(typedTag().length)} `);
    return;
  }
  if (key.name === "tab") return switchTab(key.shift ? -1 : 1);
  if (key.name === "return" && !isNewline(chunk, key)) return save();
  if (isNewline(chunk, key)) return state.editor.insert("\n");
  if (key.ctrl && key.name === "g" && here.folder && !state.editing) {
    state.anywhere = !state.anywhere;
    return;
  }
  if (key.ctrl && key.name === "v") {
    const text = readClipboard();
    if (text) state.editor.insert(text);
    else state.notice = text === null ? "no clipboard tool found" : "clipboard is empty";
    return;
  }
  if (key.name === "up") return state.editor.moveVertical(-1, ui.width() - 2);
  if (key.name === "down") {
    if (state.editor.moveVertical(1, ui.width() - 2) || !state.notes.length || state.editing) return;
    state.focus = "list";
    return;
  }
  editKey(state.editor, chunk, key);
}

function save() {
  if (state.editor.isEmpty) {
    state.notice = state.editing ? "a note needs some text · esc cancels" : "write something first";
    return;
  }
  try {
    if (state.editing) {
      store.edit(state.editing, state.editor.text);
      state.notice = "saved";
      state.editing = null;
      state.focus = "list";
      state.editor = new Editor(state.stash);
      reload();
    } else {
      const note = store.add({ text: state.editor.text, folders: state.anywhere ? [] : [here.folder], source: here.source });
      writeFile(DRAFT, "");
      state.editor = new Editor("");
      reload();
      state.index = Math.max(0, state.notes.findIndex((n) => n.id === note.id));
      state.notice = `saved to ${state.anywhere ? "anywhere" : shortenPath(here.folder, 40)}`;
    }
  } catch (error) {
    state.notice = error.message;
  }
}

function onListKey(chunk, key) {
  if (state.confirmDelete) {
    state.confirmDelete = false;
    if (key.ctrl && key.name === "d") {
      const notes = targets();
      for (const note of notes) store.remove(note.id);
      state.ticked.clear();
      state.notice = `deleted ${plural(notes.length, "note")}`;
      reload();
    }
    return;
  }
  switch (true) {
    case key.name === "tab":
      switchTab(key.shift ? -1 : 1);
      break;
    case key.name === "up":
      if (state.index === 0) state.focus = "input";
      else state.index -= 1;
      break;
    case key.name === "down":
      state.index = Math.min(state.notes.length - 1, state.index + 1);
      break;
    case chunk === " ":
      if (state.ticked.has(current().id)) state.ticked.delete(current().id);
      else state.ticked.add(current().id);
      state.index = Math.min(state.notes.length - 1, state.index + 1);
      break;
    case key.name === "return":
      state.stash = state.editor.text;
      state.editing = current().id;
      state.editor = new Editor(current().text);
      state.focus = "input";
      break;
    case key.ctrl && key.name === "x":
      toggleDone(targets());
      break;
    case key.ctrl && key.name === "d":
      state.confirmDelete = true;
      break;
    case key.ctrl && key.name === "n":
      state.sheet = { type: "launch" };
      break;
    case key.ctrl && key.name === "r":
      openRunning();
      break;
    case key.ctrl && key.name === "o":
      resume(current());
      break;
    // Typing anywhere writes a note.
    case isPrintable(chunk, key):
      state.focus = "input";
      state.editor.insert(chunk);
      break;
    default:
      break;
  }
}

function switchTab(step) {
  state.tab = (state.tab + step + TABS.length) % TABS.length;
  state.index = 0;
  state.ticked.clear();
  reload();
}

function toggleDone(notes) {
  const finish = notes.some((n) => !n.done);
  for (const note of notes) store.setDone(note.id, finish);
  state.ticked.clear();
  state.notice = `${finish ? "done" : "reopened"}: ${plural(notes.length, "note")}`;
  reload();
}

/* ---------- handing off ---------- */

function launch() {
  const kind = chips[state.agent].kind;
  const destination = DESTINATIONS[state.destination].id;
  writeFile(PREFS, JSON.stringify({ ...prefs, kind, destination }));
  const notes = targets();
  dispatch({ type: "launch", kind, destination, cwd: launchDirectory(notes), workspace, pane: originPane, notes: notes.map((n) => n.id) });
}

function resume(note) {
  const src = note?.source ?? {};
  if (!src.session || !RESUME_ARGS[src.agent]) {
    state.notice = src.agent ? `cannot reopen a ${src.agent} session` : "this note was not written beside an agent";
    return;
  }
  dispatch({
    type: "resume",
    kind: src.agent,
    args: RESUME_ARGS[src.agent](src.session),
    destination: DESTINATIONS[state.destination].id,
    cwd: src.cwd ?? note.folders?.[0],
    workspace,
    pane: originPane,
  });
}

// The worker runs after the popup has closed, so it never waits on an agent.
function dispatch(request) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, `request-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
  spawnDetached(process.execPath, [LAUNCHER, file]);
  const unsaved = state.editing ? state.stash : state.editor.text;
  writeFile(DRAFT, unsaved.trim() ? unsaved : "");
  ui.quit(0);
}

const SHEETS = {
  launch: { body: launchBody, key: onLaunchKey },
  running: { body: runningBody, key: onRunningKey },
};

function onKey(chunk, key) {
  state.notice = null;
  if (state.sheet) return SHEETS[state.sheet.type].key(chunk, key);
  if (state.focus === "list") return onListKey(chunk, key);
  return onInputKey(chunk, key);
}

// Out of whatever you are in, one step at a time. Closing keeps an unsaved
// note for next time.
function onEscape() {
  state.notice = null;
  state.confirmDelete = false;
  if (state.sheet) {
    state.sheet = null;
  } else if (state.editing) {
    state.editing = null;
    state.editor = new Editor(state.stash);
    state.focus = "list";
  } else if (state.focus === "list") {
    state.focus = "input";
  } else {
    writeFile(DRAFT, state.editor.text.trim() ? state.editor.text : "");
    ui.quit(0);
  }
}

function onPaste(text) {
  if (state.sheet?.type === "running") {
    state.sheet.filter += text.replace(/\n/g, " ");
    return;
  }
  if (state.sheet) return;
  state.focus = "input";
  state.editor.insert(text);
}

reload();
const ui = start({
  name: "popup",
  body: (width, rows) => (state.sheet ? SHEETS[state.sheet.type].body(width, rows) : mainBody(width, rows)),
  onKey,
  onPaste,
  onEscape,
});
