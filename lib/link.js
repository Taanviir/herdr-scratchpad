"use strict";

// `scratch` on PATH is a symlink to bin/scratch.js in this checkout. Herdr
// installs every update into a new folder, so a link made once by setup would
// keep running the old copy.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.resolve(__dirname, "..", "bin", "scratch.js");

function binDir() {
  return process.env.SCRATCHPAD_BIN_DIR ?? path.join(os.homedir(), ".local", "bin");
}

// Setup's link, as a line for its report.
function link() {
  if (process.platform === "win32") return `add a scratch command that runs: node "${SCRIPT}"`;
  const dir = binDir();
  const at = path.join(dir, "scratch");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.lstatSync(at, { throwIfNoEntry: false });
    if (existing && !existing.isSymbolicLink()) return `${at} exists and is not ours; scratch was not linked`;
    if (existing) fs.unlinkSync(at);
    fs.symlinkSync(SCRIPT, at);
    const onPath = (process.env.PATH ?? "").split(path.delimiter).includes(dir);
    return `scratch linked into ${dir}${onPath ? "" : " (not on your PATH)"}`;
  } catch (error) {
    return `could not link scratch: ${error.message}`;
  }
}

// Points a link to another Scratchpad checkout at this one. Anything that is
// not such a link is left alone, and so is a missing one: that is setup's call.
function relink() {
  const at = path.join(binDir(), "scratch");
  try {
    const target = fs.readlinkSync(at);
    if (target === SCRIPT || !/scratchpad.*[\\/]bin[\\/]scratch\.js$/.test(target)) return false;
    fs.unlinkSync(at);
    fs.symlinkSync(SCRIPT, at);
    return true;
  } catch {
    return false;
  }
}

module.exports = { link, relink, SCRIPT };
