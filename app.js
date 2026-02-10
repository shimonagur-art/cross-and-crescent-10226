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
// ✅ UPDATED: routes now use Culture / Commerce / Conquest (case-insensitive).
// (Kept defensive aliases so older data won't break.)
function routeColor(influence) {
  const v = String(influence || "").trim().toLowerCase();
  if (v === "conquest" || v === "christianity") return "#c53030"; // red
  if (v === "culture" || v === "cultural") return "#2b6cb0";      // blue
  if (v === "commerce" || v === "commercial" || v === "islam") return "#2f855a"; // green
  return "#0b4f6c"; // fallback teal
}

// ✅ UPDATED: categories now accept Culture / Commerce / Conquest.
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

// ===== Dashed crawl animation WITHOUT dash-offset (no judder) =====
async function animateRouteCrawl(polyline, {
  fromLatLng,
  toLatLng,
  durationMs = 1500,
  delayMs = 0,
  token
} = {}) {
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  if (token !== renderToken) return;

  const start = performance.now();

  function frame(now) {
    if (token !== renderToken) return;

    const t = Math.min(1, (now - start) / durationMs);
    const e = easeLinear(t);

    const lat = fromLatLng.lat + (toLatLng.lat - fromLatLng.lat) * e;
    const lng = fromLatLng.lng + (toLatLng.lng - fromLatLng.lng) * e;

    polyline.setLatLngs([fromLatLng, L.latLng(lat, lng)]);

    if (t < 1) requestAnimationFrame(frame);
    else {
      polyline.setLatLngs([fromLatLng, toLatLng]);
    }
  }

  requestAnimationFrame(frame);
}

// ✅ NEW: helper for period-aware routes
function routeVisibleInPeriod(route, periodIndex) {
  const p = route?.periods;
  if (!p || !Array.isArray(p) || p.length === 0) return true; // default: show always
  return p.includes(periodIndex);
}

// --- Hover tooltip HTML (minimal) ---
// ✅ UPDATED: accept a per-marker location label, so objects with multiple
// locations show the correct location on each marker’s hover card.
function buildHoverHTML(obj, locLabel) {
  const title = escapeHtml(obj?.title || obj?.id || "Object");
  const thumb = String(obj?.hover?.thumb || "").trim();
  const yearRaw = obj?.hover?.year ?? obj?.year ?? "";
  const year = yearRaw ? escapeHtml(yearRaw) : "";

  // Use per-marker label first, fall back to obj.hover.location if present
  const locRaw = locLabel ?? obj?.hover?.location ?? "";
  const loc = locRaw ? escapeHtml(locRaw) : "";

  const imgHtml = thumb
    ? `<img class="hover-thumb" src="${escapeHtml(thumb)}" alt="${title}" />`
    : "";

  return `
    <div class="hover-card">
      ${imgHtml}
      <div class="hover-meta">
        <div class="hover-title">${title}</div>
        ${loc ? `<div class="hover-year">${loc}</div>` : ""}
        ${year ? `<div class="hover-year">${year}</div>` : ""}
      </div>
    </div>
  `;
}

// --- Right panel HTML ---
function buildPanelHTML(obj, period) {
  const title = escapeHtml(obj?.title || obj?.id || "Object");
  const subtitle = escapeHtml(obj?.panel?.subtitle || "");
  const body = escapeHtml(obj?.panel?.body || "");

  // ✅ NEW: show year/date label in panel (comes from year_lable mapping)
  const yearRaw = obj?.panel?.year ?? obj?.hover?.year ?? obj?.year ?? "";
  const year = yearRaw ? escapeHtml(yearRaw) : "";

  const tags = Array.isArray(obj?.tags) ? obj.tags : [];
  const tagHtml = tags.length
    ? `<p><strong>Tags:</strong> ${tags.map(t => escapeHtml(t)).join(", ")}</p>`
    : "";

  const locs = Array.isArray(obj?.locations) ? obj.locations : [];
  const locHtml = locs.length
    ? `<p><strong>Locations:</strong> ${locs.map(l => escapeHtml(l.label || "")).filter(Boolean).join(", ")}</p>`
    : "";

  const pLabel = escapeHtml(period?.label || "");
  const pStart = escapeHtml(period?.yearStart ?? "");
  const pEnd = escapeHtml(period?.yearEnd ?? "");

  const images = Array.isArray(obj?.panel?.images) ? obj.panel.images : [];
  const imagesHtml = images.length
    ? `
      <div class="panel-images">
        ${images
          .filter(Boolean)
          .map(src => `<img class="panel-img" src="${escapeHtml(src)}" alt="${title}" />`)
          .join("")}
      </div>
    `
    : "";

  return `
    <p><strong>Selected period:</strong> ${pLabel} (${pStart}–${pEnd})</p>
    ${year ? `<p><strong>Date:</strong> ${year}</p>` : ""}
    ${subtitle ? `<h3>${subtitle}</h3>` : ""}
    ${tagHtml}
    ${locHtml}
    ${body ? `<p>${body}</p>` : ""}
    ${imagesHtml}
  `;
}

// --- Data loading ---
async function loadData() {
  const [objectsRes, periodsRes] = await Promise.all([
    fetch("data/objects.json", { cache: "no-store" }),
    fetch("data/periods.json", { cache: "no-store" })
  ]);

  if (!objectsRes.ok) throw new Error("Failed to load data/objects.json");
  if (!periodsRes.ok) throw new Error("Failed to load data/periods.json");

  const objectsArr = await objectsRes.json();
  const periodsObj = await periodsRes.json();

  if (!Array.isArray(objectsArr)) {
    throw new Error("objects.json must be an array of objects");
  }
  if (!periodsObj || !Array.isArray(periodsObj.periods)) {
    throw new Error('periods.json must be an object like: { "periods": [ ... ] }');
  }

  OBJECTS_BY_ID = new Map(objectsArr.map(o => [o.id, o]));
  PERIODS = periodsObj.periods;

  periodRange.min = "0";
  periodRange.max = String(Math.max(0, PERIODS.length - 1));
  if (!periodRange.value) periodRange.value = "0";

  const v = Number(periodRange.value);
  if (v > PERIODS.length - 1) periodRange.value = String(PERIODS.length - 1);
}

// --- Render for a period index ---
function drawForPeriod(periodIndex) {
  renderToken++;
  const token = renderToken;

  let routeIndex = 0;

  const period = PERIODS[periodIndex];
  clearLayers();

  if (!period) {
    setPanel("No period", "<p>Period not found.</p>");
    return;
  }

  const objectIds = Array.isArray(period.objects) ? period.objects : [];

  if (objectIds.length === 0) {
    setPanel("No objects", `<p>No objects configured for ${escapeHtml(period.label)}.</p>`);
    return;
  }

  for (const id of objectIds) {
    const obj = OBJECTS_BY_ID.get(id);
    if (!obj) continue;

    const col = categoryColor(obj.category);
    const baseStyle = markerStyleBase(col);
    const hoverStyle = markerStyleHover(col);
    const selectedStyle = markerStyleSelected(col);

    const locations = Array.isArray(obj.locations) ? obj.locations : [];
    const routes = Array.isArray(obj.routes) ? obj.routes : [];

    if (locations.length === 0) continue;

    for (const loc of locations) {
      if (loc?.lat == null || loc?.lng == null) continue;

      const marker = L.circleMarker([Number(loc.lat), Number(loc.lng)], baseStyle);
      marker.__baseStyle = baseStyle;
      marker.__hoverStyle = hoverStyle;
      marker.__selectedStyle = selectedStyle;

      // ✅ UPDATED: pass loc.label so hover card shows correct place per marker
      marker.bindTooltip(buildHoverHTML(obj, loc.label), {
        direction: "top",
        offset: [0, -10],
        opacity: 1,
        className: "hover-tooltip",
        sticky: true
      });

      marker.on("mouseover", () => {
        if (selectedMarker === marker) return;
        marker.setStyle(marker.__hoverStyle);
      });

      marker.on("mouseout", () => {
        if (selectedMarker === marker) return;
        marker.setStyle(marker.__baseStyle);
      });

      marker.on("click", () => {
        if (selectedMarker && selectedMarker !== marker) {
          selectedMarker.setStyle(selectedMarker.__baseStyle);
        }
        selectedMarker = marker;
        marker.setStyle(marker.__selectedStyle);
        setPanel(obj.title || obj.id || "Object", buildPanelHTML(obj, period));
      });

      marker.addTo(markersLayer);
      fadeInMarker(marker, marker.__baseStyle.fillOpacity, 400);

      for (const r of routes) {
        // ✅ NEW: skip route if not meant for this period
        if (!routeVisibleInPeriod(r, periodIndex)) continue;

        if (r?.toLat == null || r?.toLng == null) continue;

        const from = L.latLng(Number(loc.lat), Number(loc.lng));
        const to = L.latLng(Number(r.toLat), Number(r.toLng));

        const routeLine = L.polyline([from, from], {
          color: routeColor(r.influence),
          weight: 3,
          opacity: 0.9,
          dashArray: "6 8"
        }).addTo(routesLayer);

        animateRouteCrawl(routeLine, {
          fromLatLng: from,
          toLatLng: to,
          durationMs: 1500,
          delayMs: routeIndex * 200,
          token
        });

        routeIndex++;
      }
    }
  }

  setPanel("Select an object", `<p>Hover markers to preview. Click a marker to see full details.</p>`);
}

async function applyPeriod(index) {
  if (isTransitioning) return;
  isTransitioning = true;

  const idx = Math.max(0, Math.min(index, PERIODS.length - 1));
  periodRange.value = String(idx);
  updatePeriodUI(idx);
  updateActiveBand(idx);

  await fadeOutLayers(markersLayer, routesLayer, 400);
  drawForPeriod(idx);

  isTransitioning = false;
}

function wireControls() {
  periodRange.addEventListener("input", (e) => {
    applyPeriod(Number(e.target.value));
  });
}

function wireBands() {
  document.querySelectorAll(".bands span").forEach((el) => {
    const activate = () => {
      const idx = Number(el.dataset.index);
      if (Number.isFinite(idx) && idx >= 0 && idx < PERIODS.length) {
        applyPeriod(idx);
      }
    };

    el.addEventListener("click", activate);

    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        activate();
      }
    });
  });
}

(async function main() {
  initMap();
  wireControls();
  wireBands();

  try {
    await loadData();
    await applyPeriod(Number(periodRange.value));
  } catch (err) {
    setPanel("Error", `<p>${escapeHtml(err.message)}</p>`);
    console.error(err);
  }
})();
