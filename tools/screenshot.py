#!/usr/bin/env python3
"""Render the popup to a PNG.

Runs bin/popup.js on a real pty at the popup's real size, against a fixture
scratchpad, captures the final repaint, and draws it inside a frame standing in
for the one Herdr paints around a popup.

    uv run --with pillow tools/screenshot.py docs/scratchpad.png --keys '\\x1b[B' '\\x1b[B'

Needs Pillow and DejaVu Sans Mono. Development only: nothing at runtime does.
"""

import argparse
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from datetime import datetime, timedelta, timezone

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_SIZE = 16
PAD = 14
MARGIN = 18
# What Herdr hands the process for a 108x28 popup: the frame takes the rest.
COLS, ROWS = 105, 26

# Catppuccin Mocha, Herdr's default theme, plus the popup's own background.
BASE = "#1e1e2e"
POPUP = "#262626"
TEXT = "#cdd6f4"
BRIGHT = "#f5f6fa"
DIM = "#6c7086"
COLOURS = {
    "31": "#f38ba8", "91": "#eba0ac", "32": "#a6e3a1", "33": "#f9e2af",
    "34": "#89b4fa", "35": "#f5c2e7", "36": "#89dceb", "97": BRIGHT,
}

# Fake agents on PATH, so the agent chips do not depend on this machine.
AGENTS = ["claude", "codex", "opencode"]
FAKE_HERDR = """#!/bin/sh
case "$1 $2" in
  "agent start") echo "  [possible values: claude, codex, cursor, gemini, opencode, pi]";;
  "agent list") echo '{"result":{"agents":[
    {"pane_id":"w1:p2","agent":"claude","agent_status":"idle","terminal_title_stripped":"Release prep","foreground_cwd":"HOME/projects/budgit"},
    {"pane_id":"w1:p3","agent":"codex","agent_status":"working","terminal_title_stripped":"Flaky e2e tests","foreground_cwd":"HOME/projects/budgit"}]}}';;
  *) echo '{"result":{}}';;
esac
"""


def iso(delta):
    return (datetime.now(timezone.utc) + delta).isoformat().replace("+00:00", "Z")


# The popup runs in UTC, so a day and hour here are UTC too.
def at_hour(days, hour):
    moment = (datetime.now(timezone.utc) + timedelta(days=days)).replace(hour=hour, minute=0, second=0, microsecond=0)
    return moment.isoformat().replace("+00:00", "Z")


def fixture_notes(folder, other):
    source = {"agent": "claude", "title": "Release prep", "branch": "dev", "session": "0f3c"}

    def note(id_, text, created, due=None, where=folder, src=source):
        return {"id": id_, "text": text, "folders": [where], "source": src, "created": iso(-created),
                "updated": iso(-created), "due": due, "done": None, "sent": []}

    return [
        note("a1c9e2", "#release Raise the minor version before the next release PR, since this batch adds a feature. "
             "Then check the prod VM has Playwright 1.63's Chromium, or PDF export will fail there.",
             timedelta(hours=2), due=iso(timedelta(hours=4))),
        note("b7d014", "#release Back up the database first: the release PR rebuilds the settings table on deploy.",
             timedelta(hours=3), due=at_hour(1, 9)),
        note("c33f8a", "Reply to Sam about the onboarding doc", timedelta(days=2), due=iso(-timedelta(hours=20)),
             src={"agent": "codex", "title": "Onboarding doc", "branch": "main"}),
        note("d90b5e", "#ci The dev guard should also skip vitest, it hangs on CI", timedelta(days=1)),
        note("e4a7c1", "#ci Cache the Playwright browsers between runs", timedelta(days=1, hours=4)),
        note("f2e6b3", "#idea Show notes from the current branch first", timedelta(days=3)),
        note("0a5d77", "Check the draft PR for the invoices page later this week", timedelta(days=4)),
        note("1b8c4f", "#idea A dark theme for the PDF export", timedelta(days=5), where=other),
    ]


def capture(keys, env):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.clear()
        os.environ.update(env)
        os.execv(env["NODE"], ["node", "bin/popup.js"])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    # Output has to be read while the keys go in: a full pty blocks the popup's
    # writes, and the keys sent meanwhile then arrive as one chunk, which the
    # popup reads as a paste.
    buf = b""

    def drain(seconds):
        nonlocal buf
        deadline = time.time() + seconds
        while time.time() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                try:
                    buf += os.read(fd, 65536)
                except OSError:
                    return

    drain(1.0)
    for chunk in keys:
        os.write(fd, chunk)
        drain(0.4)
    drain(0.6)
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass

    screen = buf.decode("utf8", "replace").split("\x1b[2J\x1b[H")[-1]
    cursor = None
    shown = re.findall(r"\x1b\[(\d+);(\d+)H\x1b\[\?25h", screen)
    if shown:
        cursor = (int(shown[-1][0]) - 1, int(shown[-1][1]) - 1)
    return screen, cursor


SGR = re.compile(r"\x1b\[([0-9;]*)m")
OTHER_ESCAPE = re.compile(r"\x1b\[[?0-9;<>]*[a-zA-Z]")
CONTROL = re.compile(r"[\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def runs(line):
    """Split one line into (text, foreground, background) runs."""
    out = []
    fg, bg = TEXT, POPUP
    pos = 0
    for match in SGR.finditer(line):
        chunk = CONTROL.sub("", OTHER_ESCAPE.sub("", line[pos:match.start()]))
        if chunk:
            out.append((chunk, fg, bg))
        codes = [c for c in match.group(1).split(";") if c] or ["0"]
        i = 0
        while i < len(codes):
            code = codes[i]
            if code == "0":
                fg, bg = TEXT, POPUP
            elif code == "1":
                fg = BRIGHT
            elif code == "2":
                fg = DIM
            elif code == "30":
                fg = BASE
            elif code == "46":
                bg = COLOURS["36"]
            elif code == "48":
                bg = POPUP
                i += 2
            elif code in COLOURS:
                fg = COLOURS[code]
            i += 1
        pos = match.end()
    tail = CONTROL.sub("", OTHER_ESCAPE.sub("", line[pos:]))
    if tail:
        out.append((tail, fg, bg))
    return out


def render(screen, cursor, out_path):
    font = ImageFont.truetype(FONT, FONT_SIZE)
    cell_w = font.getlength("M")
    cell_h = FONT_SIZE + 6
    frame_w = int(cell_w * COLS) + PAD * 2
    frame_h = cell_h * ROWS + PAD * 2
    image = Image.new("RGB", (frame_w + MARGIN * 2, frame_h + MARGIN * 2), BASE)
    draw = ImageDraw.Draw(image)

    box = (MARGIN, MARGIN, MARGIN + frame_w, MARGIN + frame_h)
    draw.rounded_rectangle(box, radius=6, fill=POPUP, outline=COLOURS["36"], width=1)
    draw.rectangle((MARGIN + 12, MARGIN - 9, MARGIN + 12 + int(cell_w * 12), MARGIN + 9), fill=BASE)
    draw.text((MARGIN + 16, MARGIN - 9), "Scratchpad", font=font, fill=COLOURS["36"])

    lines = screen.split("\r\n")
    for row in range(ROWS):
        line = lines[row] if row < len(lines) else ""
        x = MARGIN + PAD
        y = MARGIN + PAD + row * cell_h
        for text, fg, bg in runs(line):
            width = font.getlength(text)
            if bg != POPUP:
                draw.rectangle((x, y - 2, x + width, y + cell_h - 2), fill=bg)
            draw.text((x, y), text, font=font, fill=fg)
            x += width

    if cursor:
        row, col = cursor
        x = MARGIN + PAD + cell_w * col
        y = MARGIN + PAD + row * cell_h
        draw.rectangle((x, y - 1, x + cell_w, y + cell_h - 3), fill=TEXT)

    image.save(out_path)
    print(f"{out_path}  {image.width}x{image.height}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    parser.add_argument("--type", default="", help="text to type before the keys")
    parser.add_argument("--keys", nargs="*", default=[], help="keypresses, each sent on its own, with python escapes")
    args = parser.parse_args()

    root = tempfile.mkdtemp(prefix="scratchpad-shot-")
    home = os.path.join(root, "home")
    folder = os.path.join(home, "projects", "budgit")
    other = os.path.join(home, "projects", "website")
    for path in (folder, other, os.path.join(root, "bin"), os.path.join(root, "notes"), os.path.join(root, "state")):
        os.makedirs(path)
    for name in AGENTS:
        with open(os.path.join(root, "bin", name), "w") as handle:
            handle.write("#!/bin/sh\n")
    herdr = os.path.join(root, "bin", "herdr")
    with open(herdr, "w") as handle:
        handle.write(FAKE_HERDR.replace("HOME", home))
    os.chmod(herdr, 0o755)
    with open(os.path.join(root, "notes", "notes.jsonl"), "w") as handle:
        for note in fixture_notes(folder, other):
            handle.write(json.dumps(note) + "\n")
    with open(os.path.join(root, "state", "prefs.json"), "w") as handle:
        handle.write('{"kind":"claude","destination":"tab"}')

    env = {
        "HOME": home,
        "PATH": os.path.join(root, "bin"),
        # Version-manager shims fetch Node when PATH looks unfamiliar, so the
        # real binary is resolved here, outside the fixture PATH.
        "NODE": subprocess.run(["node", "-p", "process.execPath"], capture_output=True, text=True, check=True).stdout.strip(),
        "TERM": "xterm-256color",
        "TZ": "UTC",
        "HERDR_BIN_PATH": herdr,
        "HERDR_PLUGIN_STATE_DIR": os.path.join(root, "state"),
        "SCRATCHPAD_HOME": os.path.join(root, "notes"),
        "SCRATCHPAD_CWD": folder,
    }
    keys = []
    if args.type:
        keys.append(args.type.encode())
    for key in args.keys:
        keys.append(key.encode().decode("unicode_escape").encode("latin1"))

    try:
        screen, cursor = capture(keys, env)
        render(screen, cursor, args.output)
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
