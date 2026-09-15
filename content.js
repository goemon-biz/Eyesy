(() => {
if (globalThis.__eyesyContentLoaded) {
  globalThis.__eyesyRefresh?.();
  return;
}

globalThis.__eyesyContentLoaded = true;

const EYESY_DEFAULT_FILTER_SETTINGS = {
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

const EYESY_DEFAULT_SETTINGS = {
  enabled: true,
  defaultMode: "dark",
  filterSettings: EYESY_DEFAULT_FILTER_SETTINGS,
  siteModes: {},
  siteAdjustments: {}
};

const EYESY_STYLE_ID = "eyesy-base-style";
const EYESY_WARM_OVERLAY_ID = "eyesy-warm-overlay";
const EYESY_DIM_OVERLAY_ID = "eyesy-dim-overlay";
const EYESY_RESTORE_ATTR = "data-eyesy-original-style";
const EYESY_TOUCHED_ATTR = "data-eyesy-touched";
const EYESY_VERSION_ATTR = "data-eyesy-version";
const EYESY_CONVERSION_VERSION = "3";
const EYESY_EMPTY_STYLE = "__eyesy_empty__";
const EYESY_SCAN_LIMIT = 5000;

let eyesySettings = { ...EYESY_DEFAULT_SETTINGS };
let eyesyObserver = null;
let eyesyScanTimer = 0;
let eyesyLastMode = "normal";

initEyesy();

function initEyesy() {
  if (!isExcludedPage()) {
    ensureBaseStyle();
  }
  loadEyesySettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    const next = { ...eyesySettings };
    for (const [key, value] of Object.entries(changes)) {
      next[key] = value.newValue;
    }
    eyesySettings = normalizeSettings(next);
    applyEyesy();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "eyesy-refresh") {
      loadEyesySettings().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (message?.type === "eyesy-get-state") {
      sendResponse({
        ok: true,
        mode: getEffectiveMode(),
        host: location.hostname,
        tuning: getEffectiveTuning()
      });
    }

    return false;
  });
}

async function loadEyesySettings() {
  const stored = await chrome.storage.sync.get(null);
  eyesySettings = normalizeSettings(stored);
  applyEyesy();
}

function normalizeSettings(settings) {
  const filterSettings = settings?.filterSettings && typeof settings.filterSettings === "object"
    ? {
      dark: normalizeTuning(settings.filterSettings.dark, EYESY_DEFAULT_FILTER_SETTINGS.dark),
      filtered: normalizeTuning(
        settings.filterSettings.filtered,
        EYESY_DEFAULT_FILTER_SETTINGS.filtered
      )
    }
    : {
      dark: normalizeTuning(getLegacyTuning(settings), EYESY_DEFAULT_FILTER_SETTINGS.dark),
      filtered: normalizeTuning(getLegacyTuning(settings), EYESY_DEFAULT_FILTER_SETTINGS.filtered)
    };

  return {
    enabled: settings?.enabled ?? EYESY_DEFAULT_SETTINGS.enabled,
    defaultMode: ["dark", "filtered", "normal"].includes(settings?.defaultMode)
      ? settings.defaultMode
      : EYESY_DEFAULT_SETTINGS.defaultMode,
    filterSettings,
    siteModes: settings?.siteModes && typeof settings.siteModes === "object"
      ? settings.siteModes
      : {},
    siteAdjustments: settings?.siteAdjustments && typeof settings.siteAdjustments === "object"
      ? settings.siteAdjustments
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

function getLegacyTuning(settings) {
  return {
    brightness: settings?.brightness,
    contrast: settings?.contrast,
    saturation: settings?.saturation,
    temperature: settings?.temperature,
    dim: settings?.dim,
    imageFilter: settings?.imageFilter
  };
}

function applyEyesy() {
  const root = document.documentElement;
  if (!root) return;

  if (isExcludedPage()) {
    disableEyesyOnPage(root);
    return;
  }

  ensureBaseStyle();

  const mode = getEffectiveMode();
  const tuning = getEffectiveTuning(mode);

  updateCssVariables(root, tuning);
  updateHostClasses(root);
  root.classList.toggle("eyesy-dark", mode === "dark");
  root.classList.toggle("eyesy-filtered", mode === "filtered");
  root.classList.toggle("eyesy-active", mode !== "normal");

  ensureOverlays(mode);

  if (mode === "dark") {
    stopEyesyObserver();
    if (eyesyLastMode !== "dark" || hasOutdatedTouchedElements()) {
      restoreTouchedElements();
    }
    scheduleEyesyScan();
    startEyesyObserver();
  } else {
    stopEyesyObserver();
    if (eyesyLastMode === "dark") restoreTouchedElements();
  }

  if (mode !== "normal" && tuning.imageFilter) {
    scheduleImageFilter();
  } else {
    clearImageFilter();
  }

  eyesyLastMode = mode;
}

function disableEyesyOnPage(root) {
  stopEyesyObserver();
  clearTimeout(eyesyScanTimer);
  eyesyScanTimer = 0;
  restoreTouchedElements();
  clearImageFilter();
  removeElement(EYESY_STYLE_ID);
  removeElement(EYESY_WARM_OVERLAY_ID);
  removeElement(EYESY_DIM_OVERLAY_ID);
  root.classList.remove(
    "eyesy-dark",
    "eyesy-filtered",
    "eyesy-active",
    "eyesy-host-x",
    "eyesy-host-google-calendar"
  );
  eyesyLastMode = "normal";
}

function updateHostClasses(root) {
  const host = location.hostname;

  root.classList.toggle("eyesy-host-x", host === "x.com" || host.endsWith(".x.com"));
  root.classList.toggle(
    "eyesy-host-google-calendar",
    host === "calendar.google.com" || host.endsWith(".calendar.google.com")
  );
}

function getEffectiveMode() {
  if (isExcludedPage()) return "normal";
  if (!eyesySettings.enabled) return "normal";
  const host = location.hostname;
  const siteMode = eyesySettings.siteModes?.[host];
  return ["dark", "filtered", "normal"].includes(siteMode)
    ? siteMode
    : eyesySettings.defaultMode;
}

function getEffectiveTuning(mode = getEffectiveMode()) {
  const globalTuning = getGlobalTuning(mode);
  const host = location.hostname;
  const siteTuning = eyesySettings.siteAdjustments?.[host];

  if (!siteTuning?.enabled) return globalTuning;

  return {
    ...globalTuning,
    brightness: siteTuning.brightness ?? globalTuning.brightness,
    contrast: siteTuning.contrast ?? globalTuning.contrast,
    saturation: siteTuning.saturation ?? globalTuning.saturation,
    temperature: siteTuning.temperature ?? globalTuning.temperature,
    dim: siteTuning.dim ?? globalTuning.dim,
    imageFilter: siteTuning.imageFilter ?? globalTuning.imageFilter
  };
}

function getGlobalTuning(mode = "dark") {
  if (mode === "filtered") return eyesySettings.filterSettings.filtered;
  return eyesySettings.filterSettings.dark;
}

function isExcludedPage() {
  return location.protocol === "file:";
}

function updateCssVariables(root, tuning) {
  const brightness = clamp(tuning.brightness, 70, 125) / 100;
  const contrast = clamp(tuning.contrast, 70, 135) / 100;
  const saturation = clamp(tuning.saturation, 0, 140) / 100;
  const temperature = clamp(tuning.temperature, 0, 100);
  const dim = clamp(tuning.dim, 0, 70);

  root.style.setProperty("--eyesy-brightness", String(brightness));
  root.style.setProperty("--eyesy-contrast", String(contrast));
  root.style.setProperty("--eyesy-saturation", String(saturation));
  root.style.setProperty("--eyesy-warm-alpha", String(temperature / 220));
  root.style.setProperty("--eyesy-dim-alpha", String(dim / 100));
  root.style.setProperty("--eyesy-bg", "#111419");
  root.style.setProperty("--eyesy-bg-soft", "#191e25");
  root.style.setProperty("--eyesy-surface", "#202733");
  root.style.setProperty("--eyesy-text", "#dce4ee");
  root.style.setProperty("--eyesy-muted", "#aeb8c5");
  root.style.setProperty("--eyesy-link", "#8ab4f8");
  root.style.setProperty("--eyesy-border", "#344050");
}

function ensureBaseStyle() {
  let style = document.getElementById(EYESY_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = EYESY_STYLE_ID;
  }

  const css = `
    :root.eyesy-dark {
      color-scheme: dark !important;
    }

    :root.eyesy-dark body {
      filter:
        brightness(var(--eyesy-brightness))
        contrast(var(--eyesy-contrast))
        saturate(var(--eyesy-saturation)) !important;
    }

    :root.eyesy-filtered {
      filter:
        brightness(var(--eyesy-brightness))
        contrast(var(--eyesy-contrast))
        saturate(var(--eyesy-saturation)) !important;
    }

    :root.eyesy-filtered body {
      filter: none !important;
    }

    :root.eyesy-dark,
    :root.eyesy-dark body {
      background-color: var(--eyesy-bg) !important;
      color: var(--eyesy-text) !important;
    }

    :root.eyesy-dark input,
    :root.eyesy-dark textarea,
    :root.eyesy-dark select,
    :root.eyesy-dark button {
      background-color: var(--eyesy-surface) !important;
      border-color: var(--eyesy-border) !important;
      color: var(--eyesy-text) !important;
    }

    :root.eyesy-dark input::placeholder,
    :root.eyesy-dark textarea::placeholder {
      color: var(--eyesy-muted) !important;
    }

    :root.eyesy-dark a,
    :root.eyesy-dark a * {
      color: var(--eyesy-link) !important;
    }

    :root.eyesy-dark table,
    :root.eyesy-dark th,
    :root.eyesy-dark td,
    :root.eyesy-dark hr {
      border-color: var(--eyesy-border) !important;
    }

    :root.eyesy-dark ::selection {
      background: #375a7f !important;
      color: #ffffff !important;
    }

    :root.eyesy-dark img.eyesy-image-filter,
    :root.eyesy-dark svg.eyesy-image-filter,
    :root.eyesy-filtered img.eyesy-image-filter,
    :root.eyesy-filtered svg.eyesy-image-filter,
    :root.eyesy-dark [style*="background-image"].eyesy-image-filter {
      filter: brightness(0.82) contrast(0.96) saturate(0.9) !important;
    }

    :root.eyesy-dark.eyesy-host-x,
    :root.eyesy-dark.eyesy-host-x body,
    :root.eyesy-dark.eyesy-host-x main,
    :root.eyesy-dark.eyesy-host-x header,
    :root.eyesy-dark.eyesy-host-x [data-testid="primaryColumn"],
    :root.eyesy-dark.eyesy-host-x [data-testid="sidebarColumn"],
    :root.eyesy-dark.eyesy-host-x [data-testid="cellInnerDiv"],
    :root.eyesy-dark.eyesy-host-x [data-testid="tweet"] {
      background-color: #050505 !important;
    }

    :root.eyesy-dark.eyesy-host-x aside section,
    :root.eyesy-dark.eyesy-host-x [aria-label*="Timeline"] article {
      background-color: #0b0f14 !important;
      border-color: #2f3336 !important;
    }

    :root.eyesy-dark.eyesy-host-google-calendar [data-eventid],
    :root.eyesy-dark.eyesy-host-google-calendar [data-eventid] *,
    :root.eyesy-dark.eyesy-host-google-calendar [role="button"][style*="background"] {
      color: #f8fafc !important;
      text-shadow: 0 1px 1px rgba(0, 0, 0, 0.45) !important;
    }

    #${EYESY_WARM_OVERLAY_ID},
    #${EYESY_DIM_OVERLAY_ID} {
      position: fixed !important;
      inset: 0 !important;
      display: none !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
    }

    #${EYESY_WARM_OVERLAY_ID} {
      background: rgba(255, 178, 92, var(--eyesy-warm-alpha)) !important;
      mix-blend-mode: multiply !important;
    }

    #${EYESY_DIM_OVERLAY_ID} {
      background: rgba(0, 0, 0, var(--eyesy-dim-alpha)) !important;
    }

    :root.eyesy-active #${EYESY_WARM_OVERLAY_ID},
    :root.eyesy-active #${EYESY_DIM_OVERLAY_ID} {
      display: block !important;
    }
  `;

  if (style.textContent !== css) {
    style.textContent = css;
  }

  if (!style.isConnected) {
    appendToDocument(style);
  }
}

function ensureOverlays(mode) {
  if (mode === "normal") {
    removeElement(EYESY_WARM_OVERLAY_ID);
    removeElement(EYESY_DIM_OVERLAY_ID);
    return;
  }

  if (!document.getElementById(EYESY_WARM_OVERLAY_ID)) {
    const warm = document.createElement("div");
    warm.id = EYESY_WARM_OVERLAY_ID;
    appendToDocument(warm);
  }

  if (!document.getElementById(EYESY_DIM_OVERLAY_ID)) {
    const dim = document.createElement("div");
    dim.id = EYESY_DIM_OVERLAY_ID;
    appendToDocument(dim);
  }
}

function appendToDocument(node) {
  const target = document.documentElement || document.head || document.body;
  if (target) target.appendChild(node);
}

function removeElement(id) {
  document.getElementById(id)?.remove();
}

function scheduleEyesyScan() {
  clearTimeout(eyesyScanTimer);
  eyesyScanTimer = setTimeout(scanAndConvertPage, 30);
}

function scanAndConvertPage() {
  if (getEffectiveMode() !== "dark") return;

  const elements = document.body
    ? [document.body, ...document.body.querySelectorAll("*")]
    : [];

  let count = 0;
  for (const element of elements) {
    if (count >= EYESY_SCAN_LIMIT) break;
    if (convertElement(element)) count += 1;
  }
}

function convertElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (shouldSkipElement(element)) return false;

  const computed = getComputedStyle(element);
  const updates = {};
  const background = parseColor(computed.backgroundColor);
  const color = parseColor(computed.color);
  let targetBackground = null;

  if (background && background.a > 0.05 && luminance(background) > 0.28) {
    const mappedBackground = mapBackground(background, element, computed);
    updates.backgroundColor = mappedBackground.css;
    targetBackground = mappedBackground.color;
  }

  if (color && color.a > 0.05 && targetBackground && contrastRatio(color, targetBackground) < 4.5) {
    updates.color = bestTextForBackground(targetBackground);
  } else if (color && color.a > 0.05 && luminance(color) < 0.62) {
    updates.color = mapForeground(color);
  }

  const borderColor = parseColor(computed.borderTopColor);
  if (borderColor && borderColor.a > 0.05 && luminance(borderColor) > 0.3) {
    updates.borderColor = mapBorder(borderColor);
  }

  if (Object.keys(updates).length === 0) return false;

  rememberStyle(element);
  for (const [property, value] of Object.entries(updates)) {
    element.style.setProperty(toKebabCase(property), value, "important");
  }
  element.setAttribute(EYESY_TOUCHED_ATTR, "true");
  element.setAttribute(EYESY_VERSION_ATTR, EYESY_CONVERSION_VERSION);
  return true;
}

function shouldSkipElement(element) {
  if (
    element.id === EYESY_STYLE_ID ||
    element.id === EYESY_WARM_OVERLAY_ID ||
    element.id === EYESY_DIM_OVERLAY_ID
  ) {
    return true;
  }

  return [
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "META",
    "LINK",
    "IMG",
    "VIDEO",
    "CANVAS",
    "PICTURE",
    "SOURCE",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "SVG",
    "PATH"
  ].includes(element.tagName);
}

function rememberStyle(element) {
  if (element.hasAttribute(EYESY_RESTORE_ATTR)) return;
  const style = element.getAttribute("style");
  element.setAttribute(EYESY_RESTORE_ATTR, style === null ? EYESY_EMPTY_STYLE : style);
}

function restoreTouchedElements() {
  const touched = document.querySelectorAll(`[${EYESY_RESTORE_ATTR}]`);
  for (const element of touched) {
    const original = element.getAttribute(EYESY_RESTORE_ATTR);
    if (original === EYESY_EMPTY_STYLE) {
      element.removeAttribute("style");
    } else if (original !== null) {
      element.setAttribute("style", original);
    }
    element.removeAttribute(EYESY_RESTORE_ATTR);
    element.removeAttribute(EYESY_TOUCHED_ATTR);
    element.removeAttribute(EYESY_VERSION_ATTR);
  }
}

function hasOutdatedTouchedElements() {
  return Boolean(
    document.querySelector(
      `[${EYESY_RESTORE_ATTR}]:not([${EYESY_VERSION_ATTR}="${EYESY_CONVERSION_VERSION}"])`
    )
  );
}

function startEyesyObserver() {
  if (eyesyObserver || !document.documentElement) return;

  eyesyObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
        scheduleEyesyScan();
        return;
      }

      if (mutation.type === "attributes" && mutation.target instanceof HTMLElement) {
        convertElement(mutation.target);
      }
    }
  });

  eyesyObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"]
  });
}

function stopEyesyObserver() {
  if (!eyesyObserver) return;
  eyesyObserver.disconnect();
  eyesyObserver = null;
}

function scheduleImageFilter() {
  setTimeout(applyImageFilter, 150);
}

function applyImageFilter() {
  if (getEffectiveMode() === "normal") return;

  for (const image of document.querySelectorAll("img, svg")) {
    const rect = image.getBoundingClientRect();
    const width = image instanceof HTMLImageElement ? image.naturalWidth || rect.width : rect.width;
    const height = image instanceof HTMLImageElement ? image.naturalHeight || rect.height : rect.height;

    if (width > 0 && height > 0 && width <= 160 && height <= 160) {
      image.classList.add("eyesy-image-filter");
    }
  }
}

function clearImageFilter() {
  for (const image of document.querySelectorAll(".eyesy-image-filter")) {
    image.classList.remove("eyesy-image-filter");
  }
}

function parseColor(value) {
  const match = String(value).match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/
  );
  if (!match) return null;

  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4])
  };
}

function luminance(color) {
  const values = [color.r, color.g, color.b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

function mapBackground(color, element, computed) {
  const hsl = rgbToHsl(color.r, color.g, color.b);

  if (isXHost()) {
    return mapXBackground(element, computed, hsl);
  }

  if (shouldPreserveSemanticColor(element, computed, hsl)) {
    return mapSemanticBackground(hsl);
  }

  if (isControlElement(element)) {
    return cssColor("#202733");
  }

  if (isPageShellElement(element)) {
    return cssColor("#111419");
  }

  if (luminance(color) > 0.82) {
    return cssColor("#111419");
  }

  return cssColor("#191e25");
}

function mapXBackground(element, computed, hsl) {
  if (isColorfulBackground(hsl)) {
    return mapSemanticBackground(hsl);
  }

  if (isXSearchOrControl(element)) {
    return cssColor("#202327");
  }

  if (isXSidebarCard(element, computed)) {
    return cssColor("#16181c");
  }

  return cssColor("#000000");
}

function mapForeground(color) {
  const hsl = rgbToHsl(color.r, color.g, color.b);
  const saturation = hsl.s > 18 ? clamp(hsl.s * 0.8, 20, 70) : 10;
  const lightness = hsl.s > 18 ? 72 : 86;
  return `hsl(${Math.round(hsl.h)} ${Math.round(saturation)}% ${lightness}%)`;
}

function mapBorder(color) {
  const hsl = rgbToHsl(color.r, color.g, color.b);
  const saturation = clamp(hsl.s * 0.35, 5, 24);
  return `hsl(${Math.round(hsl.h)} ${Math.round(saturation)}% 30%)`;
}

function mapSemanticBackground(hsl) {
  const saturation = clamp(hsl.s < 12 ? hsl.s + 18 : hsl.s * 0.72, 18, 58);
  const lightness = clamp(hsl.l * 0.58, 24, 38);
  const css = `hsl(${Math.round(hsl.h)} ${Math.round(saturation)}% ${Math.round(lightness)}%)`;

  return {
    css,
    color: hslToRgb(hsl.h, saturation, lightness)
  };
}

function cssColor(hex) {
  return {
    css: hex,
    color: hexToRgb(hex)
  };
}

function shouldPreserveSemanticColor(element, computed, hsl) {
  return isColorfulBackground(hsl) || isCalendarEventLike(element, computed);
}

function isColorfulBackground(hsl) {
  return hsl.s >= 18 && hsl.l >= 18 && hsl.l <= 82;
}

function isCalendarEventLike(element, computed) {
  if (!document.documentElement.classList.contains("eyesy-host-google-calendar")) return false;

  if (element.closest("[data-eventid]")) return true;

  const text = element.textContent?.trim();
  if (!text) return false;

  const role = element.getAttribute("role");
  const borderRadius = parseFloat(computed.borderRadius) || 0;
  const rect = element.getBoundingClientRect();

  return role === "button" && borderRadius >= 2 && rect.width >= 24 && rect.height >= 8 && rect.height <= 36;
}

function isXHost() {
  return document.documentElement.classList.contains("eyesy-host-x");
}

function isXSearchOrControl(element) {
  return isControlElement(element)
    || element.closest('[role="search"]')
    || element.getAttribute("data-testid") === "SearchBox_Search_Input";
}

function isXSidebarCard(element, computed) {
  const rect = element.getBoundingClientRect();
  const borderRadius = parseFloat(computed.borderRadius) || 0;
  const testId = element.getAttribute("data-testid") || "";

  if (element.closest('[data-testid="primaryColumn"]')) return false;
  if (testId === "sidebarColumn") return false;

  return (
    element.closest('[data-testid="sidebarColumn"]')
    && borderRadius >= 12
    && rect.width >= 220
    && rect.height >= 40
  );
}

function isControlElement(element) {
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(element.tagName)
    || element.getAttribute("role") === "button"
    || element.getAttribute("role") === "textbox"
    || element.getAttribute("role") === "combobox";
}

function isPageShellElement(element) {
  return element === document.body
    || element === document.documentElement
    || ["HTML", "BODY", "MAIN"].includes(element.tagName)
    || element.getAttribute("role") === "main";
}

function contrastRatio(first, second) {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function bestTextForBackground(background) {
  return luminance(background) > 0.42 ? "#101318" : "#f1f5f9";
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
    a: 1
  };
}

function hslToRgb(h, s, l) {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hue = h / 60;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const match = lightness - chroma / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (hue >= 0 && hue < 1) [r, g, b] = [chroma, x, 0];
  else if (hue < 2) [r, g, b] = [x, chroma, 0];
  else if (hue < 3) [r, g, b] = [0, chroma, x];
  else if (hue < 4) [r, g, b] = [0, x, chroma];
  else if (hue < 5) [r, g, b] = [x, 0, chroma];
  else [r, g, b] = [chroma, 0, x];

  return {
    r: Math.round((r + match) * 255),
    g: Math.round((g + match) * 255),
    b: Math.round((b + match) * 255),
    a: 1
  };
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) {
    return { h: 0, s: 0, l: lightness * 100 };
  }

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;

  if (max === rn) {
    hue = ((gn - bn) / delta) % 6;
  } else if (max === gn) {
    hue = (bn - rn) / delta + 2;
  } else {
    hue = (rn - gn) / delta + 4;
  }

  return {
    h: (hue * 60 + 360) % 360,
    s: saturation * 100,
    l: lightness * 100
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

globalThis.__eyesyRefresh = loadEyesySettings;
})();
