// Pilot — page-side library.
//
// Injected into the tab's isolated world with chrome.scripting.executeScript
// ({files}), where it installs globalThis.__pilot. The service worker then
// calls __pilot.<fn>(...) per action. One file means one accessible-name
// function, one element collector and one resolver shared by snap, clickN,
// form, type and hover, instead of a copy per injected function.
//
// The pure helpers (accessibleName, roleOf, textMatches, parseRef,
// validateValue, fieldError) take plain objects that look like elements, so
// the tests run them under node.
//
// Refs: every element Pilot reports gets a ref "p<doc>r<seq>". <doc> is the
// document's number in this tab, handed out by the service worker the first
// time Pilot touches a document (so it changes on every navigation, and every
// iframe document has its own). A ref from an older document is refused with
// "page changed since that snap" instead of silently hitting whatever element
// now carries the same sequence number.

(function (root) {
  const P = {};
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  // ── pure helpers ──────────────────────────────────────────────────────────

  const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number",
    "date", "datetime-local", "month", "week", "time", "color", "range"]);
  const isTextInput = (el) => el && el.tagName === "INPUT" && TEXT_TYPES.has(String(el.type || "").toLowerCase());
  const isEditable = (el) => !!el && (isTextInput(el) || el.tagName === "TEXTAREA" || el.isContentEditable === true);

  // Visible text of a label, minus the controls inside it (a wrapping label's
  // own select would otherwise add every option text to the name).
  function labelText(label, self) {
    let s = "";
    const visit = (n) => {
      for (const c of n.childNodes || []) {
        if (c.nodeType === 3) s += c.nodeValue + " ";
        else if (c.nodeType === 1) {
          if (c === self || /^(INPUT|SELECT|TEXTAREA|SCRIPT|STYLE|BUTTON)$/.test(c.tagName)) continue;
          visit(c);
        }
      }
    };
    visit(label);
    return clean(s);
  }

  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "A") return el.hasAttribute && el.hasAttribute("href") ? "link" : "generic";
    if (tag === "SELECT") return el.multiple || Number(el.size) > 1 ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      const t = String(el.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio" || t === "file") return t;
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (el.getAttribute && el.getAttribute("list")) return "combobox";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    if (tag === "DIALOG") return "dialog";
    return String(tag || "").toLowerCase();
  }

  // Roles whose name comes from their own text (ARIA "name from content").
  const NAME_FROM_CONTENT = new Set(["button", "link", "tab", "option", "menuitem", "menuitemcheckbox",
    "menuitemradio", "treeitem", "switch", "heading", "cell", "row", "label", "generic", "listitem"]);

  // One accessible-name function for every reader (snap, form, clickN,
  // clickText, type errors). Order follows the ARIA name computation, with the
  // Angular Material label as an extra source before placeholder.
  function accessibleName(el) {
    if (!el || !el.getAttribute) return "";
    const lookup = (id) => {
      const r = el.getRootNode ? el.getRootNode() : null;
      const doc = el.ownerDocument || (typeof document !== "undefined" ? document : null);
      return (r && r.getElementById && r.getElementById(id)) || (doc && doc.getElementById && doc.getElementById(id)) || null;
    };
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => { const n = lookup(id); return n ? (n.innerText || n.textContent || "") : ""; }).join(" "));
      if (t) return t;
    }
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const tag = el.tagName;
    const isField = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el.isContentEditable === true ||
      ["textbox", "combobox", "searchbox", "checkbox", "radio", "switch", "slider", "spinbutton"].includes(el.getAttribute("role") || "");
    if (isField) {
      for (const l of el.labels || []) {
        const t = labelText(l, el);
        if (t) return t;
      }
      if (el.id) {
        const r = el.getRootNode ? el.getRootNode() : null;
        const l = r && r.querySelector ? r.querySelector('label[for="' + String(el.id).replace(/"/g, '\\"') + '"]') : null;
        const t = l ? labelText(l, el) : "";
        if (t) return t;
      }
      const wrap = el.closest && el.closest("label");
      if (wrap) {
        const t = labelText(wrap, el);
        if (t) return t;
      }
      const mff = el.closest && el.closest("mat-form-field, .mat-mdc-form-field, .mat-form-field");
      if (mff && mff.querySelector) {
        const ml = mff.querySelector("mat-label, label, .mat-mdc-floating-label");
        const t = ml ? labelText(ml, el) : "";
        if (t) return t;
      }
    }
    if (tag === "INPUT") {
      const t = String(el.type || "").toLowerCase();
      if ((t === "submit" || t === "button" || t === "reset") && clean(el.value)) return clean(el.value);
      if (t === "image" && clean(el.getAttribute("alt"))) return clean(el.getAttribute("alt"));
    }
    if (tag === "IMG" && clean(el.getAttribute("alt"))) return clean(el.getAttribute("alt"));
    if (!isField && NAME_FROM_CONTENT.has(roleOf(el))) {
      const t = clean(el.innerText != null ? el.innerText : el.textContent);
      if (t) return t;
      // Icon buttons: a labelled child, an img alt, or an svg <title>.
      const inner = el.querySelector && el.querySelector("[aria-label], img[alt], svg title");
      if (inner) {
        const v = clean(inner.getAttribute("aria-label") || inner.getAttribute("alt") || inner.textContent);
        if (v) return v;
      }
    }
    const ph = clean(el.getAttribute("placeholder") || el.getAttribute("aria-placeholder"));
    if (ph) return ph;
    return clean(el.getAttribute("title"));
  }

  // Did the text the agent typed stick? Exact, or equal once a mask's
  // spacing/punctuation is stripped ("4242 4242" for "42424242").
  function textMatches(value, want) {
    const v = String(value == null ? "" : value);
    const w = String(want == null ? "" : want);
    if (v === w) return true;
    if (v.replace(/\r\n?/g, "\n").trim() === w.replace(/\r\n?/g, "\n").trim()) return true;
    const alnum = (s) => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
    return alnum(w).length > 0 && alnum(v) === alnum(w);
  }

  // "p4r12" -> { doc: 4, seq: 12 }. Old refs ("r12") are refused: they carry
  // no document, so they cannot be checked against the page they came from.
  function parseRef(ref) {
    const m = /^p(\d+)r(\d+)$/.exec(String(ref == null ? "" : ref).trim());
    if (m) return { doc: Number(m[1]), seq: Number(m[2]) };
    if (/^r\d+$/.test(String(ref).trim())) return { legacy: true };
    return null;
  }

  // Inputs whose value must be set with the native setter (insertText cannot
  // type into them) and whose value has a fixed format the browser enforces:
  // a bad value would be silently sanitised to "" and wipe the field.
  const NATIVE_TYPES = new Set(["date", "time", "datetime-local", "month", "week", "color", "range", "number"]);
  const pad = (n) => String(n).padStart(2, "0");

  function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1) return false;
    const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    return d <= days;
  }
  function normTime(v) {
    let m = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d{1,3})?)?$/.exec(v);
    if (m) return pad(m[1]) + ":" + m[2] + (m[3] ? ":" + m[3] + (m[4] || "") : "");
    m = /^(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?$/i.exec(v);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) {
      let h = Number(m[1]) % 12;
      if (m[3].toLowerCase() === "p") h += 12;
      return pad(h) + ":" + (m[2] || "00");
    }
    return null;
  }

  // Check (and normalise) a value for a typed input BEFORE touching the field.
  // { ok: true, value } or { ok: false, error } with the expected format.
  function validateValue(type, raw) {
    const t = String(type || "").toLowerCase();
    const v = String(raw == null ? "" : raw).trim();
    const bad = (fmt) => ({ ok: false, error: "'" + String(raw) + "' is not a valid " + t + " value; use " + fmt + " (the field was left unchanged)" });
    if (!NATIVE_TYPES.has(t)) return { ok: true, value: String(raw == null ? "" : raw) };
    if (v === "" && t !== "range" && t !== "color") return { ok: true, value: "" };
    switch (t) {
      case "number":
      case "range":
        if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return bad("a number like 42 or 3.5");
        return { ok: true, value: v.replace(/^\+/, "") };
      case "date": {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
        if (!m || !validDate(+m[1], +m[2], +m[3])) return bad("YYYY-MM-DD, e.g. 2026-10-08");
        return { ok: true, value: v };
      }
      case "time": {
        const n = normTime(v);
        return n ? { ok: true, value: n } : bad("HH:MM in 24h, e.g. 14:30");
      }
      case "datetime-local": {
        const m = /^(\d{4})-(\d{2})-(\d{2})[T ](.+)$/.exec(v);
        const tm = m && normTime(m[4]);
        if (!m || !tm || !validDate(+m[1], +m[2], +m[3])) return bad("YYYY-MM-DDTHH:MM, e.g. 2026-10-08T14:30");
        return { ok: true, value: m[1] + "-" + m[2] + "-" + m[3] + "T" + tm };
      }
      case "month": {
        const m = /^(\d{4})-(\d{2})$/.exec(v);
        if (!m || +m[2] < 1 || +m[2] > 12) return bad("YYYY-MM, e.g. 2026-10");
        return { ok: true, value: v };
      }
      case "week": {
        const m = /^(\d{4})-W(\d{2})$/i.exec(v);
        if (!m || +m[2] < 1 || +m[2] > 53) return bad("YYYY-Www, e.g. 2026-W41");
        return { ok: true, value: m[1] + "-W" + m[2] };
      }
      case "color": {
        let m = /^#?([0-9a-f]{6})$/i.exec(v);
        if (m) return { ok: true, value: "#" + m[1].toLowerCase() };
        m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
        if (m) return { ok: true, value: ("#" + m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toLowerCase() };
        return bad("#rrggbb, e.g. #ff8800");
      }
    }
    return { ok: true, value: v };
  }

  // The error message tied to ONE field, or "". Only field-bound signals
  // count: aria-invalid with its aria-errormessage / aria-describedby text, a
  // native constraint failure on a field that has a value, or a mat-error
  // inside the field's own mat-form-field. Page-wide banners never count.
  function fieldError(el, lookup) {
    if (!el || !el.getAttribute) return "";
    const textOf = (n) => clean(n && (n.innerText != null ? n.innerText : n.textContent));
    const msgs = [];
    if (el.getAttribute("aria-invalid") === "true") {
      for (const attr of ["aria-errormessage", "aria-describedby"]) {
        for (const id of String(el.getAttribute(attr) || "").split(/\s+/).filter(Boolean)) {
          const t = textOf(lookup ? lookup(id) : null);
          if (t) msgs.push(t);
        }
        if (msgs.length) break;
      }
      if (!msgs.length) msgs.push("invalid");
    } else if (el.validity && el.validity.valid === false && !el.validity.valueMissing && el.validationMessage) {
      msgs.push(clean(el.validationMessage));
    }
    const mff = el.closest && el.closest("mat-form-field, .mat-mdc-form-field, .mat-form-field");
    if (mff && mff.querySelector) {
      const me = mff.querySelector("mat-error, .mat-mdc-form-field-error, .mat-error");
      const t = textOf(me);
      if (t && !msgs.includes(t)) msgs.push(t);
    }
    return [...new Set(msgs)].join("; ").slice(0, 160);
  }

  // Is the field required and still empty? Reported as "missing", not as an
  // error: an untouched required field is not a mistake yet.
  function isMissing(el) {
    return !!(el && el.validity && el.validity.valueMissing);
  }

  P.accessibleName = accessibleName;
  P.roleOf = roleOf;
  P.textMatches = textMatches;
  P.isEditable = isEditable;
  P.parseRef = parseRef;
  P.validateValue = validateValue;
  P.fieldError = fieldError;
  P.isMissing = isMissing;
  P.NATIVE_TYPES = NATIVE_TYPES;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = P;
    return;
  }


  // ── DOM helpers (browser only) ────────────────────────────────────────────

  // Every element matching `selector` under root, in document order,
  // descending into open shadow roots.
  function deepAll(selector, from) {
    const out = [];
    const walk = (r) => {
      const tw = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
      let n = r.nodeType === 1 ? r : tw.nextNode();
      while (n) {
        if (n.matches(selector)) out.push(n);
        if (n.shadowRoot) walk(n.shadowRoot);
        n = tw.nextNode();
      }
    };
    walk(from || document);
    return out;
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  const deepFromPoint = (x, y) => {
    let e = document.elementFromPoint(x, y);
    while (e && e.shadowRoot) {
      const inner = e.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  };
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  };
  const touchesViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const lookupId = (el) => (id) => {
    const r = el.getRootNode ? el.getRootNode() : null;
    return (r && r.getElementById && r.getElementById(id)) || document.getElementById(id);
  };

  // ── document number + refs ────────────────────────────────────────────────

  // Called by the worker right after injecting. A document Pilot touched
  // before (a worker restart re-injects) keeps the number stored on it.
  P.init = (boot, candidate) => {
    const de = document.documentElement;
    const had = de && de.getAttribute("data-pilot-doc");
    P.doc = had ? Number(had) : Number(candidate);
    if (de && !had) de.setAttribute("data-pilot-doc", String(P.doc));
    P.boot = boot;
    return { doc: P.doc };
  };
  P.docInfo = () => ({ doc: P.doc, url: location.href, top: window === window.top });

  function refOf(el) {
    let r = el.getAttribute("data-pilot-ref");
    const prefix = "p" + P.doc + "r";
    if (r && r.startsWith(prefix)) return r;
    const de = document.documentElement;
    const seq = Number(de.getAttribute("data-pilot-seq") || 0) + 1;
    de.setAttribute("data-pilot-seq", String(seq));
    r = prefix + seq;
    el.setAttribute("data-pilot-ref", r);
    return r;
  }
  const STALE = { ok: false, stale: true, error: "page changed since that snap — snap again", hint: "refs are only valid on the page they came from; run {\"action\":\"snap\"} and use the new refs" };
  function byRef(ref) {
    const p = parseRef(ref);
    if (!p) return { fail: { ok: false, error: "'" + ref + "' is not a ref (refs look like p4r12)", hint: "copy a ref from the last snap" } };
    if (p.legacy) return { fail: { ok: false, stale: true, error: "'" + ref + "' is an old-style ref without a page number", hint: "snap again; refs now look like p4r12" } };
    if (p.doc !== P.doc) return { fail: STALE };
    const el = deepAll('[data-pilot-ref="' + CSS.escape(String(ref)) + '"]')[0] || null;
    if (!el) return { fail: { ok: false, error: "ref " + ref + " is gone (the page removed or re-rendered it)", hint: "snap again for fresh refs" } };
    return { el };
  }

  // Raw value for verification; valueOf masks passwords for display.
  function rawValue(el) {
    if (!el) return "";
    if (el.tagName === "SELECT") { const o = el.selectedOptions && el.selectedOptions[0]; return o ? clean(o.label || o.text) : ""; }
    if (el.tagName === "INPUT" && el.type === "file") return [...(el.files || [])].map((f) => f.name).join(", ");
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return String(el.value ?? "");
    if (el.isContentEditable) return String(el.innerText ?? "");
    return "";
  }
  function valueOf(el) {
    if (el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type)) return undefined;
    if (el.tagName === "INPUT" && /^(submit|button|reset|image)$/i.test(el.type)) return undefined;
    const v = rawValue(el);
    if (el.tagName === "INPUT" && el.type === "password") return v ? "*".repeat(v.length) : "";
    return v.length > 80 ? v.slice(0, 80) + "…" : v;
  }
  const isField = (el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable ||
    /^(textbox|combobox|searchbox)$/.test(el.getAttribute("role") || "");

  // Plain description of an element for replies and field lists.
  // Draggable blocks (kanban cards, sortable columns) have no ARIA name;
  // their text is the only handle a driver has.
  const nameOf = (el) => accessibleName(el) ||
    (el.getAttribute("draggable") === "true" ? clean(el.innerText).slice(0, 80) : "");

  function describe(el, opts) {
    const role = roleOf(el);
    const d = { ref: refOf(el), role, name: nameOf(el).slice(0, 80), tag: el.tagName.toLowerCase() };
    if (el.getAttribute("draggable") === "true") d.draggable = true;
    if (el.tagName === "INPUT") d.type = el.type;
    if (el.name) d.field = el.name;
    const v = valueOf(el);
    if (v !== undefined && (v !== "" || isField(el))) d.value = v;
    if ((el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type))) d.checked = el.checked;
    else if (el.getAttribute("aria-checked")) d.checked = el.getAttribute("aria-checked") === "true";
    if (el.getAttribute("aria-expanded")) d.expanded = el.getAttribute("aria-expanded") === "true";
    if (el.required || el.getAttribute("aria-required") === "true") d.required = true;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") d.disabled = true;
    if (el.readOnly && isField(el)) d.readonly = true;
    if (el.tagName === "A" && el.target && !/^_(self|parent|top)$/i.test(el.target)) d.newTab = true;
    if (opts && opts.options && el.tagName === "SELECT") {
      d.options = [...el.options].slice(0, 40).map((o) => ({ value: o.value, label: clean(o.label || o.text) }));
    }
    if (!opts || opts.pos !== false) Object.assign(d, center(el));
    return d;
  }

  // ── the shared item collector (snap, hover n, visibleTexts) ───────────────

  const ITEM_SEL = [
    "a", "button", "input:not([type=hidden])", "textarea", "select", "summary", "label",
    "[role=button]", "[role=link]", "[role=tab]", "[role=option]", "[role=menuitem]",
    "[role=menuitemcheckbox]", "[role=menuitemradio]", "[role=combobox]", "[role=textbox]",
    "[role=searchbox]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=treeitem]",
    "[contenteditable]:not([contenteditable=false])", "[tabindex]:not([tabindex='-1'])", "[draggable=true]",
  ].join(", ");
  const INTERACTIVE_SEL = "a, button, input, textarea, select, summary, [role], [contenteditable]";
  const OVERLAY_SEL = "[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true], [role=menu], [role=listbox]";
  const isNative = (el) => /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/.test(el.tagName);

  // Visible items in priority order: inside an open dialog/menu/listbox
  // first, then on screen, then the rest (each group in document order).
  // `pri` is 0/1/2 for that order. Collection stops at a hard cap so huge
  // pages stay fast; `more` says how many were left out.
  function listItems(cap) {
    const overlays = deepAll(OVERLAY_SEL).filter(visible);
    const inOverlay = (el) => overlays.some((o) => o === el || o.contains(el));
    const groups = [[], [], []];
    let total = 0;
    for (const el of deepAll(ITEM_SEL)) {
      if (!visible(el)) continue;
      if (el.tagName === "LABEL") {
        // Labels only matter when they stand in for a hidden control
        // (custom-styled checkboxes); otherwise the control itself is listed.
        const c = el.control;
        if (!c || visible(c)) continue;
      } else if (el.isContentEditable && el.parentElement && el.parentElement.isContentEditable) {
        continue;
      } else if (!isNative(el) && !el.getAttribute("role") && !el.isContentEditable) {
        // A bare [tabindex]/[draggable] wrapper: skip it when it holds a real control.
        if (el.querySelector(INTERACTIVE_SEL)) continue;
      }
      const name = nameOf(el);
      const field = isField(el) || (el.tagName === "INPUT");
      const iconBtn = !name && roleOf(el) === "button";
      if (!name && !field && !iconBtn) continue;
      const pri = overlays.length && inOverlay(el) ? 0 : touchesViewport(el) ? 1 : 2;
      groups[pri].push(el);
      total++;
      if (total >= 1500) break;
    }
    const all = [];
    groups.forEach((g, pri) => g.forEach((el) => all.push({ el, pri })));
    const limit = cap || 400;
    return { list: all.slice(0, limit), more: Math.max(0, all.length - limit), overlay: overlays.length > 0 };
  }

  // ── target resolution: ref | sel | text ─────────────────────────────────

  const CLICK_SEL = ITEM_SEL + ", [onclick], span, div, li, td, p";
  function byText(want, exact) {
    const w = String(want);
    const wLc = w.toLowerCase();
    const rank = (t) => {
      const lc = t.toLowerCase();
      if (t === w) return 0;
      if (exact) return 99;
      if (lc === wLc) return 1;
      if (t.startsWith(w)) return 2;
      if (lc.startsWith(wLc)) return 3;
      if (lc.includes(wLc)) return 4;
      return 99;
    };
    let best = null;
    for (const el of deepAll(CLICK_SEL)) {
      if (!visible(el)) continue;
      const t = isNative(el) || el.getAttribute("role") ? (accessibleName(el) || clean(el.innerText)) : clean(el.innerText);
      if (!t) continue;
      const tier = rank(t);
      if (tier === 99) continue;
      const score = [tier, isNative(el) || el.getAttribute("role") || el.tagName === "LABEL" ? 0 : 1, t.length];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] ||
          (score[1] === best.score[1] && score[2] < best.score[2])))) best = { el, score };
    }
    return best ? { el: best.el, match: ["exact", "exact-ci", "starts", "starts-ci", "contains-ci"][best.score[0]] } : null;
  }

  function visibleTexts() {
    const seen = new Set();
    const out = [];
    for (const { el } of listItems(60).list) {
      const t = accessibleName(el).slice(0, 50);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 20) break;
    }
    return out;
  }

  function fieldList() {
    return deepAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=combobox]")
      .filter(visible).slice(0, 25).map((el) => {
        const d = describe(el, { pos: false });
        return { ref: d.ref, role: d.role, name: d.name || d.field || "", ...(d.value ? { value: d.value } : {}) };
      });
  }

  // spec: { ref } | { sel } | { text, exact }. notFound marks a miss the
  // worker may retry in another frame (sel/text only; a ref names its frame).
  function resolve(spec) {
    spec = spec || {};
    if (spec.ref != null && spec.ref !== "") {
      const r = byRef(spec.ref);
      if (r.fail) return r;
      return { el: r.el, how: "ref" };
    }
    if (spec.sel) {
      let el = null;
      try { el = document.querySelector(spec.sel) || deepAll(spec.sel)[0] || null; } catch (e) {
        return { fail: { ok: false, error: "invalid CSS selector '" + spec.sel + "'", hint: "use a ref from snap instead" } };
      }
      if (!el) return { fail: { ok: false, notFound: true, error: "no element matches selector '" + spec.sel + "'", hint: "use a ref from snap, or clickText" } };
      return { el, how: "sel" };
    }
    if (spec.text != null && spec.text !== "") {
      const hit = byText(spec.text, spec.exact);
      if (!hit) return { fail: { ok: false, notFound: true, error: "no clickable element with text '" + spec.text + "'" + (spec.exact ? " (exact)" : ""), hint: "pick one of visibleTexts, or snap and use a ref" } };
      return { el: hit.el, how: "text", match: hit.match };
    }
    return { fail: { ok: false, error: "need one of: ref, sel, text", hint: "e.g. {\"action\":\"click\",\"ref\":\"p1r3\"}" } };
  }

  // ── visual feedback ───────────────────────────────────────────────────────

  function feedback(x, y, show) {
    if (show === false) return;
    const base = "cb-bridge-";
    let cursor = document.getElementById(base + "cursor");
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = base + "cursor";
      cursor.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;z-index:2147483647;display:none;";
      cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.8))"><path d="M4 2l16 9.5-6.8 1.6L9 20.5z" fill="#fff" stroke="#c00" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(cursor);
    }
    if (window === window.top && !document.getElementById(base + "glow")) {
      const glow = document.createElement("div");
      glow.id = base + "glow";
      glow.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;box-sizing:border-box;" +
        "border:3px solid rgba(255,110,110,0.55);box-shadow:inset 0 0 48px 14px rgba(255,90,90,0.26), 0 0 40px 8px rgba(255,90,90,0.35);";
      document.documentElement.appendChild(glow);
    }
    cursor.style.left = x + "px";
    cursor.style.top = y + "px";
    cursor.style.display = "block";
  }

  // ── frames: where is this document inside the top page? ──────────────────

  // Same-origin chain: add up each frame element's content-box position.
  // Returns null as soon as a parent is cross-origin (frameElement is null).
  P.selfOffset = () => {
    let x = 0, y = 0, w = window;
    try {
      while (w !== w.top) {
        const fe = w.frameElement;
        if (!fe) return null;
        const r = fe.getBoundingClientRect();
        x += r.left + fe.clientLeft + (parseFloat(getComputedStyle(fe).paddingLeft) || 0);
        y += r.top + fe.clientTop + (parseFloat(getComputedStyle(fe).paddingTop) || 0);
        w = w.parent;
      }
    } catch { return null; }
    return { x: Math.round(x), y: Math.round(y) };
  };
  // Cross-origin: the child posts a token to its parent; the parent finds the
  // <iframe> whose contentWindow sent it and reports that frame's position.
  const probes = {};
  P.probeListen = (token) => {
    probes[token] = null;
    const h = (e) => {
      if (!e.data || e.data.__pilotProbe !== token) return;
      for (const f of deepAll("iframe, frame")) {
        if (f.contentWindow === e.source) {
          const r = f.getBoundingClientRect();
          probes[token] = { x: Math.round(r.left + f.clientLeft), y: Math.round(r.top + f.clientTop) };
        }
      }
      window.removeEventListener("message", h, true);
    };
    window.addEventListener("message", h, true);
    return true;
  };
  P.probeSend = (token) => { window.parent.postMessage({ __pilotProbe: token }, "*"); return true; };
  P.probeRead = (token) => { const r = probes[token]; delete probes[token]; return r; };

  // ── probes: did trusted input actually reach the page? ────────────────────
  // A capture listener on window sees every real event before the page does.
  // If none of the expected events arrive, the debugger input was dropped and
  // the caller may safely fall back to synthetic events (no double action).

  let probe = null;
  P.armProbe = (kinds) => {
    if (probe) probe.off();
    const st = { seen: [], trusted: false };
    const h = (e) => { st.seen.push(e.type); if (e.isTrusted) st.trusted = true; };
    for (const k of kinds) window.addEventListener(k, h, true);
    st.off = () => { for (const k of kinds) window.removeEventListener(k, h, true); };
    probe = st;
    return true;
  };
  P.readProbe = () => {
    if (!probe) return { landed: null };
    probe.off();
    const r = { landed: probe.seen.length > 0, trusted: probe.trusted, seen: [...new Set(probe.seen)] };
    probe = null;
    return r;
  };

  const tag = (el, mark) => {
    const a = mark || "data-pilot-t";
    for (const o of deepAll("[" + a + "]")) o.removeAttribute(a);
    el.setAttribute(a, "1");
  };
  const tagged = (mark) => deepAll("[" + (mark || "data-pilot-t") + "]")[0] || null;
  const checkedOf = (el) => {
    const input = el.tagName === "INPUT" ? el : (el.control || (el.querySelector && el.querySelector("input")) || null);
    if (input && (input.type === "radio" || input.type === "checkbox")) return input.checked;
    const ac = el.getAttribute && el.getAttribute("aria-checked");
    return ac ? ac === "true" : undefined;
  };

  const fireClick = (el, x, y) => {
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  };

  // Would clicking this element open a new tab or window? (a link with a
  // target other than _self/_parent/_top, or one inherited from <base>).
  function opensNewTab(el) {
    const a = el.closest && el.closest("a[href]");
    if (!a) return false;
    const base = document.querySelector("base[target]");
    const t = (a.getAttribute("target") || (base && base.getAttribute("target")) || "").trim();
    return !!t && !/^_(self|parent|top)$/i.test(t);
  }

  // ── click / hover ─────────────────────────────────────────────────────────

  // Resolve, scroll into view, report the center for a debugger click, and
  // arm the probe. covered:true means a coordinate click would hit an overlay.
  P.locate = (spec, show) => {
    const r = resolve(spec);
    if (r.fail) return { ...r.fail, ...(r.fail.stale ? {} : { visibleTexts: visibleTexts() }) };
    const el = r.el;
    if (!inViewport(el)) el.scrollIntoView({ block: "center", inline: "center" });
    const c = center(el);
    feedback(c.x, c.y, show);
    const hit = deepFromPoint(c.x, c.y);
    const reachable = !!hit && (hit === el || el.contains(hit) || hit.contains(el) ||
      (el.control && (hit === el.control || el.control.contains(hit))) ||
      (el.labels && [...el.labels].some((l) => l === hit || l.contains(hit))));
    tag(el);
    const meta = { clicked: accessibleName(el).slice(0, 60) || el.tagName.toLowerCase(), ref: refOf(el), role: roleOf(el) };
    if (r.match) meta.match = r.match;
    P.armProbe(["pointerdown", "mousedown", "click"]);
    const nt = opensNewTab(el);
    return { ok: true, x: c.x, y: c.y, covered: !reachable, newTab: nt, ...(nt ? { href: el.closest("a[href]").href } : {}), meta };
  };
  P.remeasure = () => {
    const el = tagged();
    return el ? center(el) : null;
  };
  P.clickTagged = () => {
    const el = tagged();
    if (!el) return { ok: false, error: "target vanished before the click", hint: "snap again" };
    const c = center(el);
    fireClick(el, c.x, c.y);
    return { ok: true };
  };
  // fallback: if the debugger's click never reached the page, click
  // synthetically now (safe: nothing landed, so nothing clicks twice).
  P.confirmClick = (fallback) => {
    const el = tagged();
    const out = P.readProbe();
    if (fallback && out.landed === false && el && el.isConnected) {
      const c = center(el);
      fireClick(el, c.x, c.y);
      out.fellBack = true;
    }
    if (el) {
      el.removeAttribute("data-pilot-t");
      const chk = checkedOf(el);
      if (chk !== undefined) out.checkedNow = chk;
    }
    return out;
  };
  P.clickXY = (x, y, show) => {
    const el = deepFromPoint(x, y);
    if (!el) return { ok: false, error: "no element at " + x + "," + y, hint: "coordinates are viewport pixels; run snap for fresh ones" };
    feedback(x, y, show);
    fireClick(el, x, y);
    return { ok: true, clicked: accessibleName(el).slice(0, 60) || el.tagName.toLowerCase(), ref: refOf(el), x, y };
  };
  P.hoverXY = (x, y, show) => {
    const el = deepFromPoint(x, y);
    if (!el) return { ok: false, error: "no element at " + x + "," + y, hint: "coordinates are viewport pixels; run snap for fresh ones" };
    feedback(x, y, show);
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent("pointerover", opts));
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    try { el.dispatchEvent(new MouseEvent("mouseenter", opts)); } catch { /* React reads mouseover */ }
    return { ok: true, hovered: accessibleName(el).slice(0, 60) || el.tagName.toLowerCase(), x, y };
  };
  P.hoverLocate = (spec, show) => {
    const r = resolve(spec);
    if (r.fail) return r.fail;
    if (!inViewport(r.el)) r.el.scrollIntoView({ block: "center", inline: "center" });
    const c = center(r.el);
    feedback(c.x, c.y, show);
    tag(r.el);
    return { ok: true, hovered: accessibleName(r.el).slice(0, 60), ref: refOf(r.el), x: c.x, y: c.y };
  };

  // ── drag ──────────────────────────────────────────────────────────────────

  P.dragLocate = (fromSpec, toSpec, show) => {
    const a = resolve(fromSpec);
    if (a.fail) return { ...a.fail, which: "from" };
    const b = resolve(toSpec);
    if (b.fail) return { ...b.fail, which: "to" };
    if (!inViewport(a.el)) a.el.scrollIntoView({ block: "center", inline: "center" });
    if (!inViewport(b.el)) b.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!touchesViewport(a.el) || !touchesViewport(b.el)) {
      return { ok: false, error: "from and to do not fit on one screen", hint: "scroll so both are visible, or drag in two steps" };
    }
    tag(a.el, "data-pilot-t");
    tag(b.el, "data-pilot-t2");
    const fc = center(a.el), tc = center(b.el);
    feedback(fc.x, fc.y, show);
    P.armProbe(["dragstart", "drop", "mousedown", "mouseup", "pointerup"]);
    return {
      ok: true,
      html5: !!(a.el.closest && a.el.closest("[draggable=true]")),
      from: { x: fc.x, y: fc.y, name: accessibleName(a.el).slice(0, 40) || clean(a.el.innerText).slice(0, 40), ref: refOf(a.el) },
      to: { x: tc.x, y: tc.y, name: accessibleName(b.el).slice(0, 40) || clean(b.el.innerText).slice(0, 40), ref: refOf(b.el) },
    };
  };
  // HTML5 drag and drop with a shared DataTransfer, for pages the debugger's
  // native drag did not reach.
  P.dragSynthetic = () => {
    const a = tagged("data-pilot-t"), b = tagged("data-pilot-t2");
    if (!a || !b) return { ok: false, error: "drag source or target vanished", hint: "snap again" };
    const dt = new DataTransfer();
    const ac = center(a), bc = center(b);
    const ev = (type, el, c) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: c.x, clientY: c.y, dataTransfer: dt }));
    ev("dragstart", a, ac);
    ev("drag", a, ac);
    ev("dragenter", b, bc);
    ev("dragover", b, bc);
    ev("drop", b, bc);
    ev("dragend", a, bc);
    a.removeAttribute("data-pilot-t");
    b.removeAttribute("data-pilot-t2");
    return { ok: true };
  };
  P.dragDone = () => {
    for (const m of ["data-pilot-t", "data-pilot-t2"]) { const e = tagged(m); if (e) e.removeAttribute(m); }
    return P.readProbe();
  };

  // ── typing ────────────────────────────────────────────────────────────────

  // Pick the field to type into. With a ref/sel: that element (or the one
  // text field inside it). Without: the focused field, else the only visible
  // one. A miss is an error with the field list, never a silent guess.
  function pickField(spec) {
    const has = spec && (spec.ref || spec.sel);
    if (has) {
      const r = resolve(spec);
      if (r.fail) return { fail: r.fail.stale ? r.fail : { ...r.fail, fields: fieldList(), hint: "use a ref from fields (or snap), e.g. {\"action\":\"type\",\"ref\":\"p1r3\",\"text\":\"...\"}" } };
      let el = r.el;
      if (el.tagName === "INPUT" && el.type === "file") {
        return { fail: { ok: false, error: "that is a file input", hint: "use {\"action\":\"upload\",\"ref\":\"" + refOf(el) + "\",\"path\":\"/abs/file\"}" } };
      }
      if (!isEditable(el)) {
        const inner = deepAll("input, textarea, [contenteditable]:not([contenteditable=false])", el).find((x) => isEditable(x));
        if (!inner) return { fail: { ok: false, error: "target is not a text field (" + roleOf(el) + ")", fields: fieldList(), hint: "pick a text field from fields" } };
        el = inner;
      }
      return { el };
    }
    const a = deepActive();
    if (isEditable(a)) return { el: a };
    const vis = deepAll("input, textarea, [contenteditable]:not([contenteditable=false])").filter((x) => isEditable(x) && visible(x));
    if (vis.length === 1) return { el: vis[0] };
    return { fail: { ok: false, notFound: !vis.length, error: vis.length ? "no field is focused and there are " + vis.length + " text fields" : "no text field on the page", fields: fieldList(), hint: "pass a ref, e.g. {\"action\":\"type\",\"ref\":\"p1r3\",\"text\":\"...\"}" } };
  }

  // Focus the field in-page and select its content, so the next trusted
  // insertText replaces it. Arms an input probe. Typed inputs (number, date,
  // time, color, range, ...) are reported as native:true: the worker sets
  // them with setNative instead, after validating the value.
  P.focusField = (spec, clear, show) => {
    const p = pickField(spec);
    if (p.fail) return p.fail;
    const el = p.el;
    if (el.disabled) return { ok: false, error: "field is disabled", field: describe(el, { pos: false }) };
    if (el.readOnly) return { ok: false, error: "field is read-only", field: describe(el, { pos: false }) };
    if (!inViewport(el)) el.scrollIntoView({ block: "center" });
    const c = center(el);
    feedback(c.x, c.y, show);
    tag(el);
    const d = describe(el, { pos: false });
    const type = el.tagName === "INPUT" ? String(el.type || "").toLowerCase() : "";
    if (NATIVE_TYPES.has(type)) return { ok: true, native: true, type, into: d.name || d.field || d.tag, ref: d.ref, role: d.role };
    el.focus({ preventScroll: true });
    if (clear) {
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        try { el.select(); } catch { /* not selectable */ }
      } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    P.armProbe(["beforeinput", "input", "keydown"]);
    return { ok: true, into: d.name || d.field || d.tag, ref: d.ref, role: d.role, focused: deepActive() === el, before: rawValue(el) };
  };

  // Typed inputs: validate first, set with the native setter, check the
  // browser kept it (and that it passes min/max/step), and only then fire
  // input/change. A rejected value is put back, so nothing is wiped.
  P.setNative = (value) => {
    const el = tagged();
    if (!el) return { ok: false, error: "field vanished", hint: "snap again" };
    const type = String(el.type || "").toLowerCase();
    const v = validateValue(type, value);
    if (!v.ok) return { ok: false, error: v.error, valueNow: el.value, hint: "the field still holds '" + el.value + "'" };
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const before = el.value;
    set.call(el, v.value);
    const now = el.value;
    const vs = el.validity || {};
    let why = null;
    if (now !== v.value) why = "the browser changed it to '" + now + "'";
    else if (vs.rangeUnderflow) why = "below the minimum " + el.min;
    else if (vs.rangeOverflow) why = "above the maximum " + el.max;
    else if (vs.stepMismatch) why = "not a multiple of step " + (el.step || "1");
    else if (vs.badInput) why = "the browser rejected it";
    if (why) {
      set.call(el, before);
      return { ok: false, error: "'" + value + "' does not fit this " + type + " field: " + why + " (the field was left unchanged)", valueNow: before };
    }
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.removeAttribute("data-pilot-t");
    return { ok: true, valueNow: el.value, via: "native-setter" };
  };

  // After trusted typing: did it land, and did the value stick?
  P.checkField = (want, mode) => {
    const el = tagged();
    const pr = P.readProbe();
    if (!el) return { gone: true, ...pr };
    const v = rawValue(el);
    const stuck = mode === "none" ? true : textMatches(v, want);
    const shown = el.type === "password" ? "*".repeat(v.length) : v.slice(0, 80);
    return { valueNow: shown, stuck, ...pr };
  };

  // Synthetic last resort: native setter + the events frameworks listen on.
  // Frameworks track their own value state, so a bare `.value =` is invisible
  // to React/Angular/Vue; the prototype setter plus bubbling input/change is
  // what they see. Blur fires without moving real focus.
  P.setTagged = (text, perKey) => {
    const el = tagged();
    if (!el) return { ok: false, error: "field vanished" };
    el.focus({ preventScroll: true });
    const fire = (type, data) => {
      try { el.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data })); }
      catch { el.dispatchEvent(new Event(type, { bubbles: true })); }
    };
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, "value").set;
      if (perKey) {
        set.call(el, "");
        for (const ch of String(text)) {
          const o = { key: ch, bubbles: true, cancelable: true, composed: true };
          el.dispatchEvent(new KeyboardEvent("keydown", o));
          el.dispatchEvent(new KeyboardEvent("keypress", o));
          set.call(el, el.value + ch);
          fire("input", ch);
          el.dispatchEvent(new KeyboardEvent("keyup", o));
        }
      } else {
        el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true }));
        set.call(el, text);
        fire("input", text);
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true }));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      if (!document.execCommand("insertText", false, text)) {
        el.textContent = text;
        fire("input", text);
      }
    }
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    return { ok: true };
  };

  // fill on a <select>: by value, then by visible label.
  P.fillSelect = (spec, value) => {
    const r = resolve(spec);
    if (r.fail) return r.fail.stale ? r.fail : { ...r.fail, fields: fieldList() };
    const el = r.el;
    if (el.tagName !== "SELECT") return { notSelect: true };
    const options = [...el.options].map((o) => ({ value: o.value, label: clean(o.label || o.text) }));
    const want = String(value);
    const hit = options.find((o) => o.value === want) || options.find((o) => o.label.toLowerCase() === want.toLowerCase());
    if (!hit) return { ok: false, error: "select has no option '" + value + "'", options, hint: "use one of these values or labels" };
    el.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, hit.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: el.value === hit.value, filled: accessibleName(el) || el.name, ref: refOf(el), valueNow: hit.label, via: "synthetic-select", ...(hit.value !== want ? { note: "matched option by label" } : {}) };
  };

  P.targetKind = (spec) => {
    const r = resolve(spec);
    if (r.fail) return r.fail.stale ? r.fail : { ...r.fail, fields: fieldList() };
    const el = r.el;
    return { ok: true, tag: el.tagName.toLowerCase(), type: el.type || null, role: roleOf(el) };
  };

  // ── upload ────────────────────────────────────────────────────────────────

  // Mark the file input with a one-off token so the debugger can find the
  // same node (DOM.performSearch) and set its files.
  P.fileLocate = (spec, token) => {
    const r = resolve(spec);
    if (r.fail) return r.fail;
    let el = r.el;
    if (!(el.tagName === "INPUT" && el.type === "file")) {
      el = (el.control && el.control.type === "file" && el.control) ||
        deepAll("input[type=file]", el)[0] || null;
    }
    if (!el) return { ok: false, error: "target is not a file input", hint: "snap and pick the item with role file" };
    for (const o of deepAll("[data-pilot-u]")) o.removeAttribute("data-pilot-u");
    el.setAttribute("data-pilot-u", token);
    return { ok: true, ref: refOf(el), name: accessibleName(el) || el.name || "file", multiple: !!el.multiple, accept: el.accept || "" };
  };
  P.fileCheck = (token) => {
    const el = deepAll('[data-pilot-u="' + CSS.escape(token) + '"]')[0];
    if (!el) return { ok: false, error: "file input vanished" };
    el.removeAttribute("data-pilot-u");
    return { ok: true, files: [...(el.files || [])].map((f) => f.name) };
  };

  // ── keys (synthetic fallback) ─────────────────────────────────────────────

  // A synthetic Enter does not run the browser's implicit submission, so do
  // what the browser would: submit the focused field's form. If something
  // called preventDefault (the page's own handler, or another extension's),
  // watch for half a second first: only when nothing reacted (no DOM change,
  // no navigation) is the form submitted, so a page that handles Enter in
  // script is never submitted twice.
  P.syntheticKey = async (key, meta, shift) => {
    const target = deepActive() || document.body;
    const opts = { key, bubbles: true, cancelable: true, composed: true, metaKey: !!meta, shiftKey: !!shift };
    const enterInForm = key === "Enter" && !meta && !shift && target.form && target.tagName !== "TEXTAREA";
    let changed = 0, leaving = false;
    const mo = enterInForm ? new MutationObserver((ms) => { changed += ms.length; }) : null;
    const onLeave = () => { leaving = true; };
    if (mo) { mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); addEventListener("pagehide", onLeave); addEventListener("beforeunload", onLeave); }
    const go = target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    const out = { ok: true, key, on: target.tagName.toLowerCase() };
    if (enterInForm) {
      if (!go) await new Promise((r) => setTimeout(r, 500));
      mo.disconnect();
      removeEventListener("pagehide", onLeave);
      removeEventListener("beforeunload", onLeave);
      if (go || (!changed && !leaving)) {
        try { target.form.requestSubmit(); out.submitted = true; } catch (e) { out.submitError = String(e.message || e); }
      } else {
        out.note = "the page handled Enter itself, so Pilot did not submit the form";
      }
    } else if (key === "Enter" && !target.form) {
      out.note = "the focused element is not in a form; nothing to submit";
    }
    return out;
  };

  // ── reading ───────────────────────────────────────────────────────────────

  function topDialog() {
    const ds = deepAll("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]").filter(visible);
    return ds.length ? ds[ds.length - 1] : null;
  }

  // Page text: rendered text, plus open shadow-root text the body's
  // innerText missed, plus the values of filled fields (readonly included).
  function pageText() {
    let text = (document.body && document.body.innerText) || "";
    for (const host of deepAll("*")) {
      if (!host.shadowRoot) continue;
      const t = clean([...host.shadowRoot.children].map((c) => c.innerText || "").join("\n"));
      if (t && !text.includes(t.slice(0, 60))) text += "\n" + t;
    }
    const vals = [];
    for (const el of deepAll("input:not([type=hidden]):not([type=password]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file]), textarea")) {
      const v = clean(el.value);
      if (!v || !visible(el)) continue;
      vals.push((accessibleName(el) || el.name || el.tagName.toLowerCase()) + ": " + v.slice(0, 200));
    }
    if (vals.length) text += "\n[field values]\n" + vals.join("\n");
    return text;
  }

  // Items for snap, in priority order, each with pri (0 overlay, 1 on
  // screen, 2 below/above the fold). The worker merges frames and caps.
  P.snap = (opts) => {
    const o = opts || {};
    const { list, more, overlay } = listItems(o.cap || 400);
    const items = list.map(({ el, pri }) => {
      const d = describe(el);
      if (d.role === "button" && !d.name) d.icon = "icon-btn";
      d.pri = pri;
      return d;
    });
    const dlg = topDialog();
    return {
      doc: P.doc, title: document.title, url: location.href, top: window === window.top,
      vw: innerWidth, vh: innerHeight,
      text: o.noText ? "" : pageText().slice(0, 3000),
      items, more, overlay,
      ...(dlg ? { dialog: accessibleName(dlg) || "open" } : {}),
    };
  };
  P.read = (offset) => {
    const text = pageText();
    const o = Number(offset) || 0;
    return { ok: true, length: text.length, offset: o, text: text.slice(o, o + 12000) };
  };
  P.tail = () => pageText().slice(-3000);
  P.hrefs = (a) => [...document.querySelectorAll("a[href]")]
    .map((x) => ({ text: clean(x.innerText).slice(0, 40), href: x.getAttribute("href"), ref: refOf(x) }))
    .filter((x) => !a || x.text.toLowerCase().includes(a.toLowerCase()) || x.href.toLowerCase().includes(a.toLowerCase()))
    .slice(0, 10);
  P.dialog = () => {
    const d = topDialog();
    return d ? d.innerText.slice(0, 2000) : null;
  };
  P.form = () => {
    const dlg = topDialog();
    const scope = dlg || document.body;
    if (!scope) return { ok: false, error: "page has no body yet", hint: "navigate first or wait for the page to load" };
    const els = deepAll("input:not([type=hidden]), textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=combobox], [role=checkbox], [role=radio], [role=switch]", scope)
      .filter((el) => visible(el) || (el.labels && [...el.labels].some(visible)))
      .slice(0, 60);
    const fields = [];
    const errors = [];
    const missing = [];
    for (const el of els) {
      const d = describe(el, { options: true, pos: false });
      const err = fieldError(el, lookupId(el));
      if (err) { d.error = err; errors.push({ ref: d.ref, field: d.name || d.field || d.ref, error: err }); }
      if (isMissing(el)) missing.push(d.name || d.field || d.ref);
      fields.push(d);
    }
    return {
      ok: true,
      scope: dlg ? "dialog" : "page",
      fields,
      errors,
      ...(missing.length ? { missing } : {}),
    };
  };
  P.findText = (text) => {
    const want = String(text);
    const wLc = want.toLowerCase();
    const pass = (fn) => {
      const out = [];
      for (const el of deepAll("button, a, span, div, li, p, h1, h2, h3, h4, h5, h6, td, th, label, legend, dt, dd, [role=button], [role=link], [role=tab], input, textarea")) {
        if (!visible(el)) continue;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          if (el.type === "password") continue;
          const v = String(el.value || "");
          if (v && fn(v)) out.push({ ref: refOf(el), tag: el.tagName.toLowerCase(), name: accessibleName(el).slice(0, 60), value: v.slice(0, 60), ...center(el) });
        } else {
          const t = clean(el.innerText);
          if (fn(t) && el.children.length <= 4) {
            const c = center(el);
            out.push({ ref: refOf(el), tag: el.tagName.toLowerCase(), ...(el.getAttribute("role") ? { role: el.getAttribute("role") } : {}), text: t.slice(0, 60), x: c.x, y: c.y });
          }
        }
        if (out.length >= 10) break;
      }
      return out;
    };
    let out = pass((t) => t.startsWith(want));
    if (!out.length) out = pass((t) => t.toLowerCase().includes(wLc));
    // Text sitting directly in <body> (simple frames) has no element of its own.
    if (!out.length && document.body && clean(document.body.innerText).toLowerCase().includes(wLc) && document.body.children.length <= 4) {
      const c = center(document.body);
      out.push({ ref: refOf(document.body), tag: "body", text: clean(document.body.innerText).slice(0, 60), x: c.x, y: c.y });
    }
    return out;
  };

  // Main-content text: the article, not the chrome around it. Prefer <main>,
  // [role=main] or <article>; else the block holding the most paragraph text.
  // Navigation, header, footer, asides and hidden parts are skipped.
  const SKIP_SEL = "nav, header, footer, aside, script, style, noscript, template, svg, [role=navigation], [role=banner], [role=contentinfo], [role=complementary], [role=search], [aria-hidden=true]";
  function contentRoot() {
    const cands = deepAll("main, [role=main], article").filter(visible);
    if (cands.length) {
      return cands.sort((a, b) => clean(b.innerText).length - clean(a.innerText).length)[0];
    }
    const score = new Map();
    for (const p of document.querySelectorAll("p, pre, li, td, blockquote")) {
      const n = clean(p.innerText).length;
      if (n < 40 || p.closest(SKIP_SEL)) continue;
      const a = p.parentElement, b = a && a.parentElement;
      if (a) score.set(a, (score.get(a) || 0) + n);
      if (b) score.set(b, (score.get(b) || 0) + n / 2);
    }
    let best = null, bestScore = 0;
    for (const [el, s] of score) if (s > bestScore) { best = el; bestScore = s; }
    return best || document.body;
  }
  function textSkipping(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return "";
    if (node.matches(SKIP_SEL)) return "";
    if (!node.querySelector(SKIP_SEL)) return node.innerText || "";
    const parts = [];
    for (const c of node.childNodes) {
      const t = c.nodeType === 1 && !visible(c) && getComputedStyle(c).display !== "contents" ? "" : textSkipping(c);
      if (t && t.trim()) parts.push(t.trim());
    }
    return parts.join("\n");
  }
  P.mainText = (offset) => {
    const root = contentRoot();
    const text = (root ? textSkipping(root) : "").replace(/\n{3,}/g, "\n\n").trim();
    const o = Number(offset) || 0;
    return { ok: true, title: document.title, url: location.href, from: root ? root.tagName.toLowerCase() + (root.id ? "#" + root.id : "") : null, length: text.length, offset: o, text: text.slice(o, o + 12000) };
  };

  // ── scroll + wait ─────────────────────────────────────────────────────────

  // The element that actually scrolls: the document, or (for apps that
  // scroll an inner panel) the largest scrollable element on screen.
  function scroller() {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight > se.clientHeight + 4) return se;
    let best = null, area = 0;
    for (const el of document.querySelectorAll("div, main, section, article, ul")) {
      if (el.scrollHeight <= el.clientHeight + 40) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll") continue;
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > area) { best = el; area = a; }
    }
    return best || se;
  }
  P.scroll = (spec, dy, to) => {
    if (spec && (spec.ref || spec.sel || spec.text)) {
      const r = resolve(spec);
      if (r.fail) return r.fail;
      r.el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      return { ok: true, scrolledTo: accessibleName(r.el).slice(0, 60) || r.el.tagName.toLowerCase(), ref: refOf(r.el) };
    }
    const s = scroller();
    const max = s.scrollHeight - s.clientHeight;
    let top;
    if (to === "top") top = 0;
    else if (to === "bottom") top = max;
    else top = s.scrollTop + (dy != null && dy !== "" ? Number(dy) : Math.round(innerHeight * 0.8));
    s.scrollTo({ top: Math.max(0, Math.min(max, top)), behavior: "instant" });
    return { ok: true, y: Math.round(s.scrollTop), maxY: Math.max(0, Math.round(max)), atTop: s.scrollTop <= 1, atBottom: s.scrollTop >= max - 2 };
  };
  P.waitCheck = (w) => {
    const body = (document.body && document.body.innerText) || "";
    const has = (t) => body.toLowerCase().includes(String(t).toLowerCase());
    if (w.sel) {
      let el = null;
      try { el = document.querySelector(w.sel) || deepAll(w.sel)[0]; } catch (e) { return { ok: false, error: "invalid CSS selector '" + w.sel + "'" }; }
      const shown = !!el && visible(el);
      return { ok: true, met: w.gone === true ? !shown : shown };
    }
    if (typeof w.gone === "string") return { ok: true, met: !has(w.gone) };
    if (w.text != null) return { ok: true, met: has(w.text) };
    return { ok: true, met: true };
  };

  // fillShadow pierces shadow roots by a partial match on name, placeholder,
  // aria-label or data-testid, for widgets querySelector cannot reach.
  P.fillShadowLocate = (match) => {
    const wantLc = String(match || "").toLowerCase();
    const found = [];
    for (const el of deepAll("input, textarea, select")) {
      const id = [el.name, el.placeholder, el.getAttribute("aria-label"), el.getAttribute("data-testid"), accessibleName(el)]
        .filter(Boolean).join("|").toLowerCase();
      found.push(id || el.tagName.toLowerCase());
      if (wantLc && id.includes(wantLc)) return { ok: true, ref: refOf(el), tag: el.tagName.toLowerCase() };
    }
    return { ok: false, notFound: true, error: "no shadow field matches '" + match + "'", fields: [...new Set(found)].slice(0, 15), hint: "pass a substring of one of these in \"match\"" };
  };

  P.boot = null;
  P.doc = 0;
  root.__pilot = P;
})(typeof self !== "undefined" ? self : globalThis);
