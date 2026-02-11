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
//   - Curved routes using Leaflet.Curve (robust numeric validation)
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
  if (v === "culture" || v === "cultural") return "#2b6cb0";      // blue
  if (v === "commerce" || v === "commercial" || v === "islam") return "#2f855a"; // green
  return "#0b4f6c"; // fallback teal
}

function categoryColor(category) {
  const v = String(category || "").trim().toLowerCase();
  if (v === "culture" || v === "cultural") return "#2b6cb0";     // blue
  if (v === "commerce" || v === "commercial") return "#2f855a";  // green
  if (v === "conquest") return "#c53030";                        // red-ish
  return "#0b4f6c";                                              // fallback teal
}

// Marker visual states
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

// --- Fade helpers ---
function easeLinear(t) { return t; }

function animateStyle(layer, from, to, durationMs = 300, onDone) {
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const e = easeLinear(t);

    const cur = {};
    for (const k of Object.keys(to)) {
      const a = (from[k] ?? 0);
      const b = to[k];
      cur[k] = a + (b - a) * e;
    }
    layer.setStyle(cur);

    if (t < 1) requestAnimationFrame(tick);
    else if (onDone) onDone();
  }
  requestAnimationFrame(tick);
}

function fadeOutLayers(markersLayer, routesLayer, durationMs = 220) {
  const markers = [];
  markersLayer.eachLayer(l => markers.push(l));

  const routes = [];
  routesLayer.eachLayer(l => routes.push(l));

  for (const m of markers) {
    const from = {
      fillOpacity: (typeof m.options?.fillOpacity === "number") ? m.options.fillOpacity : 0.5,
      opacity: (typeof m.options?.opacity === "number") ? m.options.opacity : 1
    };
    const to = { fillOpacity: 0, opacity: 0 };
    animateStyle(m, from, to, durationMs);
  }

  for (const r of routes) {
    const from = { opacity: (typeof r.options?.opacity === "number") ? r.options.opacity : 0.9 };
    const to = { opacity: 0 };
    animateStyle(r, from, to, durationMs);
  }

  return new Promise(resolve => setTimeout(resolve, durationMs));
}

function fadeInMarker(marker, targetFillOpacity, durationMs = 450) {
  marker.setStyle({ fillOpacity: 0, opacity: 0 });
  animateStyle(marker, { fillOpacity: 0, opacity: 0 }, { fillOpacity: targetFillOpacity, opacity: 1 }, durationMs);
}

// --- Robust numeric parsing / validation (prevents leaflet.curve undefined x) ---
function toFiniteNumber(v) {
  // Accept numbers and numeric strings, reject "", null, NaN, Infinity
  const n = (typeof v === "number") ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function toLatLngSafe(lat, lng) {
  const la = toFiniteNumber(lat);
  const lo = toFiniteNumber(lng);
  if (la == null || lo == null) return null;
  return L.latLng(la, lo);
}

// --- Curved route helper (Leaflet.Curve) ---
// Uses arrays [lat, lng] for maximum compatibility with the plugin.
function makeCurvedRoute(fromLatLng, toLatLng, style) {
  // Fallback: if curve plugin isn't present or map not ready, draw straight line
  const hasCurve = typeof L.curve === "function";
  const mapReady = !!(map && map._loaded);
  if (!hasCurve || !mapReady) {
    const poly = L.polyline([fromLatLng, toLatLng], style);
    return poly;
  }

  const pA = map.latLngToLayerPoint(fromLatLng);
  const pB = map.latLngToLayerPoint(toLatLng);

  // Extra safety (very defensive)
  if (!pA || !pB || typeof pA.x !== "number" || typeof pB.x !== "number") {
    const poly = L.polyline([fromLatLng, toLatLng], style);
    return poly;
  }

  const mid = pA.add(pB).divideBy(2);
  const dx = pB.x - pA.x;
  const dy = pB.y - pA.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;

  // perpendicular unit vector
  const ux = -dy / len;
  const uy = dx / len;

  // Bend amount in pixels (scaled by distance, clamped)
  const bend = Math.min(120, Math.max(40, len * 0.15));

  const controlPoint = L.point(mid.x + ux * bend, mid.y + uy * bend);
  const controlLatLng = map.layerPointToLatLng(controlPoint);

  const A = [fromLatLng.lat, fromLatLng.lng];
  const B = [toLatLng.lat, toLatLng.lng];
  const C =
