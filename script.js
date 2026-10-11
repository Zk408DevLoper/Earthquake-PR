"use strict";

const EARTHQUAKE_API_BASE = "https://www.seismicportal.eu/fdsnws/event/1/query";
const EARTHQUAKE_SEARCH_RADIUS_KM = 100;

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
  earthquakeList: document.getElementById("earthquake-list"),
  timelineCount: document.getElementById("timeline-count"),
  homeEventCount: document.getElementById("home-event-count"),
  homeLocationStatus: document.getElementById("home-location-status"),
  homeCoordinates: document.getElementById("home-coordinates"),
  homeNearestLocation: document.getElementById("home-nearest-location"),
  homeNearestMag: document.getElementById("home-nearest-mag"),
  homeNearestDistance: document.getElementById("home-nearest-distance"),
  toast: document.getElementById("toast"),
  refreshButton: document.getElementById("refresh-button")
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

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(earthquakeMap);

  L.control.zoom({ position: "bottomright" }).addTo(earthquakeMap);
  earthquakeLayer = L.layerGroup().addTo(earthquakeMap);
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

async function loadEarthquakeData(showFeedback = false) {
  if (activeFetchController) activeFetchController.abort();
  activeFetchController = new AbortController();
  const fetchController = activeFetchController;

  setConnectionState("loading", "Retrieving earthquake data…");
  elements.mapMessage.hidden = false;
  elements.mapMessage.textContent = "Loading earthquake data…";
  elements.refreshButton.classList.add("is-loading");

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
    if (showFeedback) showToast(`Earthquake data refreshed (${earthquakeEvents.length} events).`);
  } catch (error) {
    if (error && error.name === "AbortError") return;
    console.error("Earthquake retrieval error:", error);
    setConnectionState("error", "Unable to retrieve earthquake data");
    elements.mapMessage.hidden = false;
    elements.mapMessage.textContent = "Unable to load earthquake data. Check your internet connection and try again.";
    elements.earthquakeList.innerHTML = '<div class="empty-state">Earthquake data could not be retrieved. Check your connection and try again.</div>';
    if (showFeedback) showToast("Could not retrieve earthquake data. Check your connection and try again.");
  } finally {
    if (activeFetchController === fetchController) {
      activeFetchController = null;
      elements.refreshButton.classList.remove("is-loading");
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
      <span class="popup-title">${escapeHtml(event.location)}</span>
      <span class="popup-mag">M ${event.magnitude === null ? "--" : event.magnitude.toFixed(1)}</span><br>
      <span>Depth: ${event.depth === null ? "Unknown" : `${event.depth} km`}</span><br>
      <span>${escapeHtml(formatDate(event.time))}</span><br>
      <button class="popup-select" type="button" onclick="selectEarthquake('${escapeHtml(event.id).replace(/'/g, "\\'")}')">View event details</button>
    `);
    marker.addTo(earthquakeLayer);
  });

  if (userLatitude !== null && userLongitude !== null) {
    if (userMarker && earthquakeMap.hasLayer(userMarker)) earthquakeMap.removeLayer(userMarker);
    const icon = L.divIcon({ className: "", html: '<div class="user-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
    userMarker = L.marker([userLatitude, userLongitude], { icon, title: "Your location", zIndexOffset: 1000 })
      .bindPopup("<strong>Your location</strong><br>GPS coordinates from this device")
      .addTo(earthquakeMap);
  }
}

function updateEventDistances() {
  earthquakeEvents.forEach(event => {
    event.distance = calculateDistance(userLatitude, userLongitude, event.latitude, event.longitude);
  });
  const candidates = earthquakeEvents.filter(event => Number.isFinite(event.distance));
  candidates.sort((a, b) => a.distance - b.distance);
  nearestEvent = candidates.length ? candidates[0] : null;
}

function renderNearestEarthquake() {
  if (userLatitude === null || userLongitude === null) {
    elements.nearestLocation.textContent = "Get your location to calculate the nearest reported earthquake.";
    elements.nearestDistance.textContent = "--";
    elements.nearestDepth.textContent = "--";
    elements.nearestMagnitude.textContent = "--";
    elements.magnitudeBadge.textContent = "M --";
    elements.homeLocationStatus.textContent = "Not set";
    elements.homeCoordinates.textContent = "Tap locate to get coordinates";
    elements.homeNearestLocation.textContent = "Location not available yet";
    elements.homeNearestMag.textContent = "Magnitude --";
    elements.homeNearestDistance.textContent = "Distance --";
    return;
  }

  if (!nearestEvent) {
    elements.nearestLocation.textContent = "No earthquake location is available in the retrieved records.";
    elements.nearestDistance.textContent = "--";
    elements.nearestDepth.textContent = "--";
    elements.nearestMagnitude.textContent = "--";
    elements.magnitudeBadge.textContent = "M --";
    elements.homeNearestLocation.textContent = "No event available";
    elements.homeNearestMag.textContent = "Magnitude --";
    elements.homeNearestDistance.textContent = "Distance --";
    return;
  }

  const magnitude = nearestEvent.magnitude === null ? "--" : nearestEvent.magnitude.toFixed(1);
  elements.nearestLocation.textContent = nearestEvent.location;
  elements.nearestDistance.textContent = `${nearestEvent.distance.toFixed(1)} km`;
  elements.nearestDepth.textContent = nearestEvent.depth === null ? "--" : nearestEvent.depth.toLocaleString();
  elements.nearestMagnitude.textContent = magnitude;
  elements.magnitudeBadge.textContent = `M ${magnitude}`;
  elements.homeLocationStatus.textContent = "Available";
  elements.homeCoordinates.textContent = `${userLatitude.toFixed(4)}, ${userLongitude.toFixed(4)}`;
  elements.homeNearestLocation.textContent = nearestEvent.location;
  elements.homeNearestMag.textContent = `Magnitude ${magnitude}`;
  elements.homeNearestDistance.textContent = `Distance ${nearestEvent.distance.toFixed(1)} km`;
}

function renderTimeline() {
  elements.timelineCount.textContent = `${earthquakeEvents.length} event${earthquakeEvents.length === 1 ? "" : "s"}`;
  if (!earthquakeEvents.length) {
    elements.earthquakeList.innerHTML = '<div class="empty-state">No earthquake events are currently available.</div>';
    return;
  }

  const list = [...earthquakeEvents];
  if (userLatitude !== null && userLongitude !== null) {
    list.sort((a, b) => {
      const distanceA = a.distance === null ? Infinity : a.distance;
      const distanceB = b.distance === null ? Infinity : b.distance;
      return distanceA - distanceB;
    });
  } else {
    list.sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime());
  }

  elements.earthquakeList.innerHTML = list.map(event => {
    const magnitude = event.magnitude === null ? "--" : event.magnitude.toFixed(1);
    const severity = event.magnitude >= 5 ? "severe" : event.magnitude >= 4 ? "strong" : "";
    const distance = event.distance === null ? "Distance unavailable" : `${event.distance.toFixed(1)} km away`;
    return `<button class="earthquake-item" type="button" data-event-id="${escapeHtml(event.id)}">
      <span class="event-magnitude ${severity}">${magnitude}</span>
      <span class="event-content"><strong>${escapeHtml(event.location)}</strong><span>${escapeHtml(formatDate(event.time))}</span><span>${escapeHtml(distance)} · Depth ${event.depth === null ? "unknown" : `${event.depth} km`}</span></span>
      <span class="event-chevron">›</span>
    </button>`;
  }).join("");

}

function selectEarthquake(eventId) {
  const event = earthquakeEvents.find(item => item.id === eventId);
  if (!event) return;
  switchView("map-view");
  if (earthquakeMap) {
    earthquakeMap.setView([event.latitude, event.longitude], Math.max(earthquakeMap.getZoom(), 6), { animate: true });
    const layer = earthquakeLayer.getLayers().find(marker => {
      const position = marker.getLatLng();
      return Math.abs(position.lat - event.latitude) < 0.000001 && Math.abs(position.lng - event.longitude) < 0.000001;
    });
    if (layer) layer.openPopup();
  }
  elements.nearestLocation.textContent = event.location;
  elements.nearestDistance.textContent = event.distance === null ? "--" : `${event.distance.toFixed(1)} km`;
  elements.nearestDepth.textContent = event.depth === null ? "--" : event.depth.toLocaleString();
  elements.nearestMagnitude.textContent = event.magnitude === null ? "--" : event.magnitude.toFixed(1);
  elements.magnitudeBadge.textContent = `M ${event.magnitude === null ? "--" : event.magnitude.toFixed(1)}`;
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

function getUserLocation() {
  if (!navigator.geolocation) {
    showToast("Geolocation is not supported by this device.");
    return;
  }

  showToast("Requesting your location…");
  navigator.geolocation.getCurrentPosition(async position => {
    userLatitude = position.coords.latitude;
    userLongitude = position.coords.longitude;
    elements.coordinates.textContent = `${userLatitude.toFixed(6)}, ${userLongitude.toFixed(6)}`;
    updateEventDistances();
    renderMapMarkers();
    renderNearestEarthquake();
    renderTimeline();

    if (earthquakeMap) earthquakeMap.setView([userLatitude, userLongitude], 7, { animate: true });

    // Re-query the EMSC catalogue around the new location so the nearest event
    // isn't limited to the newest 100 events worldwide.
    showToast("Location found. Looking for nearby earthquakes…");
    await loadEarthquakeData();
    showToast("Your location was updated.");
  }, error => {
    console.error("Location error:", error);
    const messages = {
      1: "Location permission was denied. Allow location access in your browser or app settings.",
      2: "Your location is currently unavailable. Please try again.",
      3: "The location request timed out. Please try again."
    };
    showToast(messages[error.code] || "An unknown location error occurred.");
  }, {
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 30000
  });
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

  if (button.dataset.eventId) {
    selectEarthquake(button.dataset.eventId);
    return;
  }

  switch (button.id) {
    case "locate-button":
    case "location-inline-button":
    case "home-locate-button":
    case "menu-locate-button":
      getUserLocation();
      break;
    case "refresh-button":
    case "timeline-refresh":
    case "menu-refresh-button":
      loadEarthquakeData(true);
      break;
    case "home-map-button":
      switchView("map-view");
      break;
    default:
      break;
  }
});

initializeMap();
loadEarthquakeData();

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
