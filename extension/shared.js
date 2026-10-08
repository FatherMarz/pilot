// Pilot — pure helpers shared by the service worker and the tests.
//
// No chrome.* calls: the worker loads this with importScripts, the tests
// require it under node.

(function (root) {
  // Merge per-frame snap results into one list. frames: [{ frame, offset,
  // result }] with frame 0 = main document. Items keep their page order
  // inside each priority band (0 open dialog/menu/listbox, 1 on screen,
  // 2 off screen); frame items get the frame's offset added so x/y are top
  // viewport pixels, and a `frame` number. Returns { items, truncated, total }.
  function mergeSnapItems(frames, cap) {
    const all = [];
    for (const f of frames) {
      const r = f.result || {};
      const ox = (f.offset && f.offset.x) || 0;
      const oy = (f.offset && f.offset.y) || 0;
      (r.items || []).forEach((it, i) => {
        const item = { ...it };
        if (f.frame) {
          item.frame = f.frame;
          if (item.x != null) item.x += ox;
          if (item.y != null) item.y += oy;
          // A frame that is scrolled out of the top page is not on screen.
          if (item.pri === 1 && f.onScreen === false) item.pri = 2;
        }
        all.push({ item, key: [item.pri == null ? 2 : item.pri, f.frame || 0, i] });
      });
    }
    all.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
    const more = frames.reduce((n, f) => n + ((f.result && f.result.more) || 0), 0);
    const limit = cap || 150;
    const items = all.slice(0, limit).map((x) => x.item);
    const left = all.length - items.length + more;
    return { items, truncated: left > 0, total: all.length + more, left };
  }

  const BLANK = /^(about:blank|chrome:\/\/newtab|chrome:\/\/new-tab-page)/;

  // Which tabs does a cleanup touch? Pure decision over plain data.
  //   tabs:     [{ id, groupId, url, active, lastAccessed, discarded }]
  //   groups:   [{ id, title }]
  //   titles:   group titles that belong to Pilot (["Pilot", "Harness"])
  //   owned:    { [tabId]: { session, lastUsed, parent? } } — the worker's registry
  //   keep:     tab ids that must survive (live CLI sessions)
  //   idleMs:   idle limit; 0 turns idle release off
  // Rules: never close a tab the user is looking at (active) — ungroup it
  // instead; never close a tab the user moved out of the Pilot group — just
  // forget it; orphans (in a Pilot group, owned by no session) are closed
  // only when blank, discarded, or not looked at for idleMs.
  function selectSweep({ tabs, groups, titles, owned, keep, now, idleMs }) {
    const pilotGroups = new Set((groups || []).filter((g) => (titles || []).includes(g.title)).map((g) => g.id));
    const keepSet = new Set((keep || []).map(Number));
    const byId = new Map((tabs || []).map((t) => [t.id, t]));
    const close = [], ungroup = [], forget = [];
    const own = owned || {};
    const handled = new Set();

    for (const [idStr, o] of Object.entries(own)) {
      const id = Number(idStr);
      const t = byId.get(id);
      if (!t) { forget.push({ id, reason: "tab is gone" }); continue; }
      handled.add(id);
      if (keepSet.has(id)) continue;
      const parentKept = o && o.parent != null && keepSet.has(Number(o.parent)) && byId.has(Number(o.parent));
      if (parentKept) continue;
      const idle = idleMs > 0 && now - ((o && o.lastUsed) || 0) > idleMs;
      if (!idle) continue;
      const inPilot = pilotGroups.has(t.groupId);
      if (t.active) { if (inPilot) ungroup.push({ id, reason: "idle session, but the user is viewing it" }); forget.push({ id, reason: "idle session" }); }
      else if (!inPilot) forget.push({ id, reason: "idle session; the user moved the tab out of the Pilot group" });
      else close.push({ id, reason: "idle session (" + Math.round((now - ((o && o.lastUsed) || 0)) / 60000) + " min)", session: o && o.session });
    }

    for (const t of tabs || []) {
      if (handled.has(t.id) || keepSet.has(t.id) || !pilotGroups.has(t.groupId)) continue;
      const blank = !t.url || BLANK.test(t.url);
      const stale = idleMs > 0 && t.lastAccessed != null && now - t.lastAccessed > idleMs;
      if (t.active) { if (blank || stale) ungroup.push({ id: t.id, reason: "orphan Pilot tab the user is viewing" }); continue; }
      if (blank) close.push({ id: t.id, reason: "orphan blank Pilot tab" });
      else if (t.discarded) close.push({ id: t.id, reason: "orphan discarded Pilot tab" });
      else if (stale) close.push({ id: t.id, reason: "orphan Pilot tab untouched for " + Math.round((now - t.lastAccessed) / 60000) + " min" });
    }
    return { close, ungroup, forget };
  }

  // Chrome debugger errors that mean "this tab's session is gone or was
  // refused", which a detach + fresh attach can cure. Timeouts are NOT in
  // the list: a timed-out Input event may still have been delivered, and
  // sending it again would act twice.
  const HEALABLE = /not attached|Detached while handling|No target with given id|Target closed|Cannot access a chrome-extension|different extension|Cannot access contents of url "chrome-extension|Inspected target navigated or closed|Cannot find context|Session with given id not found/i;
  function cdpHealable(message) {
    const m = String(message || "");
    if (/timed out/i.test(m)) return false;
    return HEALABLE.test(m);
  }

  // Run one debugger command; on a healable error reset the tab's debugger
  // state (heal: detach, clear, reattach, re-enable focus emulation) and try
  // ONCE more. A second failure, an unhealable error or a failed heal is
  // thrown to the caller, which falls back to simulated input.
  async function withHeal(send, heal) {
    try {
      return await send();
    } catch (e) {
      if (!cdpHealable(e && e.message)) throw e;
      await heal(e);
      return await send();
    }
  }

  // Page shim for JavaScript dialogs when the debugger is out. Both
  // functions run in the page's MAIN world via executeScript (they must stay
  // self-contained: no closure over this file).
  function dialogShim(on, policy) {
    const K = "__pilotDialogShim";
    let S = window[K];
    if (!S) {
      S = { log: [], policy: null, on: false, orig: { alert: window.alert, confirm: window.confirm, prompt: window.prompt } };
      Object.defineProperty(window, K, { value: S, configurable: true });
      const answer = (type, message, def) => {
        const pol = S.policy || { accept: true };
        const accepted = pol.accept !== false;
        const rec = { type, message: String(message === undefined ? "" : message).slice(0, 500), accepted, at: Date.now() };
        if (type === "prompt") rec.promptText = pol.promptText != null ? String(pol.promptText) : String(def === undefined ? "" : def);
        S.log.push(rec);
        if (S.log.length > 20) S.log.shift();
        if (pol.once) S.policy = null;
        return rec;
      };
      S.fake = {
        alert: function alert(m) { answer("alert", m); },
        confirm: function confirm(m) { return answer("confirm", m).accepted; },
        prompt: function prompt(m, d) { const r = answer("prompt", m, d); return r.accepted ? r.promptText : null; },
      };
      // Capture on window runs before the page's own beforeunload handlers
      // (and onbeforeunload), so none of them can ask "leave this page?".
      window.addEventListener("beforeunload", (e) => { if (S.on) e.stopImmediatePropagation(); }, true);
    }
    S.policy = policy || null;
    S.on = !!on;
    for (const k of ["alert", "confirm", "prompt"]) window[k] = on ? S.fake[k] : S.orig[k];
    if (on) window.onbeforeunload = null;
    return true;
  }

  function drainShim() {
    const S = window.__pilotDialogShim;
    if (!S || !S.log.length) return [];
    const out = S.log;
    S.log = [];
    return out;
  }

  const api = { mergeSnapItems, selectSweep, cdpHealable, withHeal, dialogShim, drainShim };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PilotShared = api;
})(typeof self !== "undefined" ? self : globalThis);
