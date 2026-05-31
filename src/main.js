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
import { geocode, fetchOSMData, parseOSMData, parseMSBuildings, parseOvertureWater, parseOvertureBuildings, resolveOverlaps } from './geo/osmData.js';
import { buildMapModel } from './geometry/buildMap.js';
import { buildMapModelV2 } from './geometry/mapEngine.js';
import { SceneManager }  from './preview/scene.js';
import { exportSTL, export3MF } from './export/exporters.js';
import { MODEL_RADIUS_MM } from './utils/helpers.js';
import { fetchElevationForModel } from './terrain/terrain.js';
import { fetchHiResElevationForModel, checkSuperDetailCoverage } from './geo/elevationData.js';
import { fetchSubway } from './geo/subwayData.js';
import * as THREE from 'three';
import { isTileable, neighborsOf, cellToModelOffset, cellToGeoCenter, validateSelection, priceForTiles, MAX_TILES } from './geo/tileGrid.js';

// ─── Connected-tile selection state ─────────────────────────────────────────
// selectedTiles holds integer cells {a,b}; {0,0} = the anchor (search/click
// location). Empty/[{0,0}] = a normal single-tile model.
let selectedTiles = [{ a: 0, b: 0 }];

// ─── State ────────────────────────────────────────────────────────────────────

let leafletMap      = null;
let shapeLayerGroup = null;
let markerLayerGroup= null;
let scene           = null;

let selectedCenter  = null;   // { lat, lng }
let   currentShape  = 'hexagon';
let   activeOrderId = '';      // order ID for engraving on base bottom
let generating      = false;
let generateId      = 0;      // increments each run — stale runs bail out
let lastGenerateTime = 0;
let searchDebounceTimer = null;
let adminMode       = false;  // unlocked via Ctrl+Shift+E
let adminToken      = '';     // HMAC token returned by /api/admin-verify
let testTerrainMode  = false;  // shown only when adminMode is true
let mountainViewMode = false;  // admin: terrain + roads/rivers only, high relief

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
  selectedTiles = [{ a: 0, b: 0 }];   // new location → reset to single anchor tile

  // Place marker
  markerLayerGroup.clearLayers();
  L.marker([lat, lng], { icon: PIN_ICON }).addTo(markerLayerGroup);

  // Pan map
  leafletMap.setView([lat, lng], Math.max(leafletMap.getZoom(), 13));

  // Draw shape outline + tile grid
  updateShapeOverlay();
  updateTilePrice();

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

  const R      = getRadiusMeters();
  const rotRad = getRotationRad();
  // Rotation is baked into the projection — unproject() applies the inverse
  // rotation, so getShapeVerticesGeo returns the correct rotated outline.
  const proj   = createProjection(selectedCenter.lat, selectedCenter.lng, R, rotRad);

  // Draw every SELECTED tile (filled) + ADDABLE neighbours (dashed), so the
  // user can build a bigger connected map. Circle is single-tile only.
  const tileable = isTileable(currentShape);
  const cells = tileable ? selectedTiles : [{ a: 0, b: 0 }];
  const sel = new Set(cells.map(c => `${c.a},${c.b}`));

  const drawCell = (cell, filled, addable) => {
    const geo = cellToGeoCenter(currentShape, cell, selectedCenter.lat, selectedCenter.lng, R);
    const cproj = createProjection(geo.lat, geo.lng, R, rotRad);
    const cv = getShapeVerticesGeo(cproj, currentShape).map(v => [v.lat, v.lng]);
    const poly = L.polygon(cv, {
      color:       '#000000',
      fillColor:   '#000000',
      fillOpacity: filled ? 0.16 : 0.0,
      weight:      filled ? 2 : 1.5,
      dashArray:   filled ? null : '4 5',
      opacity:     addable ? 0.5 : 0.9,
    }).addTo(shapeLayerGroup);
    if (tileable) {
      poly.on('click', (e) => {
        if (e.originalEvent) L.DomEvent.stop(e);
        toggleTile(cell);
      });
    }
  };

  // selected tiles
  for (const c of cells) drawCell(c, true, false);
  // addable neighbours (not already selected), only if under the cap
  if (tileable && cells.length < MAX_TILES) {
    const seenAdd = new Set();
    for (const c of cells) {
      for (const nb of neighborsOf(currentShape, c)) {
        const k = `${nb.a},${nb.b}`;
        if (sel.has(k) || seenAdd.has(k)) continue;
        seenAdd.add(k);
        drawCell(nb, false, true);
      }
    }
  }
}

// Add a neighbour tile, or remove a selected one (anchor can't be removed).
function toggleTile(cell) {
  if (cell.a === 0 && cell.b === 0) return;   // anchor stays
  const k = `${cell.a},${cell.b}`;
  const idx = selectedTiles.findIndex(c => `${c.a},${c.b}` === k);
  let next;
  if (idx >= 0) {
    next = selectedTiles.filter((_, i) => i !== idx);
  } else {
    if (selectedTiles.length >= MAX_TILES) { setStatus(`Max ${MAX_TILES} tiles.`, 0); return; }
    next = [...selectedTiles, cell];
  }
  // Keep only contiguous selections (removing a middle tile could orphan others)
  const v = validateSelection(currentShape, next);
  if (!v.ok) { setStatus(`Tiles must stay connected.`, 0); return; }
  selectedTiles = next;
  updateShapeOverlay();
  updateTilePrice();
}

// Live tile count + price readout on the Order button + a small label.
function updateTilePrice() {
  const n = isTileable(currentShape) ? selectedTiles.length : 1;
  const price = priceForTiles(n);
  const lbl = el('order-price-label');
  if (lbl) lbl.textContent = n > 1
    ? `Order ${n} tiles — $${price.toFixed(2)}`
    : `Order Print — $${price.toFixed(2)}`;
  const tc = el('tile-count-label');
  if (tc) tc.textContent = isTileable(currentShape)
    ? (n > 1 ? `${n} connected tiles · $${price.toFixed(2)}` : 'Click a dashed tile to extend the map')
    : 'Circle: single tile only';
}

function getRadiusMeters() {
  if (adminMode) return parseFloat(el('admin-radius-slider').value) * 1000;
  return parseFloat(el('radius-slider').value) * 1000;
}
function getVertExag()      { return parseFloat(el('vscale-slider').value); }
function getRotationRad()   { return parseFloat(el('rotation-slider').value) * (Math.PI / 180); }

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

// ─── Connected-tile helpers ────────────────────────────────────────────────

// Build ONE tile (core pipeline: OSM + terrain + engine) at a given geo centre,
// returning its THREE.Group. Used for the EXTRA tiles in a connected map; the
// anchor tile keeps the full generate() path (subway/Overture/etc.). Kept
// deliberately minimal so a connected order is fast and predictable.
async function buildOneTileGroup(cLat, cLng, radiusMeters, vertExag, rotRad, onMsg) {
  const projection = createProjection(cLat, cLng, radiusMeters, rotRad);
  const shapeVerts = getShapeVertices(MODEL_RADIUS_MM, currentShape);
  const bbox = projection.getBBox(1.25);
  const osmJson = await fetchOSMData(bbox, () => {}, adminToken);
  const features = parseOSMData(osmJson, projection, shapeVerts);
  if (Array.isArray(features.buildings) && features.buildings.length > 1) {
    features.buildings = resolveOverlaps(features.buildings);
  }
  let terrainOptions = null;
  try {
    const GRID = 129;
    const elevGrid = await fetchElevationForModel(cLat, cLng, radiusMeters, MODEL_RADIUS_MM, GRID, () => {});
    terrainOptions = { elevGrid, gridSize: GRID };
  } catch { /* flat base fallback */ }
  const result = buildMapModelV2(features, terrainOptions, projection, vertExag, () => {}, currentShape);
  return result.group;
}

// ─── Generation pipeline ──────────────────────────────────────────────────────

async function generate() {
  if (!selectedCenter) return;

  // Rate limit: minimum 3 seconds between generations
  const now = Date.now();
  if (now - lastGenerateTime < 3000) {
    setStatus('Please wait a moment before generating again.', 0);
    return;
  }
  lastGenerateTime = now;
  generating = true;
  const thisRunId = ++generateId; // tag this run so stale ones can bail

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

    // 1. Projection + shape
    // Rotation is baked into the projection — all projected coordinates
    // (buildings, roads, water) are automatically rotated in model space.
    const rotRad     = getRotationRad();
    const projection = createProjection(lat, lng, radiusMeters, rotRad);
    const shapeVerts = getShapeVertices(MODEL_RADIUS_MM, currentShape); // no rotation arg
    const bbox       = projection.getBBox(1.25); // 25% extra margin catches edge buildings

    // Subway / transit mode (admin). In subway-ONLY mode we skip the entire
    // city OSM + terrain pipeline so the radius can go large (whole-metro)
    // without a massive Overpass city fetch timing out.
    const subwayMode        = el('subway-mode')?.checked || false;
    const subwayIncludeCity = el('subway-include-city')?.checked || false;
    const subwayOnly        = subwayMode && !subwayIncludeCity;

    // 2. Fetch OSM data (skipped entirely in subway-only mode)
    let features;
    if (subwayOnly) {
      features = { buildings: [], roads: [], paths: [], water: [], waterways: [], parks: [], trees: [], landuse: [] };
    } else {
      setStatus('Fetching OpenStreetMap data...', 10);
      const osmJson = await fetchOSMData(bbox, setStatus, adminToken);

      // 3. Parse features
      setStatus('Parsing features...', 30);
      features = parseOSMData(osmJson, projection, shapeVerts);

      const counts = [
        `${features.buildings.length} buildings`,
        `${features.roads.length} roads`,
        `${features.paths.length} paths`,
        `${features.water.length} water`,
        `${features.parks.length} parks`,
      ].join(' · ');
      setStatus(`Parsed: ${counts}`, 35);
    }

    // 3a. Overture buildings (admin-only, opt-in via Test Mode radio).
    // Overture supplies real LiDAR-derived building heights and fuller coverage
    // than OSM in many areas.  Requires the OVERTURE_BUILDINGS R2 bucket to be
    // populated; if not, the endpoint returns an empty feature list and we
    // silently fall back to OSM-only buildings.
    const dataSource = document.querySelector('input[name="data-source"]:checked')?.value || 'osm';
    if (!subwayOnly && adminMode && dataSource === 'overture') {
      try {
        setStatus('Fetching Overture buildings…', 36);
        const ovrResp = await fetch('/api/overture-buildings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(projection.getBBox(1.0)),
        });
        if (ovrResp.ok) {
          const ovrData = await ovrResp.json();
          // parseOvertureBuildings returns the FULL merged building list:
          // surviving OSM (those Overture didn't claim) + all Overture polys.
          const merged = parseOvertureBuildings(ovrData.features, projection, shapeVerts, features.buildings);
          const replaced = merged._replacedCount || 0;
          const added    = merged._addedCount    || 0;
          if (added > 0) {
            features.buildings = merged;  // swap the whole set
            setStatus(`Overture: ${replaced} OSM replaced, ${added} Overture polygons total`, 38);
          } else if (ovrData.note) {
            setStatus(`Overture data unavailable (${ovrData.note}) — using OSM only`, 38);
          }
        }
      } catch {
        setStatus('Overture fetch failed — using OSM only', 38);
      }
    }

    // 3b. MS Global Building Footprints (optional toggle)
    const useMsBuildings = (el('ms-buildings')?.checked || false) && !subwayOnly;
    if (useMsBuildings) {
      setStatus('Fetching extended building data…', 38);
      try {
        const bbox = projection.getBBox(1.0);
        const resp = await fetch('/api/ms-buildings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bbox),
        });
        if (resp.ok) {
          const msData = await resp.json();
          const msBuildings = parseMSBuildings(msData.features, projection, shapeVerts, features.buildings);
          if (msBuildings.length > 0) {
            features.buildings.push(...msBuildings);
            setStatus(`Extended data: +${msBuildings.length} buildings`, 40);
          } else {
            setStatus('Extended data: no additional buildings for this area', 40);
          }
        }
      } catch {
        setStatus('Extended data unavailable — using OSM only', 40);
      }
    }

    // 4. Optionally fetch real terrain elevation (test mode or Mountain View)
    let terrainOptions = null;
    const superDetailMode = el('super-detail')?.checked || false;

    // 4a. Super Detail — LiDAR-grade terrain from USGS 3DEP (admin, US coverage).
    //     Falls back to the Terrarium path below if there's no 3DEP coverage.
    if (superDetailMode && !subwayOnly) {
      try {
        setStatus('Checking LiDAR coverage…', 50);
        const cov = await checkSuperDetailCoverage(lat, lng);
        if (!cov.covered) {
          setStatus('No LiDAR coverage here — falling back to standard terrain', 52);
        } else {
          const GRID_SIZE = parseInt(el('super-detail-res')?.value, 10) || 192;
          const elevGrid = await fetchHiResElevationForModel(
            lat, lng, radiusMeters, MODEL_RADIUS_MM, GRID_SIZE,
            msg => setStatus(msg, 55),
          );
          terrainOptions = {
            elevGrid, gridSize: GRID_SIZE, terrainExag: 0,
            mountainView: mountainViewMode, superDetail: true,
          };
          setStatus('LiDAR terrain loaded — super detail…', 58);
        }
      } catch (err) {
        setStatus(`Super Detail failed (${err.message}) — trying standard terrain`, 54);
      }
    }

    // 4b. Standard terrain (Terrarium tiles) — used directly, or as the
    //     graceful fallback when Super Detail has no coverage / fails.
    if (!terrainOptions && !subwayOnly && (testTerrainMode || mountainViewMode || superDetailMode)) {
      try {
        setStatus('Fetching terrain elevation…', 52);
        // Higher grid → more elevation samples → smoother, more detailed terrain.
        // 96×96 ≈ one sample every ~10 m for a 1 km radius — close to tile resolution.
        const GRID_SIZE = 96;
        const elevGrid = await fetchElevationForModel(
          lat, lng, radiusMeters, MODEL_RADIUS_MM, GRID_SIZE,
          msg => setStatus(msg, 55),
        );
        // terrainExag = 0 → buildMap auto-detects the best exaggeration for this area.
        // mountainView flag unlocks higher exaggeration ceiling for dramatic relief.
        terrainOptions = { elevGrid, gridSize: GRID_SIZE, terrainExag: 0, mountainView: mountainViewMode };
        setStatus(mountainViewMode ? 'Terrain loaded — Mountain View mode…' : 'Terrain loaded — auto-scaling relief…', 58);
      } catch (err) {
        setStatus(`Terrain fetch failed (${err.message}) — using flat base`, 58);
      }
    }

    // 4d. Subway / transit network (admin) — fetch railway=subway + stations
    //     directly from Overpass (worker egress is blocked) and project onto
    //     the model. In subway-only mode the city was never fetched.
    if (subwayMode) {
      try {
        const sub = await fetchSubway(bbox, msg => setStatus(msg, 56));
        features.subway = sub.lines.map(l => ({
          points: l.pts.map(([la, lo]) => projection.project(la, lo)),
          colour: l.colour,
        }));
        features.subwayStations = sub.stations.map(s => {
          const p = projection.project(s.lat, s.lng);
          return { x: p.x, y: p.y, name: s.name };
        });
        setStatus(`Subway: ${features.subway.length} segments · ${features.subwayStations.length} stations`, 58);
      } catch (err) {
        setStatus(`Subway fetch failed (${err.message})`, 58);
      }
    }

    // 4c. Resolve overlapping footprints across ALL sources (OSM + Overture +
    //     MS) — removes the stacked/duplicate buildings that z-fight in the
    //     preview. Runs once on the fully-merged list, just before meshing.
    if (Array.isArray(features.buildings) && features.buildings.length > 1) {
      const before = features.buildings.length;
      features.buildings = resolveOverlaps(features.buildings);
      const dropped = before - features.buildings.length;
      if (dropped > 0) setStatus(`Resolved ${dropped} overlapping building${dropped === 1 ? '' : 's'}…`, 59);
    }

    // 5. Build 3D model — terrain-fused engine is the ONLY engine now.
    setStatus('Building 3D model...', 60);
    // Always drape onto real elevation (fusion is the whole point): if no
    // terrain was fetched above, pull a Terrarium grid now.
    if (!terrainOptions) {
      try {
        setStatus('Fetching terrain elevation…', 52);
        const GRID = 129;
        const elevGrid = await fetchElevationForModel(
          lat, lng, radiusMeters, MODEL_RADIUS_MM, GRID, m => setStatus(m, 55),
        );
        terrainOptions = { elevGrid, gridSize: GRID };
      } catch (err) {
        setStatus(`Terrain unavailable (${err.message}) — using flat base`, 56);
      }
    }
    const result = buildMapModelV2(features, terrainOptions, projection, vertExag, setStatus, currentShape);
    let group = result.group;
    const modelStats = result.stats;

    // ── Connected tiles: build extra selected tiles and offset them so they
    //    abut the anchor as one bigger uniform map. Only for tileable shapes
    //    (square grid / hex honeycomb); circle is single-tile only.
    const extraCells = (isTileable(currentShape) ? selectedTiles : [])
      .filter(c => !(c.a === 0 && c.b === 0))
      .slice(0, MAX_TILES - 1);
    if (extraCells.length > 0) {
      const combined = new THREE.Group();
      combined.add(group); // anchor at origin
      let tileNum = 1;
      for (const cell of extraCells) {
        if (thisRunId !== generateId) break; // a newer run started — bail
        tileNum++;
        setStatus(`Connected map: building tile ${tileNum}/${extraCells.length + 1}…`, 60 + Math.round(35 * tileNum / (extraCells.length + 1)));
        try {
          const geo = cellToGeoCenter(currentShape, cell, lat, lng, radiusMeters);
          const tileGroup = await buildOneTileGroup(geo.lat, geo.lng, radiusMeters, vertExag, rotRad);
          const off = cellToModelOffset(currentShape, cell);
          tileGroup.position.set(off.x, 0, -off.y); // model→scene: y stays, x→x, y→-z
          combined.add(tileGroup);
        } catch (e) {
          console.error('tile build failed', cell, e);
        }
      }
      group = combined;
    }

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
    if (modelStats.isAllWater) {
      setStatus('Done — this area is open water (no land features).  Try a location closer to shore.', 100);
    } else {
      setStatus(`Done — ${modelStats.buildings.toLocaleString()} buildings · ${modelStats.roads.toLocaleString()} roads`, 100);
    }
  } catch (err) {
    // Only show error if this is still the active run
    if (thisRunId === generateId) {
      console.error('Generation error:', err);
      setStatus('Error: ' + err.message, 0);
    }
  } finally {
    // Only reset generating flag if this is still the active run
    if (thisRunId === generateId) {
      generating = false;
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
  lblRoad.textContent = 'Roads';
}

// ─── Model stats ─────────────────────────────────────────────────────────────

function updateModelStats(stats) {
  el('stats-bar').style.display = '';
  el('stat-buildings').textContent = stats.buildings.toLocaleString();
  el('stat-roads').textContent = stats.roads.toLocaleString();
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

  // Check order availability first
  const btn = el('order-print');
  btn.disabled = true;
  setStatus('Checking availability...', 85);

  try {
    const availResp = await fetch('/api/order-availability', { method: 'POST' });
    const avail = await availResp.json();
    if (avail.limitReached) {
      if (!avail.preOrderEnabled) {
        setStatus('Orders are currently closed. Please check back later.', 0);
        btn.disabled = false;
        return;
      }
      // Show pre-order confirmation
      const msg = avail.preOrderMessage || 'This will be a pre-order and may take longer to ship.';
      if (!confirm(`Order limit reached (${avail.orderCount}/${avail.orderLimit}).\n\n${msg}\n\nWould you like to place a pre-order?`)) {
        setStatus('Pre-order cancelled.', 0);
        btn.disabled = false;
        return;
      }
    }
  } catch {
    // If availability check fails, proceed anyway
  }

  // Ask for shipping region
  const region = await showRegionPicker();
  if (!region) { btn.disabled = false; return; } // cancelled

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
        detailedBuildings: el('detailed-buildings')?.checked || false,
        terrainRelief:     el('terrain-relief')?.checked     || false,
        elevation:         el('test-terrain-enabled')?.checked || false,
        roadElevation:     el('road-elevation')?.checked     || false,
        shape:             currentShape,
        rotation: parseFloat(el('rotation-slider')?.value || '0'),
        region,
        tileCount: isTileable(currentShape) ? selectedTiles.length : 1,
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
  // Search. Enter jumps straight to the best match (so it "goes to the place").
  // Typing also shows a debounced dropdown of options — but only after a 600 ms
  // pause and ≥3 chars, which keeps requests well under the geocode rate limit
  // (the previous 350 ms / 2-char setting hammered it and caused 429s).
  // Search — wired via EVENT DELEGATION on document so it can never be
  // orphaned if the #search-input node is re-rendered after init (that was
  // the bug: a direct listener silently stopped firing). Delegated listeners
  // live on document, which is never replaced, so search always works.
  document.addEventListener('input', (e) => {
    if (!e.target || e.target.id !== 'search-input') return;
    clearTimeout(searchDebounceTimer);
    const q = e.target.value.trim();
    const resEl = el('search-results');
    if (q.length < 2) { if (resEl) resEl.innerHTML = ''; return; }
    searchDebounceTimer = setTimeout(doSearch, 350);
  });
  document.addEventListener('keydown', async (e) => {
    if (!e.target || e.target.id !== 'search-input' || e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(searchDebounceTimer);
    const q = e.target.value.trim();
    if (!q) return;
    setStatus('Searching…', 2);
    try {
      const places = await geocode(q);
      if (!places.length) { setStatus('No results found', 0); return; }
      const p = places[0];
      const label = p.displayName.split(',')[0].trim();
      const inp = el('search-input'); if (inp) inp.value = label;
      const resEl = el('search-results'); if (resEl) resEl.innerHTML = '';
      selectLocation(p.lat, p.lng, label);
    } catch (err) {
      setStatus('Search failed: ' + err.message, 0);
    }
  });

  // Close search results on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-row') && !e.target.closest('#search-results')) {
      const resEl = el('search-results'); if (resEl) resEl.innerHTML = '';
    }
  });

  // Radius slider (hidden, default 1km for regular users)
  const radiusSlider = el('radius-slider');
  radiusSlider.addEventListener('input', () => {
    const km = parseFloat(radiusSlider.value).toFixed(1);
    el('radius-value').textContent = `${km} km`;
    updateShapeOverlay();
  });

  // Admin radius slider (shown only in admin mode, up to 10km)
  const adminRadiusSlider = el('admin-radius-slider');
  adminRadiusSlider.addEventListener('input', () => {
    const km = parseFloat(adminRadiusSlider.value).toFixed(1);
    el('admin-radius-display').textContent = `${km} km`;
    updateShapeOverlay();
  });

  // Rotation slider
  const rotationSlider = el('rotation-slider');
  rotationSlider.addEventListener('input', () => {
    el('rotation-value').textContent = `${rotationSlider.value}°`;
    updateShapeOverlay();
  });

  // Vertical scale slider
  const vscaleSlider = el('vscale-slider');
  vscaleSlider.addEventListener('input', () => {
    el('vscale-value').textContent = `${vscaleSlider.value}x`;
  });

  // Shape selector
  const shapeSelector = el('shape-selector');
  if (shapeSelector) {
    shapeSelector.addEventListener('click', e => {
      const btn = e.target.closest('.shape-btn');
      if (!btn) return;
      const shape = btn.dataset.shape;
      if (shape === currentShape) return;
      currentShape = shape;
      selectedTiles = [{ a: 0, b: 0 }];   // shape change → reset connected tiles
      shapeSelector.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateShapeOverlay();
      updateTilePrice();
    });
  }

  const priceLabel = el('order-price-label');
  if (priceLabel) priceLabel.textContent = 'Order Print — $29.99';

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
            adminMode  = true;
            adminToken = data.token || '';
            el('export-stl').style.display = '';
            el('export-3mf').style.display = '';
            el('admin-radius-section').style.display = '';
            el('test-mode-section').style.display = '';
            setStatus('Admin mode enabled — Test Mode available in Settings', 0);
          } else {
            setStatus('Invalid admin password', 0);
          }
        })
        .catch(() => setStatus('Admin verification failed', 0));
    }
  });

  // Super Detail (LiDAR terrain) toggle + resolution slider + live coverage check
  el('super-detail')?.addEventListener('change', async e => {
    const on = e.target.checked;
    el('super-detail-options').style.display = on ? '' : 'none';
    const covEl = el('super-detail-coverage');
    if (on && covEl && selectedCenter) {
      covEl.textContent = 'Checking LiDAR coverage…';
      const cov = await checkSuperDetailCoverage(selectedCenter.lat, selectedCenter.lng);
      covEl.textContent = cov.covered
        ? `✓ LiDAR available here (ground ≈ ${Math.round(cov.value)} m)`
        : '✕ No LiDAR coverage — will use standard terrain';
      covEl.style.color = cov.covered ? '#34d399' : 'var(--text-dim)';
    } else if (on && covEl) {
      covEl.textContent = 'Pick a location to check coverage.';
      covEl.style.color = 'var(--text-dim)';
    }
  });
  el('super-detail-res')?.addEventListener('input', () => {
    el('super-detail-res-val').textContent = el('super-detail-res').value;
  });

  // Subway / Transit mode toggle — reveal the "include city" sub-option
  el('subway-mode')?.addEventListener('change', e => {
    const row = el('subway-city-row');
    if (row) row.style.display = e.target.checked ? '' : 'none';
  });

  // Test mode terrain toggle + exaggeration slider
  el('test-terrain-enabled').addEventListener('change', e => {
    testTerrainMode = e.target.checked;
    el('test-terrain-options').style.display = testTerrainMode ? '' : 'none';
    // Mountain View row only visible when terrain is on
    el('mountain-view-row').style.display = testTerrainMode ? '' : 'none';
    // If terrain is turned off, also turn off Mountain View
    if (!testTerrainMode) {
      mountainViewMode = false;
      el('mountain-view-enabled').checked = false;
    }
  });
  el('test-terrain-exag').addEventListener('input', () => {
    el('test-terrain-exag-val').textContent = parseFloat(el('test-terrain-exag').value).toFixed(2) + '×';
  });

  // Mountain View toggle — boosts radius to 5 km for mountain-scale captures
  el('mountain-view-enabled')?.addEventListener('change', e => {
    mountainViewMode = e.target.checked;
    if (mountainViewMode) {
      // Bump admin radius slider to 5 km so you capture the whole mountain
      const slider  = el('admin-radius-slider');
      const display = el('admin-radius-display');
      if (slider && parseFloat(slider.value) < 5) {
        slider.value = '5';
        if (display) display.textContent = '5.0 km';
        updateShapeOverlay();
      }
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
        // Set rotation
        if (params.has('rotation')) {
          const deg = parseFloat(params.get('rotation'));
          if (!isNaN(deg)) {
            const rs = el('rotation-slider');
            if (rs) { rs.value = deg; el('rotation-value').textContent = `${deg}°`; }
          }
        }
        // Set park hills (formerly terrain-relief)
        if (params.has('terrainRelief')) {
          const tr = el('terrain-relief');
          if (tr) tr.checked = params.get('terrainRelief') === 'true';
        }
        // Set detailed buildings
        if (params.has('detailedBuildings')) {
          const db = el('detailed-buildings');
          if (db) db.checked = params.get('detailedBuildings') === 'true';
        }
        // Set road elevation
        if (params.has('roadElevation')) {
          const re = el('road-elevation');
          if (re) re.checked = params.get('roadElevation') === 'true';
        }
        // Set shape
        if (params.has('shape')) {
          const s = params.get('shape');
          const validShapes = ['hexagon', 'square', 'circle'];
          if (validShapes.includes(s)) {
            currentShape = s;
            const sel = el('shape-selector');
            if (sel) {
              sel.querySelectorAll('.shape-btn').forEach(b => b.classList.toggle('active', b.dataset.shape === s));
            }
          }
        }
        // Select location and enable generate button
        selectLocation(lat, lng, `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        el('generate-btn').disabled = false;

        // Read order ID if passed from admin dashboard (engraved on model base).
        // Validated: strip to alphanumerics + hyphens, 20 char max.
        if (params.has('orderId')) {
          const raw = String(params.get('orderId')).slice(0, 20);
          activeOrderId = /^[A-Za-z0-9\-]+$/.test(raw) ? raw : '';
        }

        // NOTE: ?admin=1 URL param activation was removed — it allowed anyone to
        // bypass the Ctrl+Shift+E password prompt and unlock admin UI (10 km radius,
        // export buttons) without authentication.  Admin mode now ALWAYS requires the
        // server-verified password (Ctrl+Shift+E).
      }, 500);
    }
  } else {
    setStatus('Ready', 0);
  }

  // ── Mobile tab navigation ────────────────────────────────────────────────────
  // Runs inside DOMContentLoaded so all elements exist.
  // Lives in this module script (not an inline <script>) so it isn't blocked
  // by the page's Content-Security-Policy (script-src 'self').

  if (window.innerWidth <= 768) {
    initMobile();
  }

  document.querySelectorAll('.mob-tab').forEach(btn => {
    btn.addEventListener('click', () => mobTab(btn, btn.dataset.panel));
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      // Restore desktop — undo all mobile overrides
      document.querySelector('.sidebar')?.classList.remove('mob-hidden');
      document.querySelector('.preview-area')?.classList.remove('mob-active');
      document.querySelectorAll('.mob-loc-panel, .sidebar-map, .sidebar-settings, .sidebar-actions')
        .forEach(e => e.style.display = '');
    } else {
      initMobile();
    }
  });
});

// ── Mobile helpers (called from DOMContentLoaded above) ──────────────────────

function mobTab(btn, panel) {
  if (window.innerWidth > 768) return;
  document.querySelectorAll('.mob-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  applyMobLayout(panel);
}

function applyMobLayout(panel) {
  const sidebar    = document.querySelector('.sidebar');
  const preview    = document.querySelector('.preview-area');
  const locPanels  = document.querySelectorAll('.mob-loc-panel, .sidebar-map');
  const setPanel   = document.querySelector('.sidebar-settings');
  const adminPanel = document.getElementById('admin-radius-section');
  const actions    = document.querySelector('.sidebar-actions');

  if (panel === 'location') {
    sidebar.classList.remove('mob-hidden');
    preview.classList.remove('mob-active');
    locPanels.forEach(e => e.style.display = '');
    if (setPanel) setPanel.style.display = 'none';
    if (actions)  actions.style.display  = '';
    // Nudge Leaflet to repaint tiles after map container is revealed
    setTimeout(() => window.dispatchEvent(new Event('resize')), 80);
  } else if (panel === 'settings') {
    sidebar.classList.remove('mob-hidden');
    preview.classList.remove('mob-active');
    locPanels.forEach(e => e.style.display = 'none');
    if (setPanel)   setPanel.style.display = '';
    if (adminPanel) adminPanel.style.display = adminPanel.dataset.adminVisible === '1' ? '' : 'none';
    if (actions)    actions.style.display   = '';
  } else {
    sidebar.classList.add('mob-hidden');
    preview.classList.add('mob-active');
  }
}

function initMobile() {
  // Hide settings section so we start on the Location sub-view
  const setPanel = document.querySelector('.sidebar-settings');
  if (setPanel) setPanel.style.display = 'none';

  // Tapping Generate auto-switches to Preview so user sees progress
  const genBtn = el('generate-btn');
  if (genBtn && !genBtn._mobListener) {
    genBtn._mobListener = true;
    genBtn.addEventListener('click', () => {
      if (window.innerWidth > 768) return;
      const tab = el('mob-preview-tab');
      if (tab) mobTab(tab, 'preview');
    });
  }
}
