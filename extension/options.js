const DEFAULTS = {
  profileName: "default",
  relayUrl: "ws://127.0.0.1:8756",
  harnessUrl: "http://127.0.0.1:3080",
  autoStartRelay: true,
  groupName: "Harness",
  groupColor: "red",
  focusOnAction: false,
  screenshotMode: "auto",
  shotMaxWidth: 1280,
  shotFormat: "jpeg",
};

function load() {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    document.getElementById("profileName").value = s.profileName;
    document.getElementById("relayUrl").value = s.relayUrl;
    document.getElementById("harnessUrl").value = s.harnessUrl;
    document.getElementById("autoStartRelay").checked = !!s.autoStartRelay;
    document.getElementById("groupName").value = s.groupName;
    document.getElementById("groupColor").value = s.groupColor;
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
    harnessUrl: document.getElementById("harnessUrl").value.trim() || DEFAULTS.harnessUrl,
    autoStartRelay: document.getElementById("autoStartRelay").checked,
    groupName: document.getElementById("groupName").value.trim() || "Harness",
    groupColor: document.getElementById("groupColor").value,
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
