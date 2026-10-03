"use strict";

// Action entrypoint: note where the user is, then open the popup there.

const { run } = require("../lib/herdr");
const { context } = require("../lib/term");

const ctx = context();

// The popup's own pane is not the one you were looking at, and the manifest
// launches it by a path relative to the plugin root, so where you were travels
// as environment rather than as its working directory.
const env = {
  SCRATCHPAD_CWD: ctx.focused_pane_cwd ?? ctx.workspace_cwd ?? process.env.HOME,
  SCRATCHPAD_PANE: ctx.focused_pane_id ?? process.env.HERDR_PANE_ID,
  SCRATCHPAD_WORKSPACE: ctx.workspace_id ?? process.env.HERDR_WORKSPACE_ID,
  SCRATCHPAD_SELECTION: ctx.selected_text,
};

const args = ["plugin", "pane", "open", "--plugin", "taanviir.scratchpad", "--entrypoint", "popup"];
for (const [key, value] of Object.entries(env)) if (value) args.push("--env", `${key}=${value}`);

const res = run(args, { check: false });
if (res.ok === false) {
  process.stderr.write(`${res.message}\n`);
  process.exit(1);
}
