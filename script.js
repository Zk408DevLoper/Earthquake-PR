"use strict";

/**
 * Earthquake Monitor contributor guide
 * -----------------------------------
 * Settings and shared state come first, followed by requests, country filtering,
 * map rendering, timeline/details navigation, and device integrations.
 * EMSC data is normalized by eventFromFeature() before reaching the UI.
 * Location permission is optional; never substitute zero for missing coordinates.
 * See README.md for setup, data sources, and the Android bridge contract.
 */

const EARTHQUAKE_API_BASE = "https://www.seismicportal.eu/fdsnws/event/1/query";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

// ---------- Settings you can change ----------
const NEAREST_MAX_AGE_DAYS = 2;          // "Nearest earthquake" only uses events from the last 2 days
const TIMELINE_DAYS = 7;                 // timeline and map show the last 7 days for your country
const MAX_COUNTRY_EVENTS = 300;          // most events requested for your country
const MAX_GLOBAL_EVENTS = 100;           // only used before your location is known
const FALLBACK_RADIUS_KM = 500;          // used if your country cannot be determined
const COUNTRY_BBOX_PADDING_DEGREES = 0.5; // also include offshore events just outside the country's borders
const COUNTRY_RECHECK_KM = 50;           // look up the country again after moving this far
const COUNTRY_RETRY_MS = 60 * 1000;      // wait this long after a failed country lookup
const COUNTRY_OFFSHORE_BUFFER_KM = 100;  // timeline also keeps offshore events this close to the country's coast
const MAX_SHAPE_POINTS = 6000;           // limit for the saved country outline

const AUTO_REFRESH_MS = 30 * 1000;       // reload earthquake data every 30 seconds
const MOVE_THRESHOLD_KM = 0.03;          // ignore GPS jitter smaller than ~30 m
const REFETCH_DISTANCE_KM = 25;          // only used when the country is unknown
const FOLLOW_RESUME_MS = 30 * 1000;      // resume following the user this long after a manual map drag

// ---------- Estimated shaking intensity ----------
const MILD_INTENSITY = 2;
const MODERATE_INTENSITY = 4;
const DANGER_INTENSITY = 5;              // paper’s intense-shaking boundary (Methods)
const DEFAULT_DEPTH_KM = 10;             // used when an event has no depth (paper's assumption)
const EARTH_RADIUS_KM = 6371;

const NEAREST_MAX_AGE_MS = NEAREST_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const COUNTRY_CACHE_KEY = "eq_country_v2";
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
// Keep a snapshot so a 30-second refresh cannot remove the event being read.
let selectedEarthquake = null;
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
  themeSwatches: document.getElementById("theme-swatches"),
  themeCurrentName: document.getElementById("theme-current-name"),
  toast: document.getElementById("toast")
};

const VIEW_TITLES = {
  "home-view": "Home",
  "timeline-view": "Earthquake Timeline",
  "event-details-view": "Earthquake details",
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
      polygon_geojson: "1",
      polygon_threshold: "0.05",
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
      shape: buildCountryShape(data.geojson), // country outline, or null
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
    renderCountryEmergencyContacts();
    renderTimeline();
    loadEarthquakeData({ silent: true });
    return;
  }

  countryLookupInProgress = true;
  try {
    const found = await lookupCountry(latitude, longitude);
    if (found) {
      userCountry = found;
      renderCountryEmergencyContacts();
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

/* ---------- Country outline filter (timeline) ---------- */

// Turns the GeoJSON outline from the country lookup into a list of polygons:
// shape = [ polygon, ... ], polygon = [ ring, ... ], ring = [ [lon, lat], ... ].
// The first ring of a polygon is its outer edge; any others are holes.
function buildCountryShape(geojson) {
  if (!geojson || !Array.isArray(geojson.coordinates)) return null;

  let polygons = null;
  if (geojson.type === "Polygon") polygons = [geojson.coordinates];
  else if (geojson.type === "MultiPolygon") polygons = geojson.coordinates;
  if (!polygons) return null;

  // Keep the saved outline small by dropping vertices on very detailed borders.
  let total = 0;
  polygons.forEach(polygon => polygon.forEach(ring => { total += ring.length; }));
  const step = Math.max(1, Math.ceil(total / MAX_SHAPE_POINTS));

  const result = [];
  polygons.forEach(polygon => {
    const rings = [];
    polygon.forEach(ring => {
      const kept = [];
      for (let i = 0; i < ring.length; i += step) {
        kept.push([Number(ring[i][0]), Number(ring[i][1])]);
      }
      const lastPoint = ring[ring.length - 1];
      kept.push([Number(lastPoint[0]), Number(lastPoint[1])]);
      if (kept.length >= 4) rings.push(kept);
    });
    if (rings.length) result.push(rings);
  });
  return result.length ? result : null;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInShape(lon, lat, shape) {
  return shape.some(polygon => {
    if (!pointInRing(lon, lat, polygon[0])) return false;
    for (let i = 1; i < polygon.length; i++) {
      if (pointInRing(lon, lat, polygon[i])) return false; // inside a hole
    }
    return true;
  });
}

// Shortest distance (km) from a point to the outline. Stops early once the
// distance is within limitKm, because only "close enough or not" matters.
function distanceToShapeKm(lon, lat, shape, limitKm) {
  const kmPerDegree = 111.195;
  const cosLat = Math.cos(degreesToRadians(lat));
  let best = Infinity;

  for (const polygon of shape) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length - 1; i++) {
        const ax = (ring[i][0] - lon) * cosLat * kmPerDegree;
        const ay = (ring[i][1] - lat) * kmPerDegree;
        const bx = (ring[i + 1][0] - lon) * cosLat * kmPerDegree;
        const by = (ring[i + 1][1] - lat) * kmPerDegree;
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSquared = dx * dx + dy * dy;
        let t = lengthSquared === 0 ? 0 : -(ax * dx + ay * dy) / lengthSquared;
        t = Math.max(0, Math.min(1, t));
        const distance = Math.hypot(ax + t * dx, ay + t * dy);
        if (distance < best) {
          best = distance;
          if (best <= limitKm) return best;
        }
      }
    }
  }
  return best;
}

function normalizeCountryName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
}

function sameCountryName(first, second) {
  const a = normalizeCountryName(first);
  const b = normalizeCountryName(second);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

// Region names often look like "MINDANAO, PHILIPPINES". Returns the part after the last comma.
function regionCountrySuffix(location) {
  const match = String(location || "").match(/,\s*([^,]+)$/);
  return match ? match[1].trim() : "";
}

function isEventInCountry(event, country) {
  // Inside the country's outline: always keep.
  if (pointInShape(event.longitude, event.latitude, country.shape)) return true;

  // Outside the outline (for example at sea): keep it only if its region name
  // does not name a different country and it is close to the coast.
  const suffix = regionCountrySuffix(event.location);
  if (suffix && !sameCountryName(suffix, country.name)) return false;
  return distanceToShapeKm(event.longitude, event.latitude, country.shape, COUNTRY_OFFSHORE_BUFFER_KM) <= COUNTRY_OFFSHORE_BUFFER_KM;
}

// Marks every loaded event as inside or outside the user's country.
// Without a country outline, nothing is filtered out.
function classifyEventsByCountry() {
  const filterActive = eventsScope === "country" && userCountry && Array.isArray(userCountry.shape);
  earthquakeEvents.forEach(event => {
    event.inCountry = filterActive ? isEventInCountry(event, userCountry) : true;
  });
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

  // EMSC's depth property is positive km; GeoJSON elevation is negative below
  // the surface. Normalize only the coordinate sign, not invalid property values.
  const propertyDepth = toNumberOrNull(properties.depth);
  const coordinateDepth = coordinates.length > 2 ? toNumberOrNull(coordinates[2]) : null;
  const depth = propertyDepth !== null && propertyDepth >= 0
    ? propertyDepth : coordinateDepth !== null ? Math.abs(coordinateDepth) : null;

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
    inCountry: true,
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
    classifyEventsByCountry();
    lastFetchLatitude = requestLatitude;
    lastFetchLongitude = requestLongitude;

    // Use the newest GPS position, which may have changed while fetching.
    if (userLatitude !== null && userLongitude !== null) updateEventDistances();
    else nearestEvent = null;

    renderMapMarkers();
    renderTimeline();
    renderNearestEarthquake();
    elements.eventCount.textContent = String(earthquakeEvents.length);
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
    resetMovedLocationAddress();
    updateLocationPopup();
    return;
  }

  const icon = L.divIcon({ className: "", html: '<div class="user-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  userMarker = L.marker([userLatitude, userLongitude], { icon, title: "Your location", zIndexOffset: 1000 })
    .bindPopup("Your location")
    .addTo(earthquakeMap);
  userMarker.on("popupopen", requestStreetAddress);
  updateLocationPopup();
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
  renderHomeSummary();
  setNearestHeading(false);
  updateDangerBanner();
  if (elements.nearestIntensity) elements.nearestIntensity.textContent = "";

  if (userLatitude === null || userLongitude === null) {
    elements.nearestLocation.textContent = "Waiting for your location to calculate the nearest reported earthquake.";
    elements.nearestDistance.textContent = "--";
    elements.nearestDepth.textContent = "--";
    elements.nearestMagnitude.textContent = "--";
    elements.magnitudeBadge.textContent = "M --";
    return;
  }


  if (!nearestEvent) {
    const message = eventsScope === "global"
      ? "Looking for earthquakes near you…"
      : `No earthquake reported in the last ${NEAREST_MAX_AGE_DAYS} days.`;
    elements.nearestLocation.textContent = message;
    elements.nearestDistance.textContent = "--";
    elements.nearestDepth.textContent = "--";
    elements.nearestMagnitude.textContent = "--";
    elements.magnitudeBadge.textContent = "M --";
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
  renderHistoricalTest();

  const hasLocation = userLatitude !== null && userLongitude !== null;
  if (!hasLocation || eventsScope === "global") {
    const message = hasLocation ? "Finding your country…" : "Waiting for your location…";
    elements.timelineCount.textContent = "0 events";
    elements.earthquakeList.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }

  // Newest first.
  const list = earthquakeEvents.filter(event => event.inCountry).sort((a, b) => (getEventTimeMs(b) || 0) - (getEventTimeMs(a) || 0));

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

/** Open the report first. Map navigation is a separate, explicit action. */
function selectEarthquake(eventId) {
  const event = earthquakeEvents.find(item => item.id === eventId)
    || (historicalTestEvent?.id === eventId ? historicalTestEvent : null);
  if (!event) {
    showToast("This report is no longer in the timeline. Refresh and try again.");
    return;
  }

  if (event.isHistoricalTest) updateHistoricalTestMetrics();
  selectedEarthquake = { ...event };
  const details = document.getElementById("event-details-fields");
  document.getElementById("event-details-location").textContent = event.isHistoricalTest
    ? `${event.location} · Historical test report, not a current alert` : event.location;
  const formatNumber = (value, suffix = "") => Number.isFinite(value)
    ? `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`
    : "Not available";

  const hasReportedDepth = Number.isFinite(event.depth) && event.depth >= 0;
  document.getElementById("report-depth-method").textContent = hasReportedDepth
    ? `IPE uses EMSC reported depth (${event.depth.toLocaleString()} km). Mild ≥ 2 · Moderate ≥ 4 · Intense ≥ 5. Not measured shaking.`
    : "Depth unavailable: IPE uses a 10 km fallback. Mild ≥ 2 · Moderate ≥ 4 · Intense ≥ 5. Not measured shaking.";

  // Summary and local estimate have different meanings; keep them visually separate.
  document.getElementById("report-magnitude").textContent = Number.isFinite(event.magnitude)
    ? `M ${event.magnitude.toFixed(1)}` : "Not reported";
  document.getElementById("report-kind").textContent = event.isHistoricalTest
    ? "Historical test report" : "EMSC earthquake report";
  document.getElementById("report-time").textContent = formatDate(event.time);
  const hasIntensity = Number.isFinite(event.intensity);
  const crossed = meetsDangerThreshold(event.intensity);
  document.getElementById("report-intensity").textContent = hasIntensity ? event.intensity.toFixed(2) : "—";
  document.getElementById("report-shaking-description").textContent = hasIntensity
    ? describeIntensity(event.intensity) : "Allow location access to calculate this estimate.";
  const threshold = document.getElementById("report-threshold");
  threshold.textContent = hasIntensity
    ? (crossed ? `At or above ${DANGER_INTENSITY}` : `Below ${DANGER_INTENSITY}`)
    : "Location needed";
  threshold.dataset.state = hasIntensity ? (crossed ? "crossed" : "below") : "unknown";

  // Use textContent: region names and other catalogue values are external data.
  const fields = [
    ["Depth", formatNumber(event.depth, " km")],
    ["Distance from you", formatNumber(event.distance, " km")],
    ["Epicenter", `${event.latitude.toFixed(5)}, ${event.longitude.toFixed(5)}`],
    ["Source", "EMSC / SeismicPortal"],
    ["Event ID", event.id]
  ];
  details.replaceChildren();
  fields.forEach(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    details.append(row);
  });

  switchView("event-details-view");
  document.getElementById("event-details-heading").focus({ preventScroll: true });
}

/** Show the saved report even if it has left the latest catalogue response. */
function showSelectedEarthquakeOnMap() {
  const event = selectedEarthquake;
  if (!event) return;
  if (!earthquakeMap) {
    showToast("The map is unavailable. Check your connection and reload.");
    return;
  }
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
    else if (event.isHistoricalTest) {
      // Historical markers live outside the layer rebuilt by automatic refresh.
      if (historicalTestMapMarker) historicalTestMapMarker.remove();
      historicalTestMapMarker = L.marker([event.latitude, event.longitude], {
        title: "Historical test earthquake"
      }).addTo(earthquakeMap);
      const label = document.createElement("span");
      label.textContent = `Historical test · M ${event.magnitude.toFixed(1)} · ${event.location} · ${formatDate(event.time)}`;
      historicalTestMapMarker.bindPopup(label).openPopup();
    }
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

// Use reported EMSC depth, including zero and shallow events. Missing or invalid
// values use the paper's preliminary 10 km assumption, explicitly labeled in UI.
function effectiveDepth(depthKm) {
  return Number.isFinite(depthKm) && depthKm >= 0 ? depthKm : DEFAULT_DEPTH_KM;
}

// Source: Finazzi et al. (2024), Methods, doi:10.1038/s41598-024-55279-z.
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
  if (!Number.isFinite(intensity)) return "Not available";
  if (intensity >= DANGER_INTENSITY) return "Intense shaking estimate";
  if (intensity >= MODERATE_INTENSITY) return "Moderate shaking estimate";
  if (intensity >= MILD_INTENSITY) return "Mild shaking estimate";
  return "Below the mild-shaking threshold";
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
      if (meetsDangerThreshold(event.intensity) && (worst === null || event.intensity > worst.intensity)) {
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
  banner.innerHTML = `<strong>Intense shaking estimated at your location</strong>
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
  locationAccuracy = position.coords.accuracy;
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
  loadLocalFrequency();

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
    const navigationView = viewId === "event-details-view" ? "timeline-view" : viewId;
    const active = button.dataset.view === navigationView;
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

  if (button.id === "event-details-map") {
    showSelectedEarthquakeOnMap();
    return;
  }

  if (button.id === "event-details-back") {
    switchView("timeline-view");
    // Restore keyboard focus to the report that opened this view, if still loaded.
    const report = Array.from(elements.earthquakeList.querySelectorAll("[data-event-id]"))
      .find(item => item.dataset.eventId === selectedEarthquake?.id);
    if (report) report.focus({ preventScroll: true });
    return;
  }

  if (button.id === "home-report-details") {
    if (nearestEvent) selectEarthquake(nearestEvent.id);
    return;
  }
  if (button.id === "home-location-button") {
    if (userLatitude === null || userLongitude === null) {
      startLocationWatch();
      showToast("Allow location access in Android or browser settings if it was denied.");
    } else requestStreetAddress();
    return;
  }
  if (button.id === "home-timeline-button") {
    switchView("timeline-view");
    return;
  }
  if (button.id === "home-contacts-button") {
    switchView("menu-view");
    document.getElementById("emergency-title").scrollIntoView({ block: "center" });
    return;
  }
  if (button.id === "home-map-button") {
    switchView("map-view");
  }
});

/* ---------- Device location details ---------- */

// Coordinates are used for calculations; the popup displays city/province only.
let locationAccuracy = null;
let addressLocation = null;
let addressText = "Tap to show your city and province";
let addressBusy = false;
let addressAttempt = 0;
let frequencyLocation = null;
let frequencyBusy = false;
let frequencyUpdated = 0;

// Invalidate the cached place label after moving at least 100 metres.
function resetMovedLocationAddress() {
  if (addressLocation && calculateDistance(...addressLocation, userLatitude, userLongitude) >= 0.1) {
    addressLocation = null;
    addressText = "Tap to show your city and province";
  }
}

function updateLocationPopup() {
  renderHomeSummary();
  if (!userMarker) return;
  const content = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "Your location";
  const details = document.createElement("p");
  details.textContent = addressText;
  details.style.whiteSpace = "pre-line";
  content.append(title, details);
  userMarker.setPopupContent(content);
}

window.receiveCityProvince = function (latitude, longitude, address) {
  addressBusy = false;
  if (userLatitude === null || calculateDistance(latitude, longitude, userLatitude, userLongitude) > 0.1) return;
  addressLocation = [latitude, longitude];
  addressText = address || "City and province unavailable.";
  updateLocationPopup();
};

function requestStreetAddress() {
  updateLocationPopup();
  if (addressBusy || Date.now() - addressAttempt < 10000) return;
  if (addressLocation && calculateDistance(...addressLocation, userLatitude, userLongitude) < 0.1) return;
  if (!window.AndroidBridge || typeof window.AndroidBridge.resolveCityProvince !== "function") {
    addressText = "City and province lookup requires the updated Android app.";
    updateLocationPopup();
    return;
  }
  addressAttempt = Date.now();
  addressBusy = true;
  addressText = "Finding city and province…";
  updateLocationPopup();
  window.AndroidBridge.resolveCityProvince(userLatitude, userLongitude);
  window.setTimeout(() => { if (addressBusy) { addressBusy = false; addressText = "Address lookup timed out. Tap again to retry."; updateLocationPopup(); } }, 15000);
}

/* ---------- Nearby frequency, independent of the country timeline ---------- */

/**
 * Count reported events within 100 km over fixed UTC time windows.
 * Pagination avoids treating a truncated response as the complete count.
 * Cache for five minutes unless the user moves or explicitly refreshes.
 */
async function loadLocalFrequency(force = false) {
  const status = document.getElementById("frequency-status");
  if (!status || userLatitude === null || frequencyBusy) return;
  if (!force && frequencyLocation && Date.now() - frequencyUpdated < 300000 && calculateDistance(...frequencyLocation, userLatitude, userLongitude) < 1) return;
  frequencyBusy = true;
  const latitude = userLatitude, longitude = userLongitude, now = Date.now();
  status.textContent = "Loading EMSC reports…";
  document.getElementById("frequency-counts").textContent = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const ids = new Set(), times = [];
    let offset = 1;
    while (true) {
      const params = new URLSearchParams({ format: "json", latitude: String(latitude), longitude: String(longitude), maxradius: String(100 / 111.195), starttime: new Date(now - 30 * 86400000).toISOString().slice(0, 19), endtime: new Date(now).toISOString().slice(0, 19), orderby: "time", limit: "1000", offset: String(offset) });
      const response = await fetch(`${EARTHQUAKE_API_BASE}?${params}`, { signal: controller.signal });
      if (response.status === 204) break;
      if (!response.ok) throw new Error("EMSC request failed");
      const data = await response.json();
      if (!Array.isArray(data.features)) throw new Error("Invalid EMSC response");
      let added = 0;
      for (const feature of data.features) {
        const event = eventFromFeature(feature, offset);
        if (!event || ids.has(event.id)) continue;
        ids.add(event.id); added++;
        const time = getEventTimeMs(event);
        if (Number.isFinite(time) && time <= now && calculateDistance(latitude, longitude, event.latitude, event.longitude) <= 100) times.push(time);
      }
      if (data.features.length < 1000) break;
      if (!added || offset >= 20000) throw new Error("Result too large to count completely");
      offset += data.features.length;
    }
    if (calculateDistance(latitude, longitude, userLatitude, userLongitude) >= 1) { status.textContent = "Location changed. Refresh to count this area."; return; }
    const counts = [1, 7, 30].map(days => times.filter(time => time >= now - days * 86400000).length);
    const countPanel = document.getElementById("frequency-counts");
    countPanel.replaceChildren();
    counts.forEach((count, index) => {
      const column = document.createElement("span");
      const value = document.createElement("span"); value.className = "frequency-value"; value.textContent = String(count);
      const label = document.createElement("span"); label.className = "frequency-label"; label.textContent = ["24 hours", "7 days", "30 days"][index];
      column.append(value, label); countPanel.append(column);
    });
    status.textContent = `Within 100 km of ${latitude.toFixed(3)}, ${longitude.toFixed(3)}. Updated ${new Date(now).toLocaleTimeString()}. EMSC reported events only; this is not a prediction.`;
    frequencyLocation = [latitude, longitude]; frequencyUpdated = now;
  } catch (error) {
    status.textContent = "Earthquake frequency unavailable. Tap Refresh to retry.";
  } finally { clearTimeout(timer); frequencyBusy = false; }
}

/* ---------- Emergency contacts: local storage only ---------- */

// Only open the dialer. The app never places a call automatically.
// Official emergency directories, checked 2026-11-09. Keep country codes ISO 3166-1.
// Never assume that 112/911 is universal. Unknown countries get no guessed number.
const EU_EMERGENCY_SOURCE = "https://digital-strategy.ec.europa.eu/en/policies/112";
const EMERGENCY_DIRECTORY = {
  PH: { name: "Philippines", source: "https://ehotlines.e.gov.ph/", contacts: [{ name: "National emergency hotline", phone: "911" }] },
  TW: { name: "Taiwan", source: "https://www.nfa.gov.tw/cht/?code=list&ids=66", contacts: [{ name: "Fire and ambulance", phone: "119" }, { name: "Police", phone: "110" }] },
  IN: { name: "India", source: "https://112.gov.in/", contacts: [{ name: "Emergency services", phone: "112" }] },
  US: { name: "United States", source: "https://www.911.gov/calling-911/", contacts: [{ name: "Emergency services", phone: "911" }] },
  GB: { name: "United Kingdom", source: "https://www.gov.uk/guidance/999-and-112-the-uks-national-emergency-numbers", contacts: [{ name: "Emergency services", phone: "999" }] },
  AU: { name: "Australia", source: "https://www.triplezero.gov.au/Documents/TripleZeroFactSheet.pdf", contacts: [{ name: "Police, fire and ambulance", phone: "000" }] },
  NZ: { name: "New Zealand", source: "https://www.police.govt.nz/call-111", contacts: [{ name: "Police, fire and ambulance", phone: "111" }] }
};
for (const [code, name] of Object.entries({
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", HR: "Croatia", CY: "Cyprus", CZ: "Czechia",
  DK: "Denmark", EE: "Estonia", FI: "Finland", FR: "France", DE: "Germany", GR: "Greece",
  HU: "Hungary", IE: "Ireland", IT: "Italy", LV: "Latvia", LT: "Lithuania", LU: "Luxembourg",
  MT: "Malta", NL: "Netherlands", PL: "Poland", PT: "Portugal", RO: "Romania", SK: "Slovakia",
  SI: "Slovenia", ES: "Spain", SE: "Sweden"
})) {
  EMERGENCY_DIRECTORY[code] = { name, source: EU_EMERGENCY_SOURCE, contacts: [{ name: "Emergency services", phone: "112" }] };
}

// An in-session override handles travel, border areas, or unavailable geolocation.
let emergencyCountryOverride = "";

/** Display-only label plus an explicit, accessible dialer action. */
function createContactRow(contact) {
  const row = document.createElement("div");
  row.className = "contact-row";
  const label = document.createElement("div");
  label.className = "contact-label";
  const name = document.createElement("span");
  name.textContent = contact.name;
  const number = document.createElement("small");
  number.textContent = contact.phone;
  label.append(name, number);

  const call = document.createElement("a");
  call.className = "contact-call primary-button";
  call.textContent = "Call";
  call.href = "tel:" + contact.phone.replace(/[ ()-]/g, "");
  call.setAttribute("aria-label", `Call ${contact.name} on ${contact.phone}`);
  row.append(label, call);
  return row;
}

function renderCountryEmergencyContacts() {
  const list = document.getElementById("country-emergency-list");
  if (!list) return;
  list.replaceChildren();
  const detectedCode = userCountry?.code?.toUpperCase() || "";
  const code = emergencyCountryOverride || detectedCode;
  const entry = EMERGENCY_DIRECTORY[code];
  const status = document.getElementById("emergency-country-status");
  const source = document.getElementById("emergency-country-source");
  source.hidden = !entry;
  if (!entry) {
    status.textContent = code
      ? `No verified preset available for ${userCountry?.name || code}. Add a verified local number below, or choose your country.`
      : "Country not detected. Choose your country below to load verified emergency numbers.";
    source.removeAttribute("href");
    return;
  }
  status.textContent = `${entry.name} · ${emergencyCountryOverride ? "Selected manually" : "Detected from location"}. Confirm this is your current country before calling.`;
  source.href = entry.source;
  source.textContent = "Official number reference · checked Nov 9, 2026";
  entry.contacts.forEach(contact => list.append(createContactRow(contact)));
}

function initializeEmergencyCountryPicker() {
  const picker = document.getElementById("emergency-country-select");
  Object.entries(EMERGENCY_DIRECTORY)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .forEach(([code, entry]) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = entry.name;
      picker.append(option);
    });
  picker.addEventListener("change", () => {
    emergencyCountryOverride = picker.value;
    renderCountryEmergencyContacts();
  });
  renderCountryEmergencyContacts();
}


let emergencyContacts = [];
try {
  const stored = JSON.parse(localStorage.getItem("eq_emergency_contacts") || "[]");
  if (Array.isArray(stored)) emergencyContacts = stored.filter(contact => contact && typeof contact.name === "string" && /^\+?[0-9 ()-]{3,25}$/.test(contact.phone)).slice(0, 20);
} catch (_) {}

function renderEmergencyContacts() {
  const list = document.getElementById("emergency-contact-list");
  list.replaceChildren();
  if (!emergencyContacts.length) list.textContent = "No contacts saved yet. Add family, a trusted person, or a verified local emergency number.";
  emergencyContacts.forEach((contact, index) => {
    const row = createContactRow(contact);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "text-button"; remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${contact.name}`);
    remove.onclick = () => saveEmergencyContacts(emergencyContacts.filter((_, i) => i !== index));
    row.append(remove);
    list.append(row);
  });
}
function saveEmergencyContacts(next) {
  try { localStorage.setItem("eq_emergency_contacts", JSON.stringify(next)); emergencyContacts = next; renderEmergencyContacts(); return true; }
  catch (_) { showToast("Could not save contacts on this device."); return false; }
}
document.getElementById("emergency-contact-form").addEventListener("submit", event => {
  event.preventDefault();
  const name = document.getElementById("contact-name").value.trim();
  const phone = document.getElementById("contact-phone").value.trim();
  if (!name || !/^\+?[0-9 ()-]{3,25}$/.test(phone) || (phone.match(/\d/g) || []).length < 3) { showToast("Enter a name and valid phone number."); return; }
  if (emergencyContacts.length >= 20) { showToast("You can save up to 20 contacts."); return; }
  if (saveEmergencyContacts([...emergencyContacts, { name, phone }])) event.target.reset();
});
document.getElementById("frequency-refresh").addEventListener("click", () => loadLocalFrequency(true));
renderEmergencyContacts();
initializeEmergencyCountryPicker();

/* ---------- Text interaction ---------- */

// This is a UI preference, not content protection. Keep form editing available.
for (const type of ["copy", "cut", "contextmenu", "selectstart"]) {
  document.addEventListener(type, event => {
    if (!event.target.closest("input, textarea, [contenteditable='true']")) event.preventDefault();
  });
}

/* ---------- Historical threshold preview ---------- */

// A separate record keeps historical data out of live counts and alert banners.
// EMSC catalogue record verified on 2026-11-08: M7.0 Luzon, 2022-07-27.
let historicalTestEvent = null;
let historicalTestUsesEpicenter = false;
let historicalTestMapMarker = null;
let historicalTestLoading = false;

function meetsDangerThreshold(intensity) {
  return Number.isFinite(intensity) && intensity >= DANGER_INTENSITY;
}

function updateHistoricalTestMetrics() {
  if (!historicalTestEvent) return;
  const hasLocation = userLatitude !== null && userLongitude !== null;
  historicalTestEvent.distance = hasLocation
    ? calculateDistance(userLatitude, userLongitude, historicalTestEvent.latitude, historicalTestEvent.longitude)
    : null;
  historicalTestEvent.intensity = hasLocation
    ? expectedIntensity(historicalTestEvent.distance, historicalTestEvent.depth, historicalTestEvent.magnitude)
    : null;
}

function renderHistoricalTest() {
  const card = document.getElementById("historical-test-card");
  card.hidden = !historicalTestEvent;
  document.getElementById("historical-test-status").textContent = historicalTestEvent
    ? "Historical preview only. Live alerts and report counts are unchanged."
    : "Load a real EMSC report to check the strong-shaking threshold.";
  if (!historicalTestEvent) return;

  updateHistoricalTestMetrics();
  const event = historicalTestEvent;
  document.getElementById("historical-test-title").textContent = `M ${event.magnitude.toFixed(1)} · ${event.location}`;
  document.getElementById("historical-test-time").textContent = `${formatDate(event.time)} · Historical report`;
  const distance = historicalTestUsesEpicenter ? 0 : event.distance;
  const intensity = expectedIntensity(distance, event.depth, event.magnitude);
  const locationLabel = historicalTestUsesEpicenter ? "At the epicenter (test point)" : "At your GPS location";
  const result = document.getElementById("historical-test-result");
  if (!Number.isFinite(intensity)) {
    result.textContent = "Allow location access, or use the epicenter test point below.";
    result.dataset.threshold = "unknown";
  } else {
    const crossed = meetsDangerThreshold(intensity);
    // Display two decimals while comparing the original, unrounded intensity.
    result.textContent = `${locationLabel}: estimated intensity ${intensity.toFixed(2)} · Threshold ≥ ${DANGER_INTENSITY} · ${crossed ? "Threshold crossed" : "Below threshold"}. Distance: ${distance.toFixed(1)} km.`;
    result.dataset.threshold = crossed ? "crossed" : "below";
  }
  document.getElementById("historical-test-point").textContent = historicalTestUsesEpicenter
    ? "Use my GPS location" : "Use epicenter as test point";
}

async function loadHistoricalTest() {
  if (historicalTestLoading) return;
  historicalTestLoading = true;
  const button = document.getElementById("load-historical-test");
  button.disabled = true;
  const status = document.getElementById("historical-test-status");
  status.textContent = "Loading the July 27, 2022 Luzon report from EMSC…";
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    // Query the verified date/region, then select the exact returned catalogue ID.
    // The service's eventid parameter does not accept this historical GeoJSON ID.
    const parameters = new URLSearchParams({
      format: "json", starttime: "2022-07-27T00:00:00", endtime: "2022-07-28T00:00:00",
      minlatitude: "15", maxlatitude: "20", minlongitude: "118", maxlongitude: "123",
      minmagnitude: "6", limit: "10"
    });
    const response = await fetch(`${EARTHQUAKE_API_BASE}?${parameters}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    if (!response.ok || response.status === 204) throw new Error("Historical report unavailable");
    const data = await response.json();
    const feature = Array.isArray(data.features)
      ? data.features.find(item => String(item.id) === "20220727_0000002") : null;
    const event = feature ? eventFromFeature(feature, 0) : null;
    if (!event || !Number.isFinite(event.magnitude) || !Number.isFinite(getEventTimeMs(event))) {
      throw new Error("Invalid historical report");
    }
    historicalTestEvent = { ...event, isHistoricalTest: true };
    historicalTestUsesEpicenter = false;
    switchView("timeline-view");
    renderHistoricalTest();
  } catch (error) {
    status.textContent = "Could not load the EMSC historical report. Check your connection and try again.";
  } finally {
    window.clearTimeout(timeout);
    button.disabled = false;
    historicalTestLoading = false;
  }
}

document.getElementById("load-historical-test").addEventListener("click", loadHistoricalTest);
document.getElementById("historical-test-point").addEventListener("click", () => {
  historicalTestUsesEpicenter = !historicalTestUsesEpicenter;
  renderHistoricalTest();
});
document.getElementById("historical-test-details").addEventListener("click", () => {
  if (historicalTestEvent) selectEarthquake(historicalTestEvent.id);
});
document.getElementById("historical-test-remove").addEventListener("click", () => {
  historicalTestEvent = null;
  historicalTestUsesEpicenter = false;
  if (historicalTestMapMarker) {
    historicalTestMapMarker.remove();
    historicalTestMapMarker = null;
  }
  renderHistoricalTest();
});


/* ---------- Home summary ---------- */

// Only current catalogue events feed this summary. Historical previews are separate.
function renderHomeSummary() {
  const setText = (id, value) => { document.getElementById(id).textContent = value; };
  const hasLocation = userLatitude !== null && userLongitude !== null;
  const hasPlace = hasLocation && addressLocation && !addressBusy;
  setText("home-place-name", hasPlace ? addressText : hasLocation ? "Location available" : "Location not available");
  setText("home-place-status", hasLocation
    ? (Number.isFinite(locationAccuracy) ? `GPS accuracy approximately ±${Math.round(locationAccuracy)} m` : "Using your device location")
    : "Allow location access for nearby reports.");
  setText("home-location-button", addressBusy ? "Finding location…" : "Show city & province");
  document.getElementById("home-location-button").disabled = addressBusy;

  const event = hasLocation && eventsScope !== "global" ? nearestEvent : null;
  document.getElementById("home-report-details").disabled = !event;
  setText("home-report-magnitude", event && Number.isFinite(event.magnitude) ? `M ${event.magnitude.toFixed(1)}` : "—");
  setText("home-report-location", event ? event.location : hasLocation ? "No recent nearby report available" : "Waiting for your location");
  setText("home-report-time", event ? formatDate(event.time) : hasLocation ? "Reports from the last two days appear here." : "Location access is needed.");
  setText("home-report-distance", event && Number.isFinite(event.distance) ? `${event.distance.toFixed(1)} km from you` : "Distance unavailable");
  const hasIntensity = event && Number.isFinite(event.intensity);
  const level = !hasIntensity ? "unknown" : event.intensity >= DANGER_INTENSITY ? "intense"
    : event.intensity >= MODERATE_INTENSITY ? "moderate" : event.intensity >= MILD_INTENSITY ? "mild" : "below";
  document.querySelector(".home-estimate").dataset.level = level;
  setText("home-estimate-title", hasIntensity ? describeIntensity(event.intensity) : "No recent estimate available");
  setText("home-estimate-context", hasIntensity
    ? `Estimated intensity ${event.intensity.toFixed(2)} · Based on the report above and ${effectiveDepth(event.depth)} km model depth.`
    : "An estimate will appear for the nearest recent earthquake.");
}

/* ---------- Startup and refresh lifecycle ---------- */

// Run after all state declarations and handlers have been initialized.
loadSavedTheme();
renderHomeSummary();
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









