#!/usr/bin/env node
"use strict";

// The scratchpad from a shell, for you and for agents. The setup action links
// this onto PATH as `scratch`.

const fs = require("node:fs");
const store = require("../lib/store");
const { describe, folderFor, relatedTo } = require("../lib/source");
const { shortenPath } = require("../lib/ui");
const { labels } = require("../lib/labels");
const when = require("../lib/when");

const USAGE = `scratch: a global scratchpad of notes, linked to folders

  scratch add <text…>            add a note for this folder (text from stdin with -);
                                 #words in the text are its labels
      --folder DIR                 file it under DIR instead
      --anywhere                   file it under no folder
      --due WHEN                   date it: "tomorrow 9am", "fri", "in 2h", "2026-10-12 14:00"
  scratch list                   open notes for this folder
      --all                        every folder
      --label NAME                 only notes labelled #NAME
      --done                       include finished notes
      --json                       machine-readable
  scratch show <id>              one note, with where it came from
  scratch done <id>…             mark finished
  scratch undo <id>…             mark open again
  scratch edit <id> <text…>      replace the text
  scratch due <id> <when|none>   set or clear its date; dated notes list first
  scratch rm <id>…               delete
  scratch where                  the notes file

Ids can be shortened to any unique prefix.`;

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--folder") flags.folder = argv[++i];
    else if (arg === "--due") flags.due = argv[++i];
    else if (arg === "--label") flags.label = String(argv[++i] ?? "").replace(/^#/, "").toLowerCase();
    else if (arg === "--all" || arg === "--done" || arg === "--json" || arg === "--anywhere") flags[arg.slice(2)] = true;
    else if (arg === "-h" || arg === "--help") flags.help = true;
    else rest.push(arg);
  }
  return { flags, rest };
}

function textFrom(rest) {
  if (rest.length === 1 && rest[0] === "-") return fs.readFileSync(0, "utf8");
  return rest.join(" ");
}

function line(note) {
  const mark = note.done ? "x" : " ";
  const [first, ...more] = note.text.split("\n");
  const extra = more.length ? ` (+${more.length} lines)` : "";
  const due = note.due && !note.done ? `${when.short(note.due)}  ` : "";
  return `[${mark}] ${note.id}  ${due}${first}${extra}`;
}

function readWhen(text) {
  const date = when.parse(text);
  if (!date) throw new Error(`cannot read "${text}" as a date; try "tomorrow 9am", "fri", "in 2h" or "2026-10-12 14:00"`);
  return date.toISOString();
}

// Dated notes first, soonest at the top, the way the popup lists them.
const byDue = (a, b) => (!a.due - !b.due) || (a.due && b.due ? a.due.localeCompare(b.due) : 0);

function cmdDue(rest) {
  const [id, ...words] = rest;
  if (!id || !words.length) throw new Error("scratch due <id> <when|none>");
  const text = words.join(" ");
  const due = /^(none|clear|off|-)$/i.test(text) ? null : readWhen(text);
  const note = store.setDue(id, due);
  console.log(due ? `${note.id} due ${when.long(due)}` : `${note.id} has no date`);
}

function cmdAdd(flags, rest) {
  const text = textFrom(rest);
  const { folder, source } = describe({ paneId: process.env.HERDR_PANE_ID, cwd: process.cwd() });
  const folders = flags.anywhere ? [] : [flags.folder ? folderFor(flags.folder) : folder].filter(Boolean);
  const note = store.add({ text, folders, source, due: flags.due === undefined ? null : readWhen(flags.due) });
  const due = note.due ? `, due ${when.long(note.due)}` : "";
  console.log(`added ${note.id}${folders[0] ? ` to ${shortenPath(folders[0], 60)}` : ""}${due}`);
}

function cmdList(flags) {
  const folder = flags.all ? null : folderFor(flags.folder ?? process.cwd());
  const notes = store.readAll()
    .filter((n) => flags.done || !n.done)
    .filter((n) => relatedTo(n, folder))
    .filter((n) => !flags.label || labels(n.text).includes(flags.label))
    .sort(byDue);
  if (flags.json) return console.log(JSON.stringify(notes, null, 2));
  if (!notes.length) return console.log(folder ? `no open notes for ${shortenPath(folder, 60)} (try --all)` : "no notes");

  if (folder) return notes.forEach((n) => console.log(line(n)));
  const groups = new Map();
  for (const note of notes) {
    const key = note.folders?.[0] ?? "anywhere";
    groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  for (const [key, group] of groups) {
    console.log(key === "anywhere" ? key : shortenPath(key, 70));
    group.forEach((n) => console.log(`  ${line(n)}`));
  }
}

function cmdShow(rest) {
  const note = store.get(rest[0]);
  console.log(`${note.id}${note.done ? " (done)" : ""}\n\n${note.text}\n`);
  const src = note.source ?? {};
  const rows = [
    ["folders", (note.folders ?? []).join(", ") || "anywhere"],
    ["created", note.created],
    ["due", note.due && when.long(note.due)],
    ["branch", src.branch],
    ["agent", src.agent && `${src.agent}${src.session ? ` session ${src.session}` : ""}`],
    ["from", src.title],
  ];
  for (const [label, value] of rows) if (value) console.log(`${label.padEnd(8)} ${value}`);
}

function each(rest, fn, verb) {
  if (!rest.length) throw new Error(`which note? scratch ${verb} <id>`);
  for (const id of rest) console.log(`${verb} ${fn(id).id}`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const { flags, rest } = parse(args);
  if (!command || flags.help || command === "help") return console.log(USAGE);

  switch (command) {
    case "add": return cmdAdd(flags, rest);
    case "list": case "ls": return cmdList(flags);
    case "show": return cmdShow(rest);
    case "done": return each(rest, (id) => store.setDone(id, true), "done");
    case "undo": return each(rest, (id) => store.setDone(id, false), "reopened");
    case "due": return cmdDue(rest);
    case "edit": return console.log(`edited ${store.edit(rest[0], rest.slice(1).join(" ")).id}`);
    case "rm": return each(rest, store.remove, "removed");
    case "where": return console.log(store.file());
    default: throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`scratch: ${error.message}\n`);
  process.exit(1);
}
