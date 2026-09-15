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

const TUNING_KEYS = ["brightness", "contrast", "saturation", "temperature", "dim"];
const sliderSaveTimers = new Map();

const inputs = {
  enabled: document.getElementById("enabledInput"),
  defaultMode: document.getElementById("defaultModeInput"),
  siteTuningEnabled: document.getElementById("siteTuningEnabledInput"),
  global: getTuningControls("global"),
  site: getTuningControls("site")
};

let activeTab = null;
let activeHost = "";
let activeGlobalFilter = "dark";
let settings = { ...DEFAULT_SETTINGS };

document.addEventListener("DOMContentLoaded", initPopup);

async function initPopup() {
  activeTab = await getActiveTab();
  activeHost = getHost(activeTab?.url || "");
  document.getElementById("hostLabel").textContent = activeHost || "このページでは利用できません";

  settings = normalizeSettings(await chrome.storage.sync.get(null));
  activeGlobalFilter = getPreferredGlobalFilter();
  renderSettings();
  bindEvents();
}

function bindEvents() {
  inputs.enabled.addEventListener("change", () => saveRootSetting("enabled", inputs.enabled.checked));
  inputs.defaultMode.addEventListener("change", () => {
    saveDefaultMode(inputs.defaultMode.value);
  });

  document.querySelector(".scope-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-panel]");
    if (!button) return;
    showPanel(button.dataset.panel);
  });

  document.getElementById("globalFilterGroup").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-global-filter]");
    if (!button) return;

    activeGlobalFilter = button.dataset.globalFilter;
    renderGlobalFilterButtons();
    renderTuning("global", getGlobalTuning(activeGlobalFilter));
  });

  bindTuningEvents("global", saveGlobalFilterTuning);
  bindTuningEvents("site", saveSiteTuning);

  document.getElementById("siteModeGroup").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-site-mode]");
    if (!button || !activeHost) return;
    await saveSiteMode(button.dataset.siteMode);
  });

  inputs.siteTuningEnabled.addEventListener("change", async () => {
    await setSiteTuningEnabled(inputs.siteTuningEnabled.checked);
  });

  document.getElementById("resetGlobalButton").addEventListener("click", async () => {
    const filterSettings = {
      ...settings.filterSettings,
      [activeGlobalFilter]: { ...DEFAULT_FILTER_SETTINGS[activeGlobalFilter] }
    };

    settings = { ...settings, filterSettings };
    await chrome.storage.sync.set({ filterSettings });
    renderTuning("global", getGlobalTuning(activeGlobalFilter));
    renderSiteTuning();
    await refreshActiveTab();
  });

  document.getElementById("resetSiteButton").addEventListener("click", async () => {
    if (!activeHost) return;

    const siteModes = { ...settings.siteModes };
    const siteAdjustments = { ...settings.siteAdjustments };
    delete siteModes[activeHost];
    delete siteAdjustments[activeHost];

    settings = { ...settings, siteModes, siteAdjustments };
    await chrome.storage.sync.set({ siteModes, siteAdjustments });
    renderSettings();
    await refreshActiveTab();
  });
}

function bindTuningEvents(scope, saveHandler) {
  for (const key of TUNING_KEYS) {
    const control = inputs[scope][key];

    control.input.addEventListener("input", () => {
      control.output.textContent = control.input.value;
      queueTuningSave(scope, key, Number(control.input.value), saveHandler);
    });

    control.input.addEventListener("change", () => {
      flushQueuedTuningSave(scope, key);
      saveHandler(key, Number(control.input.value));
    });
  }

  inputs[scope].imageFilter.input.addEventListener("change", () => {
    saveHandler("imageFilter", inputs[scope].imageFilter.input.checked);
  });
}

function queueTuningSave(scope, key, value, saveHandler) {
  const timerKey = `${scope}:${key}`;
  flushQueuedTuningSave(scope, key);

  const timerId = setTimeout(() => {
    sliderSaveTimers.delete(timerKey);
    saveHandler(key, value);
  }, 120);

  sliderSaveTimers.set(timerKey, timerId);
}

function flushQueuedTuningSave(scope, key) {
  const timerKey = `${scope}:${key}`;
  const timerId = sliderSaveTimers.get(timerKey);
  if (!timerId) return;

  clearTimeout(timerId);
  sliderSaveTimers.delete(timerKey);
}

function renderSettings() {
  inputs.enabled.checked = Boolean(settings.enabled);
  inputs.defaultMode.value = settings.defaultMode;

  renderPageStatus();
  renderGlobalFilterButtons();
  renderTuning("global", getGlobalTuning(activeGlobalFilter));
  renderSiteModeButtons();
  renderSiteTuning();
}

function renderPageStatus() {
  const status = document.getElementById("pageStatus");

  if (!activeHost) {
    status.textContent = "現在のページ: 対象外";
    status.classList.add("warning");
    return;
  }

  const mode = getCurrentSiteMode();
  const label = getModeLabel(mode);
  const source = getCurrentTuningSource();

  status.textContent = `現在のページ: ${label} / ${source}`;
  status.classList.toggle("warning", source === "サイト別調整");
}

function renderGlobalFilterButtons() {
  for (const button of document.querySelectorAll("[data-global-filter]")) {
    button.classList.toggle("active", button.dataset.globalFilter === activeGlobalFilter);
  }
}

function renderTuning(scope, tuning) {
  for (const key of TUNING_KEYS) {
    inputs[scope][key].input.value = tuning[key];
    inputs[scope][key].output.textContent = tuning[key];
  }

  inputs[scope].imageFilter.input.checked = Boolean(tuning.imageFilter);
}

function renderSiteModeButtons() {
  const siteMode = activeHost && settings.siteModes[activeHost]
    ? settings.siteModes[activeHost]
    : "auto";

  for (const button of document.querySelectorAll("[data-site-mode]")) {
    button.classList.toggle("active", button.dataset.siteMode === siteMode);
    button.disabled = !activeHost;
  }
}

function renderSiteTuning() {
  const siteTuning = activeHost ? settings.siteAdjustments[activeHost] : null;
  const isEnabled = Boolean(activeHost && siteTuning?.enabled);
  const tuning = isEnabled
    ? { ...getSiteTuningBase(), ...siteTuning }
    : getSiteTuningBase();

  inputs.siteTuningEnabled.checked = isEnabled;
  inputs.siteTuningEnabled.disabled = !activeHost;
  renderTuning("site", tuning);
  setSiteTuningDisabled(!isEnabled || !activeHost);

  document.getElementById("resetSiteButton").disabled = !activeHost;
}

function setSiteTuningDisabled(disabled) {
  for (const key of TUNING_KEYS) {
    inputs.site[key].input.disabled = disabled;
  }

  inputs.site.imageFilter.input.disabled = disabled;
  document.getElementById("siteTuningControls").classList.toggle("disabled-block", disabled);
  document.getElementById("siteImageFilterControls").classList.toggle("disabled-block", disabled);
}

function showPanel(panelId) {
  for (const button of document.querySelectorAll("[data-panel]")) {
    button.classList.toggle("active", button.dataset.panel === panelId);
  }

  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === panelId);
  }
}

async function saveRootSetting(key, value) {
  settings = { ...settings, [key]: value };
  await chrome.storage.sync.set({ [key]: value });
  renderPageStatus();
  renderSiteTuning();
  await refreshActiveTab();
}

async function saveDefaultMode(value) {
  settings = { ...settings, defaultMode: value };
  activeGlobalFilter = getPreferredGlobalFilter();
  await chrome.storage.sync.set({ defaultMode: value });
  renderSettings();
  await refreshActiveTab();
}

async function saveGlobalFilterTuning(key, value) {
  const filterSettings = {
    ...settings.filterSettings,
    [activeGlobalFilter]: {
      ...settings.filterSettings[activeGlobalFilter],
      [key]: value
    }
  };

  settings = { ...settings, filterSettings };
  await chrome.storage.sync.set({ filterSettings });
  renderPageStatus();
  renderSiteTuning();
  await refreshActiveTab();
}

async function saveSiteMode(mode) {
  const siteModes = { ...settings.siteModes };

  if (mode === "auto") {
    delete siteModes[activeHost];
  } else {
    siteModes[activeHost] = mode;
  }

  settings = { ...settings, siteModes };
  await chrome.storage.sync.set({ siteModes });
  activeGlobalFilter = getPreferredGlobalFilter();
  renderSettings();
  await refreshActiveTab();
}

async function setSiteTuningEnabled(enabled) {
  if (!activeHost) return;

  const siteAdjustments = { ...settings.siteAdjustments };
  const current = siteAdjustments[activeHost] || {};

  if (enabled) {
    siteAdjustments[activeHost] = {
      ...getSiteTuningBase(),
      ...current,
      enabled: true
    };
  } else if (siteAdjustments[activeHost]) {
    siteAdjustments[activeHost] = {
      ...current,
      enabled: false
    };
  }

  settings = { ...settings, siteAdjustments };
  await chrome.storage.sync.set({ siteAdjustments });
  renderSettings();
  await refreshActiveTab();
}

async function saveSiteTuning(key, value) {
  if (!activeHost) return;

  const siteAdjustments = { ...settings.siteAdjustments };
  siteAdjustments[activeHost] = {
    ...getSiteTuningBase(),
    ...(siteAdjustments[activeHost] || {}),
    enabled: true,
    [key]: value
  };

  settings = { ...settings, siteAdjustments };
  await chrome.storage.sync.set({ siteAdjustments });
  renderSettings();
  await refreshActiveTab();
}

function getPreferredGlobalFilter() {
  const mode = getCurrentSiteMode();
  if (mode === "dark" || mode === "filtered") return mode;
  if (settings.defaultMode === "dark" || settings.defaultMode === "filtered") return settings.defaultMode;
  return "dark";
}

function getCurrentTuningSource() {
  if (!settings.enabled) return "停止中";
  if (getCurrentSiteMode() === "normal") return "通常表示";
  return activeHost && settings.siteAdjustments[activeHost]?.enabled
    ? "サイト別調整"
    : "全体設定";
}

function getModeLabel(mode) {
  if (mode === "filtered") return "Filter";
  if (mode === "dark") return "Dark";
  return "Normal";
}

function getSiteTuningBase() {
  const mode = getCurrentSiteMode();
  if (mode === "filtered" || mode === "dark") return getGlobalTuning(mode);
  if (settings.defaultMode === "filtered" || settings.defaultMode === "dark") {
    return getGlobalTuning(settings.defaultMode);
  }
  return getGlobalTuning("dark");
}

function getCurrentSiteMode() {
  if (!activeHost) return settings.defaultMode;
  return settings.siteModes[activeHost] || settings.defaultMode;
}

function getGlobalTuning(mode) {
  return mode === "filtered"
    ? settings.filterSettings.filtered
    : settings.filterSettings.dark;
}

function getTuningControls(scope) {
  const prefix = scope === "global" ? "global" : "site";
  return {
    brightness: getRangeControl(prefix, "Brightness"),
    contrast: getRangeControl(prefix, "Contrast"),
    saturation: getRangeControl(prefix, "Saturation"),
    temperature: getRangeControl(prefix, "Temperature"),
    dim: getRangeControl(prefix, "Dim"),
    imageFilter: {
      input: document.getElementById(`${prefix}ImageFilterInput`)
    }
  };
}

function getRangeControl(prefix, name) {
  return {
    input: document.getElementById(`${prefix}${name}Input`),
    output: document.getElementById(`${prefix}${name}Output`)
  };
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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshActiveTab() {
  if (!activeTab?.id) return;

  if (await sendRefreshMessage(activeTab.id)) return;

  await injectContentScript(activeTab.id);
  await sendRefreshMessage(activeTab.id);
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
    // Browser pages and the Chrome Web Store do not allow content scripts.
  }
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
