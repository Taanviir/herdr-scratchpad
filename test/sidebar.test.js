"use strict";

const test = require("node:test");
const assert = require("node:assert");

delete process.env.HERDR_ENV;
const { foldersByWorkspace, tokensFor, changes } = require("../lib/sidebar");

const NOW = new Date("2026-10-26T12:00:00");
const NOTES = [
  { id: "a", text: "Rotate the keys", folders: ["/work/api"], due: "2026-10-20T09:00:00" },
  { id: "b", text: "Write the changelog", folders: ["/work/api"], due: "2026-10-30T09:00:00" },
  { id: "c", text: "Shipped", folders: ["/work/api"], done: "2026-10-01T09:00:00" },
  { id: "d", text: "Docs", folders: ["/work/web"] },
  { id: "e", text: "Anywhere", folders: [] },
];
const SNAPSHOT = {
  workspaces: [
    { workspace_id: "w1" },
    { workspace_id: "w2", tokens: { notes: "✎ 1" } },
    { workspace_id: "w3", tokens: { notes: "✎ 4", due: "◷ today 09:00" } },
  ],
  panes: [
    { pane_id: "w1:p1", workspace_id: "w1", cwd: "/work/api", foreground_cwd: "/work/api/src" },
    { pane_id: "w1:p2", workspace_id: "w1", cwd: "/work/web" },
    { pane_id: "w2:p1", workspace_id: "w2", cwd: "/work/web" },
    { pane_id: "w3:p1", workspace_id: "w3", cwd: "/tmp" },
  ],
};

test("a workspace's folders are where each of its panes is now", () => {
  assert.deepStrictEqual([...foldersByWorkspace(SNAPSHOT).get("w1")], ["/work/api/src", "/work/web"]);
});

test("a workspace counts the open notes of all its folders, and shows the soonest date", () => {
  assert.deepStrictEqual(tokensFor(NOTES, new Set(["/work/api/src", "/work/web"]), NOW), { notes: "✎ 3", due: "◷ overdue" });
  assert.deepStrictEqual(tokensFor(NOTES, new Set(["/work/web"]), NOW), { notes: "✎ 1", due: "" });
  assert.deepStrictEqual(tokensFor(NOTES, new Set(["/elsewhere"]), NOW), { notes: "", due: "" }, "a note filed nowhere belongs to no workspace");
});

test("only workspaces whose counts changed are reported, and a stale count is cleared", () => {
  assert.deepStrictEqual(changes(SNAPSHOT, NOTES, NOW), [
    { workspace: "w1", tokens: { notes: "✎ 3", due: "◷ overdue" } },
    { workspace: "w3", tokens: { notes: "", due: "" } },
  ]);
});
