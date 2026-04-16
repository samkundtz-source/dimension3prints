/**
 * Map2Model · Main application controller
 *
 * Wires together: Leaflet map → OSM fetch → geometry build → Three.js preview → export
 */

import 'leaflet/dist/leaflet.css';
import './style.css';

import L from 'leaflet';

// Custom marker — themed pin that reads clearly on the dark map tiles
const PIN_ICON = L.divIcon({
  className: 'cities3ds-pin',
  html: `<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">
    <path d="M13 1C6.92 1 2 5.92 2 12c0 8.25 11 21 11 21s11-12.75 11-21c0-6.08-4.92-11-11-11z"
          fill="#3b82f6" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="13" cy="12" r="4" fill="#ffffff"/>
  </svg>`,
  iconSize:   [26, 34],
  iconAnchor: [13, 33],
});

import { createProjection, getHexVerticesGeo, getHexVertices, getShapeVertices, getShapeVerticesGeo } from './geo/geoMath.js';
import { geocode, fetchOSMData, parseOSMData, fetchElevation } from './geo/osmData.js';
import { buildMapModel } from './geometry/buildMap.js';
import { SceneManager }  from './preview/scene.js';
import { exportSTL, export3MF } from './export/exporters.js';
import { MODEL_RADIUS_MM, TERRAIN_GRID_SIZE } from './utils/helpers.js';

// ─── State ────────────────────────────────────────────────────────────────────

let leafletMap      = null;
let shapeLayerGroup = null;
let markerLayerGroup= null;
let scene           = null;

let selectedCenter  = null;   // { lat, lng }
const currentShape  = 'hexagon';
let generating      = false;
let generateAbort   = null;   // AbortController for current generation
let lastGenerateTime = 0;
let searchDebounceTimer = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const el = (id) => document.getElementById(id);

// ─── Status ───────────────────────────────────────────────────────────────────

function setStatus(msg, pct) {
  el('status-text').textContent = msg;
  if (pct !== undefined) {
    el('progress-bar').style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }
}

// ─── Map initialisation ───────────────────────────────────────────────────────

function initMap() {
  leafletMap = L.map('map-container', {
    center:      [51.505, -0.09],   // Default: London
    zoom:        13,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OSM</a>',
    maxZoom:     19,
  }).addTo(leafletMap);

  shapeLayerGroup  = L.layerGroup().addTo(leafletMap);
  markerLayerGroup = L.layerGroup().addTo(leafletMap);

  leafletMap.on('click', e => {
    selectLocation(e.latlng.lat, e.latlng.lng,
      `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`);
  });
}

// ─── Location selection ───────────────────────────────────────────────────────

function selectLocation(lat, lng, label) {
  selectedCenter = { lat, lng };

  // Place marker
  markerLayerGroup.clearLayers();
  L.marker([lat, lng], { icon: PIN_ICON }).addTo(markerLayerGroup);

  // Pan map
  leafletMap.setView([lat, lng], Math.max(leafletMap.getZoom(), 13));

  // Draw shape outline
  updateShapeOverlay();

  // Always enable generate — even if a previous generation is still running.
  // Clicking Generate while one is in-flight will abort the old and start fresh.
  const genBtn = el('generate-btn');
  genBtn.disabled = false;
  genBtn.classList.remove('generating');

  setStatus(`Location: ${label}`, 5);
}

function updateShapeOverlay() {
  shapeLayerGroup.clearLayers();
  if (!selectedCenter) return;

  const R    = getRadiusMeters();
  const proj = createProjection(selectedCenter.lat, selectedCenter.lng, R);

  let verts;
  if (currentShape === 'circle') {
    // Approximate circle with 64 points
    const pts = [];
    for (let i = 0; i < 64; i++) {
      const angle = (i / 64) * Math.PI * 2;
      const pt = proj.unproject(
        MODEL_RADIUS_MM * Math.cos(angle),
        MODEL_RADIUS_MM * Math.sin(angle)
      );
      pts.push([pt.lat, pt.lng]);
    }
    L.polygon(pts, {
      color:       '#ffffff',
      fillColor:   '#ffffff',
      fillOpacity: 0.08,
      weight:      2,
      dashArray:   '6 4',
    }).addTo(shapeLayerGroup);
    return;
  }

  const geoVerts = getShapeVerticesGeo(proj, currentShape);
  verts = geoVerts.map(v => [v.lat, v.lng]);

  L.polygon(verts, {
    color:       '#000000',
    fillColor:   '#000000',
    fillOpacity: 0.08,
    weight:      2,
    dashArray:   '6 4',
  }).addTo(shapeLayerGroup);
}

function getRadiusMeters()  { return parseFloat(el('radius-slider').value) * 1000; }
function getVertExag()      { return parseFloat(el('vscale-slider').value); }

// ─── Search ───────────────────────────────────────────────────────────────────

async function doSearch() {
  const q = el('search-input').value.trim();
  if (!q) return;

  el('search-results').innerHTML = '';
  setStatus('Searching...', 2);

  try {
    const places = await geocode(q);
    if (!places.length) {
      el('search-results').innerHTML =
        '<div class="search-result-item" style="color:var(--text-muted)">No results found.</div>';
      return;
    }
    for (const place of places.slice(0, 6)) {
      const div = document.createElement('div');
      div.className   = 'search-result-item';
      div.textContent = place.displayName;
      div.addEventListener('click', () => {
        el('search-input').value = place.displayName.split(',')[0].trim();
        el('search-results').innerHTML = '';
        selectLocation(place.lat, place.lng, place.displayName.split(',')[0].trim());
      });
      el('search-results').appendChild(div);
    }
    setStatus('Ready', 0);
  } catch (err) {
    setStatus('Search failed: ' + err.message, 0);
  }
}

// ─── Generation pipeline ──────────────────────────────────────────────────────

async function generate() {
  if (!selectedCenter) return;

  // If already generating, abort the previous run
  if (generating && generateAbort) {
    generateAbort.abort();
  }

  // Rate limit: minimum 3 seconds between generations
  const now = Date.now();
  if (now - lastGenerateTime < 3000) {
    setStatus('Please wait a moment before generating again.', 0);
    return;
  }
  lastGenerateTime = now;
  generating = true;
  generateAbort = new AbortController();
  const thisRun = generateAbort; // capture for stale check

  const genBtn = el('generate-btn');
  genBtn.disabled = true;
  genBtn.classList.add('generating');
  el('export-stl').disabled   = true;
  el('export-3mf').disabled   = true;

  setStatus('Starting generation...', 5);

  try {
    const lat          = selectedCenter.lat;
    const lng          = selectedCenter.lng;
    const radiusMeters = getRadiusMeters();
    const vertExag     = getVertExag();
    const useElevation = el('use-elevation').checked;

    // 1. Projection + shape
    const projection = createProjection(lat, lng, radiusMeters);
    const shapeVerts = getShapeVertices(MODEL_RADIUS_MM, currentShape);
    const bbox       = projection.getBBox(1.15);

    // 2. Fetch OSM data
    setStatus('Fetching OpenStreetMap data...', 10);
    const osmJson = await fetchOSMData(bbox, setStatus);

    // 3. Parse features
    setStatus('Parsing features...', 30);
    const features = parseOSMData(osmJson, projection, shapeVerts);

    const counts = [
      `${features.buildings.length} buildings`,
      `${features.roads.length} roads`,
      `${features.paths.length} paths`,
      `${features.water.length} water`,
      `${features.parks.length} parks`,
    ].join(' · ');
    setStatus(`Parsed: ${counts}`, 35);

    // 4. Elevation (optional)
    let elevGrid = null;
    if (useElevation) {
      setStatus('Fetching elevation data...', 37);
      try {
        elevGrid = await fetchElevation(
          lat, lng, radiusMeters, TERRAIN_GRID_SIZE, setStatus,
        );
        if (elevGrid) {
          setStatus('Elevation data loaded.', 57);
        } else {
          setStatus('Elevation unavailable — flat terrain.', 57);
        }
      } catch {
        setStatus('Elevation failed — flat terrain.', 57);
      }
    }

    // 5. Build 3D model
    setStatus('Building 3D model...', 60);
    const bathymetry        = el('bathymetry')?.checked !== false;
    const detailedBuildings = el('detailed-buildings')?.checked || false;
    const premiumDetail     = el('premium-detail')?.checked || false;
    const terrainRelief     = el('terrain-relief')?.checked || false;
    const featuresToBuild = { ...features, water: bathymetry ? features.water : [] };
    const result = buildMapModel(featuresToBuild, elevGrid, projection, vertExag, setStatus, currentShape, detailedBuildings, premiumDetail, terrainRelief);
    const group = result.group;
    const modelStats = result.stats;

    // 6. Init or update scene
    const canvas      = el('preview-canvas');
    const placeholder = el('preview-placeholder');

    if (!scene) {
      canvas.style.display      = 'block';
      placeholder.style.display = 'none';
      scene = new SceneManager(canvas);
      el('toggle-wireframe').disabled = false;
      el('reset-camera').disabled  = false;
    }

    // Rebuild materials with current color scheme and set model
    scene.rebuildMaterials();
    scene.setModel(group);

    // Update legend
    updateLegend();

    el('order-print').disabled = false;
    el('export-stl').disabled = false;
    el('export-3mf').disabled = false;

    // Show stats
    updateModelStats(modelStats);
    setStatus(`Done — ${modelStats.buildings.toLocaleString()} buildings · ${modelStats.roads.toLocaleString()} roads`, 100);
  } catch (err) {
    // Don't show error if this run was intentionally aborted
    if (thisRun.signal.aborted) return;
    console.error('Generation error:', err);
    setStatus('Error: ' + err.message, 0);
  } finally {
    // Only reset state if this is still the active run
    if (generateAbort === thisRun) {
      generating = false;
      generateAbort = null;
    }
    genBtn.disabled = !selectedCenter;
    genBtn.classList.remove('generating');
  }
}

// ─── Legend update ────────────────────────────────────────────────────────

function updateLegend() {
  const dotBldg  = el('legend-dot-bldg');
  const dotRoad  = el('legend-dot-road');
  const lblBldg  = el('legend-label-bldg');
  const lblRoad  = el('legend-label-road');
  dotBldg.style.background = '#F0F0F0';
  dotRoad.style.background = '#1A1A1A';
  lblBldg.textContent = 'Buildings / Base';
  lblRoad.textContent = 'Roads / Parks / Water';
}

// ─── Model stats ─────────────────────────────────────────────────────────────

function updateModelStats(stats) {
  el('stats-bar').style.display = '';
  el('stat-buildings').textContent = stats.buildings.toLocaleString();
  el('stat-roads').textContent = stats.roads.toLocaleString();
  el('stat-water').textContent = stats.water.toLocaleString();
}

// ─── Region picker ───────────────────────────────────────────────────────────

function showRegionPicker() {
  return new Promise((resolve) => {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#111;border:1px solid #2a2a2a;border-radius:14px;padding:28px;max-width:360px;width:90%;font-family:Inter,system-ui,sans-serif';

    modal.innerHTML = `
      <h3 style="color:#e8e8e8;font-size:16px;margin-bottom:4px">Where are we shipping?</h3>
      <p style="color:#777;font-size:12px;margin-bottom:20px">Select your region for accurate shipping rates</p>
      <div id="region-options" style="display:flex;flex-direction:column;gap:8px"></div>
      <button id="region-cancel" style="width:100%;margin-top:12px;background:transparent;border:1px solid #2a2a2a;border-radius:8px;color:#777;padding:10px;font-family:inherit;font-size:13px;cursor:pointer">Cancel</button>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const options = [
      { region: 'US', label: 'United States', price: 'from $8' },
      { region: 'CA', label: 'Canada', price: '$18' },
      { region: 'INTL', label: 'International', price: '$30' },
    ];

    const container = modal.querySelector('#region-options');
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.style.cssText = 'display:flex;justify-content:space-between;align-items:center;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;color:#e8e8e8;padding:14px 16px;font-family:inherit;font-size:14px;cursor:pointer;transition:all 0.15s';
      btn.innerHTML = `<span style="font-weight:600">${opt.label}</span><span style="color:#777;font-size:13px">${opt.price}</span>`;
      btn.addEventListener('mouseenter', () => { btn.style.borderColor = '#555'; btn.style.background = '#222'; });
      btn.addEventListener('mouseleave', () => { btn.style.borderColor = '#2a2a2a'; btn.style.background = '#1a1a1a'; });
      btn.addEventListener('click', () => {
        document.body.removeChild(overlay);
        resolve(opt.region);
      });
      container.appendChild(btn);
    }

    modal.querySelector('#region-cancel').addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve(null);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
        resolve(null);
      }
    });
  });
}

// ─── Order ───────────────────────────────────────────────────────────────────

async function doOrderPrint() {
  if (!scene?.group || !selectedCenter) return;

  // Ask for shipping region
  const region = await showRegionPicker();
  if (!region) return; // cancelled

  const btn = el('order-print');
  btn.disabled = true;
  setStatus('Creating checkout session...', 90);

  try {
    const resp = await fetch('/api/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: selectedCenter.lat,
        lng: selectedCenter.lng,
        radius: parseFloat(el('radius-slider').value),
        verticalScale: getVertExag(),
        elevation: el('use-elevation').checked,
        terrainRelief: el('terrain-relief')?.checked || false,
        region,
      }),
    });

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      setStatus(`Checkout error: HTTP ${resp.status} — ${text.slice(0, 120) || 'empty response'}`, 0);
      btn.disabled = false;
      return;
    }
    if (data.url) {
      window.location.href = data.url;
    } else {
      setStatus('Checkout error: ' + (data.error || 'Unknown error'), 0);
      btn.disabled = false;
    }
  } catch (err) {
    setStatus('Checkout error: ' + err.message, 0);
    btn.disabled = false;
  }
}

// ─── Export (admin only) ─────────────────────────────────────────────────────

function doExportSTL() {
  if (!scene?.group) return;
  setStatus('Writing STL...', 99);
  exportSTL(scene.group, 'map-model.stl');
  setStatus('STL downloaded.', 100);
}

function doExport3MF() {
  if (!scene?.group) return;
  setStatus('Writing 3MF...', 99);
  export3MF(scene.group, 'map-model.3mf');
  setStatus('3MF downloaded.', 100);
}

// ─── Controls wiring ──────────────────────────────────────────────────────────

function initControls() {
  // Search (debounced to respect Nominatim 1 req/sec policy)
  const searchInput = el('search-input');
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(doSearch, 400);
    }
  });

  // Close search results on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-row') && !e.target.closest('#search-results')) {
      el('search-results').innerHTML = '';
    }
  });

  // Radius slider
  const radiusSlider = el('radius-slider');
  radiusSlider.addEventListener('input', () => {
    const km = parseFloat(radiusSlider.value).toFixed(1);
    el('radius-value').textContent = `${km} km`;
    updateShapeOverlay();
  });

  // Vertical scale slider
  const vscaleSlider = el('vscale-slider');
  vscaleSlider.addEventListener('input', () => {
    el('vscale-value').textContent = `${vscaleSlider.value}x`;
  });

  const priceLabel = el('order-price-label');
  if (priceLabel) priceLabel.textContent = 'Order Print — $35';

  // Generate
  el('generate-btn').addEventListener('click', generate);

  // Order
  el('order-print').addEventListener('click', doOrderPrint);

  // Export (admin only — hidden by default)
  el('export-stl').addEventListener('click', doExportSTL);
  el('export-3mf').addEventListener('click', doExport3MF);

  // Admin login: Ctrl+Shift+E prompts for password, verified server-side
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'E') {
      if (el('export-stl').style.display !== 'none') return; // already unlocked
      const pw = prompt('Admin password:');
      if (!pw) return;
      fetch('/api/admin-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            el('export-stl').style.display = '';
            el('export-3mf').style.display = '';
            setStatus('Admin mode enabled', 0);
          } else {
            setStatus('Invalid admin password', 0);
          }
        })
        .catch(() => setStatus('Admin verification failed', 0));
    }
  });

  // Wireframe toggle
  el('toggle-wireframe').addEventListener('click', () => {
    if (!scene) return;
    const wf = scene.toggleWireframe();
    el('toggle-wireframe').querySelector('svg + *')?.remove;
    // Update button text
    const btn = el('toggle-wireframe');
    const svg = btn.querySelector('svg').outerHTML;
    btn.innerHTML = svg + (wf ? ' Solid' : ' Wireframe');
  });

  // Reset camera
  el('reset-camera').addEventListener('click', () => scene?.resetCamera());
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initControls();

  // Check for URL params (from admin dashboard "Open in Generator" or landing page)
  const params = new URLSearchParams(window.location.search);
  if (params.has('lat') && params.has('lng')) {
    const lat = parseFloat(params.get('lat'));
    const lng = parseFloat(params.get('lng'));
    if (!isNaN(lat) && !isNaN(lng)) {
      // Wait for map to fully initialize before setting location
      setTimeout(() => {
        // Set radius
        if (params.has('radius')) {
          const r = parseFloat(params.get('radius'));
          el('radius-slider').value = r;
          el('radius-value').textContent = r.toFixed(1) + ' km';
        }
        // Set scale
        if (params.has('scale')) {
          const s = parseFloat(params.get('scale'));
          el('vscale-slider').value = s;
          el('vscale-value').textContent = s + 'x';
        }
        // Set elevation
        if (params.has('elevation')) {
          el('use-elevation').checked = params.get('elevation') === 'true';
        }
        // Set terrain relief
        if (params.has('terrainRelief')) {
          const tr = el('terrain-relief');
          if (tr) tr.checked = params.get('terrainRelief') === 'true';
        }
        // Select location and enable generate button
        selectLocation(lat, lng, `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        el('generate-btn').disabled = false;

        // If admin mode, auto-show export buttons
        if (params.get('admin') === '1') {
          el('export-stl').style.display = '';
          el('export-3mf').style.display = '';
          setStatus('Admin mode — generate model then export', 0);
        }
      }, 500);
    }
  } else {
    setStatus('Ready', 0);
  }
});
