const DEFAULT_FILTER_SETTINGS = {
  dark: {
    brightness: 94,
    contrast: 104,
    saturation: 90,
    temperature: 18,
    dim: 6,
    imageFilter: false
  },
  filtered: {
    brightness: 96,
    contrast: 102,
    saturation: 92,
    temperature: 18,
    dim: 6,
    imageFilter: false
  }
};

const DEFAULT_SETTINGS = {
  enabled: true,
  defaultMode: "dark",
  filterSettings: DEFAULT_FILTER_SETTINGS,
  siteModes: {},
  siteAdjustments: {}
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set(normalizeSettings(current));
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-power-extension") {
    const settings = normalizeSettings(await chrome.storage.sync.get(null));
    await chrome.storage.sync.set({ enabled: !settings.enabled });
    await refreshActiveTab();
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) return;

  const host = getHost(tab.url);
  if (!host) return;

  if (command === "toggle-current-website") {
    await toggleCurrentWebsite(host);
    await refreshTab(tab.id);
    return;
  }

  if (command === "cycle-mode") {
    await cycleCurrentWebsite(host);
    await refreshTab(tab.id);
  }
});

async function toggleCurrentWebsite(host) {
  const settings = normalizeSettings(await chrome.storage.sync.get(null));
  const siteModes = { ...settings.siteModes };
  const effectiveMode = siteModes[host] || settings.defaultMode;

  const enabledMode = settings.defaultMode === "normal" ? "dark" : settings.defaultMode;
  siteModes[host] = effectiveMode === "normal" ? enabledMode : "normal";
  await chrome.storage.sync.set({ siteModes });
}

async function cycleCurrentWebsite(host) {
  const settings = normalizeSettings(await chrome.storage.sync.get(null));
  const siteModes = { ...settings.siteModes };
  const current = siteModes[host] || settings.defaultMode;
  const modes = ["dark", "filtered", "normal"];
  const next = modes[(modes.indexOf(current) + 1) % modes.length] || "dark";

  siteModes[host] = next;
  await chrome.storage.sync.set({ siteModes });
}

async function refreshActiveTab() {
  const tab = await getActiveTab();
  if (tab?.id) await refreshTab(tab.id);
}

async function refreshTab(tabId) {
  if (await sendRefreshMessage(tabId)) return;

  await injectContentScript(tabId);
  await sendRefreshMessage(tabId);
}

async function sendRefreshMessage(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "eyesy-refresh" });
    return true;
  } catch {
    return false;
  }
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
  } catch {
    // The content script is unavailable on browser pages and restricted URLs.
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getHost(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.hostname;
  } catch {
    return "";
  }
}

function normalizeSettings(value) {
  const filterSettings = value?.filterSettings && typeof value.filterSettings === "object"
    ? {
      dark: normalizeTuning(value.filterSettings.dark, DEFAULT_FILTER_SETTINGS.dark),
      filtered: normalizeTuning(value.filterSettings.filtered, DEFAULT_FILTER_SETTINGS.filtered)
    }
    : {
      dark: normalizeTuning(getLegacyTuning(value), DEFAULT_FILTER_SETTINGS.dark),
      filtered: normalizeTuning(getLegacyTuning(value), DEFAULT_FILTER_SETTINGS.filtered)
    };

  return {
    enabled: value?.enabled ?? DEFAULT_SETTINGS.enabled,
    defaultMode: ["dark", "filtered", "normal"].includes(value?.defaultMode)
      ? value.defaultMode
      : DEFAULT_SETTINGS.defaultMode,
    filterSettings,
    siteModes: value?.siteModes && typeof value.siteModes === "object" ? value.siteModes : {},
    siteAdjustments: value?.siteAdjustments && typeof value.siteAdjustments === "object"
      ? value.siteAdjustments
      : {}
  };
}

function normalizeTuning(value, fallback) {
  return {
    brightness: value?.brightness ?? fallback.brightness,
    contrast: value?.contrast ?? fallback.contrast,
    saturation: value?.saturation ?? fallback.saturation,
    temperature: value?.temperature ?? fallback.temperature,
    dim: value?.dim ?? fallback.dim,
    imageFilter: value?.imageFilter ?? fallback.imageFilter
  };
}

function getLegacyTuning(value) {
  return {
    brightness: value?.brightness,
    contrast: value?.contrast,
    saturation: value?.saturation,
    temperature: value?.temperature,
    dim: value?.dim,
    imageFilter: value?.imageFilter
  };
}
