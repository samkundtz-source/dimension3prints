/**
 * Map2Model · Main application controller
 *
 * Wires together: Leaflet map → OSM fetch → geometry build → Three.js preview → export
 */

import 'leaflet/dist/leaflet.css';
import './style.css';

import L from 'leaflet';

// Fix Leaflet default marker icon in Vite (asset resolution issue)
import markerIcon    from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x  from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow  from 'leaflet/dist/images/marker-shadow.png';
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow });

import { createProjection, getHexVerticesGeo, getHexVertices, getShapeVertices, getShapeVerticesGeo } from './geo/geoMath.js';
import { geocode, fetchOSMData, parseOSMData, fetchElevation } from './geo/osmData.js';
import { buildMapModel, setInvertedColors } from './geometry/buildMap.js';
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
  L.marker([lat, lng]).addTo(markerLayerGroup);

  // Pan map
  leafletMap.setView([lat, lng], Math.max(leafletMap.getZoom(), 13));

  // Draw shape outline
  updateShapeOverlay();

  // Enable generate
  el('generate-btn').disabled = false;

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
  if (!selectedCenter || generating) return;

  // Rate limit: minimum 3 seconds between generations
  const now = Date.now();
  if (now - lastGenerateTime < 3000) {
    setStatus('Please wait a moment before generating again.', 0);
    return;
  }
  lastGenerateTime = now;
  generating = true;

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
    const invertColors = el('invert-colors').checked;
    setInvertedColors(invertColors);
    const group = buildMapModel(features, elevGrid, projection, vertExag, setStatus, currentShape, invertColors);

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
    updateLegend(invertColors);

    el('order-print').disabled = false;
    el('export-stl').disabled = false;
    el('export-3mf').disabled = false;

    setStatus(`Done — ${counts}`, 100);
  } catch (err) {
    console.error('Generation error:', err);
    setStatus('Error: ' + err.message, 0);
  } finally {
    genBtn.disabled = false;
    genBtn.classList.remove('generating');
    generating = false;
  }
}

// ─── Legend update ────────────────────────────────────────────────────────

function updateLegend(inverted) {
  const dotBldg  = el('legend-dot-bldg');
  const dotRoad  = el('legend-dot-road');
  const lblBldg  = el('legend-label-bldg');
  const lblRoad  = el('legend-label-road');
  if (inverted) {
    dotBldg.style.background = '#1A1A1A';
    dotRoad.style.background = '#F0F0F0';
    lblBldg.textContent = 'Base / Buildings (dark)';
    lblRoad.textContent = 'Roads / Parks / Water (light)';
  } else {
    dotBldg.style.background = '#F0F0F0';
    dotRoad.style.background = '#1A1A1A';
    lblBldg.textContent = 'Buildings / Base';
    lblRoad.textContent = 'Roads / Parks / Water';
  }
}

// ─── Order ───────────────────────────────────────────────────────────────────

async function doOrderPrint() {
  if (!scene?.group || !selectedCenter) return;

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
        invertColors: el('invert-colors').checked,
        colorMode: el('invert-colors').checked ? 'inverted' : 'standard',
      }),
    });

    const data = await resp.json();
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

  // Generate
  el('generate-btn').addEventListener('click', generate);

  // Order
  el('order-print').addEventListener('click', doOrderPrint);

  // Export (admin only — hidden by default)
  el('export-stl').addEventListener('click', doExportSTL);
  el('export-3mf').addEventListener('click', doExport3MF);

  // Admin shortcut: Ctrl+Shift+E reveals export buttons
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'E') {
      el('export-stl').style.display = '';
      el('export-3mf').style.display = '';
      setStatus('Admin: export buttons enabled', 0);
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
  setStatus('Ready', 0);
});
