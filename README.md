# Scratchpad

A [Herdr](https://herdr.dev) plugin for the ideas you get while an agent is
busy. Press a key, type the note, and go back to what you were doing. Notes go
into one global scratchpad and are tied to the folder or repo you were in.
Later you can hand them to an agent.

- Each note records where it came from: the folder (the git root if there is
  one), the branch, and the agent and session that were in front of you.
- Start a new agent with selected notes as its brief, or send them to an
  agent that is already running.
- Reopen the Claude Code or Codex session a note came from.
- Agents read and write the same notes with the `scratch` command.
- No dependencies, no build step. Node 18 or newer.

## Install

```bash
herdr plugin install Taanviir/herdr-scratchpad
herdr plugin action invoke taanviir.scratchpad.setup
```

Setup binds **ctrl+b** then **a** in your `config.toml`, and links `scratch`
into `~/.local/bin`. Set `SCRATCHPAD_KEY` first to use another key, and
`SCRATCHPAD_BIN_DIR` to link `scratch` somewhere else. A key that is already
bound is left alone.

## The popup

The cursor starts in the note box. Type, press ⏎, and the note is saved under
the folder you were in. Below the box, your notes are grouped by label on the
left, and the selected one is shown in full on the right with where it came
from.

Tabs along the top switch between **This folder**, **All** and **Done**. Notes
filed under a parent folder also show up in its subfolders.

**Labels.** Any `#word` in a note is a label: `back up the db first #release`.
Notes are grouped under their first label. Typing `#` suggests labels you
have used before, and `tab` completes one.

**Writing a note**

| Key | |
| --- | --- |
| `⏎` | save |
| `shift+⏎`, `alt+⏎`, `ctrl+j` | new line |
| `ctrl+g` | save under no folder instead, or back |
| `ctrl+v` | paste from the system clipboard |
| `↓` | move into the notes |
| `tab` / `shift+tab` | complete a label, or switch tabs |
| `esc` | close, keeping what you typed |

**In the notes**

| Key | |
| --- | --- |
| `⏎` | edit the note in the box |
| `space` | tick a note; actions apply to the ticked notes, or the one under the cursor |
| `ctrl+n` | start an agent with the notes: pick it with `1`…`9`, `ctrl+t` for a tab or split, see the exact prompt, ⏎ to start |
| `ctrl+r` | send the notes to an agent that is already running |
| `ctrl+x` | mark done, or reopen |
| `ctrl+d` twice | delete |
| `ctrl+o` | reopen the Claude Code or Codex session the note came from |
| `esc` | back to the box |

Typing a letter in the list jumps back to the box. An agent started from notes
gets them as a list with their ids, plus a line asking it to run
`scratch done <id>` when it finishes each one. When sending to a running
agent, agents working in the notes' folder are listed first.

The popup paints its own dark background so the pane behind it does not show
through. `SCRATCHPAD_BG` takes another 256-colour number; `NO_COLOR` turns
colour off.

## For agents

```text
scratch add "the dev guard should also skip vitest"   # note for this folder
scratch add --anywhere -  < idea.md                    # from stdin, no folder
scratch list                                           # open notes here
scratch list --all --json
scratch list --label release                           # only #release notes
scratch show <id>
scratch done <id>
```

Ids can be shortened to any unique prefix. To let agents use it on their own,
add something like this to your `AGENTS.md` or `CLAUDE.md`:

```markdown
## Scratchpad
- `scratch list` shows my open notes for this repo. Check it at the start of a task.
- When you notice something out of scope, `scratch add "<what and why>"` instead of doing it.
- When you finish a note you were given, `scratch done <id>`.
```

## Files

| Path | |
| --- | --- |
| `~/.local/share/herdr-scratchpad/notes.jsonl` | the notes, one per line (`SCRATCHPAD_HOME` moves it) |
| plugin state dir, `draft.txt` | the unsaved note |
| plugin state dir, `prefs.json` | last agent and where it opened |
| plugin state dir, `crash.log` | errors from the popup |

The plugin state directory is normally
`~/.local/state/herdr/plugins/taanviir.scratchpad/` on Linux.

## Developing

```bash
herdr plugin link .
npm test
```

## Releasing

The version lives in `herdr-plugin.toml` and `package.json`, and the two must
match. Merging a version bump to `main` runs the tests and publishes `vX.Y.Z`
as a GitHub release. Install a specific release with
`herdr plugin install Taanviir/herdr-scratchpad --ref vX.Y.Z`.

Changes take effect the next time the popup opens. `bin/launch.js` starts real
agents. Point `HERDR_BIN_PATH` at a stub to exercise it without them.

## License

[MIT](LICENSE).
