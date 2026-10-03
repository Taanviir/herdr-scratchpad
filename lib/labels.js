"use strict";

// A label is a #hashtag anywhere in a note, so labelling costs no extra key
// and agents label notes the same way: `scratch add "... #bug"`.

const TAG = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

function labels(text) {
  const found = [];
  for (const match of String(text).matchAll(TAG)) {
    const name = match[2].toLowerCase();
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

// The first line without its tags, which the list shows under the label
// heading anyway.
function title(text) {
  const first = String(text).split("\n").find((line) => line.trim()) ?? "";
  return first.replace(TAG, "$1").replace(/\s+/g, " ").trim() || first.trim();
}

// Every label in use, the most used first, for completing a half-typed tag.
function known(notes) {
  const counts = new Map();
  for (const note of notes) for (const name of labels(note.text)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

// Notes under their first label, the biggest group first, unlabelled last.
function group(notes) {
  const groups = new Map();
  for (const note of notes) {
    const name = labels(note.text)[0] ?? null;
    groups.set(name, [...(groups.get(name) ?? []), note]);
  }
  return [...groups]
    .map(([name, items]) => ({ name, notes: items }))
    .sort((a, b) => (a.name === null) - (b.name === null) || b.notes.length - a.notes.length || String(a.name).localeCompare(String(b.name)));
}

// The tag being typed just before the caret, if there is one.
function partialTag(textBeforeCaret) {
  const match = /(?:^|\s)#([\p{L}\p{N}_-]*)$/u.exec(textBeforeCaret);
  return match ? match[1].toLowerCase() : null;
}

module.exports = { labels, title, known, group, partialTag };
