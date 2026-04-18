/**
 * 3D model assembly — generates buildings FIRST, then fits roads around them.
 *
 * Output: exactly 3 meshes (no more):
 *   1. 'base'     — white base plate + terrain (1 mesh)
 *   2. 'building' — white buildings (1 mesh)
 *   3. 'road'     — black roads + paths + parks + water (1 mesh)
 *
 * Roads that overlap buildings are shrunk to fit rather than disappearing.
 * All geometry is solid (no hollow or degenerate triangles).
 */

import * as THREE from 'three';
import earcut from 'earcut';

import {
  MODEL_RADIUS_MM,
  BASE_THICKNESS_MM,
  LAYER,
  ROAD_WIDTHS_M,
  ROAD_MIN_VISUAL_HALF_MM,
  MIN_BUILDING_HEIGHT_MM,
  NOZZLE_MM,
  signedArea2D,
  ensureCCW,
  ensureCW,
  deduplicateRing,
  bilinearInterp,
  clamp,
} from '../utils/helpers.js';
import { getHexVertices, getShapeVertices } from '../geo/geoMath.js';
import { clipToHex, bufferLinestring } from '../geo/clipper.js';
import { landmarkRegistry, generateLandmarkBuilding } from './landmarkPresets.js';

// ─── Colours ──────────────────────────────────────────────────────────────────
// Preview uses a neutral gray palette so buildings read with depth and shadow.
// The exported STL/3MF is uncoloured — slicer assigns filament colours.
export const FEATURE_COLORS = {
  base:     0xC8C8C8,
  terrain:  0xC8C8C8,
  building: 0xB0B0B0,
  water:    0x1A1A1A,
  park:     0x1A1A1A,
  road:     0x1A1A1A,
  path:     0x1A1A1A,
};

export function setInvertedColors(inverted) {
  if (inverted) {
    FEATURE_COLORS.base     = 0x1A1A1A;
    FEATURE_COLORS.terrain  = 0x1A1A1A;
    FEATURE_COLORS.building = 0x1A1A1A;
    FEATURE_COLORS.water    = 0xF0F0F0;
    FEATURE_COLORS.park     = 0xF0F0F0;
    FEATURE_COLORS.road     = 0xF0F0F0;
    FEATURE_COLORS.path     = 0xF0F0F0;
  } else {
    FEATURE_COLORS.base     = 0xF0F0F0;
    FEATURE_COLORS.terrain  = 0xF0F0F0;
    FEATURE_COLORS.building = 0xF0F0F0;
    FEATURE_COLORS.water    = 0x1A1A1A;
    FEATURE_COLORS.park     = 0x1A1A1A;
    FEATURE_COLORS.road     = 0x1A1A1A;
    FEATURE_COLORS.path     = 0x1A1A1A;
  }
}

// ─── Geometry accumulator ────────────────────────────────────────────────────

class GeomAccumulator {
  constructor() {
    this.positions = [];
    this.indices   = [];
    this.vertCount = 0;
  }

  add(posArray, idxArray) {
    const base = this.vertCount;
    for (let i = 0; i < posArray.length; i++) this.positions.push(posArray[i]);
    for (let i = 0; i < idxArray.length;  i++) this.indices.push(idxArray[i] + base);
    this.vertCount += posArray.length / 3;
  }

  build(featureType) {
    if (this.positions.length === 0 || this.indices.length === 0) return null;

    // Filter degenerate triangles (near-zero area)
    const pos = this.positions;
    const cleanIdx = [];
    for (let i = 0; i < this.indices.length; i += 3) {
      const i0 = this.indices[i], i1 = this.indices[i+1], i2 = this.indices[i+2];
      if (i0 === i1 || i1 === i2 || i0 === i2) continue;
      const ax = pos[i0*3], ay = pos[i0*3+1], az = pos[i0*3+2];
      const bx = pos[i1*3], by = pos[i1*3+1], bz = pos[i1*3+2];
      const cx = pos[i2*3], cy = pos[i2*3+1], cz = pos[i2*3+2];
      // Cross product magnitude = 2 * triangle area
      const ux = bx-ax, uy = by-ay, uz = bz-az;
      const vx = cx-ax, vy = cy-ay, vz = cz-az;
      const area2 = Math.sqrt(
        (uy*vz-uz*vy)**2 + (uz*vx-ux*vz)**2 + (ux*vy-uy*vx)**2
      );
      if (area2 > 1e-6) {
        cleanIdx.push(i0, i1, i2);
      }
    }

    if (cleanIdx.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(pos), 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array(cleanIdx), 1));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo);
    mesh.userData.featureType = featureType;
    return mesh;
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────

// Bilinear sample of the elevation grid at an arbitrary (x, y) in mm.
// Returns mm of terrain elevation above the base plate. 0 if outside grid.
function sampleTerrainElev(x, y, elevGrid, N, vScale) {
  if (!elevGrid || N < 2) return 0;
  const fi = ((x / MODEL_RADIUS_MM + 1) / 2) * (N - 1);
  const fj = ((y / MODEL_RADIUS_MM + 1) / 2) * (N - 1);
  if (fi < 0 || fi > N - 1 || fj < 0 || fj > N - 1) return 0;
  const i = Math.max(0, Math.min(N - 2, Math.floor(fi)));
  const j = Math.max(0, Math.min(N - 2, Math.floor(fj)));
  const u = fi - i;
  const v = fj - j;
  const e00 = elevGrid[j * N + i];
  const e10 = elevGrid[j * N + (i + 1)];
  const e01 = elevGrid[(j + 1) * N + i];
  const e11 = elevGrid[(j + 1) * N + (i + 1)];
  const e = e00 * (1 - u) * (1 - v) + e10 * u * (1 - v) + e01 * (1 - u) * v + e11 * u * v;
  return clamp(e * vScale, 0, 40);
}

export function buildMapModel(features, elevGrid, projection, vertExag, onProgress, shape = 'hexagon', detailedBuildings = false, premiumDetail = false, terrainRelief = false, orderId = '') {
  const group = new THREE.Group();

  const hexFull  = getShapeVertices(MODEL_RADIUS_MM, shape);
  const hexInner = getShapeVertices(MODEL_RADIUS_MM - 5, shape);

  const hScale = projection.horizontalScale;
  const vScale = hScale * vertExag;
  const N      = elevGrid ? Math.round(Math.sqrt(elevGrid.length)) : 0;

  // ── 3 combined accumulators — everything merges into these ────────────────
  const baseAcc     = new GeomAccumulator();  // base plate + terrain + pit walls → white
  const buildingAcc = new GeomAccumulator();  // all buildings → white
  const blackAcc    = new GeomAccumulator();  // roads + water floors → black

  // ── 0. Pre-collect water polygons ─────────────────────────────────────────
  const waterPolys  = [];
  for (const feat of (features.water || [])) {
    const poly = clipToHex(feat.polygon, hexInner);
    if (!poly || poly.length < 3) continue;
    if (Math.abs(signedArea2D(poly)) < 1.0) continue; // skip puddles < 1 mm²
    waterPolys.push(poly);
  }
  const hasWater    = waterPolys.length > 0;

  // ── Constants ─────────────────────────────────────────────────────────────
  const BASE        = BASE_THICKNESS_MM; // always 1.5 mm — solid, never changes
  const ROAD_HEIGHT = NOZZLE_MM * 1.0;  // 0.4mm — bold ridge for clean printing
  const CLEARANCE   = 2.0; // gap around buildings — wider = cleaner road edges

  // ── 1. Base plate — always a simple solid prism ───────────────────────────
  onProgress?.('Building base plate…', 65);
  collectHexBase(baseAcc, hexFull, premiumDetail ? 0.8 : 0);

  // ── 2. Terrain ────────────────────────────────────────────────────────────
  if (elevGrid && N > 0) {
    onProgress?.('Building terrain…', 68);
    collectTerrainMesh(baseAcc, elevGrid, N, hexFull, vScale, BASE);
  }

  // Road types to render — skip noise (footway, path, cycleway, steps, service)
  const ROAD_TYPES = new Set([
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
  ]);

  // ── Terrain-aware base Y helper ──────────────────────────────────────────
  // Returns the Y position for any feature, sitting on the terrain when relief is on.
  const canRelief = terrainRelief && elevGrid && N > 0;
  function terrainBaseY(cx, cy) {
    if (!canRelief) return BASE;
    return BASE + sampleTerrainElev(cx, cy, elevGrid, N, vScale);
  }
  function polyTerrainBaseY(poly) {
    if (!canRelief) return BASE;
    let cx = 0, cy = 0;
    for (const p of poly) { cx += p.x; cy += p.y; }
    cx /= poly.length;
    cy /= poly.length;
    return BASE + sampleTerrainElev(cx, cy, elevGrid, N, vScale);
  }

  // ── 3. Pre-collect building footprints ────────────────────────────────────
  // Buildings are generated FIRST so roads can fit around them.
  onProgress?.('Collecting building footprints…', 70);
  const buildingFootprints = [];

  for (const feat of features.buildings) {
    const poly = clipToHex(feat.polygon, hexInner);
    if (!poly || poly.length < 3) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    buildingFootprints.push({
      polygon: poly,
      holes: feat.holes,
      tags: feat.tags,
      osmId: feat.osmId || '',
      bbox: {
        minX: minX - CLEARANCE, maxX: maxX + CLEARANCE,
        minY: minY - CLEARANCE, maxY: maxY + CLEARANCE,
      },
    });
  }

  // ── Spatial grid: O(1) building lookup instead of O(N) scan ───────────────
  // Big speedup for dense cities (was O(roads * buildings) overlap check)
  const GRID_CELL = 8; // mm per cell
  const GRID_SIZE = Math.ceil((MODEL_RADIUS_MM * 2) / GRID_CELL) + 2;
  const GRID_OFFSET = MODEL_RADIUS_MM + GRID_CELL;
  const buildingGrid = new Array(GRID_SIZE * GRID_SIZE);
  function gridKey(cx, cy) { return cy * GRID_SIZE + cx; }
  function gridCell(x, y) {
    return [
      Math.floor((x + GRID_OFFSET) / GRID_CELL),
      Math.floor((y + GRID_OFFSET) / GRID_CELL),
    ];
  }
  for (let bi = 0; bi < buildingFootprints.length; bi++) {
    const bf = buildingFootprints[bi];
    const [c0x, c0y] = gridCell(bf.bbox.minX, bf.bbox.minY);
    const [c1x, c1y] = gridCell(bf.bbox.maxX, bf.bbox.maxY);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        if (cx < 0 || cy < 0 || cx >= GRID_SIZE || cy >= GRID_SIZE) continue;
        const k = gridKey(cx, cy);
        if (!buildingGrid[k]) buildingGrid[k] = [];
        buildingGrid[k].push(bi);
      }
    }
  }

  /**
   * True if the polygon should be suppressed because it sits inside a building
   * or a ring of buildings. Uses four independent detection strategies so it
   * catches single-ring buildings, multipolygon courtyards, AND multi-segment
   * ring structures (e.g. the Colosseum made of many building:part ways).
   */
  function enclosedByAnyBuilding(poly) {
    // ── Precompute park/water bbox and centroid ──────────────────────────
    let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity;
    let cx = 0, cy = 0;
    for (const p of poly) {
      if (p.x < pMinX) pMinX = p.x;
      if (p.x > pMaxX) pMaxX = p.x;
      if (p.y < pMinY) pMinY = p.y;
      if (p.y > pMaxY) pMaxY = p.y;
      cx += p.x; cy += p.y;
    }
    cx /= poly.length;
    cy /= poly.length;

    // ── Test 1: Park bbox fully inside a single building bbox ───────────
    for (const bf of buildingFootprints) {
      if (bf.bbox.minX <= pMinX && bf.bbox.maxX >= pMaxX &&
          bf.bbox.minY <= pMinY && bf.bbox.maxY >= pMaxY) {
        return true;
      }
    }

    // ── Test 2: Centroid inside a building's hole polygon ───────────────
    // For multipolygon buildings, OSM stores the courtyard as an inner ring.
    // If the park centroid is inside that hole, it's in the courtyard.
    for (const bf of buildingFootprints) {
      if (!bf.holes || bf.holes.length === 0) continue;
      for (const hole of bf.holes) {
        if (!hole || hole.length < 3) continue;
        if (pointInSimplePolygon({ x: cx, y: cy }, hole)) return true;
      }
    }

    // ── Test 3: Multiple buildings surround the park ────────────────────
    // For ring structures made of many building segments (building:part),
    // no single bbox contains the park. Instead, check if the park's
    // perimeter vertices are covered by building bboxes from all sides.
    // Divide vertices into 4 quadrants around the centroid. If 3+ quadrants
    // have at least one vertex inside a building bbox, the park is enclosed.
    const quadCovered = [false, false, false, false]; // NE, NW, SW, SE
    for (const p of poly) {
      const qi = (p.y < cy ? 2 : 0) + (p.x < cx ? 1 : 0); // quadrant index
      if (quadCovered[qi]) continue; // already found coverage here

      // Use spatial grid for efficient lookup
      const [pgx, pgy] = gridCell(p.x, p.y);
      if (pgx < 0 || pgy < 0 || pgx >= GRID_SIZE || pgy >= GRID_SIZE) continue;
      const bucket = buildingGrid[gridKey(pgx, pgy)];
      if (!bucket) continue;
      for (const bi of bucket) {
        const bf = buildingFootprints[bi];
        if (p.x >= bf.bbox.minX && p.x <= bf.bbox.maxX &&
            p.y >= bf.bbox.minY && p.y <= bf.bbox.maxY) {
          quadCovered[qi] = true;
          break;
        }
      }
    }
    const coveredQuads = quadCovered[0] + quadCovered[1] + quadCovered[2] + quadCovered[3];
    if (coveredQuads >= 3) return true;

    // ── Test 4: Centroid inside any building polygon (solid buildings) ──
    const [gcx, gcy] = gridCell(cx, cy);
    if (gcx >= 0 && gcy >= 0 && gcx < GRID_SIZE && gcy < GRID_SIZE) {
      const bucket = buildingGrid[gridKey(gcx, gcy)];
      if (bucket) {
        for (const bi of bucket) {
          const bf = buildingFootprints[bi];
          if (cx < bf.bbox.minX || cx > bf.bbox.maxX ||
              cy < bf.bbox.minY || cy > bf.bbox.maxY) continue;
          if (pointInSimplePolygon({ x: cx, y: cy }, bf.polygon)) return true;
        }
      }
    }

    return false;
  }

  /**
   * Find building footprints overlapping a polygon. Returns hole rings
   * for earcut subtraction (offset outward by CLEARANCE).
   */
  function findOverlappingBuildings(poly) {
    let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity;
    for (const p of poly) {
      if (p.x < pMinX) pMinX = p.x;
      if (p.x > pMaxX) pMaxX = p.x;
      if (p.y < pMinY) pMinY = p.y;
      if (p.y > pMaxY) pMaxY = p.y;
    }

    // Collect candidate building indices via spatial grid (deduped)
    const [c0x, c0y] = gridCell(pMinX, pMinY);
    const [c1x, c1y] = gridCell(pMaxX, pMaxY);
    const seen = new Set();
    const candidates = [];
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        if (cx < 0 || cy < 0 || cx >= GRID_SIZE || cy >= GRID_SIZE) continue;
        const bucket = buildingGrid[gridKey(cx, cy)];
        if (!bucket) continue;
        for (const bi of bucket) {
          if (seen.has(bi)) continue;
          seen.add(bi);
          candidates.push(bi);
        }
      }
    }

    const holes = [];
    for (const bi of candidates) {
      const bf = buildingFootprints[bi];
      if (bf.bbox.maxX < pMinX || bf.bbox.minX > pMaxX ||
          bf.bbox.maxY < pMinY || bf.bbox.minY > pMaxY) continue;

      let hasOverlap = false;
      // Check vertex containment both ways
      for (const bp of bf.polygon) {
        if (pointInSimplePolygon(bp, poly)) { hasOverlap = true; break; }
      }
      if (!hasOverlap) {
        for (const pp of poly) {
          if (pointInSimplePolygon(pp, bf.polygon)) { hasOverlap = true; break; }
        }
      }
      // Check edge-edge intersections (catches cases where no vertex is inside)
      if (!hasOverlap) {
        hasOverlap = polygonEdgesIntersect(bf.polygon, poly);
      }

      if (hasOverlap) {
        const buffered = offsetPolygon(bf.polygon, CLEARANCE);
        if (buffered && buffered.length >= 3) holes.push(buffered);
      }
    }
    return holes;
  }

  // ── 4. Buildings (white) — generated FIRST ────────────────────────────────
  // All buildings are SOLID (no holes/courtyards) for clean 3D printing.
  // Tall buildings get a slight taper for a more realistic look.
  // Buildings too thin to print (< 1.5mm) are skipped.
  // Building exaggeration scales with vertExag but is capped so even at max
  // slider (8x) the tallest skyscrapers stay under MAX_BLDG_MM
  const BUILD_EXAG     = Math.min(vertExag * 0.5, 3.0);
  const MAX_BLDG_MM    = 35; // hard cap — keeps tall buildings from looking like spires
  const MIN_BLDG_DIM   = NOZZLE_MM; // 0.4mm — only skip what literally can't print

  // Helper context for landmark presets (avoids circular imports)
  const landmarkCtx = {
    collectExtrudedPolygon,
    shrinkToCentroid,
    collectSpire,
    collectBandedBuilding,
    minBBoxDimension,
    deterministicFrac,
    acc: null, // set per-building below
  };

  let buildingCount = 0;
  let landmarkCount = 0, tallTowerCount = 0, standardCount = 0;
  onProgress?.('Extruding buildings…', 74);
  for (const bf of buildingFootprints) {
    // Skip buildings too small to print — use area so narrow row-houses aren't dropped
    if (minBBoxDimension(bf.polygon) < MIN_BLDG_DIM) continue;
    if (Math.abs(signedArea2D(bf.polygon)) < 0.3) continue; // < 0.3mm² is sub-nozzle

    const heightM  = parseBuildingHeight(bf.tags, bf.polygon);
    const heightMM = clamp(heightM * hScale * BUILD_EXAG, MIN_BUILDING_HEIGHT_MM, MAX_BLDG_MM);

    // Terrain-relief mode: lift the building so it sits on the real ground height
    const baseY = polyTerrainBaseY(bf.polygon);

    if (detailedBuildings) {
      // ── 3-tier building generation system ──────────────────────────────
      // Tier 1: Landmark preset (identity-based, NOT height-based)
      // Tier 2: Generic tall-tower (≥100m real, no preset)
      // Tier 3: Standard class-based (everything else)
      const tierResult = landmarkRegistry.selectGenerator(bf.tags, bf.osmId || '', heightM, bf.polygon);

      if (tierResult.tier === 'landmark' && tierResult.presetName) {
        // ── Tier 1: Landmark with preset geometry ────────────────────
        landmarkCtx.acc = buildingAcc;
        const applied = generateLandmarkBuilding(landmarkCtx, tierResult.presetName, bf.polygon, baseY, heightMM, heightM);
        if (!applied) {
          collectDetailedBuilding(buildingAcc, bf.polygon, bf.tags, baseY, heightMM, heightM);
          standardCount++;
        } else {
          landmarkCount++;
        }
      } else if (tierResult.tier === 'tall-tower') {
        // ── Tier 2: Generic tall-tower (≥100m, no preset) ───────────
        collectGenericTallTower(buildingAcc, bf.polygon, bf.tags, baseY, heightMM, heightM);
        tallTowerCount++;
      } else {
        // ── Tier 3: Standard class-based generation ─────────────────
        collectDetailedBuilding(buildingAcc, bf.polygon, bf.tags, baseY, heightMM, heightM);
        standardCount++;
      }
    } else {
      // Plain block extrusion — no bevel, no empty space
      collectExtrudedPolygon(buildingAcc, bf.polygon, [], baseY, heightMM);
    }
    buildingCount++;
  }

  if (detailedBuildings) {
    console.log(`[Buildings] Tier 1 landmarks: ${landmarkCount}, Tier 2 tall-towers: ${tallTowerCount}, Tier 3 standard: ${standardCount}`);
  }

  // ── 5. Roads — layered with centerline ridge on major roads ──────────────
  const ROAD_SLAB = ROAD_HEIGHT;

  // Road class tiers for visual hierarchy
  const MAJOR_ROADS  = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link']);
  const MEDIUM_ROADS = new Set(['secondary','secondary_link','tertiary','tertiary_link']);
  // residential/unclassified/living_street = minor tier

  let roadCount = 0;
  onProgress?.('Building roads…', 80);
  for (const feat of features.roads) {
    const hw = feat.tags.highway || 'residential';
    if (!ROAD_TYPES.has(hw)) continue;

    const realW = hScale * (ROAD_WIDTHS_M[hw] ?? ROAD_WIDTHS_M.residential);
    const minW  = ROAD_MIN_VISUAL_HALF_MM[hw] ?? ROAD_MIN_VISUAL_HALF_MM.residential;
    const halfW = Math.max(realW, minW);
    const roadMid = feat.points[Math.floor(feat.points.length / 2)];
    const roadBaseY = roadMid ? terrainBaseY(roadMid.x, roadMid.y) : BASE;

    // Base road slab
    addRoadWithAvoidance(blackAcc, feat.points, halfW, hexInner, roadBaseY, ROAD_SLAB, findOverlappingBuildings);

    // Centerline ridge on major + medium roads — gives depth and road hierarchy
    if (MAJOR_ROADS.has(hw) || MEDIUM_ROADS.has(hw)) {
      const ridgeW   = MAJOR_ROADS.has(hw) ? halfW * 0.18 : halfW * 0.14;
      const ridgeH   = MAJOR_ROADS.has(hw) ? ROAD_SLAB * 0.6 : ROAD_SLAB * 0.4;
      const ridgePoly = bufferLinestring(feat.points, ridgeW);
      if (ridgePoly) {
        const ridgeClipped = clipToHex(ridgePoly, hexInner);
        if (ridgeClipped && ridgeClipped.length >= 3) {
          collectExtrudedPolygon(blackAcc, ridgeClipped, [], roadBaseY + ROAD_SLAB, ridgeH);
        }
      }
    }

    roadCount++;
  }

  // ── 6. Water areas — flat black slab flush with base surface ────────────
  // Base plate is always a plain solid prism — nothing taller than it is added.
  // Water is shown as a thin black slab sitting at the base top surface so it
  // reads as dark water against the white base without raising any geometry
  // above the base level.
  if (hasWater) {
    onProgress?.('Building water areas…', 88);
    for (const poly of waterPolys) {
      collectExtrudedPolygon(blackAcc, poly, [], BASE, 0.3);
    }
  }

  // ── 7. Order ID engraving on base bottom ─────────────────────────────────
  // Tiny raised text on the bottom face (Y=0) so you can flip the print
  // and identify which order it belongs to.
  if (orderId && orderId.length > 0) {
    onProgress?.('Engraving order ID…', 91);
    engraveTextOnBottom(blackAcc, orderId);
  }

  // ── Build combined meshes ──────────────────────────────────────────────────
  onProgress?.('Combining geometry…', 92);
  const baseMesh = baseAcc.build('base');
  const bldgMesh = buildingAcc.build('building');
  const roadMesh = blackAcc.build('road');

  if (baseMesh) group.add(baseMesh);
  if (bldgMesh) group.add(bldgMesh);
  if (roadMesh) group.add(roadMesh);

  onProgress?.('Model ready.', 95);
  return {
    group,
    stats: {
      buildings: buildingCount, roads: roadCount, water: waterPolys.length,
      landmarks: landmarkCount, tallTowers: tallTowerCount,
    },
  };
}

// ─── Smart road placement ────────────────────────────────────────────────────
// Tries full width first, then progressively shrinks if buildings block the road.
// Never lets a road completely disappear — it shrinks to fit.

function addRoadWithAvoidance(acc, points, halfW, hexInner, baseY, height, findOverlappingBuildings) {
  // Try full width, then progressively smaller
  const scales = [1.0, 0.6, 0.4, 0.25];
  // Strict nozzle minimum — half-width must give a road ≥ 0.4mm wide
  const MIN_HALF_W = 0.2;

  for (const scale of scales) {
    const w = halfW * scale;
    if (w < MIN_HALF_W) break; // Below printable nozzle width — give up

    const poly = bufferLinestring(points, w);
    if (!poly) continue;

    const clipped = clipToHex(poly, hexInner);
    if (!clipped || clipped.length < 3) continue;

    const bldgHoles = findOverlappingBuildings(clipped);

    if (bldgHoles.length === 0) {
      // No overlap — use this width
      collectExtrudedPolygon(acc, clipped, [], baseY, height);
      return;
    }

    // Try earcut with building holes
    if (tryCollectExtruded(acc, clipped, bldgHoles, baseY, height)) {
      return; // Succeeded with holes at this width
    }

    // Failed — try next smaller width
  }
  // All widths failed — skip this road segment entirely
}

/**
 * Attempts to add extruded polygon with holes. Returns true if geometry was
 * successfully generated (earcut produced valid triangles with sufficient area).
 */
function tryCollectExtruded(acc, polygon, holes, baseY, heightMM) {
  try {
    const ring = deduplicateRing(polygon);
    if (ring.length < 3) return false;

    const topY     = baseY + heightMM;
    const outerCCW = ensureCCW(ring);
    const { flat, holeIndices } = flattenWithHoles(outerCCW, holes || []);
    const nVerts = flat.length / 2;

    const topTris = earcut(flat, holeIndices, 2);
    if (topTris.length === 0) return false;
    if (Math.abs(earcut.deviation(flat, holeIndices, 2, topTris)) > 0.5) return false;

    // Check total area — reject if too small (degenerate)
    let totalArea = 0;
    for (let t = 0; t < topTris.length; t += 3) {
      const i0 = topTris[t], i1 = topTris[t+1], i2 = topTris[t+2];
      const ax = flat[i0*2], ay = flat[i0*2+1];
      const bx = flat[i1*2], by = flat[i1*2+1];
      const cx = flat[i2*2], cy = flat[i2*2+1];
      totalArea += Math.abs((bx-ax)*(cy-ay) - (cx-ax)*(by-ay)) / 2;
    }
    if (totalArea < 0.05) return false; // Too small to matter

    // Build full solid extrusion (top + bottom + sides)
    const allPos = [];
    const allIdx = [];

    // Top face
    for (let i = 0; i < nVerts; i++) allPos.push(flat[i*2], topY, -flat[i*2+1]);
    for (const t of topTris) allIdx.push(t);

    // Bottom face (reversed winding)
    const botOff = nVerts;
    for (let i = 0; i < nVerts; i++) allPos.push(flat[i*2], baseY, -flat[i*2+1]);
    for (let t = 0; t < topTris.length; t += 3) {
      allIdx.push(botOff + topTris[t+2], botOff + topTris[t+1], botOff + topTris[t]);
    }

    // Side walls (outer ring only — keeps it solid, no hollow)
    const n     = outerCCW.length;
    const sideT = nVerts * 2;
    const sideB = sideT + n;
    for (const p of outerCCW) allPos.push(p.x, topY,  -p.y);
    for (const p of outerCCW) allPos.push(p.x, baseY, -p.y);
    for (let i = 0; i < n; i++) {
      const tl = sideT + i,       tr = sideT + (i + 1) % n;
      const bl = sideB + i,       br = sideB + (i + 1) % n;
      allIdx.push(tl, tr, bl,  bl, tr, br);
    }

    acc.add(allPos, allIdx);
    return true;
  } catch (_) {
    return false;
  }
}

// ─── Geometry collectors ─────────────────────────────────────────────────────

// ─── Order ID engraving ──────────────────────────────────────────────────────
// Minimal 3×5 pixel font for 0-9, A-Z, and hyphen. Each char is a 3-wide,
// 5-tall bitmap stored as 5 rows of 3 bits (top to bottom).
const PIXEL_FONT = {
  '0': [0b111,0b101,0b101,0b101,0b111],
  '1': [0b010,0b110,0b010,0b010,0b111],
  '2': [0b111,0b001,0b111,0b100,0b111],
  '3': [0b111,0b001,0b111,0b001,0b111],
  '4': [0b101,0b101,0b111,0b001,0b001],
  '5': [0b111,0b100,0b111,0b001,0b111],
  '6': [0b111,0b100,0b111,0b101,0b111],
  '7': [0b111,0b001,0b010,0b010,0b010],
  '8': [0b111,0b101,0b111,0b101,0b111],
  '9': [0b111,0b101,0b111,0b001,0b111],
  'A': [0b010,0b101,0b111,0b101,0b101],
  'B': [0b110,0b101,0b110,0b101,0b110],
  'C': [0b111,0b100,0b100,0b100,0b111],
  'D': [0b110,0b101,0b101,0b101,0b110],
  'E': [0b111,0b100,0b110,0b100,0b111],
  'F': [0b111,0b100,0b110,0b100,0b100],
  'G': [0b111,0b100,0b101,0b101,0b111],
  'H': [0b101,0b101,0b111,0b101,0b101],
  'J': [0b001,0b001,0b001,0b101,0b111],
  'K': [0b101,0b110,0b100,0b110,0b101],
  'L': [0b100,0b100,0b100,0b100,0b111],
  'M': [0b101,0b111,0b111,0b101,0b101],
  'N': [0b101,0b111,0b111,0b101,0b101],
  'P': [0b111,0b101,0b111,0b100,0b100],
  'Q': [0b111,0b101,0b101,0b111,0b011],
  'R': [0b111,0b101,0b111,0b110,0b101],
  'S': [0b111,0b100,0b111,0b001,0b111],
  'T': [0b111,0b010,0b010,0b010,0b010],
  'U': [0b101,0b101,0b101,0b101,0b111],
  'V': [0b101,0b101,0b101,0b101,0b010],
  'W': [0b101,0b101,0b111,0b111,0b101],
  'X': [0b101,0b101,0b010,0b101,0b101],
  'Y': [0b101,0b101,0b010,0b010,0b010],
  'Z': [0b111,0b001,0b010,0b100,0b111],
  '-': [0b000,0b000,0b111,0b000,0b000],
  ' ': [0b000,0b000,0b000,0b000,0b000],
};

/**
 * Engrave text INTO the bottom of the base plate as black recessed pixels.
 * Each pixel is a thin black slab that sits inside the base (from Y=0 up
 * to Y=ENGRAVE_DEPTH). Added to blackAcc so it renders as dark text.
 * When you flip the print, the dark recessed text is readable against the
 * white base.
 */
function engraveTextOnBottom(acc, text) {
  const PIXEL_SIZE    = 0.7;  // mm per pixel
  const ENGRAVE_DEPTH = 0.4;  // mm into the base (from bottom up)
  const CHAR_GAP      = 1;    // 1 pixel gap between characters
  const CHAR_W        = 3;    // pixels per character width

  const chars = text.toUpperCase().split('');

  // Calculate total width in pixels
  let totalPixels = 0;
  for (const ch of chars) totalPixels += CHAR_W + CHAR_GAP;
  totalPixels -= CHAR_GAP;

  // Centre the text on the base bottom
  const totalMM = totalPixels * PIXEL_SIZE;
  const startX  = -totalMM / 2;
  const startZ  = -2.5 * PIXEL_SIZE; // centred vertically (5 rows)

  const botY = 0;                 // bottom of base plate
  const topY = ENGRAVE_DEPTH;     // how far up into the base the engraving goes

  let cursorX = startX;

  for (const ch of chars) {
    const glyph = PIXEL_FONT[ch];
    if (!glyph) { cursorX += (CHAR_W + CHAR_GAP) * PIXEL_SIZE; continue; }

    for (let row = 0; row < 5; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 3; col++) {
        if (!(bits & (1 << (2 - col)))) continue; // pixel off

        const px = cursorX + col * PIXEL_SIZE;
        const pz = startZ + row * PIXEL_SIZE;
        const x0 = px, x1 = px + PIXEL_SIZE;
        const z0 = pz, z1 = pz + PIXEL_SIZE;

        // Tiny cube recessed INTO the base (Y=0 to Y=ENGRAVE_DEPTH)
        // Bottom face visible when print is flipped over
        const pos = [
          x0, botY, z0,  x1, botY, z0,  x1, botY, z1,  x0, botY, z1,  // 0-3: bottom
          x0, topY, z0,  x1, topY, z0,  x1, topY, z1,  x0, topY, z1,  // 4-7: top
        ];
        const idx = [
          0,1,2, 0,2,3,   // bottom face (visible when flipped — normal faces -Y)
          4,6,5, 4,7,6,   // top face (hidden inside base)
          0,5,1, 0,4,5,   // front wall (z0)
          3,2,6, 3,6,7,   // back wall (z1)
          0,3,7, 0,7,4,   // left wall (x0)
          1,5,6, 1,6,2,   // right wall (x1)
        ];
        acc.add(pos, idx);
      }
    }
    cursorX += (CHAR_W + CHAR_GAP) * PIXEL_SIZE;
  }
}

function collectHexBase(acc, shapeVerts, chamfer = 0) {
  const pos = [];
  const idx = [];
  const top = BASE_THICKNESS_MM;
  const bot = 0;
  const N = shapeVerts.length;

  if (chamfer <= 0) {
    // ─── Plain prism: top + bottom + vertical walls ──────────────────────────
    pos.push(0, top, 0);
    for (const v of shapeVerts) pos.push(v.x, top, -v.y);
    for (let i = 0; i < N; i++) idx.push(0, 1 + i, 1 + (i + 1) % N);

    const bOff = N + 1;
    pos.push(0, bot, 0);
    for (const v of shapeVerts) pos.push(v.x, bot, -v.y);
    for (let i = 0; i < N; i++) idx.push(bOff, bOff + 1 + (i + 1) % N, bOff + 1 + i);

    for (let i = 0; i < N; i++) {
      const tA = 1 + i, tB = 1 + (i + 1) % N;
      const bA = bOff + 1 + i, bB = bOff + 1 + (i + 1) % N;
      idx.push(tA, bA, tB,  bA, bB, tB);
    }

    acc.add(pos, idx);
    return;
  }

  // ─── Chamfered top edge (premium look) ────────────────────────────────────
  const inset = chamfer;
  const topVerts = shapeVerts.map(v => {
    const len = Math.hypot(v.x, v.y);
    if (len < 1e-9) return { x: 0, y: 0 };
    const k = (len - inset) / len;
    return { x: v.x * k, y: v.y * k };
  });
  const yShoulder = top - chamfer;

  pos.push(0, top, 0);
  for (const v of topVerts)  pos.push(v.x, top, -v.y);
  pos.push(0, bot, 0);
  for (const v of shapeVerts) pos.push(v.x, bot, -v.y);
  for (const v of shapeVerts) pos.push(v.x, yShoulder, -v.y);

  const tCtr = 0, tRing = 1, bCtr = N + 1, bRing = N + 2, sRing = 2 * N + 2;

  for (let i = 0; i < N; i++) idx.push(tCtr, tRing + i, tRing + (i + 1) % N);
  for (let i = 0; i < N; i++) idx.push(bCtr, bRing + (i + 1) % N, bRing + i);
  for (let i = 0; i < N; i++) {
    const a = bRing + i, b = bRing + (i + 1) % N;
    const c = sRing + (i + 1) % N, d = sRing + i;
    idx.push(a, b, c,  a, c, d);
  }
  for (let i = 0; i < N; i++) {
    const a = sRing + i, b = sRing + (i + 1) % N;
    const c = tRing + (i + 1) % N, d = tRing + i;
    idx.push(a, b, c,  a, c, d);
  }

  acc.add(pos, idx);
}

/**
 * Build the base plate as a SINGLE, fully-watertight solid with recessed water pits.
 *
 * All geometry is emitted in ONE acc.add() call using a shared vertex buffer.
 * Every edge between adjacent faces references the SAME vertex indices, so
 * the mesh is 100% manifold — no coincident-but-separate vertices that confuse slicers.
 *
 * Vertex layout in allPos:
 *   [0 .. N-1]                    hex top ring, y = topY
 *   [N .. 2N-1]                   hex bottom ring, y = bot
 *   [2N]                          hex bottom center (for fan)
 *   for each water poly wi (M vertices):
 *     [wTopStart[wi] .. +M-1]     water top ring, y = topY
 *     [wFlrStart[wi] .. +M-1]     water floor ring, y = waterFloorY
 */
function collectHexBaseWithHoles(acc, shapeVerts, waterPolys, topY, waterFloorY) {
  const bot = 0;
  const N   = shapeVerts.length;

  // Pre-process each water polygon: deduplicate + ensure CCW.
  // This MUST be done BEFORE building any geometry so all faces that share
  // a water-poly edge use bit-for-bit identical vertex positions.
  const wPolys = waterPolys
    .map(poly => ensureCCW(deduplicateRing([...poly])))
    .filter(p => p.length >= 3);

  // Fall back to plain solid base if nothing is left after filtering.
  if (wPolys.length === 0) {
    collectHexBase(acc, shapeVerts, 0);
    return;
  }

  // ── Build shared vertex buffer ────────────────────────────────────────────
  const allPos = [];
  const allIdx = [];

  // Hex top ring: [0..N-1]
  for (const v of shapeVerts) allPos.push(v.x, topY, -v.y);
  // Hex bottom ring: [N..2N-1]
  for (const v of shapeVerts) allPos.push(v.x, bot,  -v.y);
  // Hex bottom center: [2N]
  allPos.push(0, bot, 0);
  const botCenterIdx = 2 * N;

  // Water poly rings — record start indices
  const wTopStart = [];
  const wFlrStart = [];
  for (const wp of wPolys) {
    wTopStart.push(allPos.length / 3);
    for (const p of wp) allPos.push(p.x, topY,        -p.y);
    wFlrStart.push(allPos.length / 3);
    for (const p of wp) allPos.push(p.x, waterFloorY, -p.y);
  }

  // ── Bottom face — solid hex fan (downward normals) ────────────────────────
  for (let i = 0; i < N; i++) {
    allIdx.push(botCenterIdx, N + (i + 1) % N, N + i);
  }

  // ── Hex outer side walls (outward-facing) ─────────────────────────────────
  for (let i = 0; i < N; i++) {
    const tA = i,     tB = (i + 1) % N;
    const bA = N + i, bB = N + (i + 1) % N;
    allIdx.push(tA, bA, tB,  bA, bB, tB);
  }

  // ── Top face with water holes — earcut with index remapping ───────────────
  // Build flat2D for earcut: outer ring (CCW) + each water hole (CW = reversed).
  // Also build eToV: earcut flat-index → allPos vertex index.
  const hexCCW = ensureCCW([...shapeVerts]); // same order as allPos[0..N-1]
  const flat2D = [];
  const eToV   = [];    // earcut flat index → allPos vertex index

  for (let i = 0; i < N; i++) {
    flat2D.push(hexCCW[i].x, hexCCW[i].y);
    // hexCCW[i] === shapeVerts[i] when shapeVerts is already CCW (which it always is)
    eToV.push(i);       // allPos index = i (hex top ring)
  }

  const earHoles = [];
  for (let wi = 0; wi < wPolys.length; wi++) {
    earHoles.push(flat2D.length / 2);
    const wp = wPolys[wi];
    const M  = wp.length;
    // Holes must be CW for earcut → iterate wp in reverse.
    for (let j = M - 1; j >= 0; j--) {
      flat2D.push(wp[j].x, wp[j].y);
      eToV.push(wTopStart[wi] + j);   // allPos index = water top vertex j
    }
  }

  const topTris = earcut(flat2D, earHoles.length > 0 ? earHoles : undefined, 2);
  for (const t of topTris) allIdx.push(eToV[t]);   // remap to shared vertices

  // ── Pit walls + floor per water poly ─────────────────────────────────────
  for (let wi = 0; wi < wPolys.length; wi++) {
    const wp   = wPolys[wi];
    const M    = wp.length;
    const tB_  = wTopStart[wi];   // allPos base for top ring of this poly
    const fB_  = wFlrStart[wi];   // allPos base for floor ring of this poly

    // Pit walls: inward-facing (reverse winding vs outer hex walls).
    // Top-ring uses wTopStart[wi]+i (shared with top-face earcut above).
    // Floor-ring uses wFlrStart[wi]+i (shared with pit-floor earcut below).
    for (let i = 0; i < M; i++) {
      const tA = tB_ + i,         tBv = tB_ + (i + 1) % M;
      const bA = fB_ + i,         bBv = fB_ + (i + 1) % M;
      allIdx.push(tA, tBv, bA,  tBv, bBv, bA);
    }

    // Pit floor cap — seals the bottom so the base is a closed solid.
    // Uses the SAME wFlrStart vertices → every pit-wall→floor edge is shared.
    const flatF = wp.flatMap(p => [p.x, p.y]);   // already CCW
    const floorTris = earcut(flatF, undefined, 2);
    for (const t of floorTris) allIdx.push(fB_ + t);
  }

  // Emit everything as one solid, manifold mesh.
  acc.add(allPos, allIdx);
}

// Small extruded prism (n-gon) used for tree bumps
function collectTreeBump(acc, x, y, baseY, height, radius, segments = 6) {
  const pos = [];
  const idx = [];
  // Bottom + top center vertices
  pos.push(x, baseY, -y);            // 0 = bottom center
  pos.push(x, baseY + height, -y);   // 1 = top center
  const ringB = 2;
  const ringT = 2 + segments;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const dx = Math.cos(a) * radius;
    const dz = Math.sin(a) * radius;
    pos.push(x + dx, baseY, -(y + dz));
  }
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const dx = Math.cos(a) * radius * 0.55; // slight taper at top
    const dz = Math.sin(a) * radius * 0.55;
    pos.push(x + dx, baseY + height, -(y + dz));
  }
  // Bottom fan
  for (let i = 0; i < segments; i++) {
    idx.push(0, ringB + (i + 1) % segments, ringB + i);
  }
  // Top fan
  for (let i = 0; i < segments; i++) {
    idx.push(1, ringT + i, ringT + (i + 1) % segments);
  }
  // Sides (quads as 2 triangles)
  for (let i = 0; i < segments; i++) {
    const a = ringB + i, b = ringB + (i + 1) % segments;
    const c = ringT + (i + 1) % segments, d = ringT + i;
    idx.push(a, b, c,  a, c, d);
  }
  acc.add(pos, idx);
}

function collectTerrainMesh(acc, elevGrid, N, hexVerts, vScale, baseY = BASE_THICKNESS_MM) {
  const pos = [];
  const idx = [];

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = (i / (N - 1)) * 2 - 1;
      const v = (j / (N - 1)) * 2 - 1;
      const x = u * MODEL_RADIUS_MM;
      const y = v * MODEL_RADIUS_MM;
      const inside = pointInHex({ x, y }, hexVerts);
      const elev   = inside ? clamp(elevGrid[j * N + i] * vScale, 0, 40) : 0;
      pos.push(x, baseY + elev, -y);
    }
  }

  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx.push(a, b, c,  b, d, c);
    }
  }

  acc.add(pos, idx);
}

// Beveled-top building extrusion — produces a small chamfer at the top edge
// for a softer, more finished look instead of a hard cube corner. Holes not
// supported (buildings are always solid). Falls back to a plain block if the
// inset produces a degenerate ring (tiny or self-intersecting footprint).
function collectBeveledBuilding(acc, polygon, baseY, heightMM) {
  const BEVEL_MAX = 0.35; // mm — subtle chamfer, prints cleanly on a 0.4mm nozzle
  const ring = deduplicateRing(polygon);
  if (ring.length < 3) {
    return collectExtrudedPolygon(acc, polygon, [], baseY, heightMM);
  }
  const outerCCW = ensureCCW(ring);
  const n = outerCCW.length;

  // Compute min distance from centroid to any edge → cap bevel so it can't collapse the shape
  let cx = 0, cy = 0;
  for (const p of outerCCW) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  let minR = Infinity;
  for (const p of outerCCW) {
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < minR) minR = d;
  }
  const bevel = Math.min(BEVEL_MAX, heightMM * 0.18, minR * 0.2);

  if (bevel < 0.15) {
    // Shape is too small to bevel cleanly — fall back to hard-edged block
    return collectExtrudedPolygon(acc, polygon, [], baseY, heightMM);
  }

  // Build inset top ring by moving each vertex toward the centroid by `bevel`.
  // Works well for convex-ish building footprints (the common case).
  const insetRing = outerCCW.map((p) => {
    const dx = cx - p.x, dy = cy - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const t = Math.min(bevel / len, 0.45);
    return { x: p.x + dx * t, y: p.y + dy * t };
  });

  // Triangulate the inset top cap
  const flatTop = [];
  for (const p of insetRing) { flatTop.push(p.x, p.y); }
  const topTris = earcut(flatTop, [], 2);
  if (topTris.length === 0 || Math.abs(earcut.deviation(flatTop, [], 2, topTris)) > 0.5) {
    return collectExtrudedPolygon(acc, polygon, [], baseY, heightMM);
  }

  // Triangulate the bottom cap (full outer)
  const flatBot = [];
  for (const p of outerCCW) { flatBot.push(p.x, p.y); }
  const botTris = earcut(flatBot, [], 2);
  if (botTris.length === 0) {
    return collectExtrudedPolygon(acc, polygon, [], baseY, heightMM);
  }

  const topY      = baseY + heightMM;
  const shoulderY = topY - bevel;
  const pos = [];
  const idx = [];

  // Vertex layout:
  //   [0..n-1]       bottom outer ring (baseY)
  //   [n..2n-1]      shoulder ring (shoulderY, full XY)
  //   [2n..3n-1]     inset top ring (topY, inset XY)
  const offBot      = 0;
  const offShoulder = n;
  const offTop      = 2 * n;

  for (const p of outerCCW) pos.push(p.x, baseY,      -p.y);
  for (const p of outerCCW) pos.push(p.x, shoulderY,  -p.y);
  for (const p of insetRing) pos.push(p.x, topY,      -p.y);

  // Bottom cap (reversed so it faces down)
  for (let t = 0; t < botTris.length; t += 3) {
    idx.push(offBot + botTris[t + 2], offBot + botTris[t + 1], offBot + botTris[t]);
  }

  // Top cap
  for (const t of topTris) idx.push(offTop + t);

  // Vertical walls (base → shoulder)
  for (let i = 0; i < n; i++) {
    const ni = (i + 1) % n;
    const bl = offBot + i,      br = offBot + ni;
    const tl = offShoulder + i, tr = offShoulder + ni;
    idx.push(bl, br, tr,  bl, tr, tl);
  }

  // Bevel slope (shoulder → top inset)
  for (let i = 0; i < n; i++) {
    const ni = (i + 1) % n;
    const bl = offShoulder + i, br = offShoulder + ni;
    const tl = offTop + i,      tr = offTop + ni;
    idx.push(bl, br, tr,  bl, tr, tl);
  }

  acc.add(pos, idx);
}

function collectExtrudedPolygon(acc, polygon, holes, baseY, heightMM) {
  try {
    const ring = deduplicateRing(polygon);
    if (ring.length < 3) return;
    const topY     = baseY + heightMM;
    const outerCCW = ensureCCW(ring);
    const { flat, holeIndices } = flattenWithHoles(outerCCW, holes || []);
    const nVerts = flat.length / 2;

    const topTris = earcut(flat, holeIndices, 2);
    if (topTris.length === 0) return;
    if (Math.abs(earcut.deviation(flat, holeIndices, 2, topTris)) > 0.5) return;

    const allPos = [];
    const allIdx = [];

    // Top face
    for (let i = 0; i < nVerts; i++) allPos.push(flat[i * 2], topY, -flat[i * 2 + 1]);
    for (const t of topTris) allIdx.push(t);

    // Bottom face (reversed)
    const botOff = nVerts;
    for (let i = 0; i < nVerts; i++) allPos.push(flat[i * 2], baseY, -flat[i * 2 + 1]);
    for (let t = 0; t < topTris.length; t += 3) {
      allIdx.push(botOff + topTris[t + 2], botOff + topTris[t + 1], botOff + topTris[t]);
    }

    // Side walls (outer ring)
    const n     = outerCCW.length;
    const sideT = nVerts * 2;
    const sideB = sideT + n;
    for (const p of outerCCW) allPos.push(p.x, topY,  -p.y);
    for (const p of outerCCW) allPos.push(p.x, baseY, -p.y);
    for (let i = 0; i < n; i++) {
      const tl = sideT + i,       tr = sideT + (i + 1) % n;
      const bl = sideB + i,       br = sideB + (i + 1) % n;
      allIdx.push(tl, tr, bl,  bl, tr, br);
    }

    acc.add(allPos, allIdx);
  } catch (_) {}
}

// ─── Comprehensive Procedural Building System ────────────────────────────────
// 7 building classes with rule-based architectural details, window banding,
// setbacks, parapets, facade offsets, spires, and landmark features.
// Classification uses REAL-WORLD height (metres) + OSM tags + footprint area.
// All geometry is solid and watertight for clean 3D printing.

// ── Building class constants ─────────────────────────────────────────────────
const CLASS_RESIDENTIAL_LOW  = 0; // houses, bungalows — ≤ 10m
const CLASS_RESIDENTIAL_MID  = 1; // apartments, row houses — 10–25m
const CLASS_OFFICE_TOWER     = 2; // office/commercial — 25–80m
const CLASS_PODIUM_TOWER     = 3; // wide base + slender tower — 30–80m+
const CLASS_INDUSTRIAL       = 4; // warehouses, factories — flat + boxy
const CLASS_LANDMARK         = 5; // signature towers — tallest / tagged
const CLASS_CIVIC            = 6; // churches, govt, hospitals — moderate + crowned
const CLASS_FILLER           = 7; // generic / unclassifiable

const RESIDENTIAL_LOW_TAGS = new Set([
  'house', 'detached', 'semidetached_house', 'bungalow', 'cabin',
  'farm', 'static_caravan', 'terrace', 'hut', 'shed',
]);
const RESIDENTIAL_MID_TAGS = new Set([
  'apartments', 'residential', 'dormitory',
]);
const OFFICE_TAGS = new Set([
  'office', 'commercial', 'hotel',
]);
const INDUSTRIAL_TAGS = new Set([
  'industrial', 'warehouse', 'storage_tank', 'hangar', 'factory',
  'manufacture', 'garage', 'garages', 'carport',
]);
const LANDMARK_TAGS = new Set([
  'cathedral', 'temple', 'mosque', 'tower', 'skyscraper',
]);
const CIVIC_TAGS = new Set([
  'church', 'chapel', 'hospital', 'school', 'university',
  'government', 'public', 'civic', 'library', 'museum',
]);

/**
 * Classify a building into one of 7+ classes based on tags, real height,
 * and footprint area (in model-mm²).
 */
function classifyBuilding(tags, heightM, polygon) {
  const t = tags?.building || 'yes';
  const area = polygon ? Math.abs(signedArea2D(polygon)) : 50;
  const frac = polygon ? deterministicFrac(polygon) : 0.5;

  // Religious/civic landmark tags → civic class (identity-based landmarks
  // are handled by the Tier 1 LandmarkRegistry, not height thresholds)
  if (LANDMARK_TAGS.has(t)) return CLASS_CIVIC;

  // Industrial
  if (INDUSTRIAL_TAGS.has(t)) return CLASS_INDUSTRIAL;

  // Civic / religious
  if (CIVIC_TAGS.has(t)) return CLASS_CIVIC;

  // Residential low
  if (RESIDENTIAL_LOW_TAGS.has(t) || heightM <= 10) return CLASS_RESIDENTIAL_LOW;

  // Office tower
  if (OFFICE_TAGS.has(t) && heightM >= 25) return CLASS_OFFICE_TOWER;

  // Podium tower: large footprint + tall = podium with slender tower on top
  if (heightM >= 30 && area > 150) {
    return frac > 0.4 ? CLASS_PODIUM_TOWER : CLASS_OFFICE_TOWER;
  }

  // Residential mid-rise
  if (RESIDENTIAL_MID_TAGS.has(t) || (heightM > 10 && heightM <= 25)) {
    return CLASS_RESIDENTIAL_MID;
  }

  // Office tower for tall unclassified
  if (heightM > 25) return CLASS_OFFICE_TOWER;

  // Generic filler
  return CLASS_FILLER;
}

/**
 * Tier 3: Standard building — plain flat-top extrusion from footprint.
 * No banding, no setbacks, no special massing. Just an honest block.
 * Tier 1 (landmark presets) and Tier 2 (generic tall-tower) are handled
 * upstream in the building loop before this is called.
 */
function collectDetailedBuilding(acc, polygon, tags, baseY, totalH, heightM) {
  collectExtrudedPolygon(acc, polygon, [], baseY, totalH);
}

// ── Window banding ───────────────────────────────────────────────────────────
// Adds horizontal groove lines on building facades to suggest floor divisions.
// Each band is a thin recessed strip created by two stacked extrusions with
// a slight inset between them (simulates window rows at print scale).

/**
 * Generate a building with horizontal window bands on the facade.
 * Splits the building into alternating full-width floors and slightly
 * inset band strips, creating a ribbed facade effect.
 *
 * @param {number} bandCount  - number of window bands (floor divisions)
 * @param {number} insetScale - how much to shrink bands (0.92 = 8% inset)
 * @param {number} bandFrac   - fraction of floor height used by band strip
 */
function collectBandedBuilding(acc, polygon, baseY, totalH, bandCount, insetScale = 0.93, bandFrac = 0.25) {
  if (bandCount <= 0 || totalH < 1.0) {
    collectExtrudedPolygon(acc, polygon, [], baseY, totalH);
    return;
  }

  const floorH = totalH / bandCount;
  const bandH = floorH * bandFrac;
  const solidH = floorH - bandH;
  const inset = shrinkToCentroid(polygon, insetScale);

  let y = baseY;
  for (let i = 0; i < bandCount; i++) {
    // Solid floor slab (full width)
    collectExtrudedPolygon(acc, polygon, [], y, solidH);
    y += solidH;
    // Inset window band (slightly recessed)
    if (inset && bandH > 0.05) {
      collectExtrudedPolygon(acc, inset, [], y, bandH);
    } else {
      collectExtrudedPolygon(acc, polygon, [], y, bandH);
    }
    y += bandH;
  }
}

// ── Parapet / crown cap ──────────────────────────────────────────────────────
// A thin slab on top that's slightly wider than the roof, giving a capped look.

function collectParapet(acc, polygon, topY, parapetH, overhang = 1.02) {
  const wider = shrinkToCentroid(polygon, overhang);
  if (wider) {
    collectExtrudedPolygon(acc, wider, [], topY, parapetH);
  } else {
    collectExtrudedPolygon(acc, polygon, [], topY, parapetH);
  }
}

// ── Per-class generators ─────────────────────────────────────────────────────

/**
 * CLASS 0: Residential Low (houses, bungalows, ≤10m)
 * Simple block with optional pitched roof via gable/hip.
 * Small footprints get a plain block to avoid degenerate roof geometry.
 */
function collectResidentialLow(acc, polygon, tags, baseY, totalH, heightM) {
  const frac = deterministicFrac(polygon);
  const dim = minBBoxDimension(polygon);

  // Very small buildings: plain block
  if (dim < 1.5 || totalH < 1.0) {
    collectExtrudedPolygon(acc, polygon, [], baseY, totalH);
    return;
  }

  // 60% chance of gable roof on houses
  if (frac > 0.4 && dim > 2.0) {
    const roofH = Math.min(totalH * 0.3, 1.5);
    const wallH = totalH - roofH;
    collectExtrudedPolygon(acc, polygon, [], baseY, wallH);
    collectGableHipRoof(acc, polygon, baseY + wallH, roofH);
  } else {
    // Flat-topped block
    collectExtrudedPolygon(acc, polygon, [], baseY, totalH);
  }
}

/**
 * CLASS 1: Residential Mid-Rise (apartments, 10–25m)
 * Banded facade with 3–8 floors. Optional parapet cap.
 */
function collectResidentialMid(acc, polygon, tags, baseY, totalH, heightM) {
  const frac = deterministicFrac(polygon);
  const floors = Math.max(2, Math.min(8, Math.round(heightM / 3.2)));
  const bands = Math.max(2, Math.min(6, floors - 1));

  // Main body with window bands
  const parapetH = Math.min(0.3, totalH * 0.04);
  const bodyH = totalH - parapetH;
  collectBandedBuilding(acc, polygon, baseY, bodyH, bands, 0.94, 0.2);

  // Parapet cap
  if (frac > 0.3) {
    collectParapet(acc, polygon, baseY + bodyH, parapetH, 1.01);
  } else {
    collectExtrudedPolygon(acc, polygon, [], baseY + bodyH, parapetH);
  }
}

/**
 * CLASS 2: Office Tower (25–80m)
 * Banded facade, setback crown, optional mechanical penthouse.
 */
function collectOfficeTower(acc, polygon, tags, baseY, totalH, heightM) {
  const frac = deterministicFrac(polygon);
  const floors = Math.max(4, Math.min(20, Math.round(heightM / 3.5)));

  // Crown + penthouse proportions
  const crownH = Math.min(1.5, totalH * 0.08);
  const pentH = frac > 0.5 ? Math.min(0.6, totalH * 0.04) : 0;
  const bodyH = totalH - crownH - pentH;
  const bands = Math.max(3, Math.min(12, floors - 2));

  // Main shaft with window banding
  collectBandedBuilding(acc, polygon, baseY, bodyH, bands, 0.92, 0.28);

  // Setback crown
  const crown = shrinkToCentroid(polygon, 0.88);
  if (crown) {
    collectExtrudedPolygon(acc, crown, [], baseY + bodyH, crownH);
  } else {
    collectExtrudedPolygon(acc, polygon, [], baseY + bodyH, crownH);
  }

  // Mechanical penthouse (smaller box on top)
  if (pentH > 0) {
    const pent = shrinkToCentroid(polygon, 0.55);
    if (pent) {
      collectExtrudedPolygon(acc, pent, [], baseY + bodyH + crownH, pentH);
    }
  }
}

/**
 * CLASS 3: Podium Tower (wide base + slender tower on top)
 * Bottom 30% is full-footprint podium, top 70% is a setback tower.
 */
function collectPodiumTower(acc, polygon, tags, baseY, totalH, heightM) {
  const frac = deterministicFrac(polygon);

  // Podium: 25–35% of total height, full footprint
  const podiumFrac = 0.25 + frac * 0.1;
  const podiumH = totalH * podiumFrac;
  const towerH = totalH - podiumH;

  // Podium body with light banding
  const podiumBands = Math.max(1, Math.round(podiumH / 2.0));
  collectBandedBuilding(acc, polygon, baseY, podiumH, podiumBands, 0.95, 0.15);

  // Tower: shrink to 60-75% of footprint, centered
  const towerScale = 0.6 + frac * 0.15;
  const tower = shrinkToCentroid(polygon, towerScale);
  if (tower) {
    // Tower body with denser banding
    const towerBands = Math.max(3, Math.round(towerH / 1.5));
    const crownH = Math.min(1.0, towerH * 0.08);
    collectBandedBuilding(acc, tower, baseY + podiumH, towerH - crownH, towerBands, 0.92, 0.3);

    // Tower crown
    const towerCrown = shrinkToCentroid(tower, 0.9);
    if (towerCrown) {
      collectExtrudedPolygon(acc, towerCrown, [], baseY + podiumH + towerH - crownH, crownH);
    }
  } else {
    // Fallback: just extend the podium
    collectBandedBuilding(acc, polygon, baseY + podiumH, towerH, 4, 0.92, 0.25);
  }
}

/**
 * CLASS 4: Industrial (warehouses, factories)
 * Flat-topped, boxy, no ornamentation. Occasional stepped roofline.
 */
function collectIndustrial(acc, polygon, tags, baseY, totalH, heightM) {
  const frac = deterministicFrac(polygon);

  if (frac > 0.6 && totalH > 2.0) {
    // Stepped roof: two levels at different heights
    const mainH = totalH * (0.7 + frac * 0.15);
    const stepH = totalH;
    const stepPoly = shrinkToCentroid(polygon, 0.65);
    collectExtrudedPolygon(acc, polygon, [], baseY, mainH);
    if (stepPoly) {
      collectExtrudedPolygon(acc, stepPoly, [], baseY + mainH, stepH - mainH);
    }
  } else {
    // Plain box
    collectExtrudedPolygon(acc, polygon, [], baseY, totalH);
  }
}

/**
 * CLASS 5: Landmark / Signature Tower (tallest buildings, cathedrals, etc.)
 * Tiered setbacks, vertical ribs implied by facade offsets,
 * spire/antenna on top. The most architecturally detailed class.
 */
function collectLandmark(acc, polygon, tags, baseY, totalH, heightM) {
  const frac = deterministicFrac(polygon);
  const t = tags?.building || 'yes';
  const isReligious = (t === 'cathedral' || t === 'temple' || t === 'mosque' || t === 'church');

  if (isReligious) {
    collectReligiousLandmark(acc, polygon, tags, baseY, totalH, heightM);
    return;
  }

  // ── Secular landmark tower with tiered setbacks ────────────────────────
  // Split into 3-4 tiers of decreasing footprint, plus spire

  const tierCount = totalH > 25 ? (frac > 0.5 ? 4 : 3) : 2;
  const spireH = Math.min(2.5, totalH * 0.12);
  const bodyH = totalH - spireH;

  // Generate tier heights and scales (bottom-up)
  const tiers = [];
  let remainH = bodyH;
  let currentScale = 1.0;
  for (let i = 0; i < tierCount; i++) {
    const isLast = (i === tierCount - 1);
    const tierFrac = isLast ? 1.0 : (0.35 + frac * 0.15);
    const h = isLast ? remainH : remainH * tierFrac;
    tiers.push({ h, scale: currentScale });
    remainH -= h;
    currentScale *= (0.78 + frac * 0.08); // each tier shrinks 14-22%
  }

  // Build tiers bottom-up with window banding
  let y = baseY;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const tierPoly = tier.scale < 0.99 ? shrinkToCentroid(polygon, tier.scale) : polygon;
    const bands = Math.max(2, Math.round(tier.h / 1.8));
    if (tierPoly) {
      collectBandedBuilding(acc, tierPoly, y, tier.h, bands, 0.90, 0.3);
    } else {
      collectExtrudedPolygon(acc, polygon, [], y, tier.h);
    }
    y += tier.h;
  }

  // Spire: narrow tapered column on top
  if (spireH > 0.3) {
    collectSpire(acc, polygon, y, spireH, frac);
  }
}

/**
 * Religious landmark: nave + central tower/dome suggestion
 */
function collectReligiousLandmark(acc, polygon, tags, baseY, totalH, heightM) {
  const frac = deterministicFrac(polygon);

  // Main nave body (85% height)
  const naveH = totalH * 0.75;
  const towerH = totalH - naveH;

  collectBandedBuilding(acc, polygon, baseY, naveH, Math.max(2, Math.round(naveH / 2.5)), 0.95, 0.15);

  // Central tower / steeple
  const tower = shrinkToCentroid(polygon, 0.45);
  if (tower) {
    const towerBody = towerH * 0.6;
    const spireH = towerH * 0.4;
    collectExtrudedPolygon(acc, tower, [], baseY + naveH, towerBody);
    collectSpire(acc, tower, baseY + naveH + towerBody, spireH, frac);
  } else {
    collectExtrudedPolygon(acc, polygon, [], baseY + naveH, towerH);
  }
}

/**
 * Spire / antenna: a narrow tapered prism rising from the polygon centroid.
 * Creates a hexagonal prism that tapers to ~15% at the top.
 */
function collectSpire(acc, polygon, baseY, height, frac) {
  // Find centroid
  let cx = 0, cy = 0;
  for (const p of polygon) { cx += p.x; cy += p.y; }
  cx /= polygon.length; cy /= polygon.length;

  // Base radius: ~20-30% of polygon's min dimension
  const dim = minBBoxDimension(polygon);
  const baseR = dim * (0.15 + frac * 0.1);
  const topR = baseR * 0.15; // sharp taper
  const segs = 6;

  const pos = [];
  const idx = [];

  // Bottom center, top center
  pos.push(cx, baseY, -cy);                  // 0
  pos.push(cx, baseY + height, -cy);         // 1

  // Bottom ring
  const ringB = 2;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pos.push(cx + Math.cos(a) * baseR, baseY, -(cy + Math.sin(a) * baseR));
  }

  // Top ring
  const ringT = ringB + segs;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pos.push(cx + Math.cos(a) * topR, baseY + height, -(cy + Math.sin(a) * topR));
  }

  // Bottom fan
  for (let i = 0; i < segs; i++) {
    idx.push(0, ringB + (i + 1) % segs, ringB + i);
  }
  // Top fan
  for (let i = 0; i < segs; i++) {
    idx.push(1, ringT + i, ringT + (i + 1) % segs);
  }
  // Side walls
  for (let i = 0; i < segs; i++) {
    const a = ringB + i, b = ringB + (i + 1) % segs;
    const c = ringT + (i + 1) % segs, d = ringT + i;
    idx.push(a, b, c, a, c, d);
  }

  acc.add(pos, idx);
}

/**
 * CLASS 6: Civic (churches, hospitals, schools, government)
 * Moderate height with crown / cornice detail and optional cupola.
 */
function collectCivic(acc, polygon, tags, baseY, totalH, heightM) {
  const frac = deterministicFrac(polygon);

  // Body with subtle banding
  const corniceH = Math.min(0.4, totalH * 0.06);
  const bodyH = totalH - corniceH;
  const bands = Math.max(2, Math.min(5, Math.round(heightM / 4)));

  collectBandedBuilding(acc, polygon, baseY, bodyH, bands, 0.95, 0.18);

  // Cornice cap (slightly wider than body)
  collectParapet(acc, polygon, baseY + bodyH, corniceH, 1.03);

  // 40% chance of a small cupola on top
  if (frac > 0.6 && totalH > 3.0) {
    const cupola = shrinkToCentroid(polygon, 0.3);
    if (cupola) {
      const cupolaH = Math.min(1.0, totalH * 0.08);
      collectExtrudedPolygon(acc, cupola, [], baseY + totalH, cupolaH);
    }
  }
}

/**
 * CLASS 7: Generic Filler (unclassified buildings)
 * Light banding for height > 2mm, otherwise plain block.
 */
function collectFiller(acc, polygon, tags, baseY, totalH, heightM) {
  if (totalH < 2.0) {
    collectExtrudedPolygon(acc, polygon, [], baseY, totalH);
    return;
  }

  const frac = deterministicFrac(polygon);
  const bands = Math.max(1, Math.min(4, Math.round(totalH / 2.5)));

  // 50% chance of banded vs plain block
  if (frac > 0.5) {
    collectBandedBuilding(acc, polygon, baseY, totalH, bands, 0.94, 0.2);
  } else {
    // Plain block with parapet
    const parapetH = Math.min(0.25, totalH * 0.05);
    collectExtrudedPolygon(acc, polygon, [], baseY, totalH - parapetH);
    collectParapet(acc, polygon, baseY + totalH - parapetH, parapetH, 1.01);
  }
}

// ── Tier 2: Generic Tall-Tower ────────────────────────────────────────────
// For verified tall buildings (≥100m real) with NO landmark preset.
// Simple tapered box with mild setbacks — NO iconic stepped massing,
// NO spires unless building data explicitly includes one.
// Represents "generic skyscraper" honestly without pretending to be iconic.
function collectGenericTallTower(acc, polygon, tags, baseY, totalH, heightM) {
  const frac = deterministicFrac(polygon);

  // 2 simple setback stages: lower 65% full width, upper 35% at 85% width
  const lowerFrac = 0.65;
  const lowerH = totalH * lowerFrac;
  const upperH = totalH - lowerH;

  // Lower section with window banding
  const lowerBands = Math.max(3, Math.round(lowerH / 1.8));
  collectBandedBuilding(acc, polygon, baseY, lowerH, lowerBands, 0.93, 0.25);

  // Upper section with mild setback
  const upper = shrinkToCentroid(polygon, 0.85);
  if (upper) {
    const upperBands = Math.max(2, Math.round(upperH / 1.8));
    collectBandedBuilding(acc, upper, baseY + lowerH, upperH, upperBands, 0.93, 0.25);
  } else {
    collectExtrudedPolygon(acc, polygon, [], baseY + lowerH, upperH);
  }
}

/** Shrink polygon toward its centroid by `scale` (1.0 = no change). */
function shrinkToCentroid(polygon, scale) {
  if (!polygon || polygon.length < 3) return null;
  let cx = 0, cy = 0;
  for (const p of polygon) { cx += p.x; cy += p.y; }
  cx /= polygon.length; cy /= polygon.length;
  return polygon.map(p => ({
    x: cx + (p.x - cx) * scale,
    y: cy + (p.y - cy) * scale,
  }));
}

/**
 * Compute the principal axis of a polygon via PCA on its vertices.
 * Returns { dx, dy } unit vector along the long axis, plus centroid.
 */
function principalAxis(polygon) {
  let cx = 0, cy = 0;
  for (const p of polygon) { cx += p.x; cy += p.y; }
  cx /= polygon.length; cy /= polygon.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of polygon) {
    const dx = p.x - cx, dy = p.y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  // Eigenvector of [sxx sxy; sxy syy] for the larger eigenvalue
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, tr * tr / 4 - det);
  const lambda = tr / 2 + Math.sqrt(disc);
  let vx, vy;
  if (Math.abs(sxy) > 1e-9) {
    vx = lambda - syy;
    vy = sxy;
  } else {
    vx = sxx >= syy ? 1 : 0;
    vy = sxx >= syy ? 0 : 1;
  }
  const len = Math.hypot(vx, vy);
  if (len < 1e-9) return { dx: 1, dy: 0, cx, cy };
  return { dx: vx / len, dy: vy / len, cx, cy };
}

/**
 * Watertight gable/hip roof. Builds a ridge segment along the polygon's
 * principal long axis through the centroid, then connects every wall edge
 * up to one of the two ridge endpoints. Edges that straddle the long-axis
 * midpoint emit a TWO-triangle fan (slope + hip seam) so the surface stays
 * closed — no empty triangle frames.
 *
 * Roof apex is fully inside the polygon footprint, so there are no eaves /
 * overhangs.
 */
function collectGableHipRoof(acc, polygon, y0, h) {
  const ring = deduplicateRing(polygon);
  if (ring.length < 3) return;
  const outer = ensureCCW(ring);
  const n = outer.length;

  const { dx, dy, cx, cy } = principalAxis(outer);
  const nx = -dy, ny = dx;

  // Project to OBB-aligned coords (u along long axis, v perpendicular)
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  const us = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = outer[i];
    const ox = p.x - cx, oy = p.y - cy;
    const u = ox * dx + oy * dy;
    const v = ox * nx + oy * ny;
    us[i] = u;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const halfWidth = (vMax - vMin) / 2;
  if (halfWidth < 0.3) return; // too thin for a ridge

  // Hip ridge: pull ends inward by halfWidth so slopes meet short walls
  // at the same height as long walls. Clamped so the ridge can't invert.
  const ridgeShrink = Math.min(halfWidth, (uMax - uMin) * 0.45);
  const u0 = uMin + ridgeShrink;
  const u1 = uMax - ridgeShrink;
  const uMid = (u0 + u1) / 2;

  const ridgeAx = cx + dx * u0;
  const ridgeAy = cy + dy * u0;
  const ridgeBx = cx + dx * u1;
  const ridgeBy = cy + dy * u1;
  const yTop = y0 + h;

  const pos = [];
  const idx = [];
  for (const p of outer) pos.push(p.x, y0, -p.y);
  pos.push(ridgeAx, yTop, -ridgeAy); // index n   = RA
  pos.push(ridgeBx, yTop, -ridgeBy); // index n+1 = RB
  const RA = n, RB = n + 1;

  // Per-vertex ridge pick: nearer of RA / RB based on u-coordinate
  const pick = new Array(n);
  for (let i = 0; i < n; i++) pick[i] = us[i] < uMid ? RA : RB;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (pick[i] === pick[j]) {
      // Both vertices on the same side of the seam — single slope triangle
      idx.push(i, j, pick[i]);
    } else {
      // Edge straddles the hip seam — TWO triangles fill the corner cleanly:
      //   1) wall edge → far ridge point  (slope face)
      //   2) wall vertex → far ridge → near ridge  (hip seam patch)
      idx.push(i, j, pick[j]);
      idx.push(i, pick[j], pick[i]);
    }
  }

  acc.add(pos, idx);
}

/**
 * Minimum bounding box dimension of a polygon (smallest of width/height).
 * Used to skip buildings too thin to 3D print.
 */
function minBBoxDimension(poly) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.min(maxX - minX, maxY - minY);
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function flattenWithHoles(outerCCW, holes) {
  const flat = outerCCW.flatMap(p => [p.x, p.y]);
  const holeIndices = [];
  for (const hole of holes) {
    const hr = deduplicateRing(hole);
    if (hr.length < 3) continue;
    holeIndices.push(flat.length / 2);
    ensureCW(hr).forEach(p => flat.push(p.x, p.y));
  }
  return { flat, holeIndices };
}

function pointInHex(pt, hexVerts) {
  const n = hexVerts.length;
  for (let i = 0; i < n; i++) {
    const a = hexVerts[i], b = hexVerts[(i + 1) % n];
    if ((b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x) < -1e-6) return false;
  }
  return true;
}

function parseBuildingHeight(tags, polygon) {
  if (tags.height) {
    const raw = String(tags.height);
    const val = parseFloat(raw);
    if (!isNaN(val) && val > 0 && val < 999) {
      return raw.toLowerCase().includes('ft') ? val * 0.3048 : val;
    }
  }

  if (tags['building:levels']) {
    const l = parseFloat(tags['building:levels']);
    if (!isNaN(l) && l > 0 && l < 200) return l * 3.2;
  }

  const t = tags.building || 'yes';
  let minH, maxH;

  if (t === 'garage' || t === 'garages' || t === 'carport' || t === 'shed' || t === 'hut') {
    minH =  2.5; maxH =  3.5;
  } else if (t === 'bungalow') {
    minH =  3.5; maxH =  4.5;
  } else if (t === 'house' || t === 'detached' || t === 'semidetached_house') {
    minH =  6;   maxH =  9;
  } else if (t === 'terrace' || t === 'farm') {
    minH =  6;   maxH =  11;
  } else if (t === 'industrial' || t === 'warehouse' || t === 'storage_tank') {
    minH =  6;   maxH =  15;
  } else if (t === 'church' || t === 'chapel') {
    minH = 12;   maxH =  22;
  } else if (t === 'cathedral' || t === 'temple') {
    minH = 20;   maxH =  45;
  } else if (t === 'apartments') {
    minH = 10;   maxH =  40;
  } else if (t === 'residential') {
    minH =  7;   maxH =  20;
  } else if (t === 'retail' || t === 'shop') {
    minH =  4;   maxH =  10;
  } else if (t === 'commercial') {
    minH =  8;   maxH =  35;
  } else if (t === 'office') {
    minH = 10;   maxH =  60;
  } else if (t === 'hotel') {
    minH = 12;   maxH =  50;
  } else if (t === 'hospital' || t === 'school' || t === 'university') {
    minH =  8;   maxH =  20;
  } else if (t === 'government' || t === 'public') {
    minH =  8;   maxH =  25;
  } else {
    const area = polygon ? Math.abs(signedArea2D(polygon)) : 100;
    if (area < 80)        { minH =  3;  maxH = 8;  }
    else if (area < 300)  { minH =  6;  maxH = 14; }
    else if (area < 1000) { minH =  9;  maxH = 25; }
    else if (area < 4000) { minH = 12;  maxH = 45; }
    else                  { minH = 15;  maxH = 80; }
  }

  const frac = polygon ? deterministicFrac(polygon) : 0.5;
  return minH + frac * (maxH - minH);
}

function deterministicFrac(polygon) {
  let sx = 0, sy = 0;
  for (const p of polygon) { sx += p.x; sy += p.y; }
  const cx = sx / polygon.length;
  const cy = sy / polygon.length;
  const ix = Math.round(cx * 10) & 0xffff;
  const iy = Math.round(cy * 10) & 0xffff;
  let h = (ix * 2654435761 ^ iy * 2246822519) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffff) / 0xffff;
}

function pointInSimplePolygon(pt, poly) {
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

/**
 * Test if two line segments (a1→a2) and (b1→b2) intersect.
 */
function segmentsIntersect(a1, a2, b1, b2) {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return false; // parallel
  const dx = b1.x - a1.x, dy = b1.y - a1.y;
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * Check if any edge of polygon A intersects any edge of polygon B.
 */
function polygonEdgesIntersect(polyA, polyB) {
  for (let i = 0; i < polyA.length; i++) {
    const a1 = polyA[i], a2 = polyA[(i + 1) % polyA.length];
    for (let j = 0; j < polyB.length; j++) {
      const b1 = polyB[j], b2 = polyB[(j + 1) % polyB.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function offsetPolygon(poly, dist) {
  const n = poly.length;
  if (n < 3) return null;

  const result = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const curr = poly[i];
    const next = poly[(i + 1) % n];

    const e1x = curr.x - prev.x, e1y = curr.y - prev.y;
    const e2x = next.x - curr.x, e2y = next.y - curr.y;
    const l1 = Math.sqrt(e1x * e1x + e1y * e1y);
    const l2 = Math.sqrt(e2x * e2x + e2y * e2y);

    if (l1 < 1e-9 || l2 < 1e-9) {
      result.push({ x: curr.x, y: curr.y });
      continue;
    }

    const n1x = -e1y / l1, n1y = e1x / l1;
    const n2x = -e2y / l2, n2y = e2x / l2;

    let nx = n1x + n2x, ny = n1y + n2y;
    const nl = Math.sqrt(nx * nx + ny * ny);
    if (nl < 1e-9) {
      result.push({ x: curr.x + n1x * dist, y: curr.y + n1y * dist });
      continue;
    }
    nx /= nl; ny /= nl;

    const dot = nx * n1x + ny * n1y;
    const scale = dot > 0.3 ? dist / dot : dist;
    const clamped = Math.min(Math.abs(scale), Math.abs(dist) * 3) * Math.sign(scale);

    result.push({ x: curr.x + nx * clamped, y: curr.y + ny * clamped });
  }

  return result.length >= 3 ? result : null;
}
