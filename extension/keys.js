// Pilot — US-layout key table for trusted keystrokes via the Chrome debugger.
//
// Pure functions, no chrome.* calls: the service worker loads this with
// importScripts, and the tests require it under node.
//
// CDP's Input.dispatchKeyEvent needs four things to look like a real key:
// `key` (what the key produces), `code` (the physical key), the Windows
// virtual key code (what old keyCode-based handlers read), and `text` (the
// character inserted). Deriving the key code from the character is wrong for
// punctuation: "." is 46 as a char code but 46 is the Delete key.

(function (root) {
  const NAMED = {
    Enter: { code: "Enter", keyCode: 13, text: "\r" },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    Insert: { code: "Insert", keyCode: 45 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    PageUp: { code: "PageUp", keyCode: 33 },
    PageDown: { code: "PageDown", keyCode: 34 },
    " ": { code: "Space", keyCode: 32, text: " " },
  };
  for (let i = 1; i <= 12; i++) NAMED["F" + i] = { code: "F" + i, keyCode: 111 + i };
  const ALIASES = { Esc: "Escape", Return: "Enter", Space: " ", Del: "Delete", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };

  // Punctuation: [unshifted, shifted, code, keyCode].
  const PUNCT = [
    ["`", "~", "Backquote", 192], ["-", "_", "Minus", 189], ["=", "+", "Equal", 187],
    ["[", "{", "BracketLeft", 219], ["]", "}", "BracketRight", 221], ["\\", "|", "Backslash", 220],
    [";", ":", "Semicolon", 186], ["'", "\"", "Quote", 222], [",", "<", "Comma", 188],
    [".", ">", "Period", 190], ["/", "?", "Slash", 191],
  ];
  const DIGIT_SHIFT = ")!@#$%^&*(";

  const CHARS = {};
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);
    const upper = lower.toUpperCase();
    CHARS[lower] = { key: lower, code: "Key" + upper, keyCode: 65 + i, text: lower, shift: false };
    CHARS[upper] = { key: upper, code: "Key" + upper, keyCode: 65 + i, text: upper, shift: true };
  }
  for (let d = 0; d <= 9; d++) {
    CHARS[String(d)] = { key: String(d), code: "Digit" + d, keyCode: 48 + d, text: String(d), shift: false };
    const s = DIGIT_SHIFT[d];
    CHARS[s] = { key: s, code: "Digit" + d, keyCode: 48 + d, text: s, shift: true };
  }
  for (const [plain, shifted, code, keyCode] of PUNCT) {
    CHARS[plain] = { key: plain, code, keyCode, text: plain, shift: false };
    CHARS[shifted] = { key: shifted, code, keyCode, text: shifted, shift: true };
  }
  CHARS[" "] = { key: " ", code: "Space", keyCode: 32, text: " ", shift: false };
  CHARS["\n"] = { key: "Enter", code: "Enter", keyCode: 13, text: "\r", shift: false };
  CHARS["\t"] = { key: "Tab", code: "Tab", keyCode: 9, shift: false };

  // Resolve a key name or single character. Returns null for characters the
  // US layout cannot type (é, emoji): callers insert those as text instead.
  function keyInfo(name) {
    const n = ALIASES[name] || name;
    if (NAMED[n]) return { key: n, shift: false, ...NAMED[n] };
    if (CHARS[n]) return { ...CHARS[n] };
    if (typeof n === "string" && n.length === 1 && CHARS[n.toLowerCase()]) return { ...CHARS[n.toLowerCase()] };
    return null;
  }

  // macOS editing shortcuts. Chrome on macOS routes Cmd+A/C/X/V/Z through
  // editor commands, not through the key event, so a raw Meta+A key event
  // does nothing unless the matching command rides along.
  function shortcutCommands(code, mods) {
    if (!mods || !mods.meta || mods.ctrl || mods.alt) return [];
    const shift = !!mods.shift;
    if (code === "KeyZ") return [shift ? "redo" : "undo"];
    if (shift) return [];
    return ({ KeyA: ["selectAll"], KeyC: ["copy"], KeyX: ["cut"], KeyV: ["paste"] })[code] || [];
  }

  function modifierBits(m) {
    return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
  }

  // The Input.dispatchKeyEvent params for one key press: [down, up].
  // `mods` is { meta, shift, ctrl, alt }. Returns null for an unknown key.
  function keyEvents(name, mods) {
    const info = keyInfo(name);
    if (!info) return null;
    const m = { ...(mods || {}) };
    if (info.shift) m.shift = true;
    const modifiers = modifierBits(m);
    const base = { key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers };
    // With Cmd/Ctrl/Alt held the key produces no text (it is a shortcut).
    const producesText = info.text !== undefined && !m.meta && !m.ctrl && !m.alt;
    const down = producesText
      ? { type: "keyDown", ...base, text: info.text, unmodifiedText: info.text }
      : { type: "rawKeyDown", ...base };
    const commands = shortcutCommands(info.code, m);
    if (commands.length) down.commands = commands;
    return [down, { type: "keyUp", ...base }];
  }

  const api = { keyInfo, keyEvents, shortcutCommands, modifierBits };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PilotKeys = api;
})(typeof self !== "undefined" ? self : globalThis);
