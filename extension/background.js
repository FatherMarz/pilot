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
  if (mode === "tail") {
    const text = (document.body && document.body.innerText || "");
    return text.slice(-3000);
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
    return { ok: true, clicked: labelOf(best.el).slice(0, 50), tag: best.el.tagName.toLowerCase(), x: p.x, y: p.y, match: ["exact", "exact-ci", "starts", "starts-ci", "contains-ci"][best.score[0]] };
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
    return { ok: true, clicked: item.text || item.icon, n: a, x: p.x, y: p.y };
  }
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
      el.dispatchEvent(new Event("input", { bubbles: true }));
      via = "value";
    } else {
      if (mode === "replace") document.execCommand("selectAll", false, null);
      via = "insertText:" + document.execCommand("insertText", false, b);
    }
    return { ok: true, typed: b.length + " chars", into: el.tagName.toLowerCase() + (el.name ? "[name=" + el.name + "]" : ""), via, valueNow: (el.value ?? el.innerText ?? "").slice(0, 60) };
  }
  return { ok: false, error: "unknown mode " + mode };
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
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.title || "").trim().slice(0, 70),
        icon: el.tagName === "BUTTON" && !(el.innerText || "").trim() ? "icon-btn" : "",
        visible: r.width > 0 && r.height > 0,
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        w: Math.round(r.width),
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
  const el = sel && document.querySelector(sel);
  if (!el) {
    const fields = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
      .slice(0, 12)
      .map((e) => ({ tag: e.tagName.toLowerCase(), name: e.name || null, id: e.id || null, placeholder: e.placeholder || null }));
    return { ok: false, error: "no field matches selector '" + sel + "'", fields, hint: "use a name from this list, e.g. {\"action\":\"fill\",\"sel\":\"[name=email]\",\"value\":\"...\"}" };
  }
  const proto = el.tagName === "SELECT" ? window.HTMLSelectElement.prototype :
    el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  if (el.tagName === "SELECT" && el.value !== value) {
    // Value didn't stick — the option value is different from the label.
    const options = [...el.options].map((o) => ({ value: o.value, label: o.innerText.trim() }));
    const byLabel = options.find((o) => o.label.toLowerCase() === String(value).toLowerCase());
    if (byLabel) {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(el, byLabel.value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
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
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
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

  switch (action) {
    case "snap": return await run(snapFunc, []);
    case "dialog": return await run(dialogFunc, []);
    case "form": return await run(formFunc, []);
    case "click": return await run(actFunc, ["click", String(msg.sel || ""), null, null, settings.visualFeedback]);
    case "clickXY": return await run(actFunc, ["clickXY", Number(msg.x), Number(msg.y), null, settings.visualFeedback]);
    case "key": return await run(actFunc, ["key", String(msg.key || ""), Boolean(msg.meta), Boolean(msg.shift), settings.visualFeedback]);
    case "tail": return await run(actFunc, ["tail", null, null, null, settings.visualFeedback]);
    case "hrefs": return await run(actFunc, ["hrefs", String(msg.text || ""), null, null, settings.visualFeedback]);
    case "clickText": return await run(actFunc, ["clickText", String(msg.text || ""), null, Boolean(msg.exact), settings.visualFeedback]);
    case "clickN": return await run(actFunc, ["clickN", Number(msg.n), null, null, settings.visualFeedback]);
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
