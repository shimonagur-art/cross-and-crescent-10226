// ==============================
// Cross & Crescent - app.js (DATA-DRIVEN)
// Loads:
//   - data/objects.json  (array of objects)
//   - data/periods.json  ({ periods: [...] })
// Renders:
//   - markers per object location
//   - hover tooltips with thumbnails (minimal text)
//   - click opens right panel with full details
//   - routes (influence) from each location -> target, colored by influence
// Adds:
//   - Fade-out old period then fade-in new period (smooth transitions)
//   - Route "crawl" animation (dashed during crawl, no judder)
//   - ✅ Curved routes (no plugins; robust)
// ==============================

const periodRange = document.getElementById("periodRange");
const periodValue = document.getElementById("periodValue");
const panelTitle = document.getElementById("panelTitle");
const panelBody = document.getElementById("panelBody");

let map = null;
let markersLayer = null;
let routesLayer = null;

let PERIODS = [];              // from data/periods.json
let OBJECTS_BY_ID = new Map(); // from data/objects.json

// Track the currently selected marker so we can keep it darker
let selectedMarker = null;

// Prevent spamming transitions when dragging slider fast
let isTransitioning = false;

// Cancels any in-flight route animations when period changes
let renderToken = 0;

function setPanel(title, html) {
  panelTitle.textContent = title;
  panelBody.innerHTML = html;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initMap() {
  map = L.map("map", { scrollWheelZoom: false }).setView([41.5, 18], 4);

  // ✅ Clean, label-free basemap (CARTO Light - No Labels)
  // This removes city/place labels and keeps a quiet background.
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    subdomains: "abcd",
    attribution: ""
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
  routesLayer = L.layerGroup().addTo(map);
}

function clearLayers() {
  markersLayer.clearLayers();
  routesLayer.clearLayers();
  selectedMarker = null;
}

function updateActiveBand(index) {
  document.querySelectorAll(".bands span").forEach(el => {
    el.classList.toggle("active", Number(el.dataset.index) === index);
  });
}

function updatePeriodUI(index) {
  const p = PERIODS[index];
  if (!p) return;
  const start = p.yearStart ?? "";
  const end = p.yearEnd ?? "";
  periodValue.textContent = `${p.label} (${start}–${end})`;
}

// --- Color / style helpers ---
function routeColor(influence) {
  const v = String(influence || "").trim().toLowerCase();
  if (v === "conquest" || v === "christianity") return "#c53030"; // red
  if (v === "culture" || indicatesCulture(v)) return "#2b6cb0";      // blue
  if (v === "commerce" || indicatesCommerce(v) || v === "islam") return "#2f855a"; // green
  return "#0b4f6c"; // fallback teal
}
function indicatesCulture(v){ return v === "cultural"; }
function indicatesCommerce(v){ return v === "commercial"; }

function categoryColor(category) {
  const v = String(category || "").trim().toLowerCase();
  if (v === "culture" || v === "cultural") return "#2b6cb0";     // blue
  if (v === "commerce" || v === "commercial") return "#2f855a";  // green
  if (v === "conquest") return "#c53030";                        // red-ish
  return "#0b4f6c";                                              // fallback teal
}

// Marker visual states (bigger; base semi-transparent; hover/selected opaque)
function markerStyleBase(color) {
  return {
    radius: 11,
    weight: 0,
    opacity: 0,
    color: color,
    fillColor: color,
    fillOpacity: 0.65
  };
}

function markerStyleHover(color) {
  return {
    radius: 12,
    weight: 0,
    opacity: 0,
    color: color,
    fillColor: color,
    fillOpacity: 0.95
  };
}

function markerStyleSelected(color) {
  return {
    radius: 12,
    weight: 0,
    opacity: 0,
    color: color,
    fillColor: color,
    fillOpacity: 1
  };
}

// --- Fade helpers (for period transitions) ---
function easeLinear(t) { return t; }

function animateStyle(layer, from, to, durationMs = 300, onDone) {
  const start = performance.now();
  function tic
