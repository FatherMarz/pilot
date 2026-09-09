// Pilot — service worker.
//
// Holds the WS to the local relay and executes commands from the harness.
//
// Design notes:
//   - Auto-connect (default on): the worker dials the relay on start, so the
//     bridge survives reboots and reloads. Disconnect in the popup stops it
//     for the session; the Options page can turn auto-connect off entirely.
//   - Background-tab friendly. Commands run via chrome.scripting.executeScript,
//     which works on inactive tabs, so the harness can drive a tab while the
//     user works elsewhere. We only bring the tab forward when the
//     "focusOnAction" setting is on (off by default).
//   - Screenshots: active-tab captures use chrome.tabs.captureVisibleTab (no
//     infobar); background-tab captures use the Chrome DevTools Protocol, which
//     photographs any tab without touching focus. Images are downscaled in the
//     worker so they stay small enough for the harness to read.

const DEFAULT_SETTINGS = {
  relayUrl: "ws://127.0.0.1:8756",
  profileName: "default",
  groupName: "Harness",
  groupColor: "red",
  focusOnAction: false,
  visualFeedback: true,
  shotMaxWidth: 1280,
  shotFormat: "jpeg", // "jpeg" | "png"
  shotQuality: 0.82,
  screenshotMode: "auto", // "auto" (visible→CDP) | "cdp" | "visible"
  // Reconnect on browser/worker start without a popup click. On by default so
  // the harness keeps its hands after a reboot; turn it off in Options for a
  // strictly manual handshake.
  autoConnect: true,
  // Send clicks and keys through the Chrome debugger so the page receives
  // REAL trusted input (event.isTrusted === true), exactly like a human click.
  // Element targeting stays the same (clickN/clickText resolve the element,
  // scroll it into view, and the debugger clicks its center). Falls back to
  // synthetic events automatically when another debugger holds the tab or the
  // element is covered.
  trustedInput: true,
};

let settings = { ...DEFAULT_SETTINGS };
let ws = null;
let retry = null;
let keepaliveTimer = null;
let intent = false; // user asked to connect (not persisted across worker restarts)

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (got) => {
      settings = { ...DEFAULT_SETTINGS, ...got };
      resolve(settings);
    });
  });
}

function setState(state) {
  try { chrome.runtime.sendMessage({ type: "state", state }).catch(() => {}); } catch {}
}

function currentState() {
  return {
    connected: !!(ws && ws.readyState === 1),
    intent,
    profile: settings.profileName,
    relay: settings.relayUrl,
  };
}

// ── page functions (run in the tab's isolated world; no eval, CSP-safe) ─────
// ONE self-contained function per injection: Chrome serializes the function
// body into the page but NOT the helpers it references, so every helper is
// inlined. Visual feedback: a soft glow around the tab edge + a cursor arrow
// at the last interaction point.
function actFunc(mode, a, b, c, d) {
  const base = "cb-bridge-";
  // Last arg: whether to draw the glow + cursor. Off for clean recordings.
  const showFeedback = d !== false;
  const ensureArm = () => {
    let cursor = document.getElementById(base + "cursor");
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = base + "cursor";
      cursor.style.cssText =
        "position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;z-index:2147483647;display:none;";
      cursor.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.8))"><path d="M4 2l16 9.5-6.8 1.6L9 20.5z" fill="#fff" stroke="#c00" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(cursor);
    }
    let glow = document.getElementById(base + "glow");
    if (!glow) {
      glow = document.createElement("div");
      glow.id = base + "glow";
      glow.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:2147483646;box-sizing:border-box;" +
        "border:3px solid rgba(255,110,110,0.55);" +
        "box-shadow:inset 0 0 48px 14px rgba(255,90,90,0.26), 0 0 40px 8px rgba(255,90,90,0.35);";
      document.documentElement.appendChild(glow);
    }
    return cursor;
  };
  const pointAt = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    if (showFeedback) {
      const cursor = ensureArm();
      cursor.style.left = x + "px";
      cursor.style.top = y + "px";
      cursor.style.display = "block";
    }
    return { x, y };
  };
  const fireClick = (el, x, y) => {
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    for (const type of ["mousedown", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, opts));
    }
  };

  // Every mode returns a plain object: { ok:true, ... } on success and
  // { ok:false, error, ...recovery data } on failure, so a driving model can
  // branch on `ok` instead of parsing prose.
  const clickables = () => [...document.querySelectorAll(
    "button, a, input, textarea, select, [role=button], [role=checkbox], [role=link], [role=tab], [onclick], label, span, div, li")];
  const labelOf = (el) =>
    (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.title || "").trim();
  // For a radio/checkbox (or its label), the checked state after a click —
  // lets the model confirm a toggle from the click result alone.
  const checkedOf = (el) => {
    const input = el.tagName === "INPUT" ? el : (el.control || (el.querySelector && el.querySelector("input")) || null);
    return input && (input.type === "radio" || input.type === "checkbox") ? input.checked : undefined;
  };
  const visibleTexts = () => {
    const seen = new Set();
    const out = [];
    for (const el of clickables()) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const t = labelOf(el).slice(0, 50);
      if (!t || t.length > 50 || seen.has(t) || el.children.length > 3) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 15) break;
    }
    return out;
  };

  if (mode === "hrefs") {
    return [...document.querySelectorAll("a[href]")]
      .map((x) => ({ text: (x.innerText || "").trim().slice(0, 40), href: x.getAttribute("href") }))
      .filter((x) => !a || x.text.toLowerCase().includes(a.toLowerCase()) || x.href.toLowerCase().includes(a.toLowerCase()))
      .slice(0, 10);
  }
  if (mode === "clickXY") {
    const el = document.elementFromPoint(a, b);
    if (!el) return { ok: false, error: "no element at " + a + "," + b, hint: "coordinates are viewport pixels; run snap for fresh ones" };
    const p = pointAt(el);
    fireClick(el, p.x, p.y);
    return { ok: true, clicked: el.tagName.toLowerCase(), text: labelOf(el).slice(0, 50), x: a, y: b };
  }
  if (mode === "hoverXY") {
    const el = document.elementFromPoint(a, b);
    if (!el) return { ok: false, error: "no element at " + a + "," + b, hint: "coordinates are viewport pixels; run snap for fresh ones" };
    pointAt(el);
    const opts = { bubbles: true, cancelable: true, clientX: a, clientY: b, view: window };
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    try { el.dispatchEvent(new MouseEvent("mouseenter", opts)); } catch { /* React reads mouseover */ }
    return { ok: true, hovered: el.tagName.toLowerCase(), text: labelOf(el).slice(0, 50), x: a, y: b, via: "synthetic" };
  }
  if (mode === "tail") {
    const text = (document.body && document.body.innerText || "");
    return text.slice(-3000);
  }
  if (mode === "read") {
    // Long-form page text for read-heavy tasks; snap caps at 3000 chars.
    const text = (document.body && document.body.innerText || "");
    const offset = Number(a) || 0;
    return { ok: true, length: text.length, offset, text: text.slice(offset, offset + 12000) };
  }
  if (mode === "key") {
    const target = document.activeElement || document.body;
    const opts = { key: a, code: a, bubbles: true, cancelable: true };
    if (b) opts.metaKey = true;
    if (c) opts.shiftKey = true;
    if (a === "Enter" || a === " " || a === "Tab") opts.keyCode = a === "Enter" ? 13 : a === "Tab" ? 9 : 32;
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    return "key: " + a + (b ? " (meta)" : "") + (c ? " (shift)" : "") + " on " + target.tagName;
  }
  if (mode === "click") {
    const el = a && document.querySelector(a);
    if (!el) {
      return { ok: false, error: "no element matches selector '" + a + "'", visibleTexts: visibleTexts(), hint: "click by text instead: {\"action\":\"clickText\",\"text\":\"...\"} or by number after a snap: {\"action\":\"clickN\",\"n\":3}" };
    }
    const p = pointAt(el);
    fireClick(el, p.x, p.y);
    return { ok: true, clicked: a, text: labelOf(el).slice(0, 50), x: p.x, y: p.y };
  }
  if (mode === "clickText") {
    // Forgiving match, tightest tier wins: exact -> case-insensitive exact ->
    // startsWith -> ci startsWith -> ci contains. Within a tier prefer real
    // controls over wrappers, then the SHORTEST text (the leaf, not the page).
    const want = String(a);
    const wantLc = want.toLowerCase();
    const rank = (el) => {
      const t = (el.innerText || "").trim();
      const tLc = t.toLowerCase();
      if (t === want) return 0;
      if (c) return 99; // exact:true accepts tier 0 only
      if (tLc === wantLc) return 1;
      if (t.startsWith(want)) return 2;
      if (tLc.startsWith(wantLc)) return 3;
      if (tLc.includes(wantLc)) return 4;
      return 99;
    };
    const control = (el) => /^(button|a|input|select|textarea|label)$/i.test(el.tagName) || el.getAttribute("role") ? 0 : 1;
    let best = null;
    for (const el of clickables()) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const tier = rank(el);
      if (tier === 99) continue;
      const len = (el.innerText || "").trim().length;
      const score = [tier, control(el), len];
      if (!best || score[0] < best.score[0] ||
          (score[0] === best.score[0] && (score[1] < best.score[1] ||
          (score[1] === best.score[1] && score[2] < best.score[2])))) {
        best = { el, score };
      }
    }
    if (!best) {
      return { ok: false, error: "no clickable element with text '" + want + "'" + (c ? " (exact)" : ""), visibleTexts: visibleTexts(), hint: "pick one of visibleTexts, or snap and use clickN" };
    }
    const p = pointAt(best.el);
    fireClick(best.el, p.x, p.y);
    const chk = checkedOf(best.el);
    return { ok: true, clicked: labelOf(best.el).slice(0, 50), tag: best.el.tagName.toLowerCase(), x: p.x, y: p.y, match: ["exact", "exact-ci", "starts", "starts-ci", "contains-ci"][best.score[0]], ...(chk !== undefined ? { checkedNow: chk } : {}) };
  }
  if (mode === "clickN") {
    // Click item N from the most recent snap: SAME collector, SAME order.
    const items = [...document.querySelectorAll("button, a, input, textarea, select, [role=dialog], [role=checkbox], label")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        const text = labelOf(el).slice(0, 70);
        const icon = el.tagName === "BUTTON" && !(el.innerText || "").trim() ? "icon-btn" : "";
        return { el, visible: r.width > 0 && r.height > 0, text, icon };
      })
      .filter((i) => i.visible && (i.text || i.icon))
      .slice(0, 120);
    const item = items[a];
    if (!item) return { ok: false, error: "no item " + a + " (snap listed " + items.length + " items)", hint: "snap again — the page changed" };
    const p = pointAt(item.el);
    fireClick(item.el, p.x, p.y);
    const chk = checkedOf(item.el);
    return { ok: true, clicked: item.text || item.icon, n: a, x: p.x, y: p.y, ...(chk !== undefined ? { checkedNow: chk } : {}) };
  }
  // Frameworks (React, Angular, Vue) track input state off their own value
  // tracker or (input)/(change) listeners, not off the raw DOM property. A
  // direct `.value =` assignment is invisible to them — the field LOOKS
  // filled but the model behind it stays empty. The fix has three parts:
  //   1. Write through the native prototype setter (bypasses React's patched
  //      setter, which would otherwise swallow the same-value check).
  //   2. Fire keydown/input/keyup/change, all bubbling, so whichever event
  //      the framework listens on (Angular reactive forms use (input); some
  //      slug/derive-field logic hooks keyup) actually sees the change.
  //   3. Fire blur/focusout WITHOUT moving real focus, so blur-triggered
  //      validation runs — but document.activeElement stays put, because
  //      `{"action":"type"}` then `{"action":"key","key":"Enter"}` (see
  //      README) depends on the field still being the active element.
  const fireValueEvents = (el, text) => {
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    try {
      el.dispatchEvent(new InputEvent("input", { ...opts, inputType: "insertText", data: text }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  };
  if (mode === "type" || mode === "replace") {
    const all = [...document.querySelectorAll('[contenteditable="true"], textarea, input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio])')];
    const el = (a && document.querySelector(a)) || all.find((e) => e.offsetParent !== null);
    if (!el) {
      return { ok: false, error: a ? "no field matches selector '" + a + "'" : "no visible text field on the page", fields: all.slice(0, 10).map((e) => ({ tag: e.tagName.toLowerCase(), name: e.name || null, placeholder: e.placeholder || null })), hint: "run {\"action\":\"form\"} to see every field" };
    }
    pointAt(el);
    el.focus();
    let via;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, b);
      fireValueEvents(el, b);
      via = "value";
    } else if (el.isContentEditable) {
      if (mode === "replace") document.execCommand("selectAll", false, null);
      const ok = document.execCommand("insertText", false, b);
      if (!ok) {
        el.textContent = b;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      via = "insertText:" + ok;
    } else {
      via = "none";
    }
    return { ok: true, typed: b.length + " chars", into: el.tagName.toLowerCase() + (el.name ? "[name=" + el.name + "]" : ""), via, valueNow: (el.value ?? el.innerText ?? "").slice(0, 60) };
  }
  if (mode === "typeKeys") {
    // Value-set + input event still isn't enough for some fields — masked or
    // per-keystroke-transformed inputs (card numbers, phone formatting) that
    // read from the actual keystroke stream. This drives one real
    // keydown/keypress/input/keyup cycle per character instead of one bulk set.
    const all = [...document.querySelectorAll('[contenteditable="true"], textarea, input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio])')];
    const el = (a && document.querySelector(a)) || all.find((e) => e.offsetParent !== null);
    if (!el) {
      return { ok: false, error: a ? "no field matches selector '" + a + "'" : "no visible text field on the page", fields: all.slice(0, 10).map((e) => ({ tag: e.tagName.toLowerCase(), name: e.name || null, placeholder: e.placeholder || null })), hint: "run {\"action\":\"form\"} to see every field" };
    }
    pointAt(el);
    el.focus();
    const isNative = el.tagName === "TEXTAREA" || el.tagName === "INPUT";
    const setter = isNative
      ? Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, "value").set
      : null;
    if (isNative) setter.call(el, "");
    else if (el.isContentEditable) { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); }
    const text = String(b);
    for (const ch of text) {
      const opts = { key: ch, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      if (isNative) {
        setter.call(el, el.value + ch);
        try {
          el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: ch }));
        } catch {
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else if (el.isContentEditable) {
        document.execCommand("insertText", false, ch);
      }
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
    }
    if (isNative) el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    return { ok: true, typed: text.length + " chars (keystrokes)", into: el.tagName.toLowerCase() + (el.name ? "[name=" + el.name + "]" : ""), via: "keys", valueNow: (el.value ?? el.innerText ?? "").slice(0, 60) };
  }
  return { ok: false, error: "unknown mode " + mode };
}

// ── trusted-input support ───────────────────────────────────────────────────
// locateFunc resolves the SAME element the synthetic modes would (identical
// matching logic), scrolls it into view, and reports its viewport center so
// the debugger can click it with a real, trusted mouse event. If the center
// is covered by something else (sticky header, overlay), it clicks
// synthetically right here and returns a final result instead — a covered
// element can still receive dispatched events, but not a coordinate click.
function locateFunc(mode, a, c, showFeedback) {
  const base = "cb-bridge-";
  const ensureArm = () => {
    let cursor = document.getElementById(base + "cursor");
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = base + "cursor";
      cursor.style.cssText =
        "position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;z-index:2147483647;display:none;";
      cursor.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.8))"><path d="M4 2l16 9.5-6.8 1.6L9 20.5z" fill="#fff" stroke="#c00" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(cursor);
    }
    return cursor;
  };
  const labelOf = (el) =>
    (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.title || "").trim();
  const clickables = () => [...document.querySelectorAll(
    "button, a, input, textarea, select, [role=button], [role=checkbox], [role=link], [role=tab], [onclick], label, span, div, li")];
  const visibleTexts = () => {
    const seen = new Set();
    const out = [];
    for (const el of clickables()) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const t = labelOf(el).slice(0, 50);
      if (!t || t.length > 50 || seen.has(t) || el.children.length > 3) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 15) break;
    }
    return out;
  };
  const fireClick = (el, x, y) => {
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    for (const type of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(type, opts));
  };
  const checkedOf = (el) => {
    const input = el.tagName === "INPUT" ? el : (el.control || (el.querySelector && el.querySelector("input")) || null);
    return input && (input.type === "radio" || input.type === "checkbox") ? input.checked : undefined;
  };

  // Resolve the target with the same logic as the synthetic modes.
  let el = null;
  let meta = {};
  if (mode === "click") {
    el = a && document.querySelector(a);
    if (!el) return { ok: false, error: "no element matches selector '" + a + "'", visibleTexts: visibleTexts(), hint: "click by text instead: {\"action\":\"clickText\",\"text\":\"...\"} or by number after a snap: {\"action\":\"clickN\",\"n\":3}" };
    meta = { clicked: a, text: labelOf(el).slice(0, 50) };
  } else if (mode === "clickText") {
    const want = String(a);
    const wantLc = want.toLowerCase();
    const rank = (x) => {
      const t = (x.innerText || "").trim();
      const tLc = t.toLowerCase();
      if (t === want) return 0;
      if (c) return 99;
      if (tLc === wantLc) return 1;
      if (t.startsWith(want)) return 2;
      if (tLc.startsWith(wantLc)) return 3;
      if (tLc.includes(wantLc)) return 4;
      return 99;
    };
    const control = (x) => /^(button|a|input|select|textarea|label)$/i.test(x.tagName) || x.getAttribute("role") ? 0 : 1;
    let best = null;
    for (const cand of clickables()) {
      const r = cand.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const tier = rank(cand);
      if (tier === 99) continue;
      const len = (cand.innerText || "").trim().length;
      const score = [tier, control(cand), len];
      if (!best || score[0] < best.score[0] ||
          (score[0] === best.score[0] && (score[1] < best.score[1] ||
          (score[1] === best.score[1] && score[2] < best.score[2])))) {
        best = { el: cand, score };
      }
    }
    if (!best) return { ok: false, error: "no clickable element with text '" + want + "'" + (c ? " (exact)" : ""), visibleTexts: visibleTexts(), hint: "pick one of visibleTexts, or snap and use clickN" };
    el = best.el;
    meta = { clicked: labelOf(el).slice(0, 50), tag: el.tagName.toLowerCase(), match: ["exact", "exact-ci", "starts", "starts-ci", "contains-ci"][best.score[0]] };
  } else if (mode === "clickN") {
    const items = [...document.querySelectorAll("button, a, input, textarea, select, [role=dialog], [role=checkbox], label")]
      .map((x) => {
        const r = x.getBoundingClientRect();
        const text = labelOf(x).slice(0, 70);
        const icon = x.tagName === "BUTTON" && !(x.innerText || "").trim() ? "icon-btn" : "";
        return { el: x, visible: r.width > 0 && r.height > 0, text, icon };
      })
      .filter((i) => i.visible && (i.text || i.icon))
      .slice(0, 120);
    const item = items[a];
    if (!item) return { ok: false, error: "no item " + a + " (snap listed " + items.length + " items)", hint: "snap again — the page changed" };
    el = item.el;
    meta = { clicked: item.text || item.icon, n: a };
  } else {
    return { ok: false, error: "locate: unknown mode " + mode };
  }

  // Bring it into view, then check the center actually hits it.
  const r0 = el.getBoundingClientRect();
  if (r0.top < 0 || r0.bottom > innerHeight || r0.left < 0 || r0.right > innerWidth) {
    el.scrollIntoView({ block: "center", inline: "center" });
  }
  const r = el.getBoundingClientRect();
  const x = Math.round(r.x + r.width / 2);
  const y = Math.round(r.y + r.height / 2);
  if (showFeedback !== false) {
    const cursor = ensureArm();
    cursor.style.left = x + "px";
    cursor.style.top = y + "px";
    cursor.style.display = "block";
  }
  const hit = document.elementFromPoint(x, y);
  const reachable = hit && (hit === el || el.contains(hit) || hit.contains(el) ||
    (el.control && (hit === el.control || el.control.contains(hit))));
  if (!reachable) {
    // Covered — a coordinate click would hit the overlay, so click in place.
    fireClick(el, x, y);
    const chk = checkedOf(el);
    return { ok: true, ...meta, x, y, via: "synthetic-covered", ...(chk !== undefined ? { checkedNow: chk } : {}) };
  }
  for (const old of document.querySelectorAll("[data-pilot-t]")) old.removeAttribute("data-pilot-t");
  el.setAttribute("data-pilot-t", "1");
  return { needsCdp: true, x, y, result: { ok: true, ...meta, x, y } };
}

// After a trusted click: read back toggle state from the tagged element.
function confirmClickFunc() {
  const el = document.querySelector("[data-pilot-t]");
  if (!el) return {};
  el.removeAttribute("data-pilot-t");
  const input = el.tagName === "INPUT" ? el : (el.control || (el.querySelector && el.querySelector("input")) || null);
  if (input && (input.type === "radio" || input.type === "checkbox")) return { checkedNow: input.checked };
  return {};
}

// After a hover-only move, re-read the tagged element's center. Hover-revealed
// controls can slide into place on mouseenter, so the pre-hover center is
// stale — this returns the post-hover one. Tag stays put for confirmClickFunc.
function remeasureFunc() {
  const el = document.querySelector("[data-pilot-t]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}

// Resolve an element the same way clickText/clickN/click do, but only to
// report its center for a hover move — no click, no coverage fallback (a hover
// can land on anything). Tags the element so remeasureFunc can re-read it.
function hoverFunc(mode, a, c) {
  const labelOf = (el) =>
    (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.title || "").trim();
  let el = null;
  let meta = {};
  if (mode === "sel") {
    el = a && document.querySelector(a);
    if (!el) return { ok: false, error: "no element matches selector '" + a + "'", hint: "use hoverXY with viewport coordinates instead" };
    meta = { text: labelOf(el).slice(0, 50) };
  } else if (mode === "text") {
    const want = String(a);
    const wantLc = want.toLowerCase();
    const rank = (x) => {
      const t = (x.innerText || "").trim();
      const tLc = t.toLowerCase();
      if (t === want) return 0;
      if (c) return 99;
      if (tLc === wantLc) return 1;
      if (t.startsWith(want)) return 2;
      if (tLc.startsWith(wantLc)) return 3;
      if (tLc.includes(wantLc)) return 4;
      return 99;
    };
    const control = (x) => /^(button|a|input|select|textarea|label)$/i.test(x.tagName) || x.getAttribute("role") ? 0 : 1;
    let best = null;
    for (const cand of document.querySelectorAll("button, a, input, textarea, select, [role=button], [role=checkbox], [role=link], [role=tab], [onclick], label, span, div, li")) {
      const r = cand.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const tier = rank(cand);
      if (tier === 99) continue;
      const len = (cand.innerText || "").trim().length;
      const score = [tier, control(cand), len];
      if (!best || score[0] < best.score[0] ||
          (score[0] === best.score[0] && (score[1] < best.score[1] ||
          (score[1] === best.score[1] && score[2] < best.score[2])))) {
        best = { el: cand, score };
      }
    }
    if (!best) return { ok: false, error: "no element with text '" + want + "'", hint: "use hoverXY with viewport coordinates instead" };
    el = best.el;
    meta = { text: labelOf(el).slice(0, 50) };
  } else if (mode === "n") {
    const items = [...document.querySelectorAll("button, a, input, textarea, select, [role=dialog], [role=checkbox], label")]
      .map((x) => {
        const r = x.getBoundingClientRect();
        const text = labelOf(x).slice(0, 70);
        const icon = x.tagName === "BUTTON" && !(x.innerText || "").trim() ? "icon-btn" : "";
        return { el: x, visible: r.width > 0 && r.height > 0, text, icon };
      })
      .filter((i) => i.visible && (i.text || i.icon))
      .slice(0, 120);
    const item = items[Number(a)];
    if (!item) return { ok: false, error: "no item " + a, hint: "snap again — the page changed" };
    el = item.el;
    meta = { text: item.text || item.icon, n: Number(a) };
  } else {
    return { ok: false, error: "hover needs one of: n, text, sel, or x+y (use hoverXY)" };
  }
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const x = Math.round(r.x + r.width / 2);
  const y = Math.round(r.y + r.height / 2);
  for (const old of document.querySelectorAll("[data-pilot-t]")) old.removeAttribute("data-pilot-t");
  el.setAttribute("data-pilot-t", "1");
  return { ok: true, ...meta, x, y };
}

// Focus a field (same resolution as type/typeKeys) so trusted keystrokes from
// the debugger land in it. Clears it first — typeKeys semantics.
function focusFieldFunc(sel) {
  const all = [...document.querySelectorAll('[contenteditable="true"], textarea, input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio])')];
  const el = (sel && document.querySelector(sel)) || all.find((e) => e.offsetParent !== null);
  if (!el) {
    return { ok: false, error: sel ? "no field matches selector '" + sel + "'" : "no visible text field on the page", fields: all.slice(0, 10).map((e) => ({ tag: e.tagName.toLowerCase(), name: e.name || null, placeholder: e.placeholder || null })), hint: "run {\"action\":\"form\"} to see every field" };
  }
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (el.isContentEditable) {
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
  }
  for (const old of document.querySelectorAll("[data-pilot-t]")) old.removeAttribute("data-pilot-t");
  el.setAttribute("data-pilot-t", "1");
  return { ok: true, into: el.tagName.toLowerCase() + (el.name ? "[name=" + el.name + "]" : "") };
}

// Read the tagged field's value after trusted typing.
function fieldValueFunc() {
  const el = document.querySelector("[data-pilot-t]");
  if (!el) return { valueNow: "" };
  el.removeAttribute("data-pilot-t");
  return { valueNow: String(el.value ?? el.innerText ?? "").slice(0, 60) };
}

function snapFunc() {
  const out = { title: document.title, url: location.href };
  out.text = (document.body && document.body.innerText || "").slice(0, 3000);
  // Items carry `n`: {"action":"clickN","n":3} clicks item 3 of THIS list.
  // clickN rebuilds the list with the same collector, so n stays stable as
  // long as the page has not changed.
  out.items = [...document.querySelectorAll("button, a, input, textarea, select, [role=dialog], [role=checkbox], label")]
    .map((el) => {
      const r = el.getBoundingClientRect();
      const isToggle = el.tagName === "INPUT" && (el.type === "radio" || el.type === "checkbox");
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.title || "").trim().slice(0, 70),
        icon: el.tagName === "BUTTON" && !(el.innerText || "").trim() ? "icon-btn" : "",
        visible: r.width > 0 && r.height > 0,
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        w: Math.round(r.width),
        ...(isToggle ? { type: el.type, checked: el.checked } : {}),
      };
    })
    .filter((i) => i.visible && (i.text || i.icon))
    .slice(0, 120)
    .map((i, n) => ({ n, ...i }));
  out.hint = "click an item with {\"action\":\"clickN\",\"n\":<n>} or {\"action\":\"clickText\",\"text\":\"...\"}";
  return out;
}
function findTextFunc(text) {
  const want = String(text);
  const wantLc = want.toLowerCase();
  const pass = (fn) => {
    const out = [];
    for (const el of document.querySelectorAll("button, a, span, div, li, p, h1, h2, h3, h4, td, th, label, legend, dt, dd, [role=button], [role=link], [role=tab]")) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const t = (el.innerText || "").trim();
      if (fn(t) && el.children.length <= 4) {
        out.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), text: t.slice(0, 60), x: Math.round(r.x), y: Math.round(r.y) });
      }
      if (out.length >= 10) break;
    }
    return out;
  };
  // Strict first, then forgiving — a small model's typo in case still lands.
  let out = pass((t) => t.startsWith(want));
  if (!out.length) out = pass((t) => t.toLowerCase().includes(wantLc));
  return out;
}
function fillFunc(sel, value) {
  // Same framework-visibility problem as type/replace: a raw `.value =` (or
  // even the native setter alone) is invisible to React/Angular/Vue unless
  // the events they listen on also fire. See actFunc's fireValueEvents for
  // the full rationale; this is the same fix, duplicated because Chrome
  // serializes each injected function standalone (no shared module scope).
  const setNative = (el, v) => {
    const proto = el.tagName === "SELECT" ? window.HTMLSelectElement.prototype :
      el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  };
  const fireEvents = (el) => {
    if (el.tagName === "SELECT") {
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    try {
      el.dispatchEvent(new InputEvent("input", { ...opts, inputType: "insertText", data: String(el.value) }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  };
  const el = sel && document.querySelector(sel);
  if (!el) {
    const fields = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
      .slice(0, 12)
      .map((e) => ({ tag: e.tagName.toLowerCase(), name: e.name || null, id: e.id || null, placeholder: e.placeholder || null }));
    return { ok: false, error: "no field matches selector '" + sel + "'", fields, hint: "use a name from this list, e.g. {\"action\":\"fill\",\"sel\":\"[name=email]\",\"value\":\"...\"}" };
  }
  el.focus();
  setNative(el, value);
  fireEvents(el);
  if (el.tagName === "SELECT" && el.value !== value) {
    // Value didn't stick — the option value is different from the label.
    const options = [...el.options].map((o) => ({ value: o.value, label: o.innerText.trim() }));
    const byLabel = options.find((o) => o.label.toLowerCase() === String(value).toLowerCase());
    if (byLabel) {
      setNative(el, byLabel.value);
      fireEvents(el);
      return { ok: true, filled: sel, valueNow: el.value, note: "matched option by label" };
    }
    return { ok: false, error: "select has no option '" + value + "'", options, hint: "use one of these values" };
  }
  return { ok: true, filled: sel, valueNow: (el.value || "").slice(0, 60) };
}
// fillShadow pierces shadow roots to reach an input by a partial match on
// name, placeholder, aria-label, or data-testid — for fields querySelector
// cannot reach (e.g. hosted checkout widgets render inputs in shadow DOM).
function fillShadowFunc(match, value) {
  const wantLc = String(match || "").toLowerCase();
  const seen = new Set();
  const found = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("input, textarea, select")) {
      const id = [el.name, el.placeholder, el.getAttribute("aria-label"), el.getAttribute("data-testid")]
        .filter(Boolean).join("|").toLowerCase();
      found.push(id || el.tagName.toLowerCase());
      if (wantLc && id.includes(wantLc)) {
        const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype :
          el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
        el.focus();
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
        if (el.tagName === "SELECT") {
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          const opts = { bubbles: true, cancelable: true };
          el.dispatchEvent(new KeyboardEvent("keydown", opts));
          try {
            el.dispatchEvent(new InputEvent("input", { ...opts, inputType: "insertText", data: String(value) }));
          } catch {
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          el.dispatchEvent(new KeyboardEvent("keyup", opts));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        }
        return { ok: true, filled: id };
      }
    }
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot && !seen.has(el.shadowRoot)) {
        seen.add(el.shadowRoot);
        const r = walk(el.shadowRoot);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(document) || { ok: false, error: "no shadow field matches '" + match + "'", fields: [...new Set(found)].slice(0, 15), hint: "pass a substring of one of these in \"match\"" };
}
function dialogFunc() {
  const d = document.querySelector("[role=dialog]");
  return d ? d.innerText.slice(0, 2000) : null;
}
function formFunc() {
  const scope = document.querySelector("[role=dialog]") || document.body;
  if (!scope) return { ok: false, error: "page has no body yet", hint: "navigate first or wait for the page to load" };
  return {
    inputs: [...scope.querySelectorAll("input")].map((i) => ({
      name: i.name, type: i.type, placeholder: i.placeholder || null,
      value: (i.value || "").slice(0, 40), checked: i.checked,
    })),
    selects: [...scope.querySelectorAll("select")].map((s) => ({
      value: s.value,
      options: [...s.options].map((o) => o.innerText.trim() + "=" + o.value).join(" / "),
    })),
    radios: [...scope.querySelectorAll("[role=radiogroup], input[type=radio]")].map((r) => ({
      text: (r.innerText || r.getAttribute("aria-label") || r.value || "").trim().slice(0, 40),
      checked: r.checked,
    })),
    errors: (scope.innerText.match(/[Ee]rror[^\n]{0,100}|required[^\n]{0,100}|must[^\n]{0,100}/g) || []).slice(0, 5),
  };
}

// ── WebSocket management ────────────────────────────────────────────────────

function connect() {
  if (retry) { clearTimeout(retry); retry = null; }
  try {
    ws = new WebSocket(settings.relayUrl);
  } catch { scheduleRetry(); return; }
  ws.onopen = () => {
    setState("connected");
    ws.send(JSON.stringify({ hello: "extension", profile: settings.profileName }));
    // MV3 suspends an idle worker after ~30s and kills the socket with it.
    // Chrome 116+ extends the worker's life on WebSocket TRAFFIC, so a small
    // application-level ping every 20s keeps the bridge up indefinitely.
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      if (ws && ws.readyState === 1) ws.send('{"ka":1}');
    }, 20000);
  };
  ws.onclose = () => {
    setState("disconnected");
    ws = null;
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (intent) scheduleRetry();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const reply = (payload) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ id: msg.id, ...payload }));
    };
    try {
      const value = await dispatchAction(msg, reply);
      if (value !== undefined) reply({ ok: true, value });
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  };
}

function scheduleRetry() {
  if (retry) return;
  retry = setTimeout(() => { retry = null; connect(); }, 3000);
}

function disconnect() {
  intent = false;
  if (retry) { clearTimeout(retry); retry = null; }
  try { if (ws) ws.close(); } catch {}
  ws = null;
  setState("disconnected");
}

// ── Command dispatch ────────────────────────────────────────────────────────

function shouldBringForward(action) {
  if (!settings.focusOnAction) return false;
  // Pure metadata actions never need focus.
  return !["ping", "tabs", "harnessTab", "newHarnessTab", "reload", "status"].includes(action);
}

// Actions that read or manage browser state without driving a page. They must
// not resolve a target tab: doing so grabs the user's ACTIVE tab and drags it
// into the Harness group as a side effect of a mere listing.
const METADATA_ACTIONS = new Set([
  "ping", "reload", "status", "tabs", "windows", "activeTab",
  "tabInfo", "closeTab", "harnessTab", "newHarnessTab",
]);

// ── trusted input via the Chrome debugger ───────────────────────────────────
// Input.dispatch* events arrive as REAL user input: event.isTrusted === true,
// default actions run (form submit on Enter, native focus, :active styles).
// Attach/detach per action; if another debugger owns the tab, the caller
// falls back to synthetic events.

function cdpSend(tabId, commands) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      const step = (i) => {
        if (i >= commands.length) {
          chrome.debugger.detach({ tabId }, () => {});
          return resolve(true);
        }
        chrome.debugger.sendCommand({ tabId }, commands[i][0], commands[i][1], () => {
          if (chrome.runtime.lastError) {
            chrome.debugger.detach({ tabId }, () => {});
            return reject(new Error(chrome.runtime.lastError.message));
          }
          step(i + 1);
        });
      };
      step(0);
    });
  });
}

function cdpClick(tabId, x, y) {
  const base = { x, y, button: "left", clickCount: 1, pointerType: "mouse" };
  return cdpSend(tabId, [
    ["Input.dispatchMouseEvent", { type: "mouseMoved", ...base, buttons: 0 }],
    ["Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1 }],
    ["Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 1 }],
  ]);
}

// Hover-only move: the debugger mouse glides to (x, y) and stops there — no
// press. This reveals hover-only controls (a "..." button that only shows on
// mouseenter). Real trusted input, so CSS :hover and React mouseenter both fire.
function cdpHover(tabId, x, y) {
  return cdpSend(tabId, [
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse" }],
  ]);
}

const CDP_VK = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32,
};

function cdpKey(tabId, key, meta, shift) {
  const modifiers = (meta ? 4 : 0) | (shift ? 8 : 0);
  const vk = CDP_VK[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const text = key === "Enter" ? "\r" : (key.length === 1 ? key : undefined);
  const down = { type: "keyDown", modifiers, key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  if (text !== undefined && !meta) down.text = text;
  return cdpSend(tabId, [
    ["Input.dispatchKeyEvent", down],
    ["Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }],
  ]);
}

function cdpTypeText(tabId, text) {
  const commands = [];
  for (const ch of String(text).slice(0, 1000)) {
    const vk = ch.toUpperCase().charCodeAt(0);
    commands.push(["Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }]);
    commands.push(["Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }]);
  }
  return cdpSend(tabId, commands);
}

async function dispatchAction(msg, reply) {
  const action = msg.action;

  if (METADATA_ACTIONS.has(action)) {
    switch (action) {
      case "ping": return "v8";
      case "reload": { setTimeout(() => chrome.runtime.reload(), 400); return "reloading"; }
      case "status": return currentState();
      case "tabs": {
        const tabs = await chrome.tabs.query({});
        return tabs.map((t) => ({ id: t.id, url: t.url || "", title: t.title || "", groupId: t.groupId, windowId: t.windowId, active: t.active }));
      }
      case "windows": {
        const wins = await chrome.windows.getAll();
        return wins.map((w) => ({ id: w.id, type: w.type, focused: w.focused, state: w.state }));
      }
      case "activeTab": {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return t ? { id: t.id, windowId: t.windowId, url: t.url || "", title: t.title || "" } : null;
      }
      case "tabInfo": {
        const t = await chrome.tabs.get(msg.tabId);
        return { id: t.id, windowId: t.windowId, url: t.url || "", title: t.title || "", groupId: t.groupId };
      }
      case "gc": {
        // Sweep leftover agent tabs: every about:blank tab in a Harness group
        // that no live session still pins, plus unfocused agent windows that
        // hold nothing but blank Harness tabs. Real pages and focused windows
        // are never touched.
        const keep = new Set(msg.keepTabIds || []);
        const removed = [];
        const gcGroups = await chrome.tabGroups.query({ title: settings.groupName }).catch(() => []);
        for (const g of gcGroups) {
          const tabs = await chrome.tabs.query({ groupId: g.id });
          for (const t of tabs || []) {
            const blank = !t.url || t.url.startsWith("about:blank");
            if (blank && !keep.has(t.id)) {
              await chrome.tabs.remove(t.id).catch(() => {});
              removed.push(t.id);
            }
          }
        }
        const closedWindows = [];
        const gcWins = await chrome.windows.getAll({ populate: true });
        for (const w of gcWins) {
          if (w.focused || w.type !== "normal") continue;
          const gcTabs = w.tabs || [];
          const agentOnly = gcTabs.length > 0 && gcTabs.every(
            (t) => t.groupId !== -1 && (!t.url || t.url.startsWith("about:blank"))
          );
          if (agentOnly) {
            await chrome.windows.remove(w.id).catch(() => {});
            closedWindows.push(w.id);
          }
        }
        return { removedTabs: removed, closedWindows };
      }
      case "closeTab": {
        await chrome.tabs.remove(msg.tabId);
        return { ok: true, closed: msg.tabId };
      }
      case "harnessTab": {
        const groups = await chrome.tabGroups.query({ title: settings.groupName }).catch(() => []);
        for (const g of groups) {
          const tabs = await chrome.tabs.query({ groupId: g.id });
          const candidate = (tabs || []).find((t) => !(t.url || "").includes("127.0.0.1:3080"));
          if (candidate) return { tabId: candidate.id, windowId: candidate.windowId, url: candidate.url || "", title: candidate.title || "" };
        }
        return null;
      }
      case "newHarnessTab": {
        let tab;
        if (msg.newWindow) {
          const win = await chrome.windows.create({ url: msg.url || "about:blank", focused: false });
          tab = win.tabs && win.tabs[0];
          if (!tab) [tab] = await chrome.tabs.query({ windowId: win.id });
        } else {
          const createProps = { url: msg.url || "about:blank", active: false };
          if (msg.windowId != null) createProps.windowId = msg.windowId;
          tab = await chrome.tabs.create(createProps);
        }
        const groupId = await ensureGrouped(tab);
        return { tabId: tab.id, windowId: tab.windowId, groupId, url: tab.url || "" };
      }
    }
  }

  const tab = await targetTab(msg.tabId);
  await ensureGrouped(tab);

  if (shouldBringForward(action)) {
    await bringForward(tab).catch(() => {});
  }

  const run = async (func, args) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
      args: args || [],
    });
    const r = results && results[0];
    if (r && r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    return r && r.result;
  };

  // A non-active tab never processes debugger input — the renderer is parked.
  // Trusted input therefore needs our tab to be the active one in ITS OWN
  // window. Rule: never disturb the user. If the tab's window is the FOCUSED
  // window (the user is working right there), we do NOT switch tabs — the
  // caller falls back to synthetic events, which work fine on background
  // tabs. In an unfocused window (the usual dedicated agent window) we
  // activate our tab; user focus is untouched — that would need
  // windows.update({focused}), which we never call.
  const canRenderTrusted = async () => {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active && active.id === tab.id) return true;
    const win = await chrome.windows.get(tab.windowId);
    if (win.focused) return false;
    await chrome.tabs.update(tab.id, { active: true });
    return true;
  };

  // Element clicks: resolve the element, then click it with a REAL debugger
  // mouse event (isTrusted: true). Falls back to synthetic dispatch when the
  // element is covered, the debugger is taken, or trustedInput is off.
  const trustedClick = async (mode, arg, exact) => {
    if (!settings.trustedInput) return await run(actFunc, [mode, arg, null, exact, settings.visualFeedback]);
    const cdpOk = await canRenderTrusted().catch(() => false);
    if (!cdpOk) {
      const r = await run(actFunc, [mode, arg, null, exact, settings.visualFeedback]);
      if (r && typeof r === "object" && r.ok) r.via = "synthetic-background";
      return r;
    }
    const loc = await run(locateFunc, [mode, arg, exact, settings.visualFeedback]);
    if (!loc || loc.needsCdp !== true) return loc; // final result (error or synthetic-covered)
    try {
      // Hover first, then re-measure. Hover-revealed controls (a "..." that
      // appears on mouseenter) can move when they show up, so clicking the
      // pre-hover center misses them. The hover-only move triggers :hover, a
      // short beat lets React re-render, then we click the element's NEW center.
      await cdpHover(tab.id, loc.x, loc.y);
      await new Promise((r) => setTimeout(r, 60));
      const rem = await run(remeasureFunc, []);
      const cx = rem && rem.x != null ? rem.x : loc.x;
      const cy = rem && rem.y != null ? rem.y : loc.y;
      await cdpClick(tab.id, cx, cy);
      let confirm = {};
      try { confirm = (await run(confirmClickFunc, [])) || {}; } catch { /* page navigated — fine */ }
      return { ...loc.result, ...confirm, via: "cdp" };
    } catch {
      const fb = await run(actFunc, [mode, arg, null, exact, settings.visualFeedback]);
      if (fb && typeof fb === "object") fb.via = "synthetic-fallback";
      return fb;
    }
  };

  switch (action) {
    case "snap": return await run(snapFunc, []);
    case "dialog": return await run(dialogFunc, []);
    case "form": return await run(formFunc, []);
    case "click": return await trustedClick("click", String(msg.sel || ""), null);
    case "clickText": return await trustedClick("clickText", String(msg.text || ""), Boolean(msg.exact));
    case "clickN": return await trustedClick("clickN", Number(msg.n), null);
    case "clickXY": {
      if (settings.trustedInput && await canRenderTrusted().catch(() => false)) {
        try {
          await cdpClick(tab.id, Number(msg.x), Number(msg.y));
          return { ok: true, x: Number(msg.x), y: Number(msg.y), via: "cdp" };
        } catch { /* fall through to synthetic */ }
      }
      return await run(actFunc, ["clickXY", Number(msg.x), Number(msg.y), null, settings.visualFeedback]);
    }
    case "hoverXY": {
      if (settings.trustedInput && await canRenderTrusted().catch(() => false)) {
        try {
          await cdpHover(tab.id, Number(msg.x), Number(msg.y));
          return { ok: true, x: Number(msg.x), y: Number(msg.y), via: "cdp" };
        } catch { /* fall through to synthetic */ }
      }
      return await run(actFunc, ["hoverXY", Number(msg.x), Number(msg.y), null, settings.visualFeedback]);
    }
    case "hover": {
      // Resolve like clickN/clickText/click, then glide the mouse onto the
      // element's center WITHOUT pressing — reveals hover-only UI. Accepts
      // {n}, {text} (+exact), or {sel}; use hoverXY for raw coordinates.
      const hm = msg.sel ? "sel" : (msg.text ? "text" : (msg.n != null ? "n" : null));
      const ha = hm === "sel" ? msg.sel : (hm === "text" ? msg.text : (hm === "n" ? msg.n : null));
      if (!hm) return { ok: false, error: "hover needs {n}, {text}, or {sel} — or use hoverXY with {x},{y}" };
      const loc = await run(hoverFunc, [hm, ha, msg.exact ? true : null]);
      if (!loc || !loc.ok) return loc;
      if (settings.trustedInput && await canRenderTrusted().catch(() => false)) {
        try {
          await cdpHover(tab.id, loc.x, loc.y);
          return { ok: true, ...loc, via: "cdp" };
        } catch { /* fall through to synthetic */ }
      }
      return await run(actFunc, ["hoverXY", loc.x, loc.y, null, settings.visualFeedback]);
    }
    case "key": {
      if (settings.trustedInput && await canRenderTrusted().catch(() => false)) {
        try {
          await cdpKey(tab.id, String(msg.key || ""), Boolean(msg.meta), Boolean(msg.shift));
          return { ok: true, key: String(msg.key || ""), via: "cdp" };
        } catch { /* fall through to synthetic */ }
      }
      return await run(actFunc, ["key", String(msg.key || ""), Boolean(msg.meta), Boolean(msg.shift), settings.visualFeedback]);
    }
    case "typeKeys": {
      // Real per-character keystrokes from the debugger — what masked or
      // per-key-formatted fields (card numbers, OTP boxes) actually require.
      if (settings.trustedInput && await canRenderTrusted().catch(() => false)) {
        const focus = await run(focusFieldFunc, [String(msg.sel || "")]);
        if (!focus || focus.ok !== true) return focus;
        try {
          await cdpTypeText(tab.id, String(msg.text || ""));
          let after = {};
          try { after = (await run(fieldValueFunc, [])) || {}; } catch { /* ignore */ }
          return { ok: true, typed: String(msg.text || "").length + " chars (trusted keystrokes)", into: focus.into, via: "cdp", ...after };
        } catch { /* fall through to synthetic */ }
      }
      return await run(actFunc, ["typeKeys", String(msg.sel || ""), String(msg.text || ""), null, settings.visualFeedback]);
    }
    case "tail": return await run(actFunc, ["tail", null, null, null, settings.visualFeedback]);
    case "read": return await run(actFunc, ["read", Number(msg.offset) || 0, null, null, settings.visualFeedback]);
    case "hrefs": return await run(actFunc, ["hrefs", String(msg.text || ""), null, null, settings.visualFeedback]);
    case "findText": return await run(findTextFunc, [String(msg.text || "")]);
    case "fill": return await run(fillFunc, [String(msg.sel || ""), String(msg.value ?? "")]);
    case "fillShadow": return await run(fillShadowFunc, [String(msg.match || ""), String(msg.value ?? "")]);
    case "type": return await run(actFunc, ["type", String(msg.sel || ""), String(msg.text || ""), null, settings.visualFeedback]);
    case "replace": return await run(actFunc, ["replace", String(msg.sel || ""), String(msg.text || ""), null, settings.visualFeedback]);
    case "shot":
    case "screenshot":
      return await takeScreenshot(tab, msg);
    case "navigate": {
      // Wait for the load to finish so the very next snap sees the new page,
      // not the old one mid-teardown. 15s cap; a slow page returns loaded:false.
      await chrome.tabs.update(tab.id, { url: msg.url });
      const loaded = await new Promise((resolve) => {
        const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); resolve(false); }, 15000);
        function onUpd(tabId, info) {
          if (tabId === tab.id && info.status === "complete") {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpd);
            resolve(true);
          }
        }
        chrome.tabs.onUpdated.addListener(onUpd);
      });
      const now = await chrome.tabs.get(tab.id);
      return { ok: true, url: now.url || msg.url, title: now.title || "", loaded };
    }
    default:
      return reply({ ok: false, error: "unknown action '" + action + "'", hint: "run {\"action\":\"help\"} via the CLI for the command list" }) ?? undefined;
  }
}

// ── Screenshots ─────────────────────────────────────────────────────────────

// Small screenshot the harness can actually read. Returns a downscaled data
// URL plus its pixel size. The calling side (CLI) writes it to disk.
async function takeScreenshot(tab, msg) {
  const format = String(msg.format || settings.shotFormat) === "png" ? "png" : "jpeg";
  const quality = Number(msg.quality ?? settings.shotQuality);
  const maxWidth = Number(msg.maxWidth ?? settings.shotMaxWidth) || 0;

  let dataUrl;
  const mode = String(msg.mode || settings.screenshotMode);
  const isActive = await tabIsActive(tab);

  if (mode === "visible" || (mode === "auto" && isActive)) {
    const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (format === "png" && (!maxWidth || maxWidth >= 4096)) {
      const dims = await measureDataUrl(png);
      return { dataUrl: png, width: dims.width, height: dims.height, format: "png", source: "visible" };
    }
    dataUrl = png; // downscale below
  } else {
    // CDP photographs any tab without touching focus.
    dataUrl = await cdpScreenshot(tab.id, "png");
  }

  const down = await downscaleDataUrl(dataUrl, maxWidth, format, quality);
  return { ...down, source: isActive ? "visible" : "cdp" };
}

function tabIsActive(tab) {
  return chrome.tabs.query({ active: true, windowId: tab.windowId }).then((t) => t[0] && t[0].id === tab.id);
}

function cdpScreenshot(tabId, format) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format }, (res) => {
        chrome.debugger.detach({ tabId }, () => {});
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || !res.data) return reject(new Error("no screenshot data"));
        resolve(`data:image/png;base64,${res.data}`);
      });
    });
  });
}

async function measureDataUrl(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const { width, height } = bmp;
  bmp.close();
  return { width, height };
}

async function downscaleDataUrl(dataUrl, maxWidth, format, quality) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = maxWidth > 0 && bmp.width > maxWidth ? maxWidth / bmp.width : 1;
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type: format === "png" ? "image/png" : "image/jpeg", quality });
  return { dataUrl: await blobToDataUrl(out), width: w, height: h, format };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("blob read failed"));
    reader.readAsDataURL(blob);
  });
}

// ── Tab helpers ─────────────────────────────────────────────────────────────

function targetTab(tabId) {
  if (tabId != null) return chrome.tabs.get(tabId);
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0]);
}

// Mark the tab the harness is driving so it is obvious on screen: a colored
// tab group (name/color from Options; default red "Harness").
async function ensureGrouped(tab) {
  if (tab.groupId !== -1) return tab.groupId;
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: settings.groupName, color: settings.groupColor }).catch(() => {});
    return groupId;
  } catch (e) {
    return -1;
  }
}

// Only called when the user opted in to focus-stealing (focusOnAction: true).
async function bringForward(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

// ── Wiring ──────────────────────────────────────────────────────────────────

// Keepalive: MV3 service workers sleep and take the WebSocket with them. The
// alarm wakes the worker; we only reconnect if the user already asked to
// connect (intent). No intent → no reconnect → the handshake stays manual.
try {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "keepalive" && intent && (!ws || ws.readyState !== 1)) connect();
  });
} catch (e) {
  console.error("pilot alarms unavailable:", e);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "connect") {
    intent = true;
    try { if (ws) ws.close(); } catch {}
    connect();
    sendResponse({ state: "connecting", ...currentState() });
  } else if (msg && msg.type === "disconnect") {
    disconnect();
    sendResponse(currentState());
  } else if (msg && msg.type === "state-query") {
    sendResponse(currentState());
  } else if (msg && msg.type === "settings-updated") {
    loadSettings().then(() => {
      // Relay URL or profile changed while connected → re-handshake.
      if (intent && ws && ws.readyState === 1) {
        try { ws.close(); } catch {}
        connect();
      }
      sendResponse(currentState());
    });
    return true; // async
  }
  return true;
});

// autoConnect (default on): the worker connects on start, so the bridge
// survives reboots and extension reloads without a popup click. Options can
// turn it off for a strictly manual handshake via the popup's Connect.
loadSettings().then(() => {
  if (settings.autoConnect) {
    intent = true;
    connect();
  }
});
