"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parse, short, long, urgency } = require("../lib/when");

// Saturday 3 October 2026, 22:30 local time.
const NOW = new Date(2026, 9, 3, 22, 30);
const at = (...parts) => new Date(...parts).getTime();
const read = (text) => parse(text, NOW)?.getTime() ?? null;

test("days without a time start at 9:00", () => {
  assert.strictEqual(read("tomorrow"), at(2026, 9, 4, 9, 0));
  assert.strictEqual(read("mon"), at(2026, 9, 5, 9, 0));
  assert.strictEqual(read("friday"), at(2026, 9, 9, 9, 0));
  assert.strictEqual(read("saturday"), at(2026, 9, 10, 9, 0), "today is saturday, so the next one");
  assert.strictEqual(read("next week"), at(2026, 9, 5, 9, 0));
  assert.strictEqual(read("2026-10-12"), at(2026, 9, 12, 9, 0));
  assert.strictEqual(read("oct 12"), at(2026, 9, 12, 9, 0));
  assert.strictEqual(read("12 oct"), at(2026, 9, 12, 9, 0));
  assert.strictEqual(read("sep 1"), at(2027, 8, 1, 9, 0), "a past month and day means next year");
});

test("times on their own mean the next time the clock shows them", () => {
  assert.strictEqual(read("23:00"), at(2026, 9, 3, 23, 0));
  assert.strictEqual(read("9am"), at(2026, 9, 4, 9, 0));
  assert.strictEqual(read("noon"), at(2026, 9, 4, 12, 0));
});

test("days and times together, in the ways people write them", () => {
  assert.strictEqual(read("tomorrow 5pm"), at(2026, 9, 4, 17, 0));
  assert.strictEqual(read("Tomorrow at 9:30 am"), at(2026, 9, 4, 9, 30));
  assert.strictEqual(read("tue 14:15"), at(2026, 9, 6, 14, 15));
  assert.strictEqual(read("2026-10-12 08:00"), at(2026, 9, 12, 8, 0));
  assert.strictEqual(read("tonight"), at(2026, 9, 3, 20, 0));
});

test("relative times count from now", () => {
  assert.strictEqual(read("in 2h"), NOW.getTime() + 2 * 3600e3);
  assert.strictEqual(read("in 30 min"), NOW.getTime() + 30 * 60e3);
  assert.strictEqual(read("in 3 days"), NOW.getTime() + 3 * 864e5);
});

test("anything else is not a date", () => {
  for (const text of ["", "soon", "13pm", "25:00", "in 2 lightyears", "feb30ish"]) assert.strictEqual(read(text), null, text);
});

test("labels say how close the date is", () => {
  assert.strictEqual(short(new Date(2026, 9, 3, 23, 0), NOW), "today 23:00");
  assert.strictEqual(short(new Date(2026, 9, 4, 9, 0), NOW), "tmrw 09:00");
  assert.strictEqual(short(new Date(2026, 9, 6, 9, 0), NOW), "tue 09:00");
  assert.strictEqual(short(new Date(2026, 9, 20, 9, 0), NOW), "20 oct");
  assert.strictEqual(short(new Date(2026, 9, 2), NOW), "overdue");
  assert.strictEqual(long(new Date(2026, 9, 5, 9, 0), NOW), "Mon 5 Oct 2026, 09:00 · in 1 day");
  assert.strictEqual(urgency(new Date(2026, 9, 3, 23, 0), NOW), "today");
  assert.strictEqual(urgency(new Date(2026, 9, 1), NOW), "overdue");
});
