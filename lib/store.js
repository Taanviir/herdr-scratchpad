"use strict";

// The notes themselves: one JSON object per line, outside the plugin's state directory,
// because agents in ordinary panes read and write it through bin/scratch.js and
// never see HERDR_PLUGIN_STATE_DIR.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

function home() {
  if (process.env.SCRATCHPAD_HOME) return process.env.SCRATCHPAD_HOME;
  const data = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(data, "herdr-scratchpad");
}

const file = () => path.join(home(), "notes.jsonl");

// A line that does not parse costs that one note, not the whole scratchpad.
// It is kept as it is, so the next write does not delete it either.
function readLines() {
  let text;
  try {
    text = fs.readFileSync(file(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`cannot read ${file()}: ${error.message}`);
  }
  return text.split("\n").filter((line) => line.trim()).map((line) => {
    try {
      const note = JSON.parse(line);
      return valid(note) ? { note } : { raw: line };
    } catch {
      return { raw: line };
    }
  });
}

function readAll() {
  return readLines().filter((entry) => entry.note).map((entry) => entry.note);
}

const valid = (note) => note && typeof note.id === "string" && typeof note.text === "string";

// Write to a sibling and rename, so a reader never sees half a file.
function writeAll(notes, unreadable = []) {
  fs.mkdirSync(home(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  const lines = [...notes.map((note) => JSON.stringify(note)), ...unreadable];
  fs.writeFileSync(tmp, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
  fs.renameSync(tmp, file());
}

// The popup and any number of agents can write at once, so every change is a
// read-modify-write under a lock directory. A lock older than STALE_LOCK_MS
// belongs to a process that died holding it.
const LOCK_WAIT_MS = 2000;
const STALE_LOCK_MS = 10000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(fn) {
  fs.mkdirSync(home(), { recursive: true });
  const lock = path.join(home(), "notes.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (fs.statSync(lock).mtimeMs < Date.now() - STALE_LOCK_MS) fs.rmdirSync(lock);
      } catch { /* released between the two calls */ }
      if (Date.now() > deadline) throw new Error(`notes are locked (${lock})`);
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lock); } catch { /* already gone */ }
  }
}

function update(fn) {
  return withLock(() => {
    const lines = readLines();
    const notes = lines.filter((entry) => entry.note).map((entry) => entry.note);
    const result = fn(notes);
    writeAll(notes, lines.filter((entry) => entry.raw).map((entry) => entry.raw));
    return result;
  });
}

function newId(taken) {
  for (;;) {
    const id = crypto.randomBytes(3).toString("hex");
    if (!taken.has(id)) return id;
  }
}

function add({ text, folders = [], source = null, due = null }) {
  const body = String(text).trim();
  if (!body) throw new Error("a note needs some text");
  return update((notes) => {
    const now = new Date().toISOString();
    const note = { id: newId(new Set(notes.map((n) => n.id))), text: body, folders, source, created: now, updated: now, due, done: null };
    notes.push(note);
    return note;
  });
}

// Ids are short, so a unique prefix is accepted the way git accepts one.
function find(notes, id) {
  const exact = notes.find((n) => n.id === id);
  if (exact) return exact;
  const hits = notes.filter((n) => n.id.startsWith(id));
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? `"${id}" matches ${hits.length} notes` : `no note "${id}"`);
}

function change(id, fn) {
  return update((notes) => {
    const note = find(notes, id);
    fn(note);
    note.updated = new Date().toISOString();
    return note;
  });
}

function edit(id, text) {
  const body = String(text).trim();
  if (!body) throw new Error("a note needs some text");
  return change(id, (note) => { note.text = body; });
}
const setDone = (id, done = true) => change(id, (note) => { note.done = done ? new Date().toISOString() : null; });
const setDue = (id, due) => change(id, (note) => { note.due = due; });

function remove(id) {
  return update((notes) => {
    const note = find(notes, id);
    notes.splice(notes.indexOf(note), 1);
    return note;
  });
}

const get = (id) => find(readAll(), id);

module.exports = { home, file, readAll, add, get, edit, setDone, setDue, remove };
