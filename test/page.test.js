// Accessible name, role and value-stuck check from the page library, run
// against tiny element fakes (no DOM needed).
const { test } = require("node:test");
const assert = require("node:assert");
const { accessibleName, roleOf, textMatches, parseRef, validateValue, fieldError, isMissing } = require("../extension/page.js");

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
  assert.equal(roleOf(el("INPUT", { type: "file" })), "file");
  assert.equal(roleOf(el("INPUT", { type: "number" })), "spinbutton");
});

test("value-stuck check tolerates input masks only", () => {
  assert.ok(textMatches("Ada", "Ada"));
  assert.ok(textMatches("4242 4242 4242 4242", "4242424242424242"));
  assert.ok(textMatches("(555) 123-4567", "5551234567"));
  assert.ok(!textMatches("", "hello"));
  assert.ok(!textMatches("hel", "hello"));
  assert.ok(textMatches("", ""));
});

test("refs carry the page number; old and foreign refs are recognised", () => {
  assert.deepEqual(parseRef("p4r12"), { doc: 4, seq: 12 });
  assert.deepEqual(parseRef(" p10r1 "), { doc: 10, seq: 1 });
  assert.deepEqual(parseRef("r12"), { legacy: true });
  assert.equal(parseRef("Password"), null);
  assert.equal(parseRef("p4"), null);
  assert.equal(parseRef(null), null);
});

test("typed values are checked before the field is touched", () => {
  const bad = validateValue("number", "abc");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a valid number.*left unchanged/);
  assert.deepEqual(validateValue("number", "42"), { ok: true, value: "42" });
  assert.deepEqual(validateValue("number", " -3.5e2 "), { ok: true, value: "-3.5e2" });
  assert.deepEqual(validateValue("number", "+7"), { ok: true, value: "7" });
  assert.equal(validateValue("number", "4 2").ok, false);
  assert.deepEqual(validateValue("number", ""), { ok: true, value: "" });

  assert.deepEqual(validateValue("time", "14:30"), { ok: true, value: "14:30" });
  assert.deepEqual(validateValue("time", "9:05"), { ok: true, value: "09:05" });
  assert.deepEqual(validateValue("time", "2:30 PM"), { ok: true, value: "14:30" });
  assert.deepEqual(validateValue("time", "12 am"), { ok: true, value: "00:00" });
  assert.deepEqual(validateValue("time", "14:30:15"), { ok: true, value: "14:30:15" });
  assert.equal(validateValue("time", "25:00").ok, false);
  assert.equal(validateValue("time", "noon").ok, false);

  assert.deepEqual(validateValue("date", "2026-10-08"), { ok: true, value: "2026-10-08" });
  assert.equal(validateValue("date", "2026-02-30").ok, false);
  assert.deepEqual(validateValue("date", "2024-02-29"), { ok: true, value: "2024-02-29" });
  assert.match(validateValue("date", "10/08/2026").error, /YYYY-MM-DD/);
  assert.deepEqual(validateValue("datetime-local", "2026-10-08 9:30"), { ok: true, value: "2026-10-08T09:30" });
  assert.deepEqual(validateValue("month", "2026-10"), { ok: true, value: "2026-10" });
  assert.equal(validateValue("month", "2026-13").ok, false);
  assert.deepEqual(validateValue("week", "2026-w41"), { ok: true, value: "2026-W41" });
  assert.deepEqual(validateValue("color", "#FF8800"), { ok: true, value: "#ff8800" });
  assert.deepEqual(validateValue("color", "f80"), { ok: true, value: "#ff8800" });
  assert.equal(validateValue("color", "orange").ok, false);
  assert.equal(validateValue("range", "").ok, false);
  assert.deepEqual(validateValue("text", "anything"), { ok: true, value: "anything" });
});

test("form errors: only messages tied to the field count", () => {
  const msgEl = { innerText: "Enter a valid email" };
  const lookup = (id) => (id === "em-err" ? msgEl : null);
  // aria-invalid + aria-errormessage
  const a = el("INPUT", { type: "email", "aria-invalid": "true", "aria-errormessage": "em-err" });
  assert.equal(fieldError(a, lookup), "Enter a valid email");
  // aria-describedby is only an error when the field is invalid
  const helpText = el("INPUT", { type: "email", "aria-describedby": "em-err" });
  assert.equal(fieldError(helpText, lookup), "");
  // native constraint failure on a filled field
  const n = el("INPUT", { type: "email" }, { validity: { valid: false, valueMissing: false }, validationMessage: "Please include an '@'" });
  assert.equal(fieldError(n, lookup), "Please include an '@'");
  // a required empty field is "missing", not an error
  const req = el("INPUT", { type: "text" }, { validity: { valid: false, valueMissing: true }, validationMessage: "Please fill out this field." });
  assert.equal(fieldError(req, lookup), "");
  assert.equal(isMissing(req), true);
  // mat-error inside the field's own mat-form-field
  const mff = { querySelector: () => ({ innerText: "Name is required" }) };
  const m = el("INPUT", { type: "text" }, { closest: (s) => (s.includes("mat-form-field") ? mff : null) });
  assert.equal(fieldError(m, lookup), "Name is required");
  // a valid field with no signals has no error
  assert.equal(fieldError(el("INPUT", { type: "text" }, { validity: { valid: true } }), lookup), "");
});
