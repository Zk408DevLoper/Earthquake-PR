"use strict";

const EARTHQUAKE_API_BASE = "https://www.seismicportal.eu/fdsnws/event/1/query";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

// ---------- Settings you can change ----------
const NEAREST_MAX_AGE_DAYS = 3;          // day
const TIMELINE_DAYS = 7;                 // timeline and map show the last 7 days for your country
const MAX_COUNTRY_EVENTS = 300;          // most events requested for your country
const MAX_GLOBAL_EVENTS = 100;           // only used before your location is known
const FALLBACK_RADIUS_KM = 500;          // used if your country cannot be determined
const COUNTRY_BBOX_PADDING_DEGREES = 0.5; // also include offshore events just outside the country's borders
const COUNTRY_RECHECK_KM = 50;           // look up the country again after moving this far
const COUNTRY_RETRY_MS = 60 * 1000;      // wait this long after a failed country lookup

const AUTO_REFRESH_MS = 30 * 1000;       // reload earthquake data every 30 seconds
const MOVE_THRESHOLD_KM = 0.03;          // ignore GPS jitter smaller than ~30 m
const REFETCH_DISTANCE_KM = 25;          // only used when the country is unknown
const FOLLOW_RESUME_MS = 30 * 1000;      // resume following the user this long after a manual map drag

// ---------- Estimated shaking intensity ----------
const DANGER_INTENSITY = 6;              // estimated intensity treated as "strong shaking"
const DEFAULT_DEPTH_KM = 10;             // used when an event has no depth (paper's assumption)
const EARTH_RADIUS_KM = 6371;

const NEAREST_MAX_AGE_MS = NEAREST_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const COUNTRY_CACHE_KEY = "eq_country_v1";
const THEME_NAME_KEY = "eq_theme_name";
const THEME_VARS_KEY = "eq_theme_css_v2";
const CLASSIC_BAR_COLOR = "#090b0c";

// tintBackground: false = the original neutral dark look; true = background tinted in the theme color.
const THEME_COLORS = [
  { id: "classic", name: "Classic", hex: "#08b8d2", tintBackground: false },
  { id: "cyan", name: "Cyan", hex: "#08b8d2", tintBackground: true },
  { id: "blue", name: "Blue", hex: "#4c8dff", tintBackground: true },
  { id: "green", name: "Green", hex: "#3ddc84", tintBackground: true },
  { id: "purple", name: "Purple", hex: "#a77bff", tintBackground: true },
  { id: "pink", name: "Pink", hex: "#ff5fa2", tintBackground: true },
  { id: "orange", name: "Orange", hex: "#ff9a3d", tintBackground: true },
  { id: "red", name: "Red", hex: "#ff5a5f", tintBackground: true },
  { id: "yellow", name: "Yellow", hex: "#e7c83d", tintBackground: true }
];

const DEFAULT_MAP_CENTER = [12.8797, 121.7740];
const DEFAULT_MAP_ZOOM = 5;

let earthquakeMap;
let earthquakeLayer;
let zoneLayer;
let userMarker;
let userLatitude = null;
let userLongitude = null;
let earthquakeEvents = [];
let eventsScope = "global"; // "global" (no location yet), "country" or "radius"
let nearestEvent = null;
let toastTimeout;
let activeFetchController = null;

let locationWatchId = null;
let lastFetchLatitude = null;
let lastFetchLongitude = null;
let locationErrorShown = false;

let userCountry = null; // { name, code, bbox: [south, north, west, east], lookupLatitude, lookupLongitude }
let countryLookupInProgress = false;
let lastCountryLookupFailure = 0;

let followUser = true;
let followResumeTimeout = null;

const elements = {
  pageTitle: document.getElementById("page-title"),
  connectionDot: document.getElementById("connection-dot"),
  connectionStatus: document.getElementById("connection-status"),
  lastUpdated: document.getElementById("last-updated"),
  eventCount: document.getElementById("event-count"),
  mapMessage: document.getElementById("map-message"),
  nearestKicker: document.getElementById("nearest-kicker"),
  nearestTitle: document.getElementById("nearest-title"),
  nearestLocation: document.getElementById("nearest-location"),
  nearestDistance: document.getElementById("nearest-distance"),
  nearestDepth: document.getElementById("nearest-depth"),
  nearestMagnitude: document.getElementById("nearest-magnitude"),
  magnitudeBadge: document.getElementById("magnitude-badge"),
  nearestIntensity: document.getElementById("nearest-intensity"),
  dangerBanner: document.getElementById("danger-banner"),
  coordinates: document.getElementById("coordinates"),
  mapCoordinates: document.getElementById("map-coordinates"),
  earthquakeList: document.getElementById("earthquake-list"),
  timelineCount: document.getElementById("timeline-count"),
  timelineDescription: document.getElementById("timeline-description"),
  homeEventCount: document.getElementById("home-event-count"),
  homeLocationStatus: document.getElementById("home-location-status"),
  homeCoordinates: document.getElementById("home-coordinates"),
  homeNearestLocation: document.getElementById("home-nearest-location"),
  homeNearestMag: document.getElementById("home-nearest-mag"),
  homeNearestDistance: document.getElementById("home-nearest-distance"),
  themeSwatches: document.getElementById("theme-swatches"),
  themeCurrentName: document.getElementById("theme-current-name"),
  toast: document.getElementById("toast")
};

const VIEW_TITLES = {
  "home-view": "Home",
  "timeline-view": "Earthquake Timeline",
  "map-view": "Earthquake Monitor",
  "menu-view": "Menu",
  "about-view": "About"
};

/* ---------- Theme ---------- */

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ];
}

function rgbToHex(rgb) {
  return "#" + rgb.map(channel => channel.toString(16).padStart(2, "0")).join("");
}

function rgbToHue(rgb) {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;

  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;

  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

// hue in degrees, saturation and lightness from 0 to 1. Returns [r, g, b].
function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360 / 60;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((h % 2) - 1));

  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) { r = chroma; g = x; }
  else if (h < 2) { r = x; g = chroma; }
  else if (h < 3) { g = chroma; b = x; }
  else if (h < 4) { g = x; b = chroma; }
  else if (h < 5) { r = x; b = chroma; }
  else { r = chroma; b = x; }

  const offset = lightness - chroma / 2;
  return [r + offset, g + offset, b + offset].map(value => Math.round(value * 255));
}

function mixWithWhite(rgb, amount) {
  const mix = channel => Math.round(channel + (255 - channel) * amount);
  return `rgb(${mix(rgb[0])}, ${mix(rgb[1])}, ${mix(rgb[2])})`;
}

// Builds the full set of dark background colors for a given hue.
function buildPalette(hue) {
  const saturation = 0.42;
  const shade = lightness => hslToRgb(hue, saturation, lightness);
  const css = rgb => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;

  const bg = shade(0.07);
  const top = shade(0.05);
  const strip = shade(0.085);
  const surface = shade(0.115);
  const raised = shade(0.15);
  const soft = shade(0.175);
  const mapBg = shade(0.095);
  const mapCard = shade(0.105);
  const mapBorder = shade(0.23);
  const panelTop = shade(0.125);
  const panelBottom = shade(0.095);
  const popup = shade(0.11);
  const toast = shade(0.17);

  return {
    vars: {
      "--bg": css(bg),
      "--bg-rgb": bg.join(", "),
      "--bg-top": css(top),
      "--top-rgb": top.join(", "),
      "--bg-strip": css(strip),
      "--strip-rgb": strip.join(", "),
      "--surface": css(surface),
      "--surface-raised": css(raised),
      "--surface-soft": css(soft),
      "--map-bg": css(mapBg),
      "--map-card-bg": css(mapCard),
      "--map-border": css(mapBorder),
      "--panel-top": css(panelTop),
      "--panel-bottom": css(panelBottom),
      "--popup-bg": css(popup),
      "--toast-bg": css(toast)
    },
    barHex: rgbToHex(top),
    swatchColor: css(raised)
  };
}

const PALETTE_VAR_NAMES = Object.keys(buildPalette(0).vars);

function renderThemeSwatches() {
  if (!elements.themeSwatches) return;

  elements.themeSwatches.innerHTML = THEME_COLORS.map(theme => {
    const backgroundColor = theme.tintBackground
      ? buildPalette(rgbToHue(hexToRgb(theme.hex))).swatchColor
      : "#222729";
    return `<button class="swatch" type="button" data-theme="${theme.id}" style="background:linear-gradient(135deg, ${backgroundColor} 50%, ${theme.hex} 50%)" aria-label="${theme.name}" title="${theme.name}"></button>`;
  }).join("");
}

// Tells the Android app which color to use behind the status bar and bottom bar.
function notifyAndroidBarColor(hex) {
  try {
    if (window.AndroidBridge && typeof window.AndroidBridge.setSystemBarColor === "function") {
      window.AndroidBridge.setSystemBarColor(hex);
    }
  } catch (error) {
    // Not running inside the Android app, or the app is an older version.
  }
}

function applyTheme(themeId, { save = true } = {}) {
  const theme = THEME_COLORS.find(item => item.id === themeId) || THEME_COLORS[0];
  const accentRgb = hexToRgb(theme.hex);

  const vars = {
    "--accent": theme.hex,
    "--accent-rgb": accentRgb.join(", "),
    "--accent-light": mixWithWhite(accentRgb, 0.45)
  };

  let barColor = CLASSIC_BAR_COLOR;
  if (theme.tintBackground) {
    const palette = buildPalette(rgbToHue(accentRgb));
    Object.assign(vars, palette.vars);
    barColor = palette.barHex;
  }

  const rootStyle = document.documentElement.style;
  Object.keys(vars).forEach(name => rootStyle.setProperty(name, vars[name]));
  if (!theme.tintBackground) {
    // Classic: remove the tinted colors so the original stylesheet colors apply.
    PALETTE_VAR_NAMES.forEach(name => rootStyle.removeProperty(name));
  }

  document.querySelectorAll(".swatch").forEach(button => {
    const active = button.dataset.theme === theme.id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  if (elements.themeCurrentName) elements.themeCurrentName.textContent = theme.name;

  notifyAndroidBarColor(barColor);

  if (save) {
    try {
      window.localStorage.setItem(THEME_NAME_KEY, theme.id);
      window.localStorage.setItem(THEME_VARS_KEY, JSON.stringify(vars));
    } catch (error) {
      // Saving is optional. The theme still changes for this session.
    }
  }
}

function loadSavedTheme() {
  let savedId = "classic";
  try {
    savedId = window.localStorage.getItem(THEME_NAME_KEY) || "classic";
  } catch (error) {
    savedId = "classic";
  }
  renderThemeSwatches();
  applyTheme(savedId, { save: false });
}

/* ---------- Requests ---------- */

function buildEarthquakeRequest() {
  const hasLocation = userLatitude !== null && userLongitude !== null;
  const days = hasLocation ? TIMELINE_DAYS : NEAREST_MAX_AGE_DAYS;

  const parameters = new URLSearchParams({
    format: "json",
    orderby: "time", // newest first
    limit: String(hasLocation ? MAX_COUNTRY_EVENTS : MAX_GLOBAL_EVENTS),
    starttime: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19)
  });

  let scope = "global";

  if (hasLocation) {
    if (userCountry && Array.isArray(userCountry.bbox)) {
      const south = userCountry.bbox[0];
      const north = userCountry.bbox[1];
      const west = userCountry.bbox[2];
      const east = userCountry.bbox[3];
      const pad = COUNTRY_BBOX_PADDING_DEGREES;

      parameters.set("minlatitude", Math.max(-90, south - pad).toFixed(4));
      parameters.set("maxlatitude", Math.min(90, north + pad).toFixed(4));
      parameters.set("minlongitude", Math.max(-180, west - pad).toFixed(4));
      parameters.set("maxlongitude", Math.min(180, east + pad).toFixed(4));
      scope = "country";
    } else {
      parameters.set("latitude", userLatitude.toFixed(6));
      parameters.set("longitude", userLongitude.toFixed(6));
      parameters.set("maxradius", (FALLBACK_RADIUS_KM / 111.195).toFixed(4));
      scope = "radius";
    }
  }

  return { url: `${EARTHQUAKE_API_BASE}?${parameters.toString()}`, scope };
}

/* ---------- Country lookup ---------- */

function readCachedCountry() {
  try {
    const raw = window.localStorage.getItem(COUNTRY_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data && data.name
      && Array.isArray(data.bbox) && data.bbox.length === 4
      && Number.isFinite(data.lookupLatitude) && Number.isFinite(data.lookupLongitude)) {
      return data;
    }
  } catch (error) {
    // Ignore a damaged cache entry.
  }
  return null;
}

function saveCachedCountry(country) {
  try {
    window.localStorage.setItem(COUNTRY_CACHE_KEY, JSON.stringify(country));
  } catch (error) {
    // Saving is optional.
  }
}

async function lookupCountry(latitude, longitude) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10000);

  try {
    const parameters = new URLSearchParams({
      format: "jsonv2",
      zoom: "3",
      addressdetails: "1",
      "accept-language": "en",
      lat: latitude.toFixed(5),
      lon: longitude.toFixed(5)
    });

    const response = await fetch(`${NOMINATIM_REVERSE_URL}?${parameters.toString()}`, {
      headers: { "Accept": "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Country lookup returned HTTP ${response.status}`);

    const data = await response.json();
    const name = data && data.address && data.address.country;
    const box = data && Array.isArray(data.boundingbox) ? data.boundingbox.map(Number) : null;
    if (!name || !box || box.length !== 4 || box.some(value => !Number.isFinite(value))) return null;

    return {
      name: String(name),
      code: String(data.address.country_code || "").toUpperCase(),
      bbox: box, // [south, north, west, east]
      lookupLatitude: latitude,
      lookupLongitude: longitude
    };
  } finally {
    window.clearTimeout(timer);
  }
}

// Works out which country the user is in. It only repeats after moving far away
// (or after a failure), so it is cheap to call on every GPS update.
async function ensureCountry(latitude, longitude) {
  if (countryLookupInProgress) return;

  if (userCountry && calculateDistance(userCountry.lookupLatitude, userCountry.lookupLongitude, latitude, longitude) < COUNTRY_RECHECK_KM) {
    return;
  }
  if (Date.now() - lastCountryLookupFailure < COUNTRY_RETRY_MS) return;

  // Use the saved result when still near the place where it was looked up.
  const cached = readCachedCountry();
  if (cached && calculateDistance(cached.lookupLatitude, cached.lookupLongitude, latitude, longitude) < COUNTRY_RECHECK_KM) {
    userCountry = cached;
    renderTimeline();
    loadEarthquakeData({ silent: true });
    return;
  }

  countryLookupInProgress = true;
  try {
    const found = await lookupCountry(latitude, longitude);
    if (found) {
      userCountry = found;
      saveCachedCountry(found);
    } else {
      lastCountryLookupFailure = Date.now();
    }
  } catch (error) {
    console.error("Country lookup error:", error);
    lastCountryLookupFailure = Date.now();
  } finally {
    countryLookupInProgress = false;
  }

  // Load data for the country (or for the fallback area if the lookup failed).
  renderTimeline();
  loadEarthquakeData({ silent: true });
}

/* ---------- Map ---------- */

function initializeMap() {
  if (typeof L === "undefined") {
    elements.mapMessage.hidden = false;
    elements.mapMessage.textContent = "Map library could not be loaded. Check your internet connection.";
    return;
  }

  earthquakeMap = L.map("earthquake-map", {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true
  }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);

  const CARTO_BASEMAP_KEY = "cb1_4h23_1_8287814bc1d518fc7b5aae2d";

  L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${CARTO_BASEMAP_KEY}`, {
    subdomains: "abcd",
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(earthquakeMap);

  L.control.zoom({ position: "bottomright" }).addTo(earthquakeMap);
  zoneLayer = L.layerGroup().addTo(earthquakeMap);
  earthquakeLayer = L.layerGroup().addTo(earthquakeMap);

  // When the user drags the map to look around, stop following their position
  // for a while, then resume automatically.
  earthquakeMap.on("dragstart", () => {
    followUser = false;
    window.clearTimeout(followResumeTimeout);
    followResumeTimeout = window.setTimeout(() => {
      followUser = true;
      followUserPosition();
    }, FOLLOW_RESUME_MS);
  });
}

function followUserPosition() {
  if (!followUser || !earthquakeMap || userLatitude === null || userLongitude === null) return;
  earthquakeMap.panTo([userLatitude, userLongitude], { animate: true });
}

/* ---------- Helpers ---------- */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatDate(value) {
  if (value === null || value === undefined || value === "") return "Time not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time not available";
  return date.toLocaleString([], {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

function formatAgo(value) {
  if (value === null || value === undefined || value === "") return "";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function getEventTimeMs(event) {
  if (!event || event.time === null || event.time === undefined || event.time === "") return NaN;
  return new Date(event.time).getTime();
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventFromFeature(feature, index) {
  if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) return null;
  const coordinates = feature.geometry.coordinates;
  if (coordinates.length < 2) return null;

  const longitude = toNumberOrNull(coordinates[0]);
  const latitude = toNumberOrNull(coordinates[1]);
  if (latitude === null || longitude === null) return null;

  const properties = feature.properties || {};
  const rawTime = properties.time || properties.lastupdate || properties.updated || null;
  const magnitude = toNumberOrNull(properties.mag ?? properties.magnitude);

  // Depth is reported as a negative number in the coordinates, so always show it as positive.
  const rawDepth = toNumberOrNull(properties.depth) ?? (coordinates.length > 2 ? toNumberOrNull(coordinates[2]) : null);
  const depth = rawDepth === null ? null : Math.abs(rawDepth);

  const location = properties.flynn_region || properties.region || properties.place || properties.title || "Location not reported";
  const id = String(feature.id || properties.source_id || properties.unid || `event-${index}`);

  return {
    id,
    latitude,
    longitude,
    magnitude,
    depth,
    location: String(location),
    time: rawTime,
    distance: null,
    intensity: null,
    feature
  };
}

// silent = true: background refresh. No loading banner and existing data
// stays on screen if the request fails.
async function loadEarthquakeData({ silent = false } = {}) {
  if (activeFetchController) activeFetchController.abort();
  activeFetchController = new AbortController();
  const fetchController = activeFetchController;

  const request = buildEarthquakeRequest();
  const requestLatitude = userLatitude;
  const requestLongitude = userLongitude;

  if (!silent) {
    setConnectionState("loading", "Retrieving earthquake data…");
    elements.mapMessage.hidden = false;
    elements.mapMessage.textContent = "Loading earthquake data…";
  }

  try {
    const response = await fetch(request.url, {
      method: "GET",
      headers: { "Accept": "application/json" },
      cache: "no-store",
      signal: fetchController.signal
    });
    if (!response.ok) throw new Error(`Earthquake service returned HTTP ${response.status}`);

    const data = await response.json();
    if (!data || !Array.isArray(data.features)) throw new Error("The earthquake service returned an unexpected response.");

    earthquakeEvents = data.features.map(eventFromFeature).filter(Boolean);
    eventsScope = request.scope;
    lastFetchLatitude = requestLatitude;
    lastFetchLongitude = requestLongitude;

    // Use the newest GPS position, which may have changed while fetching.
    if (userLatitude !== null && userLongitude !== null) updateEventDistances();
    else nearestEvent = null;

    renderMapMarkers();
    renderTimeline();
    renderNearestEarthquake();
    elements.eventCount.textContent = String(earthquakeEvents.length);
    elements.homeEventCount.textContent = String(earthquakeEvents.length);
    elements.lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    setConnectionState("online", "Earthquake data connected");
    elements.mapMessage.hidden = earthquakeEvents.length > 0;
    if (!earthquakeEvents.length) elements.mapMessage.textContent = "No earthquake events were returned.";
  } catch (error) {
    if (error && error.name === "AbortError") return;
    console.error("Earthquake retrieval error:", error);
    setConnectionState("error", "Unable to retrieve earthquake data");

    // Only replace the screen content if there is nothing to show yet.
    if (!earthquakeEvents.length) {
      elements.mapMessage.hidden = false;
      elements.mapMessage.textContent = "Unable to load earthquake data. Retrying automatically…";
      elements.earthquakeList.innerHTML = '<div class="empty-state">Earthquake data could not be retrieved. Retrying automatically…</div>';
    }
  } finally {
    if (activeFetchController === fetchController) {
      activeFetchController = null;
    }
  }
}

function setConnectionState(state, message) {
  elements.connectionDot.classList.remove("online", "error");
  if (state === "online") elements.connectionDot.classList.add("online");
  if (state === "error") elements.connectionDot.classList.add("error");
  elements.connectionStatus.textContent = message;
}

function getMagnitudeColor(magnitude) {
  if (magnitude === null) return "#70b9e6";
  if (magnitude >= 5) return "#ed2929";
  if (magnitude >= 4) return "#f28d48";
  if (magnitude >= 2) return "#4dbb91";
  return "#70b9e6";
}

function createQuakeIcon(event, isNearest) {
  const magnitude = event.magnitude === null ? 1 : Math.max(1, event.magnitude);
  const size = Math.min(20, Math.max(8, 7 + magnitude * 1.3));
  const classes = isNearest ? "quake-marker nearest-marker" : "quake-marker";
  const color = getMagnitudeColor(event.magnitude);
  return L.divIcon({
    className: "",
    html: `<div class="${classes}" style="width:${size}px;height:${size}px;background:${color};"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

function renderMapMarkers() {
  if (!earthquakeMap || !earthquakeLayer) return;
  earthquakeLayer.clearLayers();
  if (zoneLayer) zoneLayer.clearLayers();

  const zoneCutoff = Date.now() - NEAREST_MAX_AGE_MS;

  earthquakeEvents.forEach(event => {
    // Red circle = area where the estimated intensity is at least DANGER_INTENSITY.
    const eventTime = getEventTimeMs(event);
    if (zoneLayer && Number.isFinite(eventTime) && eventTime >= zoneCutoff) {
      const zoneKm = intensityRadiusKm(DANGER_INTENSITY, event.magnitude, event.depth);
      if (zoneKm > 0) {
        L.circle([event.latitude, event.longitude], {
          radius: zoneKm * 1000,
          color: "#ed2929",
          weight: 1,
          fillColor: "#ed2929",
          fillOpacity: 0.12,
          interactive: false
        }).addTo(zoneLayer);
      }
    }

    const isNearest = Boolean(nearestEvent && event.id === nearestEvent.id);
    const marker = L.marker([event.latitude, event.longitude], {
      icon: createQuakeIcon(event, isNearest),
      keyboard: true,
      title: `${event.location}; magnitude ${event.magnitude ?? "unknown"}`
    });
    marker.bindPopup(`
      <span class="popup-title">${escapeHtml(event.location)}</span>
      <span class="popup-mag">M ${event.magnitude === null ? "--" : event.magnitude.toFixed(1)}</span><br>
      <span>Depth: ${event.depth === null ? "Unknown" : `${event.depth} km`}</span><br>
      <span>${escapeHtml(formatIntensityText(event))}</span><br>
      <span>${escapeHtml(formatDate(event.time))}</span><br>
      <button class="popup-select" type="button" onclick="selectEarthquake('${escapeHtml(event.id).replace(/'/g, "\\'")}')">View event details</button>
    `);
    marker.addTo(earthquakeLayer);
  });

  updateDangerBanner();
  updateUserMarker();
}

// Moves the "you are here" dot without rebuilding the earthquake markers.
function updateUserMarker() {
  if (!earthquakeMap || userLatitude === null || userLongitude === null) return;

  if (userMarker) {
    userMarker.setLatLng([userLatitude, userLongitude]);
    return;
  }

  const icon = L.divIcon({ className: "", html: '<div class="user-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  userMarker = L.marker([userLatitude, userLongitude], { icon, title: "Your location", zIndexOffset: 1000 })
    .bindPopup("<strong>Your location</strong><br>GPS coordinates from this device")
    .addTo(earthquakeMap);
}

// Calculates the distance to every event, then picks the nearest one that
// happened within the last NEAREST_MAX_AGE_DAYS days.
function updateEventDistances() {
  earthquakeEvents.forEach(event => {
    event.distance = calculateDistance(userLatitude, userLongitude, event.latitude, event.longitude);
    event.intensity = expectedIntensity(event.distance, event.depth, event.magnitude);
  });

  nearestEvent = null;
  if (eventsScope === "global") return; // wait until the country (or area) data has loaded

  const cutoff = Date.now() - NEAREST_MAX_AGE_MS;
  let best = null;
  earthquakeEvents.forEach(event => {
    const time = getEventTimeMs(event);
    if (!Number.isFinite(time) || time < cutoff) return;
    if (!Number.isFinite(event.distance)) return;
    if (best === null || event.distance < best.distance) best = event;
  });
  nearestEvent = best;
}

function setNearestHeading(isSelected) {
  if (elements.nearestKicker) {
    elements.nearestKicker.textContent = isSelected
      ? "SELECTED EVENT"
      : `CLOSEST EVENT · LAST ${NEAREST_MAX_AGE_DAYS} DAYS`;
  }
  if (elements.nearestTitle) {
    elements.nearestTitle.textContent = isSelected ? "Selected earthquake" : "Nearest earthquake";
  }
}

function renderNearestEarthquake() {
  setNearestHeading(false);
  updateDangerBanner();
  if (elements.nearestIntensity) elements.nearestIntensity.textContent = "";

  if (userLatitude === null || userLongitude === null) {
    elements.nearestLocation.textContent = "Waiting for your location to calculate the nearest reported earthquake.";
    elements.nearestDistance.textContent = "--";
    elements.nearestDepth.textContent = "--";
    elements.nearestMagnitude.textContent = "--";
    elements.magnitudeBadge.textContent = "M --";
    elements.homeLocationStatus.textContent = "Not set";
    elements.homeCoordinates.textContent = "Waiting for GPS…";
    elements.homeNearestLocation.textContent = "Location not available yet";
    elements.homeNearestMag.textContent = "Magnitude --";
    elements.homeNearestDistance.textContent = "Distance --";
    return;
  }

  elements.homeLocationStatus.textContent = "Available";
  elements.homeCoordinates.textContent = `${userLatitude.toFixed(4)}, ${userLongitude.toFixed(4)}`;

  if (!nearestEvent) {
    const message = eventsScope === "global"
      ? "Looking for earthquakes near you…"
      : `No earthquake reported in the last ${NEAREST_MAX_AGE_DAYS} days.`;
    elements.nearestLocation.textContent = message;
    elements.nearestDistance.textContent = "--";
    elements.nearestDepth.textContent = "--";
    elements.nearestMagnitude.textContent = "--";
    elements.magnitudeBadge.textContent = "M --";
    elements.homeNearestLocation.textContent = message;
    elements.homeNearestMag.textContent = "Magnitude --";
    elements.homeNearestDistance.textContent = "Distance --";
    return;
  }

  const magnitude = nearestEvent.magnitude === null ? "--" : nearestEvent.magnitude.toFixed(1);
  const ago = formatAgo(nearestEvent.time);
  const locationText = ago ? `${nearestEvent.location} · ${ago}` : nearestEvent.location;

  elements.nearestLocation.textContent = locationText;
  elements.nearestDistance.textContent = `${nearestEvent.distance.toFixed(1)} km`;
  elements.nearestDepth.textContent = nearestEvent.depth === null ? "--" : nearestEvent.depth.toLocaleString();
  elements.nearestMagnitude.textContent = magnitude;
  elements.magnitudeBadge.textContent = `M ${magnitude}`;
  elements.homeNearestLocation.textContent = locationText;
  elements.homeNearestMag.textContent = `Magnitude ${magnitude}`;
  elements.homeNearestDistance.textContent = `Distance ${nearestEvent.distance.toFixed(1)} km`;
  if (elements.nearestIntensity) elements.nearestIntensity.textContent = formatIntensityText(nearestEvent);
}

function updateTimelineHeading() {
  if (!elements.timelineDescription) return;

  if (userLatitude === null || userLongitude === null) {
    elements.timelineDescription.textContent = "Waiting for your location to show earthquakes in your country.";
  } else if (userCountry) {
    elements.timelineDescription.textContent = `Latest earthquakes in ${userCountry.name} from the last ${TIMELINE_DAYS} days, newest first. Updates automatically.`;
  } else {
    elements.timelineDescription.textContent = `Latest earthquakes within ${FALLBACK_RADIUS_KM} km of you from the last ${TIMELINE_DAYS} days, newest first. Updates automatically.`;
  }
}

function renderTimeline() {
  updateTimelineHeading();

  const hasLocation = userLatitude !== null && userLongitude !== null;
  if (!hasLocation || eventsScope === "global") {
    const message = hasLocation ? "Finding your country…" : "Waiting for your location…";
    elements.timelineCount.textContent = "0 events";
    elements.earthquakeList.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }

  // Newest first.
  const list = [...earthquakeEvents].sort((a, b) => (getEventTimeMs(b) || 0) - (getEventTimeMs(a) || 0));

  elements.timelineCount.textContent = `${list.length} event${list.length === 1 ? "" : "s"}`;
  if (!list.length) {
    const area = userCountry ? userCountry.name : "your area";
    elements.earthquakeList.innerHTML = `<div class="empty-state">No earthquakes reported in ${escapeHtml(area)} in the last ${TIMELINE_DAYS} days.</div>`;
    return;
  }

  elements.earthquakeList.innerHTML = list.map(event => {
    const magnitude = event.magnitude === null ? "--" : event.magnitude.toFixed(1);
    const severity = event.magnitude >= 5 ? "severe" : event.magnitude >= 4 ? "strong" : "";
    const distance = event.distance === null ? "Distance unavailable" : `${event.distance.toFixed(1)} km away`;
    const ago = formatAgo(event.time);
    const when = ago ? `${formatDate(event.time)} · ${ago}` : formatDate(event.time);
    return `<button class="earthquake-item" type="button" data-event-id="${escapeHtml(event.id)}">
      <span class="event-magnitude ${severity}">${magnitude}</span>
      <span class="event-content"><strong>${escapeHtml(event.location)}</strong><span>${escapeHtml(when)}</span><span>${escapeHtml(distance)} · Depth ${event.depth === null ? "unknown" : `${event.depth} km`}</span><span>${escapeHtml(formatIntensityText(event))}</span></span>
      <span class="event-chevron">›</span>
    </button>`;
  }).join("");
}

function selectEarthquake(eventId) {
  const event = earthquakeEvents.find(item => item.id === eventId);
  if (!event) return;
  switchView("map-view");
  if (earthquakeMap) {
    // Looking at an event: pause following the user for a while.
    followUser = false;
    window.clearTimeout(followResumeTimeout);
    followResumeTimeout = window.setTimeout(() => {
      followUser = true;
      followUserPosition();
    }, FOLLOW_RESUME_MS);

    earthquakeMap.setView([event.latitude, event.longitude], Math.max(earthquakeMap.getZoom(), 6), { animate: true });
    const layer = earthquakeLayer.getLayers().find(marker => {
      const position = marker.getLatLng();
      return Math.abs(position.lat - event.latitude) < 0.000001 && Math.abs(position.lng - event.longitude) < 0.000001;
    });
    if (layer) layer.openPopup();
  }

  // Show the chosen event in the card until the next refresh.
  setNearestHeading(true);
  const ago = formatAgo(event.time);
  elements.nearestLocation.textContent = ago ? `${event.location} · ${ago}` : event.location;
  elements.nearestDistance.textContent = event.distance === null ? "--" : `${event.distance.toFixed(1)} km`;
  elements.nearestDepth.textContent = event.depth === null ? "--" : event.depth.toLocaleString();
  elements.nearestMagnitude.textContent = event.magnitude === null ? "--" : event.magnitude.toFixed(1);
  elements.magnitudeBadge.textContent = `M ${event.magnitude === null ? "--" : event.magnitude.toFixed(1)}`;
  if (elements.nearestIntensity) elements.nearestIntensity.textContent = formatIntensityText(event);
}

/* ---------- Estimated shaking intensity (EQN isotropic IPE) ---------- */

function effectiveDepth(depthKm) {
  return depthKm !== null && depthKm >= 1 ? depthKm : DEFAULT_DEPTH_KM;
}

// I = -2.15*log10(r) + 1.03*M + 2.31, where r is the hypocentral distance in km.
function expectedIntensity(distanceKm, depthKm, magnitude) {
  if (!Number.isFinite(distanceKm) || !Number.isFinite(magnitude)) return null;
  const depth = effectiveDepth(depthKm);
  const r = Math.max(Math.sqrt(distanceKm * distanceKm + depth * depth), 1);
  const intensity = -2.15 * Math.log10(r) + 1.03 * magnitude + 2.31;
  return Math.max(0, Math.min(12, intensity));
}

// Surface radius (km) inside which the estimated intensity is at least the given value.
function intensityRadiusKm(intensity, magnitude, depthKm) {
  if (!Number.isFinite(magnitude)) return 0;
  const depth = effectiveDepth(depthKm);
  const r = Math.pow(10, (2.31 - intensity + 1.03 * magnitude) / 2.15);
  if (r <= depth) return 0;
  const R = EARTH_RADIUS_KM;
  const ratio = (r * r - depth * depth) / (4 * R * (R - depth));
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(ratio)));
}

function describeIntensity(intensity) {
  if (intensity === null) return "Not available";
  if (intensity >= 7) return "Likely felt very strongly. Damage possible";
  if (intensity >= DANGER_INTENSITY) return "Likely felt strongly. Slight damage possible";
  if (intensity >= 4) return "Likely felt by most people";
  if (intensity >= 2) return "Likely felt weakly";
  return "Probably not felt";
}

function formatIntensityText(event) {
  if (!event || event.intensity === null) return "Estimated intensity unavailable";
  return `Est. intensity here: ${event.intensity.toFixed(1)} · ${describeIntensity(event.intensity)}`;
}

// Shows a banner if a recent event probably shook the user's location strongly.
function updateDangerBanner() {
  const banner = elements.dangerBanner;
  if (!banner) return;

  let worst = null;
  if (userLatitude !== null && userLongitude !== null && eventsScope !== "global") {
    const cutoff = Date.now() - NEAREST_MAX_AGE_MS;
    earthquakeEvents.forEach(event => {
      const time = getEventTimeMs(event);
      if (!Number.isFinite(time) || time < cutoff || event.intensity === null) return;
      if (event.intensity >= DANGER_INTENSITY && (worst === null || event.intensity > worst.intensity)) {
        worst = event;
      }
    });
  }

  if (!worst) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }

  const ago = formatAgo(worst.time);
  banner.hidden = false;
  banner.innerHTML = `<strong>You are inside a strong-shaking zone</strong>
    <span>M${worst.magnitude.toFixed(1)} · ${escapeHtml(worst.location)}${ago ? " · " + escapeHtml(ago) : ""}.
    Estimated intensity at your location: ${worst.intensity.toFixed(1)}.
    Aftershocks are possible. Stay clear of damaged structures.</span>`;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371;
  const latitudeDifference = degreesToRadians(lat2 - lat1);
  const longitudeDifference = degreesToRadians(lon2 - lon1);
  const a = Math.sin(latitudeDifference / 2) ** 2
    + Math.cos(degreesToRadians(lat1)) * Math.cos(degreesToRadians(lat2))
    * Math.sin(longitudeDifference / 2) ** 2;
  const safeA = Math.min(1, Math.max(0, a));
  return earthRadius * 2 * Math.atan2(Math.sqrt(safeA), Math.sqrt(1 - safeA));
}

function degreesToRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/* ---------- Live GPS ---------- */

function handlePositionUpdate(position) {
  const latitude = position.coords.latitude;
  const longitude = position.coords.longitude;
  const isFirstFix = userLatitude === null || userLongitude === null;
  locationErrorShown = false;

  // Ignore tiny GPS jitter so the screen doesn't redraw constantly.
  if (!isFirstFix && calculateDistance(userLatitude, userLongitude, latitude, longitude) < MOVE_THRESHOLD_KM) {
    return;
  }

  userLatitude = latitude;
  userLongitude = longitude;

  const coordinateText = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
  elements.coordinates.textContent = coordinateText;
  elements.mapCoordinates.textContent = coordinateText;

  const previousNearestId = nearestEvent ? nearestEvent.id : null;
  updateEventDistances();
  updateUserMarker();

  // Only rebuild the earthquake markers when the nearest event changed,
  // so an open pop-up isn't closed by every GPS update.
  const currentNearestId = nearestEvent ? nearestEvent.id : null;
  if (currentNearestId !== previousNearestId) renderMapMarkers();

  renderNearestEarthquake();
  renderTimeline();

  // First fix: jump to the user's position. After that, keep the map
  // centred on the user while following is enabled.
  if (isFirstFix && earthquakeMap) {
    earthquakeMap.setView([latitude, longitude], 7, { animate: true });
  } else {
    followUserPosition();
  }

  // Find out which country the user is in. This loads the country's earthquakes
  // when it finishes, and only repeats after moving far away.
  ensureCountry(latitude, longitude);

  // If the country could not be determined, the data covers a circle around the
  // user instead, so refresh it after moving a long way.
  if (!userCountry && lastCountryLookupFailure > 0) {
    const movedFar = lastFetchLatitude === null
      || lastFetchLongitude === null
      || calculateDistance(lastFetchLatitude, lastFetchLongitude, latitude, longitude) >= REFETCH_DISTANCE_KM;
    if (movedFar) loadEarthquakeData({ silent: true });
  }
}

function handleLocationError(error) {
  console.error("Location error:", error);

  const messages = {
    1: "Location permission was denied. Allow location access in your app settings.",
    2: "Your location is currently unavailable.",
    3: "Location request timed out. Still trying…"
  };

  // Show each problem once, not on every failed attempt.
  if (!locationErrorShown) {
    locationErrorShown = true;
    showToast(messages[error.code] || "An unknown location error occurred.");
  }

  // A denied permission ends the watch; clear it so it can be restarted later.
  if (error.code === 1 && locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
  }
}

function startLocationWatch() {
  if (!navigator.geolocation) {
    showToast("Geolocation is not supported by this device.");
    return;
  }
  if (locationWatchId !== null) return; // already watching

  locationWatchId = navigator.geolocation.watchPosition(
    handlePositionUpdate,
    handleLocationError,
    {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 10000
    }
  );
}

function switchView(viewId) {
  const target = document.getElementById(viewId);
  if (!target) return;
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === viewId));
  document.querySelectorAll(".nav-item").forEach(button => {
    const active = button.dataset.view === viewId;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  elements.pageTitle.textContent = VIEW_TITLES[viewId] || "Earthquake Monitor";
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (viewId === "map-view" && earthquakeMap) {
    window.setTimeout(() => earthquakeMap.invalidateSize(), 100);
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => elements.toast.classList.remove("show"), 3000);
}

// Used by the map pop-up buttons.
window.selectEarthquake = selectEarthquake;

// One delegated click handler keeps controls working after the view changes or
// when timeline rows are dynamically created. It also works when the user taps
// an icon or label inside a button in Android WebView.
document.addEventListener("click", event => {
  const button = event.target && event.target.closest ? event.target.closest("button") : null;
  if (!button || button.disabled) return;

  if (button.classList.contains("nav-item")) {
    const viewId = button.dataset.view;
    if (viewId) switchView(viewId);
    return;
  }

  if (button.classList.contains("swatch")) {
    applyTheme(button.dataset.theme);
    return;
  }

  if (button.dataset.eventId) {
    selectEarthquake(button.dataset.eventId);
    return;
  }

  if (button.id === "home-map-button") {
    switchView("map-view");
  }
});

loadSavedTheme();
initializeMap();
renderTimeline();
loadEarthquakeData();
startLocationWatch();

// Automatic refresh: runs while the app is on screen. It also restarts the
// GPS watch if it was stopped (for example after permission was granted late)
// and retries the country lookup if it failed earlier.
window.setInterval(() => {
  if (document.hidden) return;
  startLocationWatch();
  if (userLatitude !== null && userLongitude !== null) ensureCountry(userLatitude, userLongitude);
  loadEarthquakeData({ silent: true });
}, AUTO_REFRESH_MS);

// Refresh immediately when the app comes back to the foreground.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  startLocationWatch();
  loadEarthquakeData({ silent: true });
});

// Leaflet needs a size refresh after the first responsive layout is painted.
window.addEventListener("load", () => {
  if (earthquakeMap) window.setTimeout(() => earthquakeMap.invalidateSize(), 150);
});
window.addEventListener("resize", () => {
  if (earthquakeMap) earthquakeMap.invalidateSize({ pan: false });
});

// Make runtime errors visible during testing instead of leaving the user with
// buttons that appear to do nothing. Details remain available in browser Logcat.
window.addEventListener("error", event => {
  console.error("Website runtime error:", event.message, event.filename, event.lineno);
});
