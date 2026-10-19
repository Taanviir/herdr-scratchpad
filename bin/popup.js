"use strict";

// The one popup, with two screens. It opens on an empty page for writing,
// because a note is what you usually came for. tab turns to the notes: grouped
// by label on the left, the selected one in full on the right.

const fs = require("node:fs");
const path = require("node:path");
const store = require("../lib/store");
const { describe, relatedTo } = require("../lib/source");
const { Editor } = require("../lib/editor");
const { style, tint, pad, truncate, shortenPath, displayWidth } = require("../lib/ui");
const { compose } = require("../lib/brief");
const { labels, title, known, group, partialTag } = require("../lib/labels");
const when = require("../lib/when");
const { run, spawnDetached } = require("../lib/herdr");
const { readClipboard } = require("../lib/clipboard");
const { sanitizePasted } = require("../lib/text");
const { relink } = require("../lib/link");
const { STATE_DIR, start, isNewline, isPrintable, editKey } = require("../lib/term");

const LAUNCHER = path.join(__dirname, "launch.js");
const DRAFT = path.join(STATE_DIR, "draft.txt");

// Claude Code and Codex are the agents that take a session id on the command line.
const RESUME_ARGS = {
  claude: (id) => ["--resume", id],
  codex: (id) => ["resume", id],
};

const SUGGESTIONS = 6;

const originPane = process.env.SCRATCHPAD_PANE;
const workspace = process.env.SCRATCHPAD_WORKSPACE;
const here = describe({ paneId: originPane, cwd: process.env.SCRATCHPAD_CWD });

const TABS = [
  here.folder && { id: "here", label: "This folder", show: (n) => !n.done && relatedTo(n, here.folder) },
  { id: "all", label: "All", show: (n) => !n.done },
  { id: "done", label: "Done", show: (n) => Boolean(n.done) },
].filter(Boolean);

function writeFile(file, text) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (text) fs.writeFileSync(file, text, { mode: 0o600 });
    else fs.rmSync(file, { force: true });
  } catch { /* a preference or a draft is not worth failing over */ }
}

let draft = "";
try { draft = fs.readFileSync(DRAFT, "utf8"); } catch { /* none */ }
const selection = process.env.SCRATCHPAD_SELECTION ?? "";

const state = {
  tab: 0,
  screen: "write", // write | notes
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
  sheet: null, // { type: "when", input } while setting a date
  confirmDelete: false,
  notice: draft ? "restored your draft · ctrl+u clears it" : selection ? "started from your selection" : null,
};

// The notes file is shared with agents, so a note can vanish or the file be
// locked while the popup is open. That is a notice, not a crash.
function attempt(change) {
  try {
    change();
    return true;
  } catch (error) {
    state.notice = error.message;
    reload();
    return false;
  }
}

function reload() {
  const all = store.readAll().sort((a, b) => b.created.localeCompare(a.created));
  state.counts = TABS.map((tab) => all.filter(tab.show).length);
  state.labels = known(all);
  // Open notes with a date sit above the labels, soonest first.
  const shown = all.filter(TABS[state.tab].show);
  const dated = shown.filter((n) => n.due && !n.done).sort((a, b) => a.due.localeCompare(b.due));
  state.groups = [
    ...(dated.length ? [{ name: "upcoming", upcoming: true, notes: dated }] : []),
    ...group(shown.filter((n) => !dated.includes(n))),
  ];
  state.notes = state.groups.flatMap((g) => g.notes);
  const ids = new Set(state.notes.map((n) => n.id));
  for (const id of state.ticked) if (!ids.has(id)) state.ticked.delete(id);
  state.index = Math.max(0, Math.min(state.index, state.notes.length - 1));
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
  if (state.screen !== "write") return null;
  return partialTag(state.editor.cells.slice(0, state.editor.cursor).join(""));
}

function suggestions() {
  const partial = typedTag();
  if (partial === null) return [];
  return state.labels.filter((name) => name.startsWith(partial) && name !== partial).slice(0, SUGGESTIONS);
}

/* ---------- drawing helpers ---------- */

const DOT = ` ${style.dim("·")} `;

// "key label" pairs, the key bright so the eye finds it first. Pairs come
// most useful first, and those that do not fit in `width` are left off.
function keys(pairs, width = Infinity) {
  const shown = [];
  let used = 0;
  for (const [key, label] of pairs.filter(Boolean)) {
    const size = displayWidth(`${key} ${label}`) + (shown.length ? 2 : 0);
    if (used + size > width) break;
    shown.push(`${style.bright(key)} ${style.dim(label)}`);
    used += size;
  }
  return shown.join("  ");
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

function dueText(iso, text) {
  const level = when.urgency(iso);
  return level === "overdue" ? style.danger(text) : level === "today" ? style.warn(text) : style.accent(text);
}

const tags = (names) => names.map((name) => tint(`#${name}`)).join(" ");
const colourTags = (line) => line.replace(/(^|\s)(#[\p{L}\p{N}][\p{L}\p{N}_-]*)/gu, (_, gap, tag) => gap + tint(tag));

/* ---------- writing ---------- */

function writeHeader(width) {
  if (state.editing) return spread(style.bold("Edit note"), style.dim(state.editing), width);
  const where = state.anywhere ? "anywhere" : shortenPath(here.folder, width - 40);
  const toggle = here.folder ? style.dim(` · ctrl+g ${state.anywhere ? "this folder" : "anywhere"}`) : "";
  return spread(style.bold("New note"), `${style.dim("saves to")} ${style.accent(where)}${toggle}`, width);
}

function noteBox(lines, top, width, height) {
  const marker = state.editing ? style.accent("✎ ") : style.accent("› ");
  if (state.editor.text === "") {
    lines[top] = `${marker}${style.dim(state.editing ? "" : "write a note… add #labels to group it")}`;
    return { row: top, col: 2 };
  }
  const { rows, caret } = state.editor.layout(width - 2);
  const shown = Math.min(height, rows.length);
  const first = Math.max(0, Math.min(caret.row - shown + 1, rows.length - shown));
  for (let i = 0; i < shown; i += 1) lines[top + i] = (i === 0 ? marker : "  ") + colourTags(rows[first + i]);
  return { row: top + caret.row - first, col: 2 + caret.col };
}

function writeHints() {
  if (state.notice) return style.warn(state.notice);
  if (suggestions().length) return keys([["tab", "complete label"], ["⏎", "save"], ["esc", state.editing ? "cancel" : "close"]]);
  if (state.editing) return keys([["⏎", "save"], ["\\⏎", "new line"], ["esc", "cancel"]]);
  return keys([["⏎", "save"], ["\\⏎", "new line"], ["tab", `notes ${state.counts[state.tab] ?? 0}`], ["esc", "close"]]);
}

function writeBody(width, rows) {
  const lines = new Array(rows).fill("");
  lines[0] = writeHeader(width);
  const caret = noteBox(lines, 2, width, rows - 6);
  const found = suggestions();
  if (found.length) lines[rows - 3] = `  ${tags(found)}  ${style.dim("tab completes")}`;
  lines[rows - 2] = style.dim("─".repeat(width));
  lines[rows - 1] = writeHints();
  return { lines, caret };
}

/* ---------- the notes ---------- */

function tabRow(width) {
  const row = TABS.map((tab, i) => {
    const text = `${tab.label} ${state.counts[i] ?? 0}`;
    return i === state.tab ? style.selected(` ${text} `) : ` ${style.dim(text)} `;
  }).join(" ");
  return spread(row, style.dim("← →"), width);
}

// The left column: label headings with their notes underneath.
function listLines(width) {
  const rows = [];
  let selectedRow = 0;
  for (const g of state.groups) {
    if (rows.length) rows.push("");
    const name = g.upcoming ? style.bold("upcoming") : g.name === null ? style.dim("no label") : tint(g.name);
    rows.push(`${name} ${style.dim(`· ${g.notes.length}`)}`);
    for (const note of g.notes) {
      const selected = note === current();
      if (selected) selectedRow = rows.length;
      const marker = selected ? style.accent("›") : " ";
      const tick = state.ticked.has(note.id) ? style.accent("●") : " ";
      const date = g.upcoming ? when.short(note.due) : "";
      const text = truncate(title(note.text), width - 3 - (date ? date.length + 1 : 0));
      const head = `${marker}${tick} ${selected ? style.bright(text) : text}`;
      rows.push(date ? spread(head, dueText(note.due, date), width) : head);
    }
  }
  return { rows, selectedRow };
}

function previewLines(note, width) {
  if (!note) return [];
  const names = labels(note.text);
  const out = [spread(names.length ? tags(names) : style.dim("no label"), style.dim(ago(note.created)), width)];
  if (note.due && !note.done) out.push(dueText(note.due, `due ${when.long(note.due)}`));
  out.push("");
  for (const line of wrapWords(note.text, width)) out.push(colourTags(line));
  out.push("");

  const src = note.source ?? {};
  const from = [src.agent, src.title && `"${src.title}"`, src.branch].filter(Boolean).join(" · ");
  out.push(style.dim(from ? `from ${from}` : "written outside an agent"));
  if (TABS[state.tab].id !== "here") out.push(style.dim(`in ${note.folders?.[0] ? shortenPath(note.folders[0], width - 3) : "no folder"}`));
  if (note.done) out.push(style.ok(`done ${ago(note.done)}`));
  return out;
}

function emptyLines() {
  if (TABS[state.tab].id === "done") return [style.dim("Nothing finished yet."), "", style.dim("ctrl+x on a note marks it done.")];
  return [
    style.dim("No notes here yet."),
    "",
    style.dim("tab goes back to write one."),
    style.dim("Add #labels to group notes, e.g. #release."),
    ...(TABS[state.tab].id === "here" ? ["", style.dim("→ shows notes from every folder.")] : []),
  ];
}

function notesHints(width) {
  if (state.notice) return style.warn(state.notice);
  if (state.confirmDelete) return style.warn(`ctrl+d again deletes ${plural(targets().length, "note")} · any other key keeps them`);
  if (!current()) return keys([["tab", "write"], ["← →", "folders"], ["esc", "close"]]);
  const src = current().source ?? {};
  return keys([
    ["tab", "write"],
    ["⏎", "edit"],
    ["ctrl+n", "agent"],
    src.session && RESUME_ARGS[src.agent] && ["ctrl+o", "session"],
    ["ctrl+x", current().done ? "reopen" : "done"],
    ["ctrl+w", "when"],
    ["ctrl+d", "delete"],
    ["space", "tick"],
  ], width);
}

function notesBody(width, rows) {
  const lines = new Array(rows).fill("");
  lines[0] = tabRow(width);
  lines[1] = style.dim("─".repeat(width));
  lines[rows - 2] = style.dim("─".repeat(width));
  lines[rows - 1] = notesHints(width);
  const top = 2;
  const height = rows - top - 2;

  if (!state.notes.length) {
    emptyLines().forEach((line, i) => { if (i + 1 < height) lines[top + 1 + i] = `  ${line}`; });
    return { lines, caret: null };
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
  return { lines, caret: null };
}

/* ---------- set a date ---------- */

const WHEN_EXAMPLES = ["today 5pm", "tonight", "tomorrow", "fri 14:00", "next week", "in 2h", "in 3 days", "oct 12", "2026-10-12 9:30"];

function whenBody(width, rows) {
  const lines = new Array(rows).fill("");
  const notes = targets();
  const subject = notes.length === 1 ? `"${truncate(title(notes[0].text), width - 20)}"` : plural(notes.length, "note");
  lines[0] = `${style.bold("When is")} ${style.accent(subject)} ${style.bold("due?")}`;
  const field = state.sheet.input.viewport(width - 2);
  lines[2] = `${style.accent("› ")}${field.text}${field.text ? "" : style.dim("e.g. tomorrow 9am")}`;

  const text = state.sheet.input.text;
  const date = when.parse(text);
  const existing = notes.length === 1 && notes[0].due;
  if (date) lines[3] = `  ${dueText(date.toISOString(), `→ ${when.long(date.toISOString())}`)}`;
  else if (text.trim()) lines[3] = style.dim("  → not a date yet");
  else if (existing) lines[3] = style.dim(`  now due ${when.long(existing)} · ⏎ on an empty line clears it`);

  lines[5] = style.dim("  try:");
  const rowsOfExamples = [[]];
  for (const example of WHEN_EXAMPLES) {
    const row = rowsOfExamples[rowsOfExamples.length - 1];
    if (row.length && displayWidth([...row, example].join(" · ")) > width - 4) rowsOfExamples.push([example]);
    else row.push(example);
  }
  rowsOfExamples.forEach((row, i) => { lines[6 + i] = `  ${row.join(DOT)}`; });

  lines[rows - 2] = style.dim("─".repeat(width));
  lines[rows - 1] = state.notice ? style.warn(state.notice) : keys([["⏎", text.trim() ? "set" : existing ? "clear date" : "set"], ["esc", "back"]]);
  return { lines, caret: { row: 2, col: 2 + field.col } };
}

function onWhenKey(chunk, key) {
  const input = state.sheet.input;
  if (key.name !== "return") return editKey(input, chunk, key);

  const text = input.text.trim();
  const date = text ? when.parse(text) : null;
  if (text && !date) {
    state.notice = `"${text}" is not a date I can read`;
    return;
  }
  const notes = targets();
  const due = date ? date.toISOString() : null;
  if (!attempt(() => notes.forEach((note) => store.setDue(note.id, due)))) return;
  state.sheet = null;
  state.ticked.clear();
  reload();
  state.index = Math.max(0, state.notes.findIndex((n) => n.id === notes[0].id));
  state.notice = due ? `due ${when.short(due)}: ${plural(notes.length, "note")}` : `date cleared: ${plural(notes.length, "note")}`;
}

/* ---------- keys ---------- */

function onWriteKey(chunk, key) {
  if (key.name === "tab" && !key.shift && suggestions().length) {
    state.editor.insert(`${suggestions()[0].slice(typedTag().length)} `);
    return;
  }
  if (key.name === "tab") {
    if (!state.editing) state.screen = "notes";
    return;
  }
  // Many terminals send shift+⏎ as a plain ⏎, so a backslash before ⏎ also
  // asks for a newline, as in Claude Code and Quick Prompt.
  if (key.name === "return" && !isNewline(chunk, key)) {
    if (state.editor.cells[state.editor.cursor - 1] !== "\\") return save();
    state.editor.backspace();
    return state.editor.insert("\n");
  }
  if (isNewline(chunk, key)) return state.editor.insert("\n");
  if (key.ctrl && key.name === "g" && here.folder && !state.editing) {
    state.anywhere = !state.anywhere;
    return;
  }
  if (key.ctrl && key.name === "v") {
    const text = readClipboard();
    if (text) state.editor.insert(sanitizePasted(text));
    else state.notice = text === null ? "no clipboard tool found" : "clipboard is empty";
    return;
  }
  if (key.name === "up" || key.name === "down") return state.editor.moveVertical(key.name === "up" ? -1 : 1, ui.width() - 2);
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
      state.screen = "notes";
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

function onNotesKey(chunk, key) {
  if (state.confirmDelete) {
    state.confirmDelete = false;
    if (key.ctrl && key.name === "d") {
      const notes = targets();
      if (!attempt(() => notes.forEach((note) => store.remove(note.id)))) return;
      state.ticked.clear();
      state.notice = `deleted ${plural(notes.length, "note")}`;
      reload();
    }
    return;
  }
  // Typing anywhere writes a note, except space, which ticks one.
  if (key.name === "tab" || (isPrintable(chunk, key) && chunk !== " ")) {
    state.screen = "write";
    if (key.name !== "tab") state.editor.insert(chunk);
    return;
  }
  if (key.name === "left" || key.name === "right") return switchTab(key.name === "left" ? -1 : 1);
  if (!current()) return;
  switch (true) {
    case key.name === "up":
      state.index = Math.max(0, state.index - 1);
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
      state.screen = "write";
      break;
    case key.ctrl && key.name === "x":
      toggleDone(targets());
      break;
    case key.ctrl && key.name === "d":
      state.confirmDelete = true;
      break;
    case key.ctrl && key.name === "n":
      handOff();
      break;
    case key.ctrl && key.name === "w":
      state.sheet = { type: "when", input: new Editor("") };
      break;
    case key.ctrl && key.name === "o":
      resume(current());
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
  if (!attempt(() => notes.forEach((note) => store.setDone(note.id, finish)))) return;
  state.ticked.clear();
  state.notice = `${finish ? "done" : "reopened"}: ${plural(notes.length, "note")}`;
  reload();
}

/* ---------- handing off ---------- */

// Quick Prompt already does the rest well: which agent, a tab, split or
// worktree, presets, models, or a follow-up to one already running. The
// notes go over as its prompt, ids included, so the agent can close them.
const QUICK_PROMPT = "taanviir.quick-prompt";

function handOff() {
  const listed = run(["plugin", "list", "--plugin", QUICK_PROMPT, "--json"], { check: false, timeout: 1000 });
  if (!listed.ok || !listed.result.plugins?.some((plugin) => plugin.enabled)) {
    state.notice = "needs Quick Prompt: herdr plugin install Taanviir/herdr-quick-prompt";
    return;
  }
  const notes = targets();
  dispatch({ type: "handoff", prompt: compose(notes), cwd: launchDirectory(notes), workspace, pane: originPane });
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
    cwd: src.cwd ?? note.folders?.[0],
    workspace,
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
  when: { body: whenBody, key: onWhenKey },
};

function onKey(chunk, key) {
  state.notice = null;
  if (state.sheet) return SHEETS[state.sheet.type].key(chunk, key);
  if (state.screen === "notes") return onNotesKey(chunk, key);
  return onWriteKey(chunk, key);
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
    state.screen = "notes";
  } else {
    close();
  }
}

function close() {
  const unsaved = state.editing ? state.stash : state.editor.text;
  writeFile(DRAFT, unsaved.trim() ? unsaved : "");
  ui.quit(0);
}

function onPaste(text) {
  if (state.sheet?.type === "when") {
    state.sheet.input.insert(text.replace(/\n/g, " "));
    return;
  }
  if (state.sheet) return;
  state.screen = "write";
  state.editor.insert(text);
}

reload();
relink();
const ui = start({
  name: "popup",
  body: (width, rows) => {
    if (state.sheet) return SHEETS[state.sheet.type].body(width, rows);
    return state.screen === "notes" ? notesBody(width, rows) : writeBody(width, rows);
  },
  onKey,
  onPaste,
  onEscape,
  onInterrupt: close,
});
