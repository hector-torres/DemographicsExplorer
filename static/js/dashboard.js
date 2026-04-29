/* ═══════════════════════════════════════════════════════════════════════════
   Serendipity Research — GIS Demographic Dashboard
   dashboard.js — all client-side logic
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── State ──────────────────────────────────────────────────────────────────
const State = {
  layer: "tract",         // active census layer
  choroField: null,       // field driving choropleth
  filters: [],            // array of {id, field, label, operator, value}
  county: null,           // active county filter (still used for census layer filtering)
  overlaySelection: null, // {layerKey, id, name} — selected feature within political overlay
  fieldsMeta: {},         // layer → {marketing_fields, extended_fields, stats}
  geojsonCache: {},       // raw geojson per layer (unfiltered, for bounds)
  selectedFeatureId: null,
  filterIdCounter: 0,
  politicalLayer: null,      // active political overlay key: "cd119"|"sldl"|"sldu"|null
};

// ─── Map init ────────────────────────────────────────────────────────────────
const map = L.map("map", {
  center: [31.5, -99.5],
  zoom: 6,
  zoomControl: true,
  attributionControl: true,
});

// Dark tile layer
L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
  {
    attribution: "© OpenStreetMap © CARTO",
    subdomains: "abcd",
    maxZoom: 19,
  }
).addTo(map);

// Labels on top
L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png",
  { subdomains: "abcd", maxZoom: 19, pane: "shadowPane" }
).addTo(map);

let geoLayer = null;   // current Leaflet GeoJSON layer

// ─── Utility ─────────────────────────────────────────────────────────────────
function fmt(val, field) {
  if (val === null || val === undefined || val === "") return "—";
  const v = Number(val);
  if (isNaN(v)) return String(val);

  // Currency fields
  const currencyFields = [
    "median_hh_income","per_capita_income","median_home_value","median_gross_rent"
  ];
  if (currencyFields.includes(field)) {
    return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  // Percentage fields (fields likely to be proportions stored as raw counts — skip)
  // Just format with commas
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function showStatus(text) {
  const pill = document.getElementById("status-pill");
  document.getElementById("status-text").textContent = text;
  pill.classList.remove("hidden");
}
function hideStatus() {
  document.getElementById("status-pill").classList.add("hidden");
}

// ─── Map hover tooltip ────────────────────────────────────────────────────────
let _tooltipTimeout = null;

function showHoverTooltip(props, nameField, mouseEvent) {
  const tooltip = document.getElementById("map-hover-tooltip");
  const name    = props[nameField] || props["NAMELSAD"] || props["NAME"] || "";

  // Build rows — choropleth field first if active
  const rows = [];
  if (State.choroField && props[State.choroField] != null) {
    const meta  = State.fieldsMeta[State.layer];
    const allF  = [...(meta?.marketing_fields||[]),...(meta?.extended_fields||[])];
    const fm    = allF.find(f => f.field === State.choroField);
    const label = fm?.label || State.choroField.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase());
    rows.push(`<div class="tooltip-row">
      <span class="tooltip-label">${label}</span>
      <span class="tooltip-hero-value">${fmtWithPct(props[State.choroField], State.choroField, props)}</span>
    </div>`);
  }
  for (const {key, label} of HOVER_FIELDS) {
    if (key === State.choroField) continue;  // already shown above
    const val = props[key];
    if (val == null) continue;
    rows.push(`<div class="tooltip-row">
      <span class="tooltip-label">${label}</span>
      <span class="tooltip-value">${fmtWithPct(val, key, props)}</span>
    </div>`);
    if (rows.length >= (State.choroField ? 5 : 5)) break;
  }

  tooltip.innerHTML = `
    <div class="tooltip-title">${escHtml(name)}</div>
    ${rows.join("") || '<div style="color:#333;font-size:9px;">No data</div>'}`;

  // Position near mouse, keep within map bounds
  const mapEl  = document.getElementById("map-wrap");
  const mapRect= mapEl.getBoundingClientRect();
  const x      = mouseEvent.originalEvent.clientX - mapRect.left + 14;
  const y      = mouseEvent.originalEvent.clientY - mapRect.top  - 10;
  const tw     = 240;
  const left   = (x + tw > mapRect.width)  ? x - tw - 20 : x;
  const top    = Math.max(4, y);

  tooltip.style.left = left + "px";
  tooltip.style.top  = top  + "px";
  tooltip.classList.remove("hidden");
}

function hideHoverTooltip() {
  document.getElementById("map-hover-tooltip").classList.add("hidden");
}
function showMapLoading() {
  const steps = document.getElementById("startup-steps-list");
  const progWrap = document.getElementById("loading-progress-wrap");
  if (steps) steps.style.display = "none";
  if (progWrap) progWrap.classList.add("hidden");
  const title = document.getElementById("loading-title");
  if (title) title.textContent = "LOADING…";
  document.getElementById("map-loading").classList.remove("hidden");
  document.getElementById("map-stats-panel").classList.add("hidden");
}
function hideMapLoading() {
  document.getElementById("map-loading").classList.add("hidden");
  const steps = document.getElementById("startup-steps-list");
  if (steps) steps.style.display = "";
  document.getElementById("map-stats-panel").classList.remove("hidden");
}

// ─── Overlay search (unified: congress/house/senate/county) ──────────────────
let overlayNames  = [];   // flat list of {id, name} for current overlay
let overlayIdMap  = {};   // id → name

async function loadOverlayNames(layerKey) {
  overlayNames = [];
  overlayIdMap = {};
  if (!layerKey) return;

  // Show loading state in search input
  const searchEl = document.getElementById("overlay-search");
  if (searchEl) searchEl.placeholder = "LOADING…";

  try {
    const res  = await fetch(`/api/overlay_names/${layerKey}`);
    const data = await res.json();
    overlayIdMap  = data.id_map  || {};
    overlayNames  = Object.entries(overlayIdMap).map(([id, name]) => ({id, name}));
    overlayNames.sort((a,b) => a.name.localeCompare(b.name));
  } catch(e) { console.warn("overlay names load failed", e); }

  // Update placeholder and pre-render dropdown so it's ready on first focus/click
  const placeholder = {
    cd119:"SEARCH CONGRESSIONAL DISTRICTS…", sldl:"SEARCH STATE HOUSE DISTRICTS…",
    sldu:"SEARCH STATE SENATE DISTRICTS…", county:"SEARCH COUNTIES…"
  };
  if (searchEl) searchEl.placeholder = placeholder[layerKey] || "SEARCH…";
}

function renderOverlayDropdown(query) {
  const dropdown = document.getElementById("overlay-dropdown");
  const q = query.toLowerCase().trim();

  // If names haven't loaded yet, show loading state
  if (!overlayNames.length) {
    dropdown.innerHTML = `<div class="dropdown-item" style="color:#2a2a2a;cursor:default;">LOADING…</div>`;
    dropdown.classList.remove("hidden");
    return;
  }

  const matches = q
    ? overlayNames.filter(n => n.name.toLowerCase().includes(q)).slice(0, 30)
    : overlayNames.slice(0, 30);

  if (!matches.length) {
    dropdown.innerHTML = `<div class="dropdown-item" style="color:#2a2a2a;cursor:default;">NO MATCHES</div>`;
    dropdown.classList.remove("hidden");
    return;
  }
  dropdown.innerHTML = matches.map(n =>
    `<div class="dropdown-item" data-id="${escHtml(n.id)}" data-name="${escHtml(n.name)}">${escHtml(n.name)}</div>`
  ).join("");
  dropdown.classList.remove("hidden");
  dropdown.querySelectorAll(".dropdown-item").forEach(el => {
    el.addEventListener("click", () => {
      selectOverlayFeature(el.dataset.id, el.dataset.name);
      document.getElementById("overlay-search").value = "";
      dropdown.classList.add("hidden");
    });
  });
}

async function selectOverlayFeature(id, name) {
  const layerKey = State.politicalLayer;
  State.overlaySelection = layerKey ? {layerKey, id, name} : null;

  // Update the census layer filter based on overlay type
  if (layerKey === "county") {
    State.county = name || null;
  } else {
    // For political districts, county filter is not applicable — clear it
    State.county = null;
  }

  // Always reload census layer with the new selection filter applied
  await loadAndRenderLayer();

  // Guard: if the selection was cleared while we were loading, don't re-show the chip
  if (!State.overlaySelection || State.overlaySelection.id !== id) return;

  // Show chip
  const chip   = document.getElementById("overlay-active-chip");
  const nameEl = document.getElementById("overlay-active-name");
  if (name) {
    nameEl.textContent = name;
    chip.classList.remove("hidden");
  } else {
    chip.classList.add("hidden");
  }

  // Zoom to bbox — use district bbox for political layers, county bbox for county
  if (layerKey && id) {
    try {
      let bboxUrl;
      if (layerKey === "county") {
        bboxUrl = `/api/county_bbox/${State.layer}/${encodeURIComponent(name)}`;
      } else {
        bboxUrl = `/api/district_bbox/${layerKey}/${encodeURIComponent(id)}`;
      }
      const res = await fetch(bboxUrl);
      if (res.ok) {
        const bbox = await res.json();
        map.fitBounds([[bbox.south, bbox.west],[bbox.north, bbox.east]], {padding:[40,40], maxZoom:12});
      }
    } catch(e) { console.warn("bbox fetch failed", e); }
  }
}

function clearOverlaySelection() {
  State.overlaySelection = null;
  State.county = null;
  document.getElementById("overlay-active-chip").classList.add("hidden");
  document.getElementById("overlay-search").value = "";
  document.getElementById("overlay-dropdown").classList.add("hidden");
  loadAndRenderLayer();
  map.fitBounds([[25.8,-106.6],[36.5,-93.5]]);
}

// Keep county filter working for census layer — reads from State.county
async function setCountyFilter(county) {
  State.county = county || null;
  await loadAndRenderLayer();
  if (county) {
    try {
      const res = await fetch(`/api/county_bbox/${State.layer}/${encodeURIComponent(county)}`);
      if (res.ok) {
        const bbox = await res.json();
        map.fitBounds([[bbox.south,bbox.west],[bbox.north,bbox.east]],{padding:[40,40],maxZoom:12});
      }
    } catch(e) {}
  } else {
    map.fitBounds([[25.8,-106.6],[36.5,-93.5]]);
  }
}
function showMapError(msg) {
  const el = document.getElementById("map-error");
  document.getElementById("map-error-msg").textContent = msg;
  el.classList.remove("hidden");
}
function hideMapError() {
  document.getElementById("map-error").classList.add("hidden");
}

// Interpolate between two hex colors given t ∈ [0,1]
function hexLerp(hexA, hexB, t) {
  const parse = h => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const a = parse(hexA), b = parse(hexB);
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

// ─── Fields metadata ─────────────────────────────────────────────────────────
async function loadFieldsMeta(layer) {
  if (State.fieldsMeta[layer]) return State.fieldsMeta[layer];
  const res = await fetch(`/api/fields/${layer}`);
  const data = await res.json();
  State.fieldsMeta[layer] = data;
  return data;
}

// ─── Render field lists ───────────────────────────────────────────────────────
function renderFieldLists(meta) {
  const mkList = document.getElementById("field-list-marketing");
  const exList = document.getElementById("field-list-extended");

  mkList.innerHTML = "";
  exList.innerHTML = "";

  const make = (item) => {
    const el = document.createElement("div");
    el.className = "field-item" + (State.choroField === item.field ? " active" : "");
    el.dataset.field = item.field;
    el.innerHTML = `<span class="field-dot"></span>${item.label}`;
    el.addEventListener("click", () => setChoroField(item.field, item.label));
    return el;
  };

  meta.marketing_fields.forEach(item => mkList.appendChild(make(item)));
  meta.extended_fields.forEach(item => exList.appendChild(make(item)));
}

function setChoroField(field, label) {
  State.choroField = field === State.choroField ? null : field;
  // Update active classes
  document.querySelectorAll(".field-item").forEach(el => {
    el.classList.toggle("active", el.dataset.field === State.choroField);
  });
  updateChoroplethLegend();
  loadAndRenderLayer();
}

function filterFieldList(query) {
  const q = query.toLowerCase();
  document.querySelectorAll(".field-item").forEach(el => {
    const matches = el.textContent.toLowerCase().includes(q);
    el.style.display = matches ? "" : "none";
  });
}

// ─── Choropleth legend ────────────────────────────────────────────────────────
async function updateChoroplethLegend() {
  const field = State.choroField;
  const meta = State.fieldsMeta[State.layer];

  if (!field || !meta) {
    document.getElementById("choro-stats").classList.add("hidden");
    return;
  }

  // Fetch scale colors
  const scaleRes = await fetch(`/api/choropleth_scale/${State.layer}/${field}`);
  const scale = await scaleRes.json();

  document.getElementById("legend-bar").style.background =
    `linear-gradient(90deg, ${scale.low} 0%, ${scale.high} 100%)`;

  const stats = meta.stats[field];
  if (stats) {
    document.getElementById("stat-min").textContent  = fmt(stats.min, field);
    document.getElementById("stat-max").textContent  = fmt(stats.max, field);
    document.getElementById("stat-med").textContent  = fmt(stats.p50, field);
    document.getElementById("stat-mean").textContent = fmt(stats.mean, field);
    document.getElementById("legend-low").textContent  = fmt(stats.min, field);
    document.getElementById("legend-high").textContent = fmt(stats.max, field);
  }

  document.getElementById("choro-stats").classList.remove("hidden");

  // Store scale in State for use in styling
  State.currentScale = scale;
}

// ─── GeoJSON load & render ────────────────────────────────────────────────────
async function loadAndRenderLayer() {
  showMapLoading();
  hideMapError();

  const params = new URLSearchParams();
  if (State.choroField) params.set("choropleth_field", State.choroField);
  if (State.county) params.set("county", State.county);
  // Pass district filter when a non-county overlay feature is selected
  if (State.overlaySelection && State.overlaySelection.layerKey !== "county") {
    params.set("district_layer", State.overlaySelection.layerKey);
    params.set("district_id",    State.overlaySelection.id);
  }
  if (State.filters.length) {
    const filterPayload = State.filters.map(f => ({
      field: f.field,
      operator: f.operator,
      value: f.value,
    }));
    params.set("filters", JSON.stringify(filterPayload));
  }

  try {
    const res = await fetch(`/api/geojson/${State.layer}?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geojson = await res.json();

    // Store current geojson for export
    State.currentGeojson = geojson;

    await renderGeoJSON(geojson);
    updateLayerStats(geojson);
    hideMapLoading();

    // Re-disable census pointer events if election layer is active
    if (electionVisible && geoLayer) {
      geoLayer.eachLayer(l => { if (l._path) l._path.style.pointerEvents = "none"; });
      if (electionGeoLayer) electionGeoLayer.bringToFront();
    }
  } catch (err) {
    hideMapLoading();
    showMapError(`Failed to load ${State.layer} data: ${err.message}`);
    console.error(err);
  }
}

// Get id field for current layer
function layerIdField() {
  const map = { puma: "GEOID20", tract: "GEOID" };
  return map[State.layer] || "GEOID";
}

function layerNameField() {
  const map = { puma: "NAMELSAD20", tract: "NAMELSAD" };
  return map[State.layer] || "NAME";
}

async function getScaleColors() {
  if (State.currentScale) return State.currentScale;
  if (!State.choroField) return { low: "#1a3060", high: "#4477dd" };
  const res = await fetch(`/api/choropleth_scale/${State.layer}/${State.choroField}`);
  const scale = await res.json();
  State.currentScale = scale;
  return scale;
}

async function renderGeoJSON(geojson) {
  if (geoLayer) {
    map.removeLayer(geoLayer);
    geoLayer = null;
  }

  const scale = await getScaleColors();
  const pctField = State.choroField ? `__pct_${State.choroField}` : null;

  geoLayer = L.geoJSON(geojson, {
    style: (feature) => {
      const props = feature.properties;
      let fillColor = "#1a1a1a";
      let fillOpacity = 0.5;

      if (pctField && props[pctField] !== null && props[pctField] !== undefined) {
        const t = props[pctField] / 100;
        fillColor = hexLerp(scale.low, scale.high, t);
        fillOpacity = 0.75;
      }

      return {
        fillColor,
        fillOpacity,
        color: "#2a2a2a",
        weight: 0.5,
        opacity: 0.8,
      };
    },
    onEachFeature: (feature, leafletLayer) => {
      const props = feature.properties;
      const idField = layerIdField();
      const nameField = layerNameField();

      let _hoverTimer = null;
      leafletLayer.on("mouseover", function (e) {
        this.setStyle({ color: "#4477dd", weight: 1.5, opacity: 1 });
        this.bringToFront();
        clearTimeout(_hoverTimer);
        _hoverTimer = setTimeout(() => showHoverTooltip(props, nameField, e), 1000);
      });
      leafletLayer.on("mousemove", function (e) {
        if (!document.getElementById("map-hover-tooltip").classList.contains("hidden")) {
          showHoverTooltip(props, nameField, e);
        }
      });
      leafletLayer.on("mouseout", function (e) {
        clearTimeout(_hoverTimer);
        geoLayer.resetStyle(this);
        if (props[idField] === State.selectedFeatureId) {
          this.setStyle({ color: "#cc1100", weight: 1.5 });
        }
        hideHoverTooltip();
      });
      leafletLayer.on("click", function (e) {
        openPopup(feature, e.latlng);
        highlightFeature(props[idField]);
      });
    },
  }).addTo(map);
}

function highlightFeature(id) {
  State.selectedFeatureId = id;
  if (!geoLayer) return;
  const idField = layerIdField();
  geoLayer.eachLayer(l => {
    if (l.feature?.properties[idField] === id) {
      l.setStyle({ color: "#cc1100", weight: 1.5 });
    }
  });
}

function updateLayerStats(geojson) {
  const count = geojson.features ? geojson.features.length : 0;
  document.getElementById("stat-count").textContent = count.toLocaleString();
}

// ─── Popup ────────────────────────────────────────────────────────────────────
function openPopup(feature, latlng) {
  const props = feature.properties;
  const idField = layerIdField();
  const nameField = layerNameField();
  const id = props[idField];
  const name = props[nameField] || props["NAME"] || id;

  // Key marketing fields to show in popup
  const POPUP_FIELDS = [
    { key: "median_hh_income",  label: "Median HH Income" },
    { key: "per_capita_income", label: "Per Capita Income" },
    { key: "total_population",  label: "Population" },
    { key: "median_age",        label: "Median Age" },
    { key: "poverty_below",     label: "Below Poverty" },
    { key: "median_home_value", label: "Home Value" },
    { key: "median_gross_rent", label: "Median Rent" },
    { key: "owner_occupied",    label: "Owner-Occupied" },
    { key: "employed",          label: "Employed" },
    { key: "edu_bachelors",     label: "Bachelor's+" },
    { key: "hispanic",          label: "Hispanic / Latino" },
    { key: "transport_wfh",     label: "Work From Home" },
  ];

  // If a display variable is selected, show it prominently at the top
  let heroBlock = "";
  if (State.choroField) {
    const heroVal = props[State.choroField];
    // Get label from fieldsMeta if available, else prettify field name
    const meta = State.fieldsMeta[State.layer];
    const allFields = [
      ...(meta?.marketing_fields || []),
      ...(meta?.extended_fields  || []),
    ];
    const fieldMeta = allFields.find(f => f.field === State.choroField);
    const heroLabel = fieldMeta?.label || State.choroField.replace(/_/g, " ").replace(/\w/g, c => c.toUpperCase());

    // Percentile rank for this feature
    const pctKey = `__pct_${State.choroField}`;
    const pct = props[pctKey];
    const pctBadge = (pct !== null && pct !== undefined)
      ? `<span class="popup-pct-badge">${Math.round(pct)}<sup>th</sup> pctile</span>`
      : "";

    heroBlock = `
      <div class="popup-hero">
        <div class="popup-hero-label">${escHtml(heroLabel)}</div>
        <div class="popup-hero-value">
          ${heroVal !== null && heroVal !== undefined ? fmt(heroVal, State.choroField) : "—"}
          ${pctBadge}
        </div>
      </div>
      <div class="popup-divider"></div>`;
  }

  // Standard fields — skip the hero field to avoid duplication
  let rows = "";
  for (const { key, label } of POPUP_FIELDS) {
    if (key === State.choroField) continue;   // already shown in hero
    const val = props[key];
    if (val !== null && val !== undefined) {
      rows += `<div class="popup-row">
        <span class="popup-label">${label}</span>
        <span class="popup-value">${fmtWithPct(val, key, props)}</span>
      </div>`;
    }
  }

  const html = `
    <div class="popup-inner">
      <div class="popup-title">${escHtml(name)}</div>
      ${heroBlock}
      ${rows || '<div style="color:#333;font-size:10px;padding:4px 0;">No demographic data joined.</div>'}
      <button class="popup-select-btn" onclick="selectFeatureInSidebar('${escHtml(id)}')">
        VIEW IN SIDEBAR →
      </button>
    </div>`;

  L.popup({ maxWidth: 300, className: "sr-popup" })
    .setLatLng(latlng)
    .setContent(html)
    .openOn(map);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Sidebar feature detail ───────────────────────────────────────────────────
async function selectFeatureInSidebar(id) {
  map.closePopup();
  highlightFeature(id);

  const section = document.getElementById("selection-section");
  const detailEl = document.getElementById("selection-detail");
  const allPanel = document.getElementById("all-fields-panel");
  const allBtn = document.getElementById("show-all-fields-btn");

  section.style.display = "";
  detailEl.innerHTML = '<div style="color:#333;font-size:10px;padding:8px 0;">LOADING…</div>';
  allPanel.classList.add("hidden");
  allBtn.textContent = "▶ ALL FIELDS";
  allBtn.classList.remove("active-state");

  try {
    const res = await fetch(`/api/feature/${State.layer}/${id}`);
    const data = await res.json();

    // Marketing fields
    detailEl.innerHTML = "";
    for (const [key, label] of Object.entries(data.labels)) {
      const val = data.marketing[key];
      if (val === null || val === undefined) continue;
      detailEl.innerHTML += `
        <div class="detail-row">
          <span class="detail-label">${label}</span>
          <span class="detail-value">${fmtWithPct(val, key, data.all_fields)}</span>
        </div>`;
    }

    // All fields (hidden)
    allPanel.innerHTML = "";
    for (const [key, val] of Object.entries(data.all_fields)) {
      if (val === null) continue;
      allPanel.innerHTML += `
        <div class="detail-row">
          <span class="detail-label" style="color:#2a2a2a;">${key}</span>
          <span class="detail-value" style="color:#555;">${fmt(val, key)}</span>
        </div>`;
    }

  } catch (err) {
    detailEl.innerHTML = `<div style="color:#662222;font-size:10px;padding:8px 0;">Failed to load feature data.</div>`;
  }

  // Scroll sidebar to selection section
  section.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Make available globally (called from popup HTML)
window.selectFeatureInSidebar = selectFeatureInSidebar;

// ─── Percentile filter UI ─────────────────────────────────────────────────────
let filterDropdownFields = [];

function initFilterSearch(meta) {
  const all = [
    ...meta.marketing_fields,
    ...meta.extended_fields,
  ];
  filterDropdownFields = all.filter(f => f.field in (meta.stats || {}));

  const input = document.getElementById("filter-field-search");
  const dropdown = document.getElementById("filter-field-dropdown");

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase();
    const matches = filterDropdownFields.filter(f =>
      f.label.toLowerCase().includes(q) || f.field.toLowerCase().includes(q)
    ).slice(0, 20);

    if (!matches.length || !q) {
      dropdown.classList.add("hidden");
      return;
    }

    dropdown.innerHTML = matches.map(f =>
      `<div class="dropdown-item" data-field="${f.field}" data-label="${escHtml(f.label)}">${f.label}</div>`
    ).join("");
    dropdown.classList.remove("hidden");

    dropdown.querySelectorAll(".dropdown-item").forEach(el => {
      el.addEventListener("click", () => {
        addFilter(el.dataset.field, el.dataset.label);
        input.value = "";
        dropdown.classList.add("hidden");
      });
    });
  });

  document.addEventListener("click", e => {
    if (!e.target.closest("#filter-field-search-wrap")) {
      dropdown.classList.add("hidden");
    }
  });
}

function addFilter(field, label) {
  // Avoid duplicate field
  if (State.filters.find(f => f.field === field)) return;

  const id = `filter_${++State.filterIdCounter}`;
  State.filters.push({ id, field, label, operator: "lte", value: 50 });
  renderFilterChips();
  updateFilterBadge();
  loadAndRenderLayer();
}

function removeFilter(id) {
  State.filters = State.filters.filter(f => f.id !== id);
  renderFilterChips();
  updateFilterBadge();
  loadAndRenderLayer();
}

function updateFilter(id, key, val) {
  const f = State.filters.find(f => f.id === id);
  if (f) {
    f[key] = val;
    // Update the bar fill
    const chip = document.querySelector(`[data-filter-id="${id}"]`);
    if (chip) {
      const fill = chip.querySelector(".filter-bar-fill");
      if (fill) fill.style.width = Math.min(100, parseFloat(val) || 0) + "%";
    }
    // Only reload if the value is a valid non-empty number in range
    if (key === "value") {
      const num = parseFloat(val);
      if (val === "" || isNaN(num) || num < 1 || num > 100) return;
    }
    scheduleFilterReload();
  }
}

let filterReloadTimer = null;
function scheduleFilterReload() {
  clearTimeout(filterReloadTimer);
  filterReloadTimer = setTimeout(loadAndRenderLayer, 500);
}

function renderFilterChips() {
  const container = document.getElementById("active-filters");
  container.innerHTML = "";

  State.filters.forEach(f => {
    const chip = document.createElement("div");
    chip.className = "filter-chip";
    chip.dataset.filterId = f.id;

    const pct = Math.min(100, parseFloat(f.value) || 0);
    const operatorLabel = f.operator === "lte" ? "BOTTOM" : "TOP";

    chip.innerHTML = `
      <div class="filter-chip-header">
        <span class="filter-chip-label">${escHtml(f.label)}</span>
        <span class="filter-chip-remove" title="Remove filter" data-id="${f.id}">✕</span>
      </div>
      <div class="filter-chip-controls">
        <select data-id="${f.id}" data-key="operator">
          <option value="lte" ${f.operator === "lte" ? "selected" : ""}>BOTTOM</option>
          <option value="gte" ${f.operator === "gte" ? "selected" : ""}>TOP</option>
        </select>
        <input type="number" min="1" max="100" step="1" value="${f.value}"
          data-id="${f.id}" data-key="value" style="width:52px;">
        <span class="filter-chip-suffix">PCTILE</span>
      </div>
      <div class="filter-bar">
        <div class="filter-bar-fill" style="width:${pct}%;"></div>
      </div>`;

    chip.querySelector(".filter-chip-remove").addEventListener("click", () => removeFilter(f.id));
    chip.querySelector("select").addEventListener("change", e => {
      updateFilter(f.id, "operator", e.target.value);
    });
    chip.querySelector("input[type='number']").addEventListener("input", e => {
      updateFilter(f.id, "value", e.target.value);
    });

    container.appendChild(chip);
  });
}

function updateFilterBadge() {
  const badge = document.getElementById("filter-count-badge");
  badge.textContent = State.filters.length;
  badge.classList.toggle("has-filters", State.filters.length > 0);
}

// ─── Layer switching ──────────────────────────────────────────────────────────
async function switchLayer(layer) {
  if (layer === State.layer) return;
  State.layer = layer;
  State.choroField = null;
  State.filters = [];
  State.county = null;
  State.selectedFeatureId = null;
  State.currentScale = null;
  setCountyFilter(null);

  document.querySelectorAll(".pill[data-layer]").forEach(p => {
    p.classList.toggle("active", p.dataset.layer === layer);
  });

  renderFilterChips();
  updateFilterBadge();
  document.getElementById("selection-section").style.display = "none";
  document.getElementById("choro-stats").classList.add("hidden");

  const meta = await loadFieldsMeta(layer);
  renderFieldLists(meta);
  initFilterSearch(meta);
  // Overlay names load on demand when an overlay is selected

  document.getElementById("stat-total").textContent = "—";

  await loadAndRenderLayer();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
// ─── Startup polling ──────────────────────────────────────────────────────────
const STEP_ICONS = { pending: "·", running: "▶", done: "✓", error: "✗" };

function renderStartupSteps(steps, current) {
  const list = document.getElementById("startup-steps-list");
  if (!list) return;
  list.innerHTML = steps.map(s => `
    <div class="startup-step ${s.status}">
      <span class="step-icon">${STEP_ICONS[s.status] || "·"}</span>
      <span>${s.label}</span>
      ${s.note ? `<span class="step-note">${s.note}</span>` : ""}
    </div>`).join("");
  // Scroll to running step
  const running = list.querySelector(".startup-step.running");
  if (running) running.scrollIntoView({ block: "nearest" });
}

function updateStartupProgress(pct) {
  const wrap = document.getElementById("loading-progress-wrap");
  const bar  = document.getElementById("loading-progress-bar");
  const pctEl= document.getElementById("loading-progress-pct");
  if (!wrap) return;
  wrap.classList.remove("hidden");
  bar.style.setProperty("--pct", pct + "%");
  pctEl.textContent = pct + "%";
}

async function pollStartupStatus() {
  return new Promise((resolve, reject) => {
    document.getElementById("loading-title").textContent = "INITIALIZING SERVER…";
    const interval = setInterval(async () => {
      try {
        const res  = await fetch("/api/startup_status");
        const data = await res.json();
        renderStartupSteps(data.steps || [], data.current);
        updateStartupProgress(data.pct || 0);

        if (data.error) {
          clearInterval(interval);
          document.getElementById("loading-title").textContent = "STARTUP FAILED";
          reject(new Error(data.error));
        } else if (data.ready) {
          clearInterval(interval);
          document.getElementById("loading-title").textContent = "READY";
          updateStartupProgress(100);
          setTimeout(resolve, 400);   // brief pause so user sees 100%
        }
      } catch (e) {
        // Server may not be up yet — keep polling silently
      }
    }, 600);
  });
}

async function init() {
  showMapLoading();
  document.getElementById("loading-title").textContent = "CONNECTING…";
  try {
    // Wait for server to finish preloading all data
    await pollStartupStatus();

    // Immediately hide startup screen before any further loading
    hideMapLoading();
    // Brief pause so user sees the completed state
    await new Promise(r => setTimeout(r, 300));
    const meta = await loadFieldsMeta(State.layer);
    renderFieldLists(meta);
    initFilterSearch(meta);
    // Overlay names load on demand when an overlay is selected

    await loadAndRenderLayer();
    map.fitBounds([[25.8, -106.6], [36.5, -93.5]]);

  } catch (err) {
    hideMapLoading();
    showMapError("Initialization failed: " + err.message);
    console.error(err);
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Layer pills
document.querySelectorAll(".pill[data-layer]").forEach(btn => {
  btn.addEventListener("click", () => switchLayer(btn.dataset.layer));
});

// Field search
document.getElementById("field-search").addEventListener("input", e => {
  filterFieldList(e.target.value);
});

// Choropleth clear
document.getElementById("choro-clear").addEventListener("click", () => {
  State.choroField = null;
  State.currentScale = null;
  document.querySelectorAll(".field-item").forEach(el => el.classList.remove("active"));
  document.getElementById("choro-stats").classList.add("hidden");
  loadAndRenderLayer();
});

// Extended fields toggle
let extendedOpen = false;
document.getElementById("extended-toggle").addEventListener("click", () => {
  extendedOpen = !extendedOpen;
  document.getElementById("field-list-extended").classList.toggle("hidden", !extendedOpen);
  document.getElementById("extended-toggle").textContent =
    extendedOpen ? "▼ HIDE EXTENDED FIELDS" : "▶ SHOW ALL FIELDS";
  document.getElementById("extended-toggle").classList.toggle("active-state", extendedOpen);
});

// Clear all filters
document.getElementById("filters-clear-all").addEventListener("click", () => {
  State.filters = [];
  renderFilterChips();
  updateFilterBadge();
  loadAndRenderLayer();
});

// Selection clear
document.getElementById("selection-clear").addEventListener("click", () => {
  State.selectedFeatureId = null;
  document.getElementById("selection-section").style.display = "none";
  if (geoLayer) geoLayer.resetStyle();
  map.closePopup();
});

// Show all fields toggle in sidebar
document.getElementById("show-all-fields-btn").addEventListener("click", () => {
  const panel = document.getElementById("all-fields-panel");
  const btn = document.getElementById("show-all-fields-btn");
  const open = !panel.classList.contains("hidden");
  panel.classList.toggle("hidden", open);
  btn.textContent = open ? "▶ ALL FIELDS" : "▼ HIDE ALL FIELDS";
  btn.classList.toggle("active-state", !open);
});

// Unified overlay search
document.getElementById("overlay-search").addEventListener("input", e => {
  const q = e.target.value;
  if (q.trim()) {
    renderOverlayDropdown(q);
  } else {
    document.getElementById("overlay-dropdown").classList.add("hidden");
  }
});
document.getElementById("overlay-search").addEventListener("focus", () => {
  renderOverlayDropdown(document.getElementById("overlay-search").value);
});
document.addEventListener("click", e => {
  if (!e.target.closest("#overlay-search-wrap")) {
    document.getElementById("overlay-dropdown").classList.add("hidden");
  }
});
document.getElementById("overlay-chip-remove").addEventListener("click", clearOverlaySelection);

// ─── Political overlays ──────────────────────────────────────────────────────
let politicalGeoLayer  = null;
let districtChoroActive= false;  // true when districts are colored by demographic
const politicalCache   = {};

// ─── District demographic profile ─────────────────────────────────────────────
async function openDistrictProfile(layerKey, districtId) {
  const section  = document.getElementById("district-section");
  const detail   = document.getElementById("district-detail");
  const allPanel = document.getElementById("district-all-fields");
  const allBtn   = document.getElementById("district-show-all-btn");

  section.style.display = "";
  detail.innerHTML = '<div style="color:#333;font-size:10px;padding:8px 0;">LOADING…</div>';
  allPanel.classList.add("hidden");
  allBtn.textContent = "▶ ALL FIELDS";
  allBtn.classList.remove("active-state");

  try {
    const res  = await fetch(`/api/district/${layerKey}/${districtId}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    detail.innerHTML = `<div style="font-size:11px;font-weight:700;color:#4477dd;
      letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;padding-bottom:6px;
      border-bottom:1px solid #1a1a1a;">${data.name}</div>`;

    // Hero: if a choropleth field is active, show it first
    if (State.choroField && data.marketing[State.choroField] !== undefined) {
      const meta = State.fieldsMeta[State.layer];
      const allF = [...(meta?.marketing_fields||[]),...(meta?.extended_fields||[])];
      const fm   = allF.find(f=>f.field===State.choroField);
      const lbl  = fm?.label || State.choroField.replace(/_/g," ").replace(/\w/g,c=>c.toUpperCase());
      detail.innerHTML += `
        <div class="popup-hero" style="margin-bottom:10px;">
          <div class="popup-hero-label">${lbl}</div>
          <div class="popup-hero-value">${fmt(data.marketing[State.choroField], State.choroField)}</div>
        </div>`;
    }

    // Marketing fields
    for (const [key, label] of Object.entries(data.labels)) {
      if (key === State.choroField) continue;
      const val = data.marketing[key];
      if (val === null || val === undefined) continue;
      detail.innerHTML += `<div class="detail-row">
        <span class="detail-label">${label}</span>
        <span class="detail-value">${fmtWithPct(val, key, data.all_fields)}</span>
      </div>`;
    }

    // All fields panel
    allPanel.innerHTML = "";
    for (const [key, val] of Object.entries(data.all_fields)) {
      if (val === null) continue;
      allPanel.innerHTML += `<div class="detail-row">
        <span class="detail-label" style="color:#2a2a2a;">${key}</span>
        <span class="detail-value" style="color:#555;">${fmt(val, key)}</span>
      </div>`;
    }

  } catch (err) {
    detail.innerHTML = `<div style="color:#662222;font-size:10px;padding:8px 0;">Failed: ${err.message}</div>`;
  }
  section.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ─── District choropleth ───────────────────────────────────────────────────────
async function applyDistrictChoropleth(layerKey, field) {
  if (!field || !layerKey) return;
  showStatus("COLORING DISTRICTS");

  try {
    const scaleRes = await fetch(`/api/choropleth_scale/${State.layer}/${field}`);
    const scale    = await scaleRes.json();
    const res      = await fetch(`/api/district_choropleth/${layerKey}/${field}`);
    const geojson  = await res.json();

    // Remove existing political layer and redraw with choropleth colors
    if (politicalGeoLayer) { map.removeLayer(politicalGeoLayer); politicalGeoLayer = null; }

    const pctField = `__pct_${field}`;
    politicalGeoLayer = L.geoJSON(geojson, {
      style: (feature) => {
        const pct = feature.properties[pctField];
        const t   = pct != null ? pct / 100 : 0.5;
        return {
          fillColor:   hexLerp(scale.low, scale.high, t),
          fillOpacity: 0.65,
          color:       "#0a0a0a",
          weight:      1.2,
          opacity:     1,
        };
      },
      onEachFeature: (feature, layer) => {
        const pcfg = POLITICAL_LAYERS[layerKey];
        const id   = feature.properties[pcfg?.id_field] || feature.properties.GEOID;
        const name = feature.properties._name || feature.properties.NAMELSAD || id;
        const val  = feature.properties[field];
        layer.on("mouseover", function() {
          this.setStyle({ weight: 2, opacity: 1 });
          document.getElementById("political-hover-info").textContent =
            `${name} — ${val != null ? fmt(val, field) : "—"}`;
        });
        layer.on("mouseout", function() {
          politicalGeoLayer.resetStyle(this);
          document.getElementById("political-hover-info").textContent = "Hover a district for its name. Click for demographic profile.";
        });
        layer.on("click", () => openDistrictProfile(layerKey, id));
      },
    }).addTo(map);

    districtChoroActive = true;
    if (geoLayer) geoLayer.bringToFront();
    document.getElementById("district-choro-clear").classList.remove("hidden");
    hideStatus();

  } catch (err) {
    hideStatus();
    console.error("District choropleth failed:", err);
  }
}

const POLITICAL_LAYERS = { cd119:{id_field:"GEOID"}, sldl:{id_field:"GEOID"}, sldu:{id_field:"GEOID"} };

// ─── Hover tooltip field config ───────────────────────────────────────────────
// Top fields shown on hover. When a choropleth field is active it appears first.
// Edit this array to change which fields appear in the hover tooltip.
const HOVER_FIELDS = [
  { key: "median_hh_income",  label: "Med. HH Income" },
  { key: "total_population",  label: "Population"      },
  { key: "median_age",        label: "Median Age"      },
  { key: "hispanic",          label: "Hispanic"        },
  { key: "edu_bachelors",     label: "Bachelor's+"     },
];

// ─── Percentage denominators ───────────────────────────────────────────────────
// Maps a count field to its denominator for showing "(X%)" after the raw value.
// Used in hover tooltip, popups, and sidebar detail panels. Edit freely.
const PCT_DENOMINATORS = {
  poverty_below:           "poverty_total",
  owner_occupied:          "occupied_units_total",
  renter_occupied:         "occupied_units_total",
  employed:                "employment_total",
  unemployed:              "employment_total",
  in_labor_force:          "employment_total",
  edu_bachelors:           "edu_total",
  edu_masters:             "edu_total",
  edu_professional:        "edu_total",
  edu_doctorate:           "edu_total",
  hispanic:                "hispanic_total",
  race_white:              "race_total",
  race_black:              "race_total",
  race_asian:              "race_total",
  transport_wfh:           "transport_total",
  transport_car_alone:     "transport_total",
  transport_public_transit:"transport_total",
  transport_carpool:       "transport_total",
  occ_mgmt_business:       "occupation_total",
  occ_service:             "occupation_total",
  occ_production:          "occupation_total",
  lang_spanish:            "lang_total",
  lang_english_only:       "lang_total",
};

/** Format value with optional percentage in parens: "45,231 (18.3%)" */
function fmtWithPct(val, field, props) {
  const base = fmt(val, field);
  const denomField = PCT_DENOMINATORS[field];
  if (!denomField || !props) return base;
  const denom = props[denomField];
  if (!denom || denom <= 0 || val == null) return base;
  const pct = (parseFloat(val) / parseFloat(denom) * 100).toFixed(1);
  return base + ` <span style="color:#555;font-size:9px;font-weight:400;">(${pct}%)</span>`;
}

// District colors — styled to be clearly distinct from choropleth without
// competing with it. Transparent fill, colored stroke only.
const POLITICAL_STYLES = {
  cd119:  { color: "#cc8800", weight: 1.5, dashArray: null,  opacity: 0.85 },
  sldl:   { color: "#4a9a4a", weight: 1.2, dashArray: "5,4", opacity: 0.75 },
  sldu:   { color: "#cc4444", weight: 1.5, dashArray: "2,5", opacity: 0.80 },
  county: { color: "#4477dd", weight: 1.5, dashArray: "3,3", opacity: 0.80 },
};

async function loadPoliticalLayer(key) {
  if (politicalCache[key]) return politicalCache[key];
  showStatus("LOADING DISTRICTS");
  const res = await fetch(`/api/political/${key}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const geojson = await res.json();
  politicalCache[key] = geojson;
  hideStatus();
  return geojson;
}

function clearPoliticalLayer() {
  if (politicalGeoLayer) {
    map.removeLayer(politicalGeoLayer);
    politicalGeoLayer = null;
  }
  State.politicalLayer  = null;
  State.county          = null;
  State.overlaySelection= null;
  districtChoroActive   = false;

  document.querySelectorAll(".pill[data-political]").forEach(p => p.classList.remove("active"));
  document.getElementById("political-legend").classList.add("hidden");
  document.getElementById("political-clear").classList.add("hidden");
  document.getElementById("overlay-search-wrap").classList.add("hidden");
  document.getElementById("overlay-active-chip").classList.add("hidden");
  document.getElementById("overlay-search").value = "";
  document.getElementById("overlay-dropdown").classList.add("hidden");
  document.getElementById("political-hover-info").textContent = "Hover a feature for its name. Click for demographic profile.";
  document.getElementById("district-choro-toggle").textContent = "▶ USE DISPLAY VARIABLE";
  document.getElementById("district-choro-toggle").classList.remove("active-state");
  document.getElementById("district-choro-clear").classList.add("hidden");

  // Reset census layer to full Texas
  loadAndRenderLayer();
  map.fitBounds([[25.8,-106.6],[36.5,-93.5]]);
}

async function togglePoliticalLayer(key) {
  // If same layer clicked again — clear it
  if (State.politicalLayer === key) {
    clearPoliticalLayer();
    return;
  }

  // Clear any existing overlay first
  if (politicalGeoLayer) {
    map.removeLayer(politicalGeoLayer);
    politicalGeoLayer = null;
  }

  try {
    const geojson = await loadPoliticalLayer(key);
    const style = POLITICAL_STYLES[key] || { color: "#4477dd", weight: 1.5, dashArray: "3,3", opacity: 0.80 };

    politicalGeoLayer = L.geoJSON(geojson, {
      style: {
        color:       style.color,
        weight:      style.weight,
        dashArray:   style.dashArray,
        opacity:     style.opacity,
        fillColor:   style.color,
        fillOpacity: 0.04,      // nearly transparent fill — just a hint of color
      },
      onEachFeature: (feature, layer) => {
        const pcfg = POLITICAL_LAYERS[key];
        const id   = feature.properties[pcfg?.id_field] || feature.properties.GEOID;
        const name = feature.properties.NAMELSAD || feature.properties[Object.keys(feature.properties)[1]];
        layer.on("mouseover", function () {
          this.setStyle({ fillOpacity: 0.12, weight: style.weight + 0.5 });
          document.getElementById("political-hover-info").textContent = name;
        });
        layer.on("mouseout", function () {
          politicalGeoLayer.resetStyle(this);
          document.getElementById("political-hover-info").textContent = "Hover a district for its name. Click for demographic profile.";
        });
        layer.on("click", () => openDistrictProfile(key, id));
        layer.bindTooltip(name, {
          sticky: true,
          className: "political-tooltip",
          direction: "top",
          offset: [0, -4],
        });
      },
    }).addTo(map);

    // Bring census layer to front so clicks still work on it
    if (geoLayer) geoLayer.bringToFront();

    State.politicalLayer = key;

    // Update sidebar
    document.querySelectorAll(".pill[data-political]").forEach(p => {
      p.classList.toggle("active", p.dataset.political === key);
    });

    const labelMap = {
      cd119:"US Congress (119th)", sldl:"TX State House",
      sldu:"TX State Senate", county:"County"
    };
    document.getElementById("political-active-label").textContent = labelMap[key] || key;
    document.getElementById("political-district-count").textContent = geojson.features?.length || "—";
    document.getElementById("political-legend").classList.remove("hidden");
    document.getElementById("political-clear").classList.remove("hidden");

    // Show unified overlay search and load names for this layer
    const searchWrap = document.getElementById("overlay-search-wrap");
    searchWrap.classList.remove("hidden");
    const placeholder = {
      cd119:"SEARCH CONGRESSIONAL DISTRICTS…", sldl:"SEARCH STATE HOUSE DISTRICTS…",
      sldu:"SEARCH STATE SENATE DISTRICTS…", county:"SEARCH COUNTIES…"
    };
    document.getElementById("overlay-search").placeholder = placeholder[key] || "SEARCH…";
    await loadOverlayNames(key);

  } catch (err) {
    hideStatus();
    console.error("Political layer load failed:", err);
  }
}

// Re-raise census layer to front after every render so political overlay
// doesn't intercept map click events
const _origRenderGeoJSON = renderGeoJSON;
renderGeoJSON = async function(geojson) {
  await _origRenderGeoJSON(geojson);
  if (politicalGeoLayer) politicalGeoLayer.bringToBack();
};

// ─── Election overlay ────────────────────────────────────────────────────────
let electionGeoLayer   = null;
let electionFieldMeta  = [];     // [{field, label, group}]
let electionActiveField= null;   // currently selected display field
let electionVisible    = false;

// R=red, D=blue — standard US political color convention
const ELECTION_PARTY_COLORS = {
  trump:  "#cc2200",
  harris: "#2255cc",
  cruz:   "#cc2200",
  allred: "#2255cc",
};

async function loadElectionFields() {
  if (electionFieldMeta.length) return electionFieldMeta;
  const res  = await fetch("/api/election/fields");
  const data = await res.json();
  electionFieldMeta = data.fields || [];
  return electionFieldMeta;
}

function renderElectionFieldDropdown(query) {
  const dropdown = document.getElementById("election-field-dropdown");
  const q = query.toLowerCase().trim();
  const matches = q
    ? electionFieldMeta.filter(f => f.label.toLowerCase().includes(q) || f.group.toLowerCase().includes(q)).slice(0,20)
    : electionFieldMeta.slice(0, 20);

  if (!matches.length) {
    dropdown.innerHTML = `<div class="dropdown-item" style="color:#2a2a2a;cursor:default;">NO MATCHES</div>`;
    dropdown.classList.remove("hidden");
    return;
  }

  // Group by section
  let lastGroup = null;
  dropdown.innerHTML = matches.map(f => {
    let header = "";
    if (f.group !== lastGroup) {
      lastGroup = f.group;
      header = `<div style="font-size:8px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#333;padding:6px 10px 2px;border-top:1px solid #141414;">${f.group}</div>`;
    }
    return `${header}<div class="dropdown-item" data-field="${escHtml(f.field)}" data-label="${escHtml(f.label)}">${escHtml(f.label)}</div>`;
  }).join("");
  dropdown.classList.remove("hidden");

  dropdown.querySelectorAll(".dropdown-item[data-field]").forEach(el => {
    el.addEventListener("click", () => {
      setElectionField(el.dataset.field, el.dataset.label);
      document.getElementById("election-field-search").value = "";
      dropdown.classList.add("hidden");
    });
  });
}

async function setElectionField(field, label) {
  electionActiveField = field;
  document.getElementById("election-field-label").textContent = label;
  document.getElementById("election-active-field").classList.remove("hidden");

  // Update legend
  const scaleRes = await fetch(`/api/election/choropleth_scale/${encodeURIComponent(field)}`);
  const scale    = await scaleRes.json();
  document.getElementById("election-legend-bar").style.background =
    `linear-gradient(90deg, ${scale.low} 0%, ${scale.high} 100%)`;
  document.getElementById("election-legend").classList.remove("hidden");

  await renderElectionLayer();
}

function clearElectionField() {
  electionActiveField = null;
  document.getElementById("election-active-field").classList.add("hidden");
  document.getElementById("election-legend").classList.remove("hidden"); // keep bar visible
  renderElectionLayer();
}

async function renderElectionLayer() {
  if (!electionVisible) return;
  if (electionGeoLayer) { map.removeLayer(electionGeoLayer); electionGeoLayer = null; }

  showStatus("LOADING ELECTION DATA");
  const params = new URLSearchParams();
  if (electionActiveField) params.set("field", electionActiveField);
  if (State.county) params.set("county", State.county);
  if (State.overlaySelection && State.overlaySelection.layerKey !== "county") {
    params.set("district_layer", State.overlaySelection.layerKey);
    params.set("district_id",    State.overlaySelection.id);
  }

  try {
    const res     = await fetch(`/api/election/geojson?${params}`);
    const geojson = await res.json();
    const pctField = electionActiveField ? `__pct_${electionActiveField}` : null;

    // Get color scale
    let scale = { low: "#1a2a1a", high: "#4a9a4a" };
    if (electionActiveField) {
      const sr = await fetch(`/api/election/choropleth_scale/${encodeURIComponent(electionActiveField)}`);
      scale = await sr.json();
      // Update legend labels
      const vals = geojson.features.map(f => f.properties[electionActiveField]).filter(v => v != null);
      if (vals.length) {
        const min = Math.min(...vals), max = Math.max(...vals);
        document.getElementById("election-legend-low").textContent  = fmtElection(min, electionActiveField);
        document.getElementById("election-legend-high").textContent = fmtElection(max, electionActiveField);
        document.getElementById("election-legend").classList.remove("hidden");
      }
    }

    electionGeoLayer = L.geoJSON(geojson, {
      style: (feature) => {
        const props = feature.properties;
        let fillColor = "#1a1a1a", fillOpacity = 0.3;
        if (pctField && props[pctField] != null) {
          fillColor = hexLerp(scale.low, scale.high, props[pctField] / 100);
          fillOpacity = 0.7;
        } else if (!electionActiveField) {
          // Default: color by Trump margin when no field selected
          const margin = props["pres_margin"];
          if (margin != null) {
            fillColor = margin > 0 ? "#cc2200" : "#2255cc";
            fillOpacity = Math.min(0.8, Math.abs(margin) / 60);
          }
        }
        return { fillColor, fillOpacity, color: "#0a0a0a", weight: 0.3, opacity: 0.6 };
      },
      onEachFeature: (feature, layer) => {
        const props = feature.properties;
        let _hoverTimer = null;
        layer.on("mouseover", function(e) {
          this.setStyle({ weight: 1.2, color: "#4477dd", opacity: 1 });
          clearTimeout(_hoverTimer);
          _hoverTimer = setTimeout(() => showElectionTooltip(props, e), 400);
        });
        layer.on("mousemove", function(e) {
          if (!document.getElementById("map-hover-tooltip").classList.contains("hidden"))
            showElectionTooltip(props, e);
        });
        layer.on("mouseout", function() {
          clearTimeout(_hoverTimer);
          electionGeoLayer.resetStyle(this);
          hideHoverTooltip();
        });
        layer.on("click", () => showElectionDetail(props));
      },
    }).addTo(map);

    // Disable pointer events on census layer so election hover fires correctly
    if (geoLayer) {
      geoLayer.eachLayer(l => { if (l._path) l._path.style.pointerEvents = "none"; });
    }
    if (politicalGeoLayer) politicalGeoLayer.bringToFront();

    hideStatus();
    document.getElementById("election-hover-info").textContent =
      `${geojson.features?.length || 0} VTDs shown. Hover for results.`;

  } catch(err) {
    hideStatus();
    console.error("Election layer error:", err);
  }
}

function fmtElection(val, field) {
  if (val == null) return "—";
  if (field?.includes("_pct") || field?.includes("turnout") || field?.includes("margin")) {
    return parseFloat(val).toFixed(1) + "%";
  }
  return parseFloat(val).toLocaleString("en-US", {maximumFractionDigits: 0});
}

function showElectionTooltip(props, e) {
  const mapEl   = document.getElementById("map-wrap");
  const mapRect = mapEl.getBoundingClientRect();
  const x = e.originalEvent.clientX - mapRect.left + 14;
  const y = e.originalEvent.clientY - mapRect.top  - 10;

  const trumpPct  = props["pres_trump_pct"]  != null ? parseFloat(props["pres_trump_pct"]).toFixed(1)  + "%" : "—";
  const harrisPct = props["pres_harris_pct"] != null ? parseFloat(props["pres_harris_pct"]).toFixed(1) + "%" : "—";
  const margin    = props["pres_margin"]     != null ? parseFloat(props["pres_margin"]).toFixed(1)     + "%" : "—";
  const turnout   = props["turnout_pct"]     != null ? parseFloat(props["turnout_pct"]).toFixed(1)     + "%" : "—";
  const reg       = props["Voter_Registration"] != null ? parseInt(props["Voter_Registration"]).toLocaleString() : "—";

  const marginColor = props["pres_margin"] > 0 ? "#cc4444" : "#4477dd";

  // Active field hero if set
  let hero = "";
  if (electionActiveField && props[electionActiveField] != null) {
    const lbl = electionFieldMeta.find(f => f.field === electionActiveField)?.label || electionActiveField;
    hero = `<div class="popup-hero" style="margin-bottom:8px;">
      <div class="popup-hero-label">${escHtml(lbl)}</div>
      <div class="popup-hero-value">${fmtElection(props[electionActiveField], electionActiveField)}</div>
    </div>`;
  }

  const tooltip = document.getElementById("map-hover-tooltip");
  const vtdName = `VTD ${props.VTD || ""} (County ${props.CNTY || ""})`;
  tooltip.innerHTML = `
    <div class="tooltip-title">${vtdName}</div>
    ${hero}
    <div class="tooltip-row"><span class="tooltip-label" style="color:#cc4444;">TRUMP</span><span class="tooltip-value">${trumpPct}</span></div>
    <div class="tooltip-row"><span class="tooltip-label" style="color:#4477dd;">HARRIS</span><span class="tooltip-value">${harrisPct}</span></div>
    <div class="tooltip-row"><span class="tooltip-label" style="color:${marginColor};">R−D MARGIN</span><span class="tooltip-value">${margin}</span></div>
    <div class="tooltip-row"><span class="tooltip-label">TURNOUT</span><span class="tooltip-value">${turnout}</span></div>
    <div class="tooltip-row"><span class="tooltip-label">REG. VOTERS</span><span class="tooltip-value">${reg}</span></div>`;

  const tw = 240;
  tooltip.style.left = ((x + tw > mapRect.width) ? x - tw - 20 : x) + "px";
  tooltip.style.top  = Math.max(4, y) + "px";
  tooltip.classList.remove("hidden");
}

function showElectionDetail(props) {
  const section = document.getElementById("election-detail-section");
  const body    = document.getElementById("election-detail-body");
  section.style.display = "";

  const vtdName = `VTD ${props.VTD || ""} — County ${props.CNTY || ""}`;

  const DETAIL_GROUPS = [
    { title: "PRESIDENTIAL 2024", rows: [
      { label: "Trump (R)",  value: props["TrumpR_24G_President"],  pct: props["pres_trump_pct"],  color: "#cc4444" },
      { label: "Harris (D)", value: props["HarrisD_24G_President"], pct: props["pres_harris_pct"], color: "#4477dd" },
      { label: "R−D Margin", value: null, pct: props["pres_margin"], color: props["pres_margin"] > 0 ? "#cc4444" : "#4477dd" },
    ]},
    { title: "U.S. SENATE 2024", rows: [
      { label: "Cruz (R)",   value: props["CruzR_24G_U.S. Sen"],   pct: props["sen_cruz_pct"],   color: "#cc4444" },
      { label: "Allred (D)", value: props["AllredD_24G_U.S. Sen"], pct: props["sen_allred_pct"], color: "#4477dd" },
      { label: "R−D Margin", value: null, pct: props["sen_margin"], color: props["sen_margin"] > 0 ? "#cc4444" : "#4477dd" },
    ]},
    { title: "TURNOUT & REGISTRATION", rows: [
      { label: "Votes Cast",      value: props["Turnout"],            pct: props["turnout_pct"] },
      { label: "Registered",      value: props["Voter_Registration"],  pct: null },
      { label: "SS Registered",   value: props["Spanish_Surname_Voter_Registration"], pct: props["ss_registration_pct"] },
    ]},
  ];

  let html = `<div style="font-size:10px;font-weight:700;color:#4477dd;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #1a1a1a;">${vtdName}</div>`;

  for (const group of DETAIL_GROUPS) {
    html += `<div style="font-size:9px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#333;margin:8px 0 4px;border-bottom:1px solid #141414;padding-bottom:4px;">${group.title}</div>`;
    for (const row of group.rows) {
      const valStr  = row.value != null ? parseInt(row.value).toLocaleString() : "";
      const pctStr  = row.pct   != null ? parseFloat(row.pct).toFixed(1) + "%" : "—";
      const color   = row.color || "#c0c0c0";
      html += `<div class="detail-row">
        <span class="detail-label" style="color:${color};">${row.label}</span>
        <span class="detail-value" style="color:${color};">${valStr ? valStr + " " : ""}<span style="font-size:10px;">(${pctStr})</span></span>
      </div>`;
    }
  }

  body.innerHTML = html;
  section.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function toggleElectionLayer() {
  if (electionVisible) {
    // Turn off — re-enable census pointer events
    if (electionGeoLayer) { map.removeLayer(electionGeoLayer); electionGeoLayer = null; }
    if (geoLayer) {
      geoLayer.eachLayer(l => { if (l._path) l._path.style.pointerEvents = ""; });
    }
    electionVisible = false;
    electionActiveField = null;
    document.getElementById("election-toggle-btn").classList.remove("active");
    document.getElementById("election-controls").classList.add("hidden");
    document.getElementById("election-clear").classList.add("hidden");
    document.getElementById("election-detail-section").style.display = "none";
    hideHoverTooltip();
    return;
  }

  // Turn on
  electionVisible = true;
  document.getElementById("election-toggle-btn").classList.add("active");
  document.getElementById("election-controls").classList.remove("hidden");
  document.getElementById("election-clear").classList.remove("hidden");

  // Load field metadata
  await loadElectionFields();
  await renderElectionLayer();
}

// ─── Export ───────────────────────────────────────────────────────────────────
function buildExportUrl(format) {
  const params = new URLSearchParams();
  params.set("format", format);
  if (State.county)     params.set("county", State.county);
  if (State.choroField) params.set("choropleth_field", State.choroField);
  if (State.filters.length) {
    params.set("filters", JSON.stringify(State.filters.map(f => ({
      field: f.field, operator: f.operator, value: f.value,
    }))));
  }
  return `/api/export/${State.layer}?${params}`;
}

function triggerExport(format) {
  const btn = format === "csv"
    ? document.getElementById("export-csv-btn")
    : document.getElementById("export-xlsx-btn");
  const note = document.getElementById("export-note");

  btn.textContent = "EXPORTING…";
  btn.classList.add("active-state");
  note.textContent = "Preparing file…";

  // Use a hidden anchor to trigger download without navigating
  const a = document.createElement("a");
  a.href = buildExportUrl(format);
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Reset button state after a short delay
  setTimeout(() => {
    btn.textContent = format === "csv" ? "↓ CSV" : "↓ XLSX";
    btn.classList.remove("active-state");
    const count = document.getElementById("stat-count")?.textContent || "?";
    note.textContent = `Exports currently visible filtered data.`;
  }, 2000);
}

document.getElementById("export-csv-btn").addEventListener("click",  () => triggerExport("csv"));
document.getElementById("export-xlsx-btn").addEventListener("click", () => triggerExport("xlsx"));

// Political overlay pills
document.querySelectorAll(".pill[data-political]").forEach(btn => {
  btn.addEventListener("click", () => togglePoliticalLayer(btn.dataset.political));
});
document.getElementById("political-clear").addEventListener("click", clearPoliticalLayer);

// District choropleth toggle — use the currently active display variable
document.getElementById("district-choro-toggle").addEventListener("click", async () => {
  if (!State.politicalLayer) return;
  if (!State.choroField) {
    document.getElementById("political-hover-info").textContent =
      "Select a Display Variable first, then click this button.";
    return;
  }
  if (districtChoroActive) {
    // Reset to boundary-only mode
    clearPoliticalLayer();
    togglePoliticalLayer(State.politicalLayer || "cd119");
    districtChoroActive = false;
    document.getElementById("district-choro-clear").classList.add("hidden");
    document.getElementById("district-choro-toggle").textContent = "▶ USE DISPLAY VARIABLE";
    document.getElementById("district-choro-toggle").classList.remove("active-state");
    return;
  }
  await applyDistrictChoropleth(State.politicalLayer, State.choroField);
  document.getElementById("district-choro-toggle").textContent = "▼ RESET TO BOUNDARIES";
  document.getElementById("district-choro-toggle").classList.add("active-state");
});

// District choropleth clear
document.getElementById("district-choro-clear").addEventListener("click", () => {
  districtChoroActive = false;
  document.getElementById("district-choro-clear").classList.add("hidden");
  document.getElementById("district-choro-toggle").textContent = "▶ USE DISPLAY VARIABLE";
  document.getElementById("district-choro-toggle").classList.remove("active-state");
  if (State.politicalLayer) {
    if (politicalGeoLayer) { map.removeLayer(politicalGeoLayer); politicalGeoLayer = null; }
    togglePoliticalLayer(State.politicalLayer);
    State.politicalLayer = null;  // togglePoliticalLayer will re-set it
  }
});

// District detail section controls
document.getElementById("district-section-clear").addEventListener("click", () => {
  document.getElementById("district-section").style.display = "none";
});
document.getElementById("district-show-all-btn").addEventListener("click", () => {
  const panel = document.getElementById("district-all-fields");
  const btn   = document.getElementById("district-show-all-btn");
  const open  = !panel.classList.contains("hidden");
  panel.classList.toggle("hidden", open);
  btn.textContent = open ? "▶ ALL FIELDS" : "▼ HIDE ALL FIELDS";
  btn.classList.toggle("active-state", !open);
});

// Stats panel close button
document.getElementById("map-stats-close").addEventListener("click", () => {
  document.getElementById("map-stats-panel").classList.add("hidden");
});

// Election layer events
document.getElementById("election-toggle-btn").addEventListener("click", toggleElectionLayer);
document.getElementById("election-clear").addEventListener("click", toggleElectionLayer);
document.getElementById("election-detail-clear").addEventListener("click", () => {
  document.getElementById("election-detail-section").style.display = "none";
});

// Election field search
document.getElementById("election-field-search").addEventListener("input", e => {
  if (e.target.value.trim()) renderElectionFieldDropdown(e.target.value);
  else document.getElementById("election-field-dropdown").classList.add("hidden");
});
document.getElementById("election-field-search").addEventListener("focus", () => {
  renderElectionFieldDropdown(document.getElementById("election-field-search").value);
});
document.addEventListener("click", e => {
  if (!e.target.closest("#election-field-search-wrap"))
    document.getElementById("election-field-dropdown").classList.add("hidden");
});
document.getElementById("election-field-clear").addEventListener("click", clearElectionField);

// ─── Run ──────────────────────────────────────────────────────────────────────
init();