// Reply shaping, nearest-action hints and the compact snap format.
const { test } = require("node:test");
const assert = require("node:assert");
const { shapeReply, nearestAction, formatSnap, itemLine, ACTIONS, helpText } = require("../format.js");

test("shapeReply lifts value.ok, error and hint to the top", () => {
  const r = shapeReply({ id: 1, ok: true, value: { ok: false, error: "nope", hint: "snap again", fields: [1] } });
  assert.deepEqual(r, { ok: false, error: "nope", hint: "snap again", value: { fields: [1] } });
  assert.deepEqual(shapeReply({ ok: true, value: { ok: true } }), { ok: true });
  assert.deepEqual(shapeReply({ ok: true, value: "pilot 0.4.0" }), { ok: true, value: "pilot 0.4.0" });
  assert.deepEqual(shapeReply({ ok: true, value: [1, 2] }), { ok: true, value: [1, 2] });
  const nav = shapeReply({ ok: true, value: { ok: true, clicked: "Go", navigated: true, opened: { tabId: 9, url: "u" }, dialog: { type: "alert", message: "hi" } } });
  assert.equal(nav.ok, true);
  assert.equal(nav.navigated, true);
  assert.deepEqual(nav.opened, { tabId: 9, url: "u" });
  assert.equal(nav.dialog.type, "alert");
  assert.deepEqual(nav.value, { clicked: "Go" });
});

test("shapeReply keeps relay failures and their hint", () => {
  const r = shapeReply({ id: 3, ok: false, error: "profile 'x' not connected", hint: "click Connect", notConnected: true, profile: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.hint, "click Connect");
  assert.equal(r.notConnected, true);
  assert.equal(r.id, undefined);
});

test("nearestAction finds typos and refuses nonsense", () => {
  assert.equal(nearestAction("snapp"), "snap");
  assert.equal(nearestAction("clik"), "click");
  assert.equal(nearestAction("Navigate"), "navigate");
  assert.equal(nearestAction("screen"), null);
  assert.equal(nearestAction("xyzzyplugh"), null);
});

test("help lists every action with an example", () => {
  const h = helpText();
  for (const [name, [ex]] of Object.entries(ACTIONS)) {
    assert.ok(h.includes(name), name);
    assert.ok(h.includes(ex), ex);
  }
  for (const a of ["wait", "scroll", "back", "forward", "eval", "console", "network", "text", "upload", "drag", "dialogPolicy", "cleanup", "release"]) {
    assert.ok(ACTIONS[a], a);
  }
});

test("item lines are short and carry state", () => {
  assert.equal(itemLine({ ref: "p4r12", role: "button", name: "Save" }), 'p4r12 button "Save"');
  assert.equal(itemLine({ ref: "p4r3", role: "checkbox", name: "Remember me", checked: false, required: true }), 'p4r3 checkbox "Remember me" [unchecked] [required]');
  assert.equal(itemLine({ ref: "p4r5", role: "textbox", name: "Email", value: "" }), 'p4r5 textbox "Email" (empty)');
  assert.equal(itemLine({ ref: "p4r6", role: "textbox", name: "Q", value: 'say "hi"', frame: 1 }), "p4r6 textbox \"Q\" =\"say 'hi'\" [frame 1]");
  assert.equal(itemLine({ ref: "p4r7", role: "link", name: "Click Here", newTab: true }), 'p4r7 link "Click Here" [opens new tab]');
});

test("compact snap: on-screen first, a fold marker, and under 4 KB for a big page", () => {
  const items = [];
  for (let i = 0; i < 300; i++) items.push({ n: i, ref: "p7r" + (i + 1), role: i % 3 ? "link" : "button", name: "Item number " + i + " with a fairly long accessible name", pri: i < 20 ? 1 : 2 });
  const v = { doc: 7, title: "Big page", url: "https://example.com/big", text: "word ".repeat(2000), items, total: 450 };
  const out = formatSnap(v);
  assert.ok(Buffer.byteLength(out) < 4096, "size " + Buffer.byteLength(out));
  const lines = out.split("\n");
  assert.match(lines[0], /^ok:true page p7 "Big page" https:\/\/example.com\/big$/);
  assert.ok(lines.some((l) => l.startsWith("text: ")));
  assert.ok(out.includes("-- below the screen"), "fold marker");
  assert.ok(out.indexOf("p7r1 ") < out.indexOf("-- below the screen"));
  assert.match(out, /… \d+ more items not shown/);
  assert.match(lines[lines.length - 1], /snap again/);
});

test("compact snap: filter interactive drops the text", () => {
  const out = formatSnap({ doc: 1, title: "t", url: "u", text: "secret body text", items: [{ ref: "p1r1", role: "button", name: "Go", pri: 1 }] }, { filter: "interactive" });
  assert.ok(!out.includes("secret body text"));
  assert.ok(out.includes('p1r1 button "Go"'));
});

test("compact snap of a typical page stays small", () => {
  const items = [];
  for (let i = 0; i < 40; i++) items.push({ ref: "p2r" + i, role: "link", name: "Link " + i, pri: 1 });
  const out = formatSnap({ doc: 2, title: "Typical", url: "https://x.test/", text: "a ".repeat(400), items });
  assert.ok(Buffer.byteLength(out) < 2500, "size " + Buffer.byteLength(out));
  assert.ok(!out.includes("more items not shown"));
});
