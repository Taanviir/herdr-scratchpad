"use strict";

const { clusters, clusterWidth } = require("./text");

// Minimal text buffer with a cursor, wrapped rendering, and the editing keys a
// prompt box needs. It works in grapheme clusters rather than UTF-16 units, so
// one backspace deletes one visible character even when that character is an
// emoji or a letter with a combining accent.
class Editor {
  constructor(text = "") {
    this.cells = clusters(text);
    this.cursor = this.cells.length;
  }

  get text() {
    return this.cells.join("");
  }

  insert(chunk) {
    this.goalColumn = null;
    const added = clusters(chunk);
    // Spreading a paste into splice's arguments overflows the stack past ~125k.
    this.cells = this.cells.slice(0, this.cursor).concat(added, this.cells.slice(this.cursor));
    this.cursor += added.length;
  }

  backspace() {
    this.goalColumn = null;
    if (this.cursor === 0) return;
    this.cells.splice(this.cursor - 1, 1);
    this.cursor -= 1;
  }

  deleteForward() {
    this.goalColumn = null;
    if (this.cursor >= this.cells.length) return;
    this.cells.splice(this.cursor, 1);
  }

  // A word is a run of non-whitespace, and a word move skips the gap before it.
  wordStart() {
    let at = this.cursor;
    while (at > 0 && /\s/.test(this.cells[at - 1])) at -= 1;
    while (at > 0 && !/\s/.test(this.cells[at - 1])) at -= 1;
    return at;
  }

  wordEnd() {
    let at = this.cursor;
    while (at < this.cells.length && /\s/.test(this.cells[at])) at += 1;
    while (at < this.cells.length && !/\s/.test(this.cells[at])) at += 1;
    return at;
  }

  wordLeft() {
    this.goalColumn = null;
    this.cursor = this.wordStart();
  }

  wordRight() {
    this.goalColumn = null;
    this.cursor = this.wordEnd();
  }

  deleteWord() {
    this.goalColumn = null;
    const start = this.wordStart();
    this.cells.splice(start, this.cursor - start);
    this.cursor = start;
  }

  deleteWordForward() {
    this.goalColumn = null;
    this.cells.splice(this.cursor, this.wordEnd() - this.cursor);
  }

  clear() {
    this.goalColumn = null;
    this.cells = [];
    this.cursor = 0;
  }

  move(delta) {
    this.goalColumn = null;
    this.cursor = Math.max(0, Math.min(this.cells.length, this.cursor + delta));
  }

  toLineStart() {
    this.goalColumn = null;
    while (this.cursor > 0 && this.cells[this.cursor - 1] !== "\n") this.cursor -= 1;
  }

  toLineEnd() {
    this.goalColumn = null;
    while (this.cursor < this.cells.length && this.cells[this.cursor] !== "\n") this.cursor += 1;
  }

  get isEmpty() {
    return this.text.trim().length === 0;
  }

  // Returns false when there is no row that way, so the caller can treat the
  // top and bottom edges as something else.
  moveVertical(delta, width) {
    const { caret, positions } = this.layout(width);
    const goal = this.goalColumn ?? caret.col;
    const row = caret.row + delta;
    let target = -1;
    for (let index = 0; index < positions.length; index += 1) {
      const at = positions[index];
      if (at.row === row && (target < 0 || at.col <= goal)) target = index;
    }
    if (target >= 0) this.cursor = target;
    this.goalColumn = goal;
    return target >= 0;
  }

  // A single-line field scrolls by graphemes and keeps a cell for the caret.
  viewport(width) {
    let start = Math.min(this.viewStart ?? 0, this.cursor);
    let col = this.cells.slice(start, this.cursor).reduce((n, cell) => n + clusterWidth(cell), 0);
    while (col >= width && start < this.cursor) col -= clusterWidth(this.cells[start++]);
    this.viewStart = start;
    let text = "";
    let used = 0;
    for (const cell of this.cells.slice(start)) {
      const size = clusterWidth(cell);
      if (used + size > width) break;
      text += cell;
      used += size;
    }
    return { text, col };
  }

  // Wrap to `width` terminal cells and report where the cursor lands, so the
  // caller can place the real terminal cursor on the right row and column.
  layout(width) {
    const { rows, positions } = this.wrap(width);
    return { rows, caret: positions[this.cursor], positions };
  }

  // Wraps at the last space that fits, as prose does, so a word being typed
  // moves down whole. Only a word wider than the row is cut by cells.
  wrap(width) {
    const rows = [];
    const positions = [];
    let row = []; // indexes of the cells on the current row
    let used = 0;

    const place = (index) => {
      positions[index] = { row: rows.length, col: used };
      used += clusterWidth(this.cells[index]);
      row.push(index);
    };
    const finish = (indexes) => {
      rows.push(indexes.map((index) => this.cells[index]).join(""));
      row = [];
      used = 0;
    };

    for (let index = 0; index < this.cells.length; index += 1) {
      const cell = this.cells[index];

      if (cell === "\n") {
        positions[index] = { row: rows.length, col: used };
        finish(row);
        continue;
      }

      if (used + clusterWidth(cell) > width && used > 0) {
        const gap = row.findLastIndex((at) => /\s/.test(this.cells[at]));
        const carried = gap < 0 || /\s/.test(cell) ? [] : row.slice(gap + 1);
        finish(row.slice(0, row.length - carried.length));
        carried.forEach(place);
      }
      place(index);
    }

    positions[this.cells.length] = { row: rows.length, col: used };
    finish(row);
    return { rows, positions };
  }
}

module.exports = { Editor };
