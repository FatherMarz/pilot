// Frame merging for snap, and the cleanup decision (which tabs get swept).
const { test } = require("node:test");
const assert = require("node:assert");
const { mergeSnapItems, selectSweep } = require("../extension/shared.js");

test("merge: overlay items first, then on screen, then the rest; frames offset", () => {
  const main = { items: [
    { ref: "p1r1", pri: 2, x: 10, y: 900 },
    { ref: "p1r2", pri: 1, x: 10, y: 10 },
    { ref: "p1r3", pri: 0, x: 50, y: 50 },
  ] };
  const frame = { items: [{ ref: "p2r1", pri: 1, x: 5, y: 5 }] };
  const m = mergeSnapItems([{ frame: 0, result: main }, { frame: 1, offset: { x: 100, y: 200 }, onScreen: true, result: frame }], 150);
  assert.deepEqual(m.items.map((i) => i.ref), ["p1r3", "p1r2", "p2r1", "p1r1"]);
  const f = m.items.find((i) => i.ref === "p2r1");
  assert.equal(f.frame, 1);
  assert.equal(f.x, 105);
  assert.equal(f.y, 205);
  assert.equal(m.truncated, false);
});

test("merge: a frame scrolled out of view counts as off screen; cap sets truncated", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ ref: "p1r" + i, pri: 1 }));
  const m = mergeSnapItems([{ frame: 0, result: { items, more: 5 } }, { frame: 1, offset: { x: 0, y: 3000 }, onScreen: false, result: { items: [{ ref: "p3r1", pri: 1 }] } }], 4);
  assert.equal(m.items.length, 4);
  assert.equal(m.truncated, true);
  assert.equal(m.total, 16);
  const all = mergeSnapItems([{ frame: 0, result: { items } }, { frame: 1, offset: { x: 0, y: 3000 }, onScreen: false, result: { items: [{ ref: "p3r1", pri: 1 }] } }], 50);
  assert.equal(all.items[all.items.length - 1].ref, "p3r1");
  assert.equal(all.items[all.items.length - 1].pri, 2);
});

const now = 1_000_000_000;
const MIN = 60000;
const base = (over) => ({
  titles: ["Pilot", "Harness"],
  groups: [{ id: 10, title: "Pilot" }, { id: 11, title: "Harness" }, { id: 12, title: "Work" }],
  keep: [], now, idleMs: 30 * MIN, owned: {}, tabs: [], ...over,
});
const ids = (xs) => xs.map((x) => x.id).sort((a, b) => a - b);

test("sweep: idle sessions close; live ones and kept ones stay", () => {
  const plan = selectSweep(base({
    tabs: [
      { id: 1, groupId: 10, url: "https://a.test/", active: false },
      { id: 2, groupId: 10, url: "https://b.test/", active: false },
      { id: 3, groupId: 10, url: "https://c.test/", active: false },
    ],
    owned: { 1: { session: "old", lastUsed: now - 45 * MIN }, 2: { session: "live", lastUsed: now - 5 * MIN }, 3: { session: "kept", lastUsed: now - 90 * MIN } },
    keep: [3],
  }));
  assert.deepEqual(ids(plan.close), [1]);
  assert.deepEqual(plan.ungroup, []);
});

test("sweep: never closes the tab the user is viewing, only ungroups it", () => {
  const plan = selectSweep(base({
    tabs: [{ id: 1, groupId: 10, url: "https://a.test/", active: true }, { id: 2, groupId: -1, url: "about:blank", active: true }],
    owned: { 1: { lastUsed: now - 60 * MIN } },
  }));
  assert.deepEqual(plan.close, []);
  assert.deepEqual(ids(plan.ungroup), [1]);
  assert.ok(plan.forget.some((f) => f.id === 1));
});

test("sweep: a tab the user moved out of the Pilot group is forgotten, not closed", () => {
  const plan = selectSweep(base({
    tabs: [{ id: 1, groupId: 12, url: "https://a.test/", active: false }],
    owned: { 1: { lastUsed: now - 60 * MIN } },
  }));
  assert.deepEqual(plan.close, []);
  assert.deepEqual(ids(plan.forget), [1]);
});

test("sweep: orphans close only when blank, discarded or long untouched", () => {
  const plan = selectSweep(base({
    tabs: [
      { id: 1, groupId: 10, url: "about:blank", active: false },
      { id: 2, groupId: 11, url: "https://x.test/", active: false, discarded: true },
      { id: 3, groupId: 10, url: "https://y.test/", active: false, lastAccessed: now - 120 * MIN },
      { id: 4, groupId: 10, url: "https://z.test/", active: false, lastAccessed: now - 2 * MIN },
      { id: 5, groupId: 12, url: "about:blank", active: false },
      { id: 6, groupId: -1, url: "about:blank", active: false },
      { id: 7, groupId: 10, url: "about:blank", active: false },
    ],
    keep: [7],
  }));
  assert.deepEqual(ids(plan.close), [1, 2, 3]);
});

test("sweep: owned tabs whose tab is gone are forgotten; children of a kept parent stay", () => {
  const plan = selectSweep(base({
    tabs: [{ id: 1, groupId: 10, url: "https://a.test/", active: false }, { id: 2, groupId: 10, url: "https://pop.test/", active: false }],
    owned: { 1: { lastUsed: now - 90 * MIN }, 2: { parent: 1, lastUsed: now - 90 * MIN }, 99: { lastUsed: now } },
    keep: [1],
  }));
  assert.deepEqual(plan.close, []);
  assert.deepEqual(ids(plan.forget), [99]);
});

test("sweep: idle release off (0) still clears blank orphans only", () => {
  const plan = selectSweep(base({
    idleMs: 0,
    tabs: [{ id: 1, groupId: 10, url: "https://a.test/", active: false, lastAccessed: 0 }, { id: 2, groupId: 10, url: "about:blank", active: false }],
    owned: { 1: { lastUsed: 0 } },
  }));
  assert.deepEqual(ids(plan.close), [2]);
});
