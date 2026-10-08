// Pilot — page-side library.
//
// Injected into the tab's isolated world with chrome.scripting.executeScript
// ({files}), where it installs globalThis.__pilot. The service worker then
// calls __pilot.<fn>(...) per action. One file means one accessible-name
// function, one element collector and one resolver shared by snap, clickN,
// form, type and hover, instead of a copy per injected function.
//
// The pure helpers (accessibleName, roleOf, textMatches) take plain objects
// that look like elements, so the tests run them under node.

(function (root) {
  const P = {};
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  // ── pure helpers ──────────────────────────────────────────────────────────

  const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number",
    "date", "datetime-local", "month", "week", "time"]);
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
      if (t === "checkbox" || t === "radio") return t;
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

  P.accessibleName = accessibleName;
  P.roleOf = roleOf;
  P.textMatches = textMatches;
  P.isEditable = isEditable;

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

  // Stable refs: stamped once per element, so {"ref":"r12"} still means the
  // same element after the page adds or removes things above it.
  function refOf(el) {
    let r = el.getAttribute("data-pilot-ref");
    if (r) return r;
    const de = document.documentElement;
    const seq = Number(de.getAttribute("data-pilot-seq") || 0) + 1;
    de.setAttribute("data-pilot-seq", String(seq));
    r = "r" + seq;
    el.setAttribute("data-pilot-ref", r);
    return r;
  }
  const byRef = (ref) => deepAll('[data-pilot-ref="' + CSS.escape(String(ref)) + '"]')[0] || null;

  // Raw value for verification; valueOf masks passwords for display.
  function rawValue(el) {
    if (!el) return "";
    if (el.tagName === "SELECT") { const o = el.selectedOptions && el.selectedOptions[0]; return o ? clean(o.label || o.text) : ""; }
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
  function describe(el, opts) {
    const role = roleOf(el);
    const d = { ref: refOf(el), role, name: accessibleName(el).slice(0, 80), tag: el.tagName.toLowerCase() };
    if (el.tagName === "INPUT") d.type = el.type;
    if (el.name) d.field = el.name;
    const v = valueOf(el);
    if (v !== undefined && (v !== "" || isField(el))) d.value = v;
    if ((el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type))) d.checked = el.checked;
    else if (el.getAttribute("aria-checked")) d.checked = el.getAttribute("aria-checked") === "true";
    if (el.required || el.getAttribute("aria-required") === "true") d.required = true;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") d.disabled = true;
    if (el.readOnly && isField(el)) d.readonly = true;
    if (opts && opts.options && el.tagName === "SELECT") {
      d.options = [...el.options].slice(0, 40).map((o) => ({ value: o.value, label: clean(o.label || o.text) }));
    }
    if (!opts || opts.pos !== false) Object.assign(d, center(el));
    return d;
  }

  // ── the shared item collector (snap, clickN, hover n) ─────────────────────

  const ITEM_SEL = [
    "a", "button", "input:not([type=hidden])", "textarea", "select", "summary", "label",
    "[role=button]", "[role=link]", "[role=tab]", "[role=option]", "[role=menuitem]",
    "[role=menuitemcheckbox]", "[role=menuitemradio]", "[role=combobox]", "[role=textbox]",
    "[role=searchbox]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=treeitem]",
    "[contenteditable]:not([contenteditable=false])", "[tabindex]:not([tabindex='-1'])",
  ].join(", ");
  const INTERACTIVE_SEL = "a, button, input, textarea, select, summary, [role], [contenteditable]";
  const isNative = (el) => /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/.test(el.tagName);

  function listItems() {
    const out = [];
    for (const el of deepAll(ITEM_SEL)) {
      if (!visible(el)) {
        continue;
      }
      if (el.tagName === "LABEL") {
        // Labels only matter when they stand in for a hidden control
        // (custom-styled checkboxes); otherwise the control itself is listed.
        const c = el.control;
        if (!c || visible(c)) continue;
      } else if (el.isContentEditable && el.parentElement && el.parentElement.isContentEditable) {
        continue;
      } else if (!isNative(el) && !el.getAttribute("role") && !el.isContentEditable) {
        // A bare [tabindex] wrapper: skip it when it holds a real control.
        if (el.querySelector(INTERACTIVE_SEL)) continue;
      }
      const name = accessibleName(el);
      const field = isField(el) || (el.tagName === "INPUT");
      const iconBtn = !name && roleOf(el) === "button";
      if (!name && !field && !iconBtn) continue;
      out.push(el);
      if (out.length >= 150) break;
    }
    return out;
  }

  // ── target resolution: ref | n | sel | text ───────────────────────────────

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
    for (const el of listItems()) {
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
      .filter(visible).slice(0, 25).map((el) => describe(el, { pos: false }));
  }

  // spec: { ref } | { n } | { sel } | { text, exact }
  function resolve(spec) {
    spec = spec || {};
    if (spec.ref != null && spec.ref !== "") {
      const el = byRef(spec.ref);
      if (!el) return { fail: { ok: false, error: "no element with ref " + spec.ref + " (the page changed or re-rendered it)", hint: "snap again for fresh refs" } };
      return { el, how: "ref" };
    }
    if (spec.n != null && spec.n !== "") {
      const items = listItems();
      const el = items[Number(spec.n)];
      if (!el) return { fail: { ok: false, error: "no item " + spec.n + " (snap lists " + items.length + " items)", hint: "snap again — the page changed" } };
      return { el, how: "n" };
    }
    if (spec.sel) {
      let el = null;
      try { el = document.querySelector(spec.sel) || deepAll(spec.sel)[0] || null; } catch (e) {
        return { fail: { ok: false, error: "invalid CSS selector '" + spec.sel + "'", hint: "use a ref or n from snap instead" } };
      }
      if (!el) return { fail: { ok: false, error: "no element matches selector '" + spec.sel + "'", hint: "use a ref or n from snap, or clickText" } };
      return { el, how: "sel" };
    }
    if (spec.text != null && spec.text !== "") {
      const hit = byText(spec.text, spec.exact);
      if (!hit) return { fail: { ok: false, error: "no clickable element with text '" + spec.text + "'" + (spec.exact ? " (exact)" : ""), hint: "pick one of visibleTexts, or snap and use ref/n" } };
      return { el: hit.el, how: "text", match: hit.match };
    }
    return { fail: { ok: false, error: "need one of: ref, n, sel, text" } };
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
    if (!document.getElementById(base + "glow")) {
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
    const r = { landed: probe.seen.length > 0, trusted: probe.trusted };
    probe = null;
    return r;
  };

  const tag = (el) => {
    for (const o of deepAll("[data-pilot-t]")) o.removeAttribute("data-pilot-t");
    el.setAttribute("data-pilot-t", "1");
  };
  const tagged = () => deepAll("[data-pilot-t]")[0] || null;
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

  // ── click / hover ─────────────────────────────────────────────────────────

  // Resolve, scroll into view, report the center for a debugger click, and
  // arm the probe. covered:true means a coordinate click would hit an overlay.
  P.locate = (spec, show) => {
    const r = resolve(spec);
    if (r.fail) return { ...r.fail, visibleTexts: visibleTexts() };
    const el = r.el;
    if (!inViewport(el)) el.scrollIntoView({ block: "center", inline: "center" });
    const c = center(el);
    feedback(c.x, c.y, show);
    const hit = deepFromPoint(c.x, c.y);
    const reachable = !!hit && (hit === el || el.contains(hit) || hit.contains(el) ||
      (el.control && (hit === el.control || el.control.contains(hit))) ||
      (el.labels && [...el.labels].some((l) => l === hit || l.contains(hit))));
    tag(el);
    const meta = { clicked: accessibleName(el).slice(0, 60) || el.tagName.toLowerCase(), ref: refOf(el), role: roleOf(el), x: c.x, y: c.y };
    if (r.match) meta.match = r.match;
    if (spec.n != null) meta.n = Number(spec.n);
    P.armProbe(["pointerdown", "mousedown", "click"]);
    return { ok: true, x: c.x, y: c.y, covered: !reachable, meta };
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
    return { ok: true, text: accessibleName(r.el).slice(0, 60), ref: refOf(r.el), x: c.x, y: c.y };
  };

  // ── typing ────────────────────────────────────────────────────────────────

  // Pick the field to type into. With a ref/sel/n: that element (or the one
  // text field inside it). Without: the focused field, else the only visible
  // one. A miss is an error with the field list, never a silent guess.
  function pickField(spec) {
    const has = spec && (spec.ref || spec.sel || (spec.n != null && spec.n !== ""));
    if (has) {
      const r = resolve(spec);
      if (r.fail) return { fail: { ...r.fail, fields: fieldList(), hint: "use a ref from fields (or snap), e.g. {\"action\":\"type\",\"ref\":\"r3\",\"text\":\"...\"}" } };
      let el = r.el;
      if (!isEditable(el)) {
        const inner = deepAll("input, textarea, [contenteditable]:not([contenteditable=false])", el).find((x) => isEditable(x));
        if (!inner) return { fail: { ok: false, error: "target is not a text field (" + describe(el, { pos: false }).role + ")", fields: fieldList(), hint: "pick a text field from fields" } };
        el = inner;
      }
      return { el };
    }
    const a = deepActive();
    if (isEditable(a)) return { el: a };
    const vis = deepAll("input, textarea, [contenteditable]:not([contenteditable=false])").filter((x) => isEditable(x) && visible(x));
    if (vis.length === 1) return { el: vis[0] };
    return { fail: { ok: false, error: vis.length ? "no field is focused and there are " + vis.length + " text fields" : "no text field on the page", fields: fieldList(), hint: "pass ref or sel, e.g. {\"action\":\"type\",\"ref\":\"r3\",\"text\":\"...\"}" } };
  }

  // Focus the field in-page and select its content, so the next trusted
  // insertText replaces it. Arms an input probe.
  P.focusField = (spec, clear, show) => {
    const p = pickField(spec);
    if (p.fail) return p.fail;
    const el = p.el;
    if (el.disabled) return { ok: false, error: "field is disabled", field: describe(el, { pos: false }) };
    if (el.readOnly) return { ok: false, error: "field is read-only", field: describe(el, { pos: false }) };
    if (!inViewport(el)) el.scrollIntoView({ block: "center" });
    const c = center(el);
    feedback(c.x, c.y, show);
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
    tag(el);
    P.armProbe(["beforeinput", "input", "keydown"]);
    const d = describe(el, { pos: false });
    return { ok: true, into: d.name || d.field || d.tag, ref: d.ref, role: d.role, focused: deepActive() === el, before: rawValue(el) };
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
    if (r.fail) return { ...r.fail, fields: fieldList() };
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
    if (r.fail) return { ...r.fail, fields: fieldList() };
    const el = r.el;
    return { ok: true, tag: el.tagName.toLowerCase(), type: el.type || null, role: roleOf(el) };
  };

  // ── keys (synthetic fallback) ─────────────────────────────────────────────

  P.armKeys = () => P.armProbe(["keydown"]);
  P.syntheticKey = (key, meta, shift) => {
    const target = deepActive() || document.body;
    const opts = { key, bubbles: true, cancelable: true, composed: true, metaKey: !!meta, shiftKey: !!shift };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    return { ok: true, key, on: target.tagName.toLowerCase() };
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
    for (const el of deepAll("input:not([type=hidden]):not([type=password]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea")) {
      const v = clean(el.value);
      if (!v || !visible(el)) continue;
      vals.push((accessibleName(el) || el.name || el.tagName.toLowerCase()) + ": " + v.slice(0, 200));
    }
    if (vals.length) text += "\n[field values]\n" + vals.join("\n");
    return text;
  }

  P.snap = () => {
    const items = listItems().map((el, n) => {
      const d = describe(el);
      if (d.role === "button" && !d.name) d.icon = "icon-btn";
      return { n, ...d };
    });
    const dlg = topDialog();
    return {
      title: document.title, url: location.href,
      text: pageText().slice(0, 3000),
      items,
      ...(dlg ? { dialog: accessibleName(dlg) || "open" } : {}),
      hint: "act on an item by ref (stable): {\"action\":\"click\",\"ref\":\"r12\"}, or by number: {\"action\":\"clickN\",\"n\":3}",
    };
  };
  P.read = (offset) => {
    const text = pageText();
    const o = Number(offset) || 0;
    return { ok: true, length: text.length, offset: o, text: text.slice(o, o + 12000) };
  };
  P.tail = () => pageText().slice(-3000);
  P.hrefs = (a) => [...document.querySelectorAll("a[href]")]
    .map((x) => ({ text: clean(x.innerText).slice(0, 40), href: x.getAttribute("href") }))
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
    const fields = deepAll("input:not([type=hidden]), textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=combobox], [role=checkbox], [role=radio], [role=switch]", scope)
      .filter((el) => visible(el) || (el.labels && [...el.labels].some(visible)))
      .slice(0, 60)
      .map((el) => describe(el, { options: true, pos: false }));
    const errs = deepAll("[role=alert], [aria-live=assertive], .error, .mat-mdc-form-field-error, mat-error", scope)
      .filter(visible).map((e) => clean(e.innerText)).filter(Boolean);
    const rx = (scope.innerText.match(/[Ee]rror[^\n]{0,100}|required[^\n]{0,100}|must[^\n]{0,100}/g) || []);
    const invalid = fields.filter((f) => { const e = byRef(f.ref); return e && e.getAttribute("aria-invalid") === "true"; }).map((f) => f.name || f.ref);
    return {
      ok: true,
      scope: dlg ? "dialog" : "page",
      fields,
      ...(invalid.length ? { invalid } : {}),
      errors: [...new Set([...errs, ...rx])].slice(0, 8),
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
          if (v && fn(v)) out.push({ tag: el.tagName.toLowerCase(), ref: refOf(el), name: accessibleName(el).slice(0, 60), value: v.slice(0, 60), ...center(el) });
        } else {
          const t = clean(el.innerText);
          if (fn(t) && el.children.length <= 4) out.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), text: t.slice(0, 60), x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y) });
        }
        if (out.length >= 10) break;
      }
      return out;
    };
    let out = pass((t) => t.startsWith(want));
    if (!out.length) out = pass((t) => t.toLowerCase().includes(wLc));
    return out;
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
    return { ok: false, error: "no shadow field matches '" + match + "'", fields: [...new Set(found)].slice(0, 15), hint: "pass a substring of one of these in \"match\"" };
  };

  P.boot = null;
  root.__pilot = P;
})(typeof self !== "undefined" ? self : globalThis);
