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
// OSM coastlines are open polylines (LAND on LEFT, SEA on RIGHT, with respect
// to node order).  We can't reliably "close" them into polygons via the hex
// boundary because winding direction depends on which way the chain enters
// vs exits the hex — the previous attempt got that wrong.
//
// Instead: rasterise the hex into a grid, classify each cell against the
// nearest coastline segment using the signed cross product, then collapse
// consecutive sea cells in each row into a single rectangular water polygon.
// This is convention-direction-agnostic (the sign of the cross product picks
// the correct side every time) and handles complex coastlines (peninsulas,
// estuaries, multiple disconnected chains) automatically.

function buildSeaPolysFromCoastlines(coastlines, hexVerts) {
  // Stitch coastline ways into longer chains where they share endpoints
  const chains = mergeWaysIntoRings(coastlines).filter(c => c.length >= 2);
  if (chains.length === 0) return [];

  // Precompute flat list of segments with bbox + cross-product setup
  const segs = [];
  for (const chain of chains) {
    for (let k = 0; k < chain.length - 1; k++) {
      const a = chain[k], b = chain[k + 1];
      const sx = b.x - a.x, sy = b.y - a.y;
      const len2 = sx * sx + sy * sy;
      if (len2 < 1e-10) continue;
      segs.push({ ax: a.x, ay: a.y, sx, sy, len2 });
    }
  }
  if (segs.length === 0) return [];

  // Hex bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of hexVerts) {
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
  }

  // 64×64 grid → ~16 mm cells in a 1 km hex.  Fine enough for clean prints,
  // coarse enough that we generate ≤ ~64 strip polygons total.
  const GRID = 64;
  const dx = (maxX - minX) / GRID;
  const dy = (maxY - minY) / GRID;
  const cells = new Uint8Array(GRID * GRID); // 1 = sea

  for (let j = 0; j < GRID; j++) {
    const cy = minY + (j + 0.5) * dy;
    for (let i = 0; i < GRID; i++) {
      const cx = minX + (i + 0.5) * dx;
      if (!pointInHexSimple({ x: cx, y: cy }, hexVerts)) continue;

      // Find nearest segment and remember its signed cross product
      let bestD2 = Infinity;
      let bestCross = 0;
      for (const s of segs) {
        let t = ((cx - s.ax) * s.sx + (cy - s.ay) * s.sy) / s.len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const qx = s.ax + t * s.sx;
        const qy = s.ay + t * s.sy;
        const d2 = (cx - qx) * (cx - qx) + (cy - qy) * (cy - qy);
        if (d2 < bestD2) {
          bestD2 = d2;
          // Cross product (b-a) × (p-a).  Math convention (Y up):
          //   > 0 → P on LEFT of chain direction → LAND
          //   < 0 → P on RIGHT → SEA
          bestCross = s.sx * (cy - s.ay) - s.sy * (cx - s.ax);
        }
      }
      if (bestCross < 0) cells[j * GRID + i] = 1;
    }
  }

  // Run-length encode each row into rectangular strips.  Adjacent sea cells
  // in the same row become one polygon, drastically cutting polygon count.
  const polys = [];
  for (let j = 0; j < GRID; j++) {
    let i = 0;
    while (i < GRID) {
      if (cells[j * GRID + i] !== 1) { i++; continue; }
      let end = i + 1;
      while (end < GRID && cells[j * GRID + end] === 1) end++;

      const x0 = minX + i * dx;
      const x1 = minX + end * dx;
      const y0 = minY + j * dy;
      const y1 = minY + (j + 1) * dy;

      const rect = [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ];

      const ccw     = ensureCCW(rect);
      const clipped = clipToHex(ccw, hexVerts);
      if (clipped && clipped.length >= 3) {
        polys.push({
          polygon: clipped,
          holes:   [],
          tags:    { natural: 'water', water: 'sea' },
          osmId:   'coastline-derived',
        });
      }
      i = end;
    }
  }

  return polys;
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
