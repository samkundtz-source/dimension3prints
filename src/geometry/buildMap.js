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

// ─── Colours ──────────────────────────────────────────────────────────────────
// Default: white buildings, black roads. Inverted: black buildings, white roads.
export const FEATURE_COLORS = {
  base:     0xF0F0F0,
  terrain:  0xF0F0F0,
  building: 0xF0F0F0,
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

export function buildMapModel(features, elevGrid, projection, vertExag, onProgress, shape = 'hexagon', invertColors = false) {
  const group = new THREE.Group();

  const hexFull  = getShapeVertices(MODEL_RADIUS_MM, shape);
  const hexInner = getShapeVertices(MODEL_RADIUS_MM - 5, shape);

  const hScale = projection.horizontalScale;
  const vScale = hScale * vertExag;
  const N      = elevGrid ? Math.round(Math.sqrt(elevGrid.length)) : 0;

  // ── 3 combined accumulators — everything merges into these ────────────────
  const baseAcc     = new GeomAccumulator();  // base plate + terrain → white
  const buildingAcc = new GeomAccumulator();  // all buildings → white
  const blackAcc    = new GeomAccumulator();  // roads + paths + parks + water → black

  // ── 1. Base plate ─────────────────────────────────────────────────────────
  onProgress?.('Building base plate…', 65);
  collectHexBase(baseAcc, hexFull);

  // ── 2. Terrain ────────────────────────────────────────────────────────────
  if (elevGrid && N > 0) {
    onProgress?.('Building terrain…', 68);
    collectTerrainMesh(baseAcc, elevGrid, N, hexFull, vScale);
  }

  const BASE        = BASE_THICKNESS_MM;
  const ROAD_HEIGHT = NOZZLE_MM * 1.75; // 0.7mm — slimmer ridge, still prints reliably
  const CLEARANCE   = 1.4; // generous gap around buildings to prevent clipping

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
  const MIN_BLDG_DIM   = NOZZLE_MM; // strictly one nozzle width — anything thinner won't print

  let buildingCount = 0;
  onProgress?.('Extruding buildings…', 74);
  for (const bf of buildingFootprints) {
    // Skip buildings too thin to print
    if (minBBoxDimension(bf.polygon) < MIN_BLDG_DIM) continue;

    const heightM  = parseBuildingHeight(bf.tags, bf.polygon);
    const heightMM = clamp(heightM * hScale * BUILD_EXAG, MIN_BUILDING_HEIGHT_MM, MAX_BLDG_MM);
    // Solid extrusion (no holes) — simple block buildings
    collectExtrudedPolygon(buildingAcc, bf.polygon, [], BASE, heightMM);
    buildingCount++;
  }

  // ── 5. Water (black, RECESSED) — sits lower than roads/buildings ────────
  // Water extrudes from Y=0 up to BASE - WATER_DEPTH, creating a depression.
  // In multi-material slicing, the slicer subtracts this from the white base,
  // producing a real physical divot filled with black filament.
  const MIN_AREA_MM2  = 3.0;
  const WATER_DEPTH   = 1.0; // mm below base surface — deeper for pronounced water
  const WATER_TOP     = Math.max(BASE - WATER_DEPTH, 0.2); // don't go below 0.2mm
  const WATER_SLAB_H  = WATER_TOP; // extrude from Y=0 to WATER_TOP

  let waterCount = 0;
  onProgress?.('Building water…', 78);
  for (const feat of features.water) {
    const poly = clipToHex(feat.polygon, hexInner);
    if (!poly || poly.length < 3) continue;
    if (Math.abs(signedArea2D(poly)) < MIN_AREA_MM2) continue;
    const bldgHoles = findOverlappingBuildings(poly);
    const allHoles  = [...(feat.holes || []), ...bldgHoles];
    // Extrude from bottom (0) to WATER_TOP — sits below base surface
    collectExtrudedPolygon(blackAcc, poly, allHoles, 0, WATER_SLAB_H);
    waterCount++;
  }

  // ── 6. Parks — with building gaps ───────────────────────────────────────────
  // Default (white base, black roads): roads sit ON TOP of the base.
  // Invert (black base, white roads): roads punch THROUGH the base, piercing
  // the entire black slab so the white road network reads from every angle.
  const ROAD_BASE = invertColors ? 0 : BASE;
  const ROAD_SLAB = invertColors ? (BASE + ROAD_HEIGHT) : ROAD_HEIGHT;

  onProgress?.('Building parks…', 80);
  for (const feat of features.parks) {
    const poly = clipToHex(feat.polygon, hexInner);
    if (!poly || poly.length < 3) continue;
    if (Math.abs(signedArea2D(poly)) < MIN_AREA_MM2) continue;
    const bldgHoles = findOverlappingBuildings(poly);
    const allHoles  = [...(feat.holes || []), ...bldgHoles];
    collectExtrudedPolygon(blackAcc, poly, allHoles, ROAD_BASE, ROAD_SLAB);
  }

  // ── 7. Roads — at base bottom, shrink around buildings ────────────────────
  let roadCount = 0;
  onProgress?.('Building roads…', 84);
  for (const feat of features.roads) {
    const hw    = feat.tags.highway || 'residential';
    const realW = hScale * (ROAD_WIDTHS_M[hw] ?? ROAD_WIDTHS_M.residential);
    const minW  = ROAD_MIN_VISUAL_HALF_MM[hw] ?? ROAD_MIN_VISUAL_HALF_MM.residential;
    const halfW = Math.max(realW, minW);
    addRoadWithAvoidance(blackAcc, feat.points, halfW, hexInner, ROAD_BASE, ROAD_SLAB, findOverlappingBuildings);
    roadCount++;
  }

  // ── 8. Paths — at base bottom, shrink around buildings ────────────────────
  onProgress?.('Building paths…', 88);
  for (const feat of features.paths) {
    const hw    = feat.tags.highway || 'path';
    const realW = hScale * (ROAD_WIDTHS_M[hw] ?? ROAD_WIDTHS_M.path);
    const minW  = ROAD_MIN_VISUAL_HALF_MM[hw] ?? ROAD_MIN_VISUAL_HALF_MM.path;
    const halfW = Math.max(realW, minW);
    addRoadWithAvoidance(blackAcc, feat.points, halfW, hexInner, ROAD_BASE, ROAD_SLAB, findOverlappingBuildings);
    roadCount++;
  }

  // ── Build exactly 3 combined meshes ───────────────────────────────────────
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
    stats: { buildings: buildingCount, roads: roadCount, water: waterCount },
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

function collectHexBase(acc, shapeVerts) {
  const pos = [];
  const idx = [];
  const top = BASE_THICKNESS_MM;
  const bot = 0;
  const N = shapeVerts.length;

  // Top face
  pos.push(0, top, 0);
  for (const v of shapeVerts) pos.push(v.x, top, -v.y);
  for (let i = 0; i < N; i++) idx.push(0, 1 + i, 1 + (i + 1) % N);

  // Bottom face
  const bOff = N + 1;
  pos.push(0, bot, 0);
  for (const v of shapeVerts) pos.push(v.x, bot, -v.y);
  for (let i = 0; i < N; i++) idx.push(bOff, bOff + 1 + (i + 1) % N, bOff + 1 + i);

  // Side walls
  for (let i = 0; i < N; i++) {
    const tA = 1 + i, tB = 1 + (i + 1) % N;
    const bA = bOff + 1 + i, bB = bOff + 1 + (i + 1) % N;
    idx.push(tA, bA, tB,  bA, bB, tB);
  }

  acc.add(pos, idx);
}

function collectTerrainMesh(acc, elevGrid, N, hexVerts, vScale) {
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
      pos.push(x, BASE_THICKNESS_MM + elev, -y);
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
