#!/usr/bin/env node
"use strict";

// Updates the note counts on Herdr's sidebar. Herdr runs it at startup and
// when a workspace or pane opens; every change to the notes runs it too.

require("../lib/sidebar").report();
