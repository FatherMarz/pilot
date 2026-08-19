const DEFAULTS = {
  profileName: "default",
  relayUrl: "ws://127.0.0.1:8756",
  focusOnAction: false,
  screenshotMode: "auto",
  shotMaxWidth: 1280,
  shotFormat: "jpeg",
};

function load() {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    document.getElementById("profileName").value = s.profileName;
    document.getElementById("relayUrl").value = s.relayUrl;
    document.getElementById("focusOnAction").checked = !!s.focusOnAction;
    document.getElementById("screenshotMode").value = s.screenshotMode;
    document.getElementById("shotMaxWidth").value = s.shotMaxWidth;
    document.getElementById("shotFormat").value = s.shotFormat;
  });
}

function save() {
  const saved = {
    profileName: document.getElementById("profileName").value.trim() || "default",
    relayUrl: document.getElementById("relayUrl").value.trim() || DEFAULTS.relayUrl,
    focusOnAction: document.getElementById("focusOnAction").checked,
    screenshotMode: document.getElementById("screenshotMode").value,
    shotMaxWidth: Math.max(0, parseInt(document.getElementById("shotMaxWidth").value, 10) || 0),
    shotFormat: document.getElementById("shotFormat").value,
  };
  chrome.storage.sync.set(saved, () => {
    chrome.runtime.sendMessage({ type: "settings-updated" });
    const el = document.getElementById("saved");
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 1500);
  });
}

document.getElementById("save").addEventListener("click", save);
load();
