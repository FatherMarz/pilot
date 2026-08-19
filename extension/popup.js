const label = document.getElementById("label");
const statusEl = document.getElementById("status");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const settingsBtn = document.getElementById("settings");
const hint = document.getElementById("hint");
const profileEl = document.getElementById("profile");
const relayEl = document.getElementById("relay");

function render(state) {
  if (typeof state === "string") state = { connected: state === "connected", intent: state === "connecting" };
  if (!state) state = {};
  statusEl.className = state.connected ? "connected" : state.intent ? "connecting" : "disconnected";
  label.textContent = state.connected
    ? "Connected to harness"
    : state.intent
      ? "Connecting…"
      : "Disconnected — click Connect to handshake";
  connectBtn.hidden = state.connected;
  disconnectBtn.hidden = !state.connected;
  hint.hidden = state.connected || state.intent;
  if (state.profile) profileEl.textContent = state.profile;
  if (state.relay) relayEl.textContent = state.relay;
}

connectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "connect" }, (r) => render(r || {}));
});
disconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "disconnect" }, (r) => render(r || {}));
});
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.runtime.sendMessage({ type: "state-query" }, (r) => render(r || {}));
chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "state") render(m.state); });
