// Key table and macOS shortcut commands for trusted keystrokes.
const { test } = require("node:test");
const assert = require("node:assert");
const { keyInfo, keyEvents, shortcutCommands } = require("../extension/keys.js");

test("punctuation gets its real key code, not its char code", () => {
  const cases = {
    ".": ["Period", 190], "(": ["Digit9", 57], "'": ["Quote", 222], "#": ["Digit3", 51],
    "$": ["Digit4", 52], "%": ["Digit5", 53], "&": ["Digit7", 55], "@": ["Digit2", 50],
    "/": ["Slash", 191], "-": ["Minus", 189], "?": ["Slash", 191], "\"": ["Quote", 222],
  };
  for (const [ch, [code, keyCode]] of Object.entries(cases)) {
    const k = keyInfo(ch);
    assert.equal(k.code, code, ch);
    assert.equal(k.keyCode, keyCode, ch);
    assert.equal(k.text, ch, ch);
    // None of these may collide with navigation keys (Delete 46, arrows 37-40, Home 36, End 35).
    assert.ok(![46, 37, 38, 39, 40, 36, 35].includes(k.keyCode), ch);
  }
});

test("letters, digits and shift", () => {
  assert.deepEqual(keyInfo("a"), { key: "a", code: "KeyA", keyCode: 65, text: "a", shift: false });
  assert.equal(keyInfo("Z").shift, true);
  assert.equal(keyInfo("Z").code, "KeyZ");
  assert.equal(keyInfo("7").code, "Digit7");
  const [down] = keyEvents("A", {});
  assert.equal(down.modifiers & 8, 8, "uppercase holds shift");
});

test("named keys", () => {
  assert.equal(keyInfo("Enter").keyCode, 13);
  assert.equal(keyInfo("Enter").text, "\r");
  assert.equal(keyInfo("ArrowDown").keyCode, 40);
  assert.equal(keyInfo("Escape").code, "Escape");
  assert.equal(keyInfo("Esc").key, "Escape");
  assert.equal(keyInfo(" ").code, "Space");
  assert.equal(keyInfo("F5").keyCode, 116);
  assert.equal(keyInfo("é"), null, "non-US characters are typed as text instead");
  assert.equal(keyEvents("NoSuchKey", {}), null);
});

test("key events: text keys send keyDown with text, shortcuts send rawKeyDown", () => {
  const [down, up] = keyEvents(".", {});
  assert.equal(down.type, "keyDown");
  assert.equal(down.text, ".");
  assert.equal(up.type, "keyUp");
  assert.equal(up.text, undefined);
  const [md] = keyEvents("a", { meta: true });
  assert.equal(md.type, "rawKeyDown");
  assert.equal(md.text, undefined);
  assert.equal(md.modifiers, 4);
  const [tab] = keyEvents("Tab", {});
  assert.equal(tab.type, "rawKeyDown");
});

test("macOS editing shortcuts carry editor commands", () => {
  assert.deepEqual(keyEvents("a", { meta: true })[0].commands, ["selectAll"]);
  assert.deepEqual(keyEvents("c", { meta: true })[0].commands, ["copy"]);
  assert.deepEqual(keyEvents("x", { meta: true })[0].commands, ["cut"]);
  assert.deepEqual(keyEvents("v", { meta: true })[0].commands, ["paste"]);
  assert.deepEqual(keyEvents("z", { meta: true })[0].commands, ["undo"]);
  assert.deepEqual(keyEvents("z", { meta: true, shift: true })[0].commands, ["redo"]);
  assert.deepEqual(keyEvents("Z", { meta: true })[0].commands, ["redo"], "Meta+Z uppercase implies shift");
  assert.equal(keyEvents("a", {})[0].commands, undefined);
  assert.deepEqual(shortcutCommands("KeyA", { meta: true, ctrl: true }), []);
  assert.deepEqual(shortcutCommands("KeyB", { meta: true }), []);
});
