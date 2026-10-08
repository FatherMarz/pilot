// Debugger self-heal state machine and the no-debugger dialog shim.
const { test } = require("node:test");
const assert = require("node:assert");
const { cdpHealable, withHeal, dialogShim, drainShim } = require("../extension/shared.js");

test("healable: refusals and lost sessions yes, timeouts and page errors no", () => {
  assert.equal(cdpHealable("Cannot access a chrome-extension:// URL of different extension"), true);
  assert.equal(cdpHealable("Debugger is not attached to the tab with id: 12."), true);
  assert.equal(cdpHealable("Detached while handling command."), true);
  assert.equal(cdpHealable("Input.dispatchMouseEvent timed out"), false);
  assert.equal(cdpHealable("Another debugger is already attached to the tab with id: 3."), false);
  assert.equal(cdpHealable("No node with given id found"), false);
  assert.equal(cdpHealable(undefined), false);
});

test("withHeal: ok first time sends once and never heals", async () => {
  let sends = 0, heals = 0;
  const r = await withHeal(async () => { sends++; return "ok"; }, async () => { heals++; });
  assert.deepEqual([r, sends, heals], ["ok", 1, 0]);
});

test("withHeal: healable error heals once and retries once", async () => {
  let sends = 0, heals = 0;
  const r = await withHeal(async () => { if (++sends === 1) throw new Error("Debugger is not attached"); return "again"; }, async () => { heals++; });
  assert.deepEqual([r, sends, heals], ["again", 2, 1]);
});

test("withHeal: a second failure is thrown, no loop", async () => {
  let sends = 0, heals = 0;
  await assert.rejects(withHeal(async () => { sends++; throw new Error("Detached while handling command."); }, async () => { heals++; }), /Detached/);
  assert.deepEqual([sends, heals], [2, 1]);
});

test("withHeal: timeouts are not retried (the event may have landed)", async () => {
  let sends = 0, heals = 0;
  await assert.rejects(withHeal(async () => { sends++; throw new Error("Input.dispatchKeyEvent timed out"); }, async () => { heals++; }), /timed out/);
  assert.deepEqual([sends, heals], [1, 0]);
});

test("withHeal: a failed heal surfaces and the command is not resent", async () => {
  let sends = 0;
  await assert.rejects(withHeal(async () => { sends++; throw new Error("Cannot access a chrome-extension:// URL of different extension"); }, async () => { throw new Error("still refused"); }), /still refused/);
  assert.equal(sends, 1);
});

function fakeWindow() {
  const listeners = [];
  const w = {
    alert: () => { throw new Error("real alert would block"); },
    confirm: () => { throw new Error("real confirm would block"); },
    prompt: () => { throw new Error("real prompt would block"); },
    onbeforeunload: () => "leave?",
    addEventListener: (type, fn, cap) => listeners.push({ type, fn, cap }),
  };
  return { w, listeners };
}

test("dialog shim: answers by policy, records, once resets, off restores", () => {
  const { w, listeners } = fakeWindow();
  const real = w.alert;
  globalThis.window = w;
  try {
    dialogShim(true, { accept: false, once: true });
    assert.equal(w.confirm("Sure?"), false);
    assert.equal(w.confirm("Again?"), true); // once: back to accept
    w.alert("hi");
    dialogShim(true, { accept: true, promptText: "yes" });
    assert.equal(w.prompt("Name?", "x"), "yes");
    dialogShim(true, null);
    assert.equal(w.prompt("Name?", "dflt"), "dflt");
    dialogShim(true, { accept: false });
    assert.equal(w.prompt("Name?"), null);
    assert.equal(w.onbeforeunload, null);
    const log = drainShim().map(({ at, ...r }) => r);
    assert.deepEqual(log.map((r) => [r.type, r.accepted]), [["confirm", false], ["confirm", true], ["alert", true], ["prompt", true], ["prompt", true], ["prompt", false]]);
    assert.equal(log[3].promptText, "yes");
    assert.deepEqual(drainShim(), []);
    // beforeunload is stopped while on, passed through when off
    const bu = listeners.find((l) => l.type === "beforeunload");
    let stopped = 0;
    bu.fn({ stopImmediatePropagation: () => stopped++ });
    dialogShim(false, null);
    bu.fn({ stopImmediatePropagation: () => stopped++ });
    assert.equal(stopped, 1);
    assert.equal(w.alert, real);
    assert.equal(listeners.length, 1); // reinstalling never stacks listeners
  } finally { delete globalThis.window; }
});
