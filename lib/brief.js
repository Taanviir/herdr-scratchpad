"use strict";

// The prompt an agent gets when notes are sent to it. The ids go along so the
// agent can close the notes itself with `scratch done` once the work is in.

function compose(notes) {
  if (notes.length === 1 && !notes[0].text.includes("\n")) {
    return `${notes[0].text} (scratchpad note ${notes[0].id}; run \`scratch done ${notes[0].id}\` when it is finished)`;
  }

  const lines = ["From my scratchpad:", ""];
  for (const note of notes) {
    const [first, ...rest] = note.text.split("\n");
    lines.push(`- [${note.id}] ${first}`);
    for (const line of rest) lines.push(`  ${line}`);
    const from = origin(note);
    if (from) lines.push(`  (noted ${from})`);
  }
  lines.push("", "Run `scratch done <id>` for each note once it is finished.");
  return lines.join("\n");
}

function origin(note) {
  const src = note.source ?? {};
  const parts = [];
  if (src.branch) parts.push(`on branch ${src.branch}`);
  if (src.title) parts.push(`while "${src.title}" was running`);
  return parts.join(" ");
}

// The single line shown for a note in the list.
function summary(note) {
  return note.text.split("\n")[0];
}

module.exports = { compose, summary };
