"use strict";

// Dates typed the way you would say them: "tomorrow 9am", "fri", "in 2h",
// "oct 12 14:00", "2026-10-12". A day without a time means the start of the
// working day; a time without a day means the next time the clock shows it.

const DEFAULT_HOUR = 9;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const UNITS = { m: 60e3, min: 60e3, mins: 60e3, h: 3600e3, hr: 3600e3, hrs: 3600e3, hour: 3600e3, hours: 3600e3, d: 864e5, day: 864e5, days: 864e5, w: 6048e5, week: 6048e5, weeks: 6048e5 };

const atStartOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

// "5pm", "9:30am", "17:00", "noon". Returns [hours, minutes] or null.
function readTime(text) {
  if (text === "noon") return [12, 0];
  if (text === "midnight") return [0, 0];
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match || (!match[2] && !match[3])) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (match[3] && (hours < 1 || hours > 12)) return null;
  if (match[3] === "pm" && hours < 12) hours += 12;
  if (match[3] === "am" && hours === 12) hours = 0;
  return hours < 24 && minutes < 60 ? [hours, minutes] : null;
}

// The day part, or null. `explicitYear` is set when the year was written out,
// so a past date is kept instead of moved to next year.
function readDay(text, now) {
  const today = atStartOfDay(now);
  if (text === "today" || text === "tonight") return { day: today };
  if (text === "tomorrow" || text === "tmrw") return { day: addDays(today, 1) };
  if (text === "next week") return { day: addDays(today, ((8 - today.getDay()) % 7) || 7) };

  const weekday = /^(?:next\s+)?([a-z]{3})[a-z]*$/.exec(text);
  if (weekday && DAYS.includes(weekday[1])) {
    const ahead = (DAYS.indexOf(weekday[1]) - today.getDay() + 7) % 7 || 7;
    return { day: addDays(today, ahead) };
  }

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return { day: new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])), explicitYear: true };

  match = /^([a-z]{3})[a-z]*\s+(\d{1,2})$/.exec(text) ?? /^(\d{1,2})\s+([a-z]{3})[a-z]*$/.exec(text);
  if (match) {
    const [month, date] = /\d/.test(match[1]) ? [match[2], match[1]] : [match[1], match[2]];
    if (!MONTHS.includes(month)) return null;
    let day = new Date(today.getFullYear(), MONTHS.indexOf(month), Number(date));
    if (day < today) day = new Date(today.getFullYear() + 1, MONTHS.indexOf(month), Number(date));
    return { day };
  }
  return null;
}

function parse(input, now = new Date()) {
  const text = String(input).trim().toLowerCase().replace(/\s+/g, " ").replace(/\s+at\s+/, " ");
  if (!text) return null;

  const relative = /^in (\d+)\s*([a-z]+)$/.exec(text);
  if (relative && UNITS[relative[2]]) return new Date(now.getTime() + Number(relative[1]) * UNITS[relative[2]]);

  // The time is the trailing word or two, if they read as one: "fri 5pm",
  // "oct 12 9:30 am".
  const words = text.split(" ");
  for (let cut = words.length; cut >= 0; cut -= 1) {
    const dayText = words.slice(0, cut).join(" ");
    const timeText = words.slice(cut).join(" ").replace(/\s+(am|pm)$/, "$1");
    const time = timeText ? readTime(timeText) : null;
    if (timeText && !time) continue;
    const day = dayText ? readDay(dayText, now) : null;
    if (dayText && !day) continue;
    if (!day && !time) continue;

    if (!day) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time[0], time[1]);
      return at > now ? at : new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, time[0], time[1]);
    }
    const [hours, minutes] = time ?? (text === "tonight" ? [20, 0] : [DEFAULT_HOUR, 0]);
    return new Date(day.day.getFullYear(), day.day.getMonth(), day.day.getDate(), hours, minutes);
  }
  return null;
}

const pad2 = (n) => String(n).padStart(2, "0");
const clock = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

// Short enough for the list: "overdue", "today 17:00", "tomorrow", "fri
// 09:00", "12 oct".
function short(iso, now = new Date()) {
  const date = new Date(iso);
  const days = Math.round((atStartOfDay(date) - atStartOfDay(now)) / 864e5);
  if (date < now) return "overdue";
  if (days === 0) return `today ${clock(date)}`;
  if (days === 1) return `tmrw ${clock(date)}`;
  if (days < 7) return `${DAYS[date.getDay()]} ${clock(date)}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

// The whole date, and how far away it is: "Fri 10 Oct 2026, 09:00 · in 2 days".
function long(iso, now = new Date()) {
  const date = new Date(iso);
  const day = DAYS[date.getDay()];
  const month = MONTHS[date.getMonth()];
  const label = `${day[0].toUpperCase()}${day.slice(1)} ${date.getDate()} ${month[0].toUpperCase()}${month.slice(1)} ${date.getFullYear()}, ${clock(date)}`;
  return `${label} · ${distance(date, now)}`;
}

function distance(date, now) {
  const ms = date - now;
  const minutes = Math.round(Math.abs(ms) / 60e3);
  const span = minutes < 60 ? `${Math.max(1, minutes)} min`
    : minutes < 60 * 24 ? `${Math.round(minutes / 60)}h`
      : `${Math.round(minutes / 60 / 24)} day${Math.round(minutes / 60 / 24) === 1 ? "" : "s"}`;
  return ms < 0 ? `${span} overdue` : `in ${span}`;
}

// How pressing the date is, for its colour.
function urgency(iso, now = new Date()) {
  const date = new Date(iso);
  if (date < now) return "overdue";
  if (atStartOfDay(date).getTime() === atStartOfDay(now).getTime()) return "today";
  return "later";
}

module.exports = { parse, short, long, urgency };
