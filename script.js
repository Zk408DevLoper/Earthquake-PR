"use strict";

const EARTHQUAKE_API_BASE = "https://www.seismicportal.eu/fdsnws/event/1/query";
const EARTHQUAKE_SEARCH_RADIUS_KM = 100;

// Auto-update settings
const AUTO_REFRESH_MS = 60 * 1000;     // reload earthquake data every 60 seconds
const MOVE_THRESHOLD_KM = 0.03;        // ignore GPS jitter smaller than ~30 m
const REFETCH_DISTANCE_KM = 5;         // re-query the catalogue after moving this far
const FOLLOW_RESUME_MS = 30 * 1000;    // resume following the user this long after a manual map drag

function buildEarthquakeApiUrl() {
  const parameters = new URLSearchParams({
    format: "json",
    limit: "100",
    // SeismicPortal uses "time" for newest-first ordering.
    orderby: "time"
  });

  // Once location is available, retrieve events around the device instead of
  // relying only on the newest global records, which may not include nearby events.
  if (userLatitude !== null && userLongitude !== null) {
    parameters.set("latitude", userLatitude.toFixed(6));
    parameters.set("longitude", userLongitude.toFixed(6));
    parameters.set(
      "maxradius",
      (EARTHQUAKE_SEARCH_RADIUS_KM / 111.195).toFixed(4)
    );
  }

  return `${EARTHQUAKE_API_BASE}?${parameters.toString()}`;
}
const DEFAULT_MAP_CENTER = [12.8797, 121.7740];
const DEFAULT_MAP_ZOOM = 5;

let earthquakeMap;
let earthquakeLayer;
let userMarker;
let userLatitude = null;
let userLongitude = null;
let earthquakeEvents = [];
let nearestEvent = null;
let toastTimeout;
let activeFetchController = null;

let locationWatchId = null;
let lastFetchLatitude = null;
let lastFetchLongitude = null;
let locationErrorShown = false;

let followUser = true;
let followResumeTimeout = null;

const elements = {
  pageTitle: document.getElementById("page-title"),
  connectionDot: document.getElementById("connection-dot"),
  connectionStatus: document.getElementById("connection-status"),
  lastUpdated: document.getElementById("last-updated"),
  eventCount: document.getElementById("event-count"),
  mapMessage: document.getElementById("map-message"),
  nearestLocation: document.getElementById("nearest-location"),
  nearestDistance: document.getElementById("nearest-distance"),
  nearestDepth: document.getElementById("nearest-depth"),
  nearestMagnitude: document.getElementById("nearest-magnitude"),
  magnitudeBadge: document.getElementById("magnitude-badge"),
  coordinates: document.getElementById("coordinates"),
  mapCoordinates: document.getElementById("map-coordinates"),
  earthquakeList: document.getElementById("earthquake-list"),
  timelineCount: document.getElementById("timeline-count"),
  homeEventCount: document.getElementById("home-event-count"),
  homeLocationStatus: document.getElementById("home-location-status"),
  homeCoordinates: document.getElementById("home-coordinates"),
  homeNearestLocation: document.getElementById("home-nearest-location"),
  homeNearestMag: document.getElementById("home-nearest-mag"),
  homeNearestDistance: document.getElementById("home-nearest-distance"),
  toast: document.getElementById("toast")
};

const VIEW_TITLES = {
  "home-view": "Home",
  "timeline-view": "Earthquake Timeline",
  "map-view": "Earthquake Monitor",
  "menu-view": "Menu"
};

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

function shortDate(value) {
  if (value === null || value === undefined || value === "") return "Time not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time not available";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
  const depth = coordinates.length > 2 ? toNumberOrNull(coordinates[2]) : toNumberOrNull(properties.depth);
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
    feature
  };
}

// silent = true: background refresh. No loading banner and existing data
// stays on screen if the request fails.
async function loadEarthquakeData({ silent = false } = {}) {
  if (activeFetchController) activeFetchController.abort();
  activeFetchController = new AbortController();
  const fetchController = activeFetchController;

  // Remember where this query was centred so we know when to re-query.
  const requestLatitude = userLatitude;
  const requestLongitude = userLongitude;

  if (!silent) {
    setConnectionState("loading", "Retrieving earthquake data…");
    elements.mapMessage.hidden = false;
    elements.mapMessage.textContent = "Loading earthquake data…";
  }

  try {
    const response = await fetch(buildEarthquakeApiUrl(), {
      method: "GET",
      headers: { "Accept": "application/json" },
      cache: "no-store",
      signal: fetchController.signal
    });
    if (!response.ok) throw new Error(`Earthquake service returned HTTP ${response.status}`);

    const data = await response.json();
    if (!data || !Array.isArray(data.features)) throw new Error("The earthquake service returned an unexpected response.");

    earthquakeEvents = data.features.map(eventFromFeature).filter(Boolean);
    lastFetchLatitude = requestLatitude;
    lastFetchLongitude = requestLongitude;

    // Use the newest GPS position, which may have changed while fetching.
    if (userLatitude !== null && userLongitude !== null) updateEventDistances();

    renderMapMarkers();
    renderTimeline();
    renderNearestEarthquake();
    elements.eventCount.textContent = String(earthquakeEvents.length);
    elements.homeEventCount.textContent = String(earthquakeEvents.length);
    elements.lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
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

  earthquakeEvents.forEach(event => {
    const isNearest = Boolean(nearestEvent && event.id === nearestEvent.id);
    const marker = L.marker([event.latitude, event.longitude], {
      icon: createQuakeIcon(event, isNearest),
      keyboard: true,
      title: `${event.location}; magnitude ${event.magnitude ?? "unknown"}`
    });
    marker.bindPopup(`
