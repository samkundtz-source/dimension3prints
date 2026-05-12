/**
 * OSM data pipeline — rewritten to use the classic, universally-supported
 * Overpass format: `out body; >; out skel qt;`
 *
 * The `out body geom` approach has inconsistent behaviour across servers.
 * This approach guarantees node coordinates are always available.
 */

import { deduplicateRing, ensureCCW, ensureCW } from '../utils/helpers.js';
import { clipToHex } from './clipper.js';

// ─── Geocoding ────────────────────────────────────────────────────────────────

export async function geocode(query) {
  const resp = await fetch('/api/geocode', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Geocoding failed (${resp.status})`);
  }
  const data = await resp.json();
  return data.map(r => ({
    displayName: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }));
}

// ─── Overpass API (proxied through worker, with direct fallback) ──────────────

// Mirrors for direct browser → Overpass fallback (used when the CF Worker
// can't reach Overpass, e.g. egress-IP blocks or CF-side timeouts).
const OVERPASS_DIRECT = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

function buildDirectQuery(south, west, north, east) {
  const bb = `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`;
  return `[out:json][timeout:30][maxsize:33554432];
(
  way["building"](${bb});
  way["building:part"](${bb});
  relation["building"](${bb});
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street)$"](${bb});
  way["natural"~"^(water|wetland)$"](${bb});
  way["water"](${bb});
  way["waterway"="riverbank"](${bb});
  way["waterway"~"^(river|canal|stream|drain|ditch)$"](${bb});
  way["landuse"~"^(reservoir|basin)$"](${bb});
  way["natural"="coastline"](${bb});
  relation["natural"="water"](${bb});
  relation["waterway"="riverbank"](${bb});
  way["leisure"~"^(park|garden|nature_reserve|golf_course|pitch|playground|common)$"](${bb});
  relation["leisure"~"^(park|nature_reserve|garden)$"](${bb});
  way["landuse"~"^(park|forest|grass|meadow|recreation_ground|village_green|cemetery|allotments|residential|commercial|industrial|retail|mixed|civic)$"](${bb});
  way["natural"~"^(wood|scrub|grassland|heath)$"](${bb});
);
out body;
>;
out skel qt;`;
}

async function fetchOSMDirect(bbox, onProgress) {
  onProgress?.('Trying direct data source…', 15);
  const query    = buildDirectQuery(bbox.south, bbox.west, bbox.north, bbox.east);
  const bodyStr  = `data=${encodeURIComponent(query)}`;

  const attempts = OVERPASS_DIRECT.map(async server => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 35000);
    try {
      const resp = await fetch(server, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    bodyStr,
        signal:  ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (!Array.isArray(json.elements)) throw new Error('bad response');
      return json;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });

  const json = await Promise.any(attempts);
  onProgress?.('Processing map data…', 30);
  return json;
}

export async function fetchOSMData(bbox, onProgress, adminToken = '') {
  onProgress?.('Querying map data…', 12);
  const body = adminToken ? { ...bbox, adminToken } : bbox;

  let workerFailed = false;
  try {
    const resp = await fetch('/api/osm-data', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (resp.ok) {
      const json = await resp.json();
      if (Array.isArray(json.elements)) {
        onProgress?.('Processing map data…', 30);
        return json;
      }
    }
    // 503 from worker = Overpass unreachable from CF; fall through to direct
    if (resp.status === 503) {
      workerFailed = true;
    } else {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Map data error (${resp.status}). Please try again.`);
    }
  } catch (e) {
    // Network failure reaching the worker itself → also try direct
    if (!workerFailed) {
      if (e.message?.includes('Map data error') || e.message?.includes('Unexpected')) throw e;
      workerFailed = true;
    }
  }

  // Fallback: browser queries Overpass directly (bypasses CF egress IPs)
  try {
    return await fetchOSMDirect(bbox, onProgress);
  } catch {
    throw new Error('Map data servers are unavailable. Please check your connection and try again.');
  }
}

// ─── OSM Parser ───────────────────────────────────────────────────────────────

/**
 * Convert raw Overpass JSON into classified, projected, hex-clipped features.
 *
 * Step 1: Index ALL nodes by ID (from `out skel qt` output).
 * Step 2: For each way, resolve geometry via node-ID → lat/lon lookup.
 * Step 3: Classify, project to model-mm, clip to hex.
 */
export function parseOSMData(json, projection, hexVertices) {
  // ── 1. Build node lookup ──────────────────────────────────────────────────
  const nodeMap = new Map();

  for (const el of json.elements) {
    if (el.type === 'node' && el.lat != null && el.lon != null) {
      nodeMap.set(el.id, el);
    }
  }

  console.log(`[Parser] nodeMap size: ${nodeMap.size}`);

  // ── 2. Build way lookup for relation resolution ───────────────────────────
  const wayMap = new Map();
  for (const el of json.elements) {
    if (el.type === 'way') wayMap.set(el.id, el);
  }

  // ── 3. Parse ways ─────────────────────────────────────────────────────────
  const features = { buildings: [], roads: [], paths: [], water: [], waterways: [], parks: [], trees: [], landuse: [] };
  let totalWays = 0, skippedNoCoords = 0, skippedUnclassified = 0, skippedClipped = 0;
  const processedWayIds = new Set();

  // Standalone tree nodes (natural=tree)
  for (const el of json.elements) {
    if (el.type !== 'node') continue;
    const tags = el.tags;
    if (!tags || tags.natural !== 'tree') continue;
    const pt = projection.project(el.lat, el.lon);
    if (!pointInHexSimple(pt, hexVertices)) continue;
    features.trees.push({ x: pt.x, y: pt.y, tags });
  }

  for (const el of json.elements) {
    if (el.type !== 'way') continue;
    totalWays++;

    const coords = resolveWayCoords(el, nodeMap, projection);

    if (coords.length < 2) {
      skippedNoCoords++;
      continue;
    }

    const tags = el.tags || {};
    const type = classifyTags(tags);

    if (!type) {
      skippedUnclassified++;
      continue;
    }

    const osmId = `way/${el.id}`;
    const added = addFeature(type, coords, tags, hexVertices, features, osmId);
    if (!added) skippedClipped++;
    else processedWayIds.add(el.id);
  }

  // ── 4. Parse relations (multipolygons) ────────────────────────────────────
  let totalRelations = 0, relationsAdded = 0;

  for (const el of json.elements) {
    if (el.type !== 'relation') continue;
    totalRelations++;

    const tags = el.tags || {};
    const type = classifyTags(tags);
    if (!type) continue;

    // Only handle multipolygon relations for area features
    if (type === 'road' || type === 'path') continue;

    // Collect outer and inner rings from relation members
    const outerWays = [];
    const innerWays = [];

    for (const member of (el.members || [])) {
      if (member.type !== 'way') continue;
      const way = wayMap.get(member.ref);
      if (!way) continue;

      const coords = resolveWayCoords(way, nodeMap, projection);
      if (coords.length < 2) continue;

      if (member.role === 'inner') {
        innerWays.push(coords);
      } else {
        outerWays.push(coords);
      }
    }

    // Merge outer ways into closed rings
    const outerRings = mergeWaysIntoRings(outerWays);
    const innerRings = mergeWaysIntoRings(innerWays);

    for (const ring of outerRings) {
      if (ring.length < 3) continue;
      const ccw = ensureCCW(deduplicateRing(ring));
      const clipped = clipToHex(ccw, hexVertices);
      if (!clipped || clipped.length < 3) continue;

      const bucket = type === 'building' ? features.buildings
                   : type === 'water'    ? features.water
                   : type === 'landuse'  ? features.landuse
                                         : features.parks;
      bucket.push({ polygon: clipped, holes: innerRings.filter(h => h.length >= 3), tags, osmId: `relation/${el.id}` });
      relationsAdded++;
    }
  }

  // ── 5. Build sea polygons from coastlines ─────────────────────────────────
  // OSM does not tag oceans as natural=water — they are the negative space
  // outside natural=coastline ways.  We sample a grid across the hex and
  // classify each cell as LAND or SEA using the OSM convention (LAND on the
  // LEFT of the chain direction, computed via signed cross product against
  // the nearest coastline segment).  This avoids any polygon-winding guesswork
  // that broke earlier coastline approaches.
  let seaPolyCount = 0;
  if (features._coastlines && features._coastlines.length > 0) {
    const seaPolys = buildSeaPolysFromCoastlines(features._coastlines, hexVertices);
    for (const p of seaPolys) features.water.push(p);
    seaPolyCount = seaPolys.length;
  }
  delete features._coastlines;

  console.log(
    `[Parser] ${totalWays} ways + ${totalRelations} relations → ` +
    `buildings:${features.buildings.length} ` +
    `roads:${features.roads.length} ` +
    `paths:${features.paths.length} ` +
    `water:${features.water.length} (${seaPolyCount} from coastlines) ` +
    `waterways:${features.waterways.length} ` +
    `parks:${features.parks.length} ` +
    `trees:${features.trees.length} ` +
    `| relations added: ${relationsAdded}` +
    `| skipped: noCoords=${skippedNoCoords} unclassified=${skippedUnclassified} clipped=${skippedClipped}`
  );

  return features;
}

// ── Resolve way geometry from node map ───────────────────────────────────────

function resolveWayCoords(way, nodeMap, projection) {
  if (!way.nodes || way.nodes.length === 0) return [];

  const coords = [];
  for (const id of way.nodes) {
    const node = nodeMap.get(id);
    if (!node) continue; // node missing (outside bbox edge case)
    coords.push(projection.project(node.lat, node.lon));
  }
  return coords;
}

// ── Tag classification ────────────────────────────────────────────────────────

const ROAD_TYPES = new Set([
  'motorway','motorway_link','trunk','trunk_link',
  'primary','primary_link','secondary','secondary_link',
  'tertiary','tertiary_link','unclassified','residential',
  'service','living_street','road',
]);
const PATH_TYPES = new Set([
  'footway','path','cycleway','steps','pedestrian','bridleway','track',
]);
const GREEN_LANDUSE = new Set([
  'park','forest','grass','meadow','recreation_ground',
  'village_green','cemetery','allotments',
]);
const INFILL_LANDUSE = new Set([
  'residential','commercial','industrial','retail','mixed','civic',
]);
const GREEN_LEISURE = new Set([
  'park','garden','pitch','playground','nature_reserve','golf_course',
]);
const GREEN_NATURAL = new Set(['wood','scrub','grassland','heath']);

function classifyTags(tags) {
  if (!tags) return null;

  if (tags.building || tags['building:part']) return 'building';

  if (tags.highway) {
    if (ROAD_TYPES.has(tags.highway)) return 'road';
    if (PATH_TYPES.has(tags.highway)) return 'path';
    // Treat any unrecognised highway value as a road so we don't miss streets
    return 'road';
  }

  // natural=bay/strait/lagoon are intentionally NOT classified as water — they
  // are huge OSM polygons (e.g. "Upper New York Bay" covers the entire harbor)
  // that clip to ugly rectangles in city-scale prints.
  if (tags.natural === 'water' || tags.water || tags.landuse === 'reservoir' ||
      tags.landuse === 'basin' || tags.natural === 'wetland' ||
      tags.waterway === 'riverbank' || tags.waterway === 'dock') {
    return 'water';
  }

  // Coastline ways are open chains (LAND on LEFT, SEA on RIGHT in OSM
  // convention).  We collect them and use a per-cell cross-product test
  // later to build sea polygons.
  if (tags.natural === 'coastline') return 'coastline';

  // Linear waterways (rivers, streams, canals) — these are lines, not polygons
  if (tags.waterway) {
    return 'waterway';
  }

  if (GREEN_LANDUSE.has(tags.landuse) ||
      GREEN_LEISURE.has(tags.leisure) ||
      GREEN_NATURAL.has(tags.natural)) {
    return 'park';
  }

  if (INFILL_LANDUSE.has(tags.landuse)) return 'landuse';

  return null;
}

// ── Add feature to bucket ─────────────────────────────────────────────────────

/** Returns true if the feature was added, false if it was rejected/clipped. */
function addFeature(type, coords, tags, hexVertices, features, osmId) {
  const isArea = type === 'building' || type === 'water' || type === 'park' || type === 'landuse';
  const isLine = type === 'road' || type === 'path' || type === 'waterway' || type === 'coastline';

  if (isArea) {
    // Need a closed ring with at least 3 unique points
    const ring = deduplicateRing(coords);
    if (ring.length < 3) return false;

    const ccw     = ensureCCW(ring);
    const clipped = clipToHex(ccw, hexVertices);
    if (!clipped || clipped.length < 3) return false;

    const bucket = type === 'building' ? features.buildings
                 : type === 'water'    ? features.water
                 : type === 'landuse'  ? features.landuse
                                       : features.parks;
    bucket.push({ polygon: clipped, holes: [], tags, osmId: osmId || '' });
    return true;

  } else if (isLine) {
    if (coords.length < 2) return false;
    if (type === 'waterway') {
      features.waterways.push({ points: coords, tags });
    } else if (type === 'coastline') {
      if (!features._coastlines) features._coastlines = [];
      features._coastlines.push(coords);
    } else {
      const bucket = type === 'road' ? features.roads : features.paths;
      bucket.push({ points: coords, tags });
    }
    return true;
  }

  return false;
}

// ─── Overture Maps building parser ───────────────────────────────────────────
// Converts GeoJSON building features from /api/overture-buildings into the
// same {polygon, holes, tags} format as features.buildings entries.
//
// Overture buildings carry richer attributes than OSM:
//   properties.height       — building height in metres (LiDAR-derived)
//   properties.num_floors   — building stories
//   properties.class        — building category (residential/commercial/etc)
//   properties.subtype      — finer-grained type
//   properties.names.primary — building name (for landmarks)
//
// We map these into OSM-style tags so the existing parseBuildingHeight()
// and building-class machinery work without modification.

export function parseOvertureBuildings(geojsonFeatures, projection, hexVertices, existingBuildings) {
  // ── Spatial index of OSM building centroids (with mutable matched flag) ──
  // For each Overture polygon we find ALL OSM buildings whose centroid sits
  // inside the Overture footprint's bbox and mark them for replacement.  This
  // handles the common case where OSM has split a complex landmark (e.g.
  // Burj Khalifa's petal base) into many sub-polygons that Overture represents
  // as one — the previous augment-only approach updated only one of them and
  // left the rest at OSM's wrong heights, producing visible "wings stacked at
  // different heights" artefacts.
  const CELL = 50; // mm cell — ~660 m at 1 km hex radius
  const osmEntries = (existingBuildings || []).map(ref => {
    let cx = 0, cy = 0;
    for (const p of ref.polygon) { cx += p.x; cy += p.y; }
    return { ref, matched: false, cx: cx / ref.polygon.length, cy: cy / ref.polygon.length };
  });
  const grid = new Map();
  function cellKey(i, j) { return `${i},${j}`; }
  for (const e of osmEntries) {
    const k = cellKey(Math.floor(e.cx / CELL), Math.floor(e.cy / CELL));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(e);
  }
  function findOsmInBbox(minX, minY, maxX, maxY) {
    const matches = [];
    const i0 = Math.floor(minX / CELL), i1 = Math.floor(maxX / CELL);
    const j0 = Math.floor(minY / CELL), j1 = Math.floor(maxY / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cell = grid.get(cellKey(i, j));
        if (!cell) continue;
        for (const e of cell) {
          if (e.cx >= minX && e.cx <= maxX && e.cy >= minY && e.cy <= maxY) matches.push(e);
        }
      }
    }
    return matches;
  }

  const overturePolys = [];
  let replacedCount = 0;

  for (const feat of (geojsonFeatures || [])) {
    const geom = feat?.geometry;
    if (!geom) continue;

    const rings = geom.type === 'Polygon'      ? [geom.coordinates[0]]
                : geom.type === 'MultiPolygon' ? geom.coordinates.map(p => p[0])
                : [];

    const props = feat.properties || {};
    const ovrHeight = (typeof props.height === 'number' && props.height > 0) ? String(props.height) : null;
    const ovrLevels = (typeof props.num_floors === 'number' && props.num_floors > 0) ? String(props.num_floors) : null;
    const ovrName   = props.names?.primary || (Array.isArray(props.names?.common) ? props.names.common[0]?.value : null);
    const ovrClass  = props.class || props.subtype || null;

    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      // GeoJSON coordinates are [lng, lat]
      const coords = ring.map(([lng, lat]) => projection.project(lat, lng));
      const deduped = deduplicateRing(coords);
      if (deduped.length < 3) continue;

      // Polygon bbox in model space
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of deduped) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }

      const osmMatches = findOsmInBbox(minX, minY, maxX, maxY);

      // Build merged tags.  Overture's class/height/levels/name win, but we
      // carry over critical OSM identifiers (wikidata, wikipedia, name) and
      // the OSM osmId itself so the landmark registry can still recognise
      // famous buildings like Burj Khalifa (Q12495 / way/263884958) and apply
      // their preset geometry — otherwise replacing OSM with Overture's
      // anonymous polygon would lose every landmark identification.
      const tags = { building: ovrClass || 'yes' };
      if (ovrHeight) tags.height = ovrHeight;
      if (ovrLevels) tags['building:levels'] = ovrLevels;
      if (ovrName) tags.name = ovrName;
      let inheritedOsmId = null;
      // Walk matches in order — for tags that carry over, the FIRST OSM
      // building with the value wins.
      for (const m of osmMatches) {
        const t = m.ref.tags || {};
        if (!tags.height && !tags['building:levels']) {
          if (t.height)              tags.height = t.height;
          if (t['building:levels'])  tags['building:levels'] = t['building:levels'];
        }
        if (!tags.name && t.name)             tags.name = t.name;
        if (!tags.wikidata && t.wikidata)     tags.wikidata = t.wikidata;
        if (!tags.wikipedia && t.wikipedia)   tags.wikipedia = t.wikipedia;
        if (!inheritedOsmId && m.ref.osmId)   inheritedOsmId = m.ref.osmId;
      }

      // Mark all matched OSM buildings for removal.  Multiple Overture polys
      // may claim the same OSM victim — only count it once.
      for (const m of osmMatches) {
        if (!m.matched) { m.matched = true; replacedCount++; }
      }

      const ccw     = ensureCCW(deduped);
      const clipped = clipToHex(ccw, hexVertices);
      if (!clipped || clipped.length < 3) continue;

      // Use the inherited OSM osmId if any, so landmark-by-way-id matching
      // continues to work (e.g. way/263884958 → burjKhalifa preset).
      overturePolys.push({
        polygon: clipped,
        holes:   [],
        tags,
        osmId:   inheritedOsmId || feat.id || 'overture',
      });
    }
  }

  // Return MERGED list: surviving OSM (those not replaced) + all Overture polys.
  // main.js does features.buildings = result so the entire building set swaps.
  const survivingOsm = osmEntries.filter(e => !e.matched).map(e => e.ref);
  const result = [...survivingOsm, ...overturePolys];
  result._replacedCount = replacedCount;
  result._addedCount    = overturePolys.length;
  return result;
}

// ─── Overture Maps water polygon parser ──────────────────────────────────────
// Converts GeoJSON features from the /api/overture-water endpoint into the
// same format as features.water (polygons), so they can be merged in.
//
// Overture's `base` theme tags water bodies — including OCEANS — as proper
// polygons (unlike OSM where the ocean is the negative space outside
// natural=coastline ways).  For coastal locations this gives clean ocean
// coverage without our coastline-stitching machinery.

export function parseOvertureWater(geojsonFeatures, projection, hexVertices) {
  const polys = [];
  for (const feat of (geojsonFeatures || [])) {
    const geom = feat?.geometry;
    if (!geom) continue;

    // Overture water features can be Polygon or MultiPolygon.  We only use
    // the outer ring; inner rings (holes for islands) are dropped because
    // extrudeSlab doesn't support holes — the island surface above the water
    // slab handles that visually.
    const rings = geom.type === 'Polygon'      ? [geom.coordinates[0]]
                : geom.type === 'MultiPolygon' ? geom.coordinates.map(p => p[0])
                : [];

    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      // GeoJSON coordinates are [lng, lat]
      const coords = ring.map(([lng, lat]) => projection.project(lat, lng));
      const deduped = deduplicateRing(coords);
      if (deduped.length < 3) continue;

      const ccw     = ensureCCW(deduped);
      const clipped = clipToHex(ccw, hexVertices);
      if (!clipped || clipped.length < 3) continue;

      const tags = {
        natural: 'water',
        water:   feat.properties?.subtype || feat.properties?.class || 'overture',
      };
      polys.push({ polygon: clipped, holes: [], tags, osmId: feat.id || 'overture' });
    }
  }
  return polys;
}

// ─── Microsoft Global Building Footprints parser ─────────────────────────────
// Converts GeoJSON features from the /api/ms-buildings endpoint into the same
// format as parseOSMData output, so they can be merged into features.buildings.

export function parseMSBuildings(geojsonFeatures, projection, hexVertices, existingBuildings) {
  // Build a quick centroid-bbox lookup of existing OSM buildings to skip dupes.
  const existing = (existingBuildings || []).map(b => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of b.polygon) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, maxX, minY, maxY };
  });

  function overlapsExisting(cx, cy) {
    for (const b of existing) {
      if (cx >= b.minX && cx <= b.maxX && cy >= b.minY && cy <= b.maxY) return true;
    }
    return false;
  }

  const buildings = [];
  for (const feat of (geojsonFeatures || [])) {
    const geom = feat?.geometry;
    if (!geom) continue;

    const rings = geom.type === 'Polygon'      ? [geom.coordinates[0]]
                : geom.type === 'MultiPolygon' ? geom.coordinates.map(p => p[0])
                : [];

    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      // GeoJSON coordinates are [lng, lat]
      const coords = ring.map(([lng, lat]) => projection.project(lat, lng));
      const deduped = deduplicateRing(coords);
      if (deduped.length < 3) continue;

      // Skip if centroid falls inside an existing OSM building's bbox
      let cx = 0, cy = 0;
      for (const p of deduped) { cx += p.x; cy += p.y; }
      cx /= deduped.length; cy /= deduped.length;
      if (overlapsExisting(cx, cy)) continue;

      const ccw = ensureCCW(deduped);
      const clipped = clipToHex(ccw, hexVertices);
      if (!clipped || clipped.length < 3) continue;

      buildings.push({ polygon: clipped, holes: [], tags: {}, osmId: '' });
    }
  }
  return buildings;
}

// ─── Ring merging for relations ──────────────────────────────────────────────

/**
 * Merge an array of way coordinate arrays into closed rings.
 * Ways sharing endpoints get joined head-to-tail until a ring closes.
 */
function mergeWaysIntoRings(ways) {
  if (ways.length === 0) return [];

  const rings = [];
  const remaining = ways.map(w => [...w]);

  while (remaining.length > 0) {
    let current = remaining.shift();

    let changed = true;
    while (changed) {
      changed = false;
      const first = current[0];
      const last  = current[current.length - 1];

      // Check if ring is already closed
      if (current.length >= 4 &&
          Math.abs(first.x - last.x) < 0.01 &&
          Math.abs(first.y - last.y) < 0.01) {
        break;
      }

      for (let i = 0; i < remaining.length; i++) {
        const way = remaining[i];
        const wFirst = way[0];
        const wLast  = way[way.length - 1];

        if (ptClose(last, wFirst)) {
          current = current.concat(way.slice(1));
          remaining.splice(i, 1);
          changed = true;
          break;
        } else if (ptClose(last, wLast)) {
          current = current.concat([...way].reverse().slice(1));
          remaining.splice(i, 1);
          changed = true;
          break;
        } else if (ptClose(first, wLast)) {
          current = way.concat(current.slice(1));
          remaining.splice(i, 1);
          changed = true;
          break;
        } else if (ptClose(first, wFirst)) {
          current = [...way].reverse().concat(current.slice(1));
          remaining.splice(i, 1);
          changed = true;
          break;
        }
      }
    }

    if (current.length >= 3) rings.push(current);
  }

  return rings;
}

function ptClose(a, b) {
  return Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05;
}

// ─── Coastline → sea-polygon construction ─────────────────────────────────────
//
// OSM coastlines are open polylines: LAND on LEFT, SEA on RIGHT relative to
// node order.  Each chain crossing the hex needs to be "closed" with hex
// boundary edges to form a sea polygon.  The right closure direction (CW vs
// CCW around the hex) depends on which way the chain enters and exits, and
// guessing wrong encloses LAND instead of sea (the bug from the very first
// coastline attempt).
//
// Solution: build BOTH candidate closures, then pick the one whose interior
// is the sea side of the chain.  At the chain's midpoint, the perpendicular-
// right of the tangent points into the sea (OSM convention, Y-up math
// coordinates).  Sample a point a few mm in that direction; the candidate
// polygon that contains it is the sea polygon.  Robust to any winding
// without hard-coded direction assumptions.
//
// Result: SMOOTH water edges that follow the actual OSM coastline geometry,
// not stair-stepped grid cells.

function buildSeaPolysFromCoastlines(coastlines, hexVerts) {
  const chains = mergeWaysIntoRings(coastlines).filter(c => c.length >= 2);
  if (chains.length === 0) return [];

  const polys = [];

  for (const chain of chains) {
    const first = chain[0];
    const last  = chain[chain.length - 1];

    // Closed chain (island ring): LAND inside, SEA outside.  Proper handling
    // would render the hex with the island as a polygon hole; skip for now.
    // Tiny islands inside larger sea regions just appear submerged, which is
    // acceptable at the scales we print.
    if (ptClose(first, last)) continue;

    // Sea-direction sample point: perpendicular-right of the tangent at the
    // chain midpoint, offset 3 mm into the sea.  Math conv (Y up): perp-right
    // of vector (tx,ty) is (ty,-tx).
    const midI = Math.floor(chain.length / 2);
    const a = chain[Math.max(0, midI - 1)];
    const b = chain[Math.min(chain.length - 1, midI + 1)];
    const tx = b.x - a.x, ty = b.y - a.y;
    const tlen = Math.hypot(tx, ty);
    if (tlen < 1e-6) continue;
    const OFFSET_MM = 3;
    const seaPt = {
      x: chain[midI].x + ( ty / tlen) * OFFSET_MM,
      y: chain[midI].y + (-tx / tlen) * OFFSET_MM,
    };

    // Build both candidate closures and pick the one containing seaPt
    const candA = closeChainWithHex(chain, hexVerts, 'ccw');
    const candB = closeChainWithHex(chain, hexVerts, 'cw');
    let chosen = null;
    if (candA && pointInPolygonGeneral(seaPt, candA)) chosen = candA;
    else if (candB && pointInPolygonGeneral(seaPt, candB)) chosen = candB;
    if (!chosen) continue;

    const ccw     = ensureCCW(deduplicateRing(chosen));
    const clipped = clipToHex(ccw, hexVerts);
    if (!clipped || clipped.length < 3) continue;

    polys.push({
      polygon: clipped,
      holes:   [],
      tags:    { natural: 'water', water: 'sea' },
      osmId:   'coastline-derived',
    });
  }

  return polys;
}

// Walk the hex boundary from chain.last back to chain.first in the given
// direction, picking up corner vertices along the way.  Returns a closed
// polygon: chain points + hex corners + back to chain.first.
function closeChainWithHex(chain, hexVerts, direction) {
  const N = hexVerts.length;
  const first = chain[0];
  const last  = chain[chain.length - 1];

  const startLoc = locateOnHexEdge(first, hexVerts);
  const endLoc   = locateOnHexEdge(last,  hexVerts);

  const corners = [];
  if (direction === 'ccw') {
    let steps = (startLoc.edge - endLoc.edge + N) % N;
    if (steps === 0 && endLoc.t >= startLoc.t) steps = N;
    for (let s = 0; s < steps; s++) {
      corners.push(hexVerts[(endLoc.edge + 1 + s) % N]);
    }
  } else {
    let steps = (endLoc.edge - startLoc.edge + N) % N;
    if (steps === 0 && startLoc.t >= endLoc.t) steps = N;
    for (let s = 0; s < steps; s++) {
      corners.push(hexVerts[(endLoc.edge - s + N) % N]);
    }
  }

  return [...chain, ...corners, first];
}

// Project a point onto the nearest hex edge; return { edge, t } where edge
// is the CCW index of that edge and t ∈ [0,1] is the parameter along it.
function locateOnHexEdge(pt, hexVerts) {
  const N = hexVerts.length;
  let bestEdge = 0, bestT = 0, bestDist = Infinity;
  for (let i = 0; i < N; i++) {
    const a = hexVerts[i], b = hexVerts[(i + 1) % N];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) continue;
    let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = a.x + t * dx - pt.x;
    const qy = a.y + t * dy - pt.y;
    const dist = qx * qx + qy * qy;
    if (dist < bestDist) { bestDist = dist; bestEdge = i; bestT = t; }
  }
  return { edge: bestEdge, t: bestT };
}

// General (non-convex) point-in-polygon via even-odd ray casting.
function pointInPolygonGeneral(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Convex polygon point-in-polygon (CCW). */
function pointInHexSimple(pt, hexVerts) {
  for (let i = 0, n = hexVerts.length; i < n; i++) {
    const a = hexVerts[i];
    const b = hexVerts[(i + 1) % n];
    if ((b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x) < -1e-6) return false;
  }
  return true;
}
