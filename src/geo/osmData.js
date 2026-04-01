/**
 * OSM data pipeline — rewritten to use the classic, universally-supported
 * Overpass format: `out body; >; out skel qt;`
 *
 * The `out body geom` approach has inconsistent behaviour across servers.
 * This approach guarantees node coordinates are always available.
 */

import { deduplicateRing, ensureCCW, ensureCW } from '../utils/helpers.js';
import { clipToHex } from './clipper.js';
import { buildElevationSampleGrid } from './geoMath.js';

// ─── Geocoding ────────────────────────────────────────────────────────────────

export async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=6`;
  const resp = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'Cities3ds/0.3 (https://cities3ds.com)' } });
  if (!resp.ok) throw new Error(`Nominatim: HTTP ${resp.status}`);
  const data = await resp.json();
  return data.map(r => ({
    displayName: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }));
}

// ─── Overpass API ─────────────────────────────────────────────────────────────

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

/**
 * Classic two-step query:
 *   `out body` → way tags + node-ID lists
 *   `>; out skel qt` → all referenced nodes with lat/lon
 *
 * This format works on every Overpass instance without exception.
 */
function buildQuery(bbox) {
  const { south, west, north, east } = bbox;
  const bb = `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`;

  return `[out:json][timeout:120];
(
  way["building"](${bb});
  way["highway"](${bb});
  way["natural"="water"](${bb});
  way["waterway"~"^(river|stream|canal|drain)$"](${bb});
  way["water"](${bb});
  way["leisure"~"^(park|garden|pitch|playground|nature_reserve)$"](${bb});
  way["landuse"~"^(park|forest|grass|meadow|recreation_ground|village_green|cemetery)$"](${bb});
  way["natural"~"^(wood|scrub|grassland|heath)$"](${bb});
  relation["natural"="water"](${bb});
  relation["water"](${bb});
  relation["waterway"](${bb});
  relation["leisure"~"^(park|garden|pitch|playground|nature_reserve)$"](${bb});
  relation["landuse"~"^(park|forest|grass|meadow|recreation_ground|village_green|cemetery)$"](${bb});
  relation["building"](${bb});
);
out body;
>;
out skel qt;`;
}

export async function fetchOSMData(bbox, onProgress) {
  const query = buildQuery(bbox);

  let lastErr;
  for (const server of OVERPASS_SERVERS) {
    try {
      const host = server.replace('https://', '').split('/')[0];
      onProgress?.(`Querying ${host}…`, 12);

      const resp = await fetch(server, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const json = await resp.json();
      if (!Array.isArray(json.elements)) throw new Error('No elements array in response');

      console.log(`[Overpass] ${json.elements.length} raw elements from ${host}`);
      return json;
    } catch (err) {
      console.warn(`[Overpass] ${server} failed:`, err.message);
      lastErr = err;
    }
  }
  throw new Error(`All Overpass servers failed. Last error: ${lastErr?.message}`);
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
  const features = { buildings: [], roads: [], paths: [], water: [], parks: [] };
  let totalWays = 0, skippedNoCoords = 0, skippedUnclassified = 0, skippedClipped = 0;
  const processedWayIds = new Set();

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

    const added = addFeature(type, coords, tags, hexVertices, features);
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
                                         : features.parks;
      bucket.push({ polygon: clipped, holes: innerRings.filter(h => h.length >= 3), tags });
      relationsAdded++;
    }
  }

  console.log(
    `[Parser] ${totalWays} ways + ${totalRelations} relations → ` +
    `buildings:${features.buildings.length} ` +
    `roads:${features.roads.length} ` +
    `paths:${features.paths.length} ` +
    `water:${features.water.length} ` +
    `parks:${features.parks.length} ` +
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

  if (tags.waterway || tags.natural === 'water' || tags.landuse === 'reservoir') {
    return 'water';
  }

  if (GREEN_LANDUSE.has(tags.landuse) ||
      GREEN_LEISURE.has(tags.leisure) ||
      GREEN_NATURAL.has(tags.natural)) {
    return 'park';
  }

  return null;
}

// ── Add feature to bucket ─────────────────────────────────────────────────────

/** Returns true if the feature was added, false if it was rejected/clipped. */
function addFeature(type, coords, tags, hexVertices, features) {
  const isArea = type === 'building' || type === 'water' || type === 'park';
  const isLine = type === 'road' || type === 'path';

  if (isArea) {
    // Need a closed ring with at least 3 unique points
    const ring = deduplicateRing(coords);
    if (ring.length < 3) return false;

    const ccw     = ensureCCW(ring);
    const clipped = clipToHex(ccw, hexVertices);
    if (!clipped || clipped.length < 3) return false;

    const bucket = type === 'building' ? features.buildings
                 : type === 'water'    ? features.water
                                       : features.parks;
    bucket.push({ polygon: clipped, holes: [], tags });
    return true;

  } else if (isLine) {
    if (coords.length < 2) return false;
    const bucket = type === 'road' ? features.roads : features.paths;
    bucket.push({ points: coords, tags });
    return true;
  }

  return false;
}

// ─── Elevation ────────────────────────────────────────────────────────────────

const OPENTOPODATA = 'https://api.opentopodata.org/v1/srtm30m';

export async function fetchElevation(centerLat, centerLng, radiusMeters, N, onProgress) {
  const gridPts = buildElevationSampleGrid(centerLat, centerLng, radiusMeters, N);
  const results = new Float32Array(N * N);
  const BATCH   = 100;
  const batches = [];
  for (let s = 0; s < gridPts.length; s += BATCH) batches.push(gridPts.slice(s, s + BATCH));

  for (let b = 0; b < batches.length; b++) {
    const batch  = batches[b];
    const locStr = batch.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');
    onProgress?.(`Elevation ${b + 1}/${batches.length}…`, 38 + Math.round(b / batches.length * 18));

    try {
      const resp = await fetch(`${OPENTOPODATA}?locations=${locStr}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      data.results?.forEach((r, i) => {
        const pt = batch[i];
        results[pt.j * N + pt.i] = r.elevation ?? 0;
      });
    } catch (err) {
      console.warn('[Elevation] batch failed:', err.message);
      return null; // fall back to flat terrain
    }

    if (b < batches.length - 1) await sleep(1150); // respect 1 req/sec
  }

  // Normalise: shift so minimum = 0
  let min = Infinity;
  for (const v of results) if (v < min) min = v;
  for (let i = 0; i < results.length; i++) results[i] -= min;

  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
