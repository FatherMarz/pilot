// Accessible name, role and value-stuck check from the page library, run
// against tiny element fakes (no DOM needed).
const { test } = require("node:test");
const assert = require("node:assert");
const { accessibleName, roleOf, textMatches } = require("../extension/page.js");

function el(tagName, attrs = {}, extra = {}) {
  const e = {
    tagName, childNodes: [], labels: [], isContentEditable: false,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
    closest: () => null,
    querySelector: () => null,
    ...extra,
  };
  if (attrs.type && !("type" in extra)) e.type = attrs.type;
  return e;
}
const text = (s) => ({ nodeType: 3, nodeValue: s });
function label(parts, extra) {
  const l = el("LABEL", {}, extra);
  l.nodeType = 1;
  l.childNodes = parts;
  return l;
}

test("aria-labelledby wins, then aria-label", () => {
  const ref = { innerText: "Billing name" };
  const input = el("INPUT", { "aria-labelledby": "lbl", "aria-label": "ignored", type: "text" }, {
    getRootNode: () => ({ getElementById: (id) => (id === "lbl" ? ref : null) }),
  });
  assert.equal(accessibleName(input), "Billing name");
  assert.equal(accessibleName(el("INPUT", { "aria-label": "Search", type: "text" })), "Search");
});

test("label[for] via el.labels, ignoring nested controls", () => {
  const input = el("INPUT", { type: "text", placeholder: "you@x.com" });
  input.nodeType = 1;
  input.labels = [label([text("E-mail "), input, text(" address")])];
  assert.equal(accessibleName(input), "E-mail address");
});

test("wrapping label when labels is empty", () => {
  const input = el("INPUT", { type: "radio" });
  input.nodeType = 1;
  const wrap = label([input, text(" Medium ")]);
  input.closest = (s) => (s === "label" ? wrap : null);
  assert.equal(accessibleName(input), "Medium");
});

test("Angular Material mat-label", () => {
  const input = el("INPUT", { type: "text" });
  const matLabel = label([text("First name")]);
  const field = { querySelector: () => matLabel };
  input.closest = (s) => (s.includes("mat-form-field") ? field : null);
  assert.equal(accessibleName(input), "First name");
});

test("placeholder then title for unlabeled fields; empty stays empty", () => {
  assert.equal(accessibleName(el("INPUT", { type: "text", placeholder: "Search", title: "t" })), "Search");
  assert.equal(accessibleName(el("TEXTAREA", { title: "Notes" })), "Notes");
  assert.equal(accessibleName(el("INPUT", { type: "text" })), "");
});

test("buttons and links take their text; icon buttons their inner label", () => {
  assert.equal(accessibleName(el("BUTTON", {}, { innerText: "  Save\n changes " })), "Save changes");
  const icon = el("BUTTON", {}, { innerText: "", querySelector: () => ({ getAttribute: (k) => (k === "aria-label" ? "Close" : null) }) });
  assert.equal(accessibleName(icon), "Close");
  assert.equal(accessibleName(el("INPUT", { type: "submit" }, { value: "Send" })), "Send");
  // A field's value is never its name.
  assert.equal(accessibleName(el("INPUT", { type: "text" }, { value: "typed text" })), "");
});

test("roles", () => {
  assert.equal(roleOf(el("A", { href: "/" })), "link");
  assert.equal(roleOf(el("INPUT", { type: "checkbox" })), "checkbox");
  assert.equal(roleOf(el("INPUT", { type: "email" })), "textbox");
  assert.equal(roleOf(el("SELECT")), "combobox");
  assert.equal(roleOf(el("DIV", { role: "option" })), "option");
  assert.equal(roleOf(el("DIV", {}, { isContentEditable: true })), "textbox");
});

test("value-stuck check tolerates input masks only", () => {
  assert.ok(textMatches("Ada", "Ada"));
  assert.ok(textMatches("4242 4242 4242 4242", "4242424242424242"));
  assert.ok(textMatches("(555) 123-4567", "5551234567"));
  assert.ok(!textMatches("", "hello"));
  assert.ok(!textMatches("hel", "hello"));
  assert.ok(textMatches("", ""));
});
