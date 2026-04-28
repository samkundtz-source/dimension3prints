/**
 * 3D model assembly — generates buildings FIRST, then fits roads around them.
 *
 * Output: exactly 3 meshes (no more):
 *   1. 'base'     — white solid base plate + terrain (1 mesh)
 *   2. 'building' — white buildings (1 mesh)
 *   3. 'road'     — black roads + water + parks (1 mesh)
 *
 * Water is rendered as flat black slabs ON TOP of the base plate (same as
 * roads). No earcut-with-holes, no pit-carving, no crash risk.
 * Roads that overlap buildings are shrunk to fit rather than disappearing.
 * All geometry is solid (no hollow or degenerate triangles).
 */

import * as THREE from 'three';
import earcut from 'earcut';

import {
  MODEL_RADIUS_MM,
  BASE_THICKNESS_MM,
  ROAD_WIDTHS_M,
  ROAD_MIN_VISUAL_HALF_MM,
  MIN_BUILDING_HEIGHT_MM,
  NOZZLE_MM,
  signedArea2D,
  ensureCCW,
  ensureCW,
  deduplicateRing,
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

export function buildMapModel(features, _elevGrid, projection, vertExag, onProgress, shape = 'hexagon', detailedBuildings = false, premiumDetail = false, parkHills = false, orderId = '', _roadElevation = false, proceduralInfill = false) {
  const group = new THREE.Group();

  const hexFull  = getShapeVertices(MODEL_RADIUS_MM, shape);
  const hexInner = getShapeVertices(MODEL_RADIUS_MM - 5, shape);

  const hScale = projection.horizontalScale;

  // ── 3 combined accumulators — everything merges into these ────────────────
  const baseAcc     = new GeomAccumulator();  // base plate + terrain → white
  const buildingAcc = new GeomAccumulator();  // all buildings → white
  const blackAcc    = new GeomAccumulator();  // roads + water slabs → black

  // ── 0. Pre-collect water polygons ─────────────────────────────────────────
  const hexArea    = Math.abs(signedArea2D(hexFull));
  const waterPolys = [];
  for (const feat of (features.water || [])) {
    let poly;
    try { poly = clipToHex(feat.polygon, hexInner); } catch { continue; }
    if (!poly || poly.length < 3) continue;
    const area = Math.abs(signedArea2D(poly));
    if (area < 1.0)            continue;
    if (area > hexArea * 0.40) continue;
    waterPolys.push(poly);
  }

  // ── Constants ─────────────────────────────────────────────────────────────
  const BASE      = BASE_THICKNESS_MM; // 1.5 mm — always solid, no holes
  const CLEARANCE = 2.0;

  // ── 1. Base plate — always solid, never carved ────────────────────────────
  onProgress?.('Building base plate…', 65);
  collectHexBase(baseAcc, hexFull, premiumDetail ? 0.8 : 0);

  // ── 2. Park hills — procedural domes under green areas ───────────────────
  if (parkHills) {
    onProgress?.('Building park hills…', 68);
    for (const feat of (features.parks || [])) {
      let poly;
      try { poly = clipToHex(feat.polygon, hexInner); } catch { continue; }
      if (!poly || poly.length < 3) continue;
      if (Math.abs(signedArea2D(poly)) < 4.0) continue;
      const tag = feat.tags?.leisure || feat.tags?.landuse || feat.tags?.natural || '';
      let maxH;
      if (tag === 'forest' || feat.tags?.natural === 'wood') maxH = 7.0;
      else if (tag === 'park' || tag === 'garden' || tag === 'recreation_ground') maxH = 5.0;
      else maxH = 3.5;
      collectParkHill(baseAcc, poly, maxH);
    }
  }

  // Road types to render — skip noise (footway, path, cycleway, steps, service)
  const ROAD_TYPES = new Set([
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
  ]);

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

    const heightM      = parseBuildingHeight(bf.tags, bf.polygon);
    const baseHeightMM = clamp(heightM * hScale * BUILD_EXAG, MIN_BUILDING_HEIGHT_MM, MAX_BLDG_MM);
    const baseY        = BASE;
    const heightMM     = baseHeightMM;

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

  // ── 4b. Procedural infill — fill sparse OSM areas using landuse zones ─────
  if (proceduralInfill && features.landuse && features.landuse.length > 0) {
    onProgress?.('Generating procedural infill…', 77);

    // Scale grid step and building size with the horizontal scale so they stay
    // city-block-sized regardless of capture radius.
    const BLOCK_M = 80;   // real-world city block spacing (m)
    const BLDG_W_M = 14;  // typical building width (m)
    const BLDG_D_M = 11;  // typical building depth (m)

    const gridStep = Math.max(4, BLOCK_M * hScale);
    const bldgW    = Math.max(1.5, BLDG_W_M * hScale);
    const bldgD    = Math.max(1.5, BLDG_D_M * hScale);

    let proceduralCount = 0;

    for (const feat of features.landuse) {
      const poly = feat.polygon;
      if (!poly || poly.length < 3) continue;

      const lu = feat.tags?.landuse || 'residential';

      // Bounding box of the landuse polygon
      let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity;
      for (const p of poly) {
        if (p.x < pMinX) pMinX = p.x;
        if (p.x > pMaxX) pMaxX = p.x;
        if (p.y < pMinY) pMinY = p.y;
        if (p.y > pMaxY) pMaxY = p.y;
      }

      for (let gx = pMinX; gx < pMaxX; gx += gridStep) {
        for (let gy = pMinY; gy < pMaxY; gy += gridStep) {
          const h  = proceduralHash(gx, gy);
          const h2 = proceduralHash(gx + 1337, gy + 7919);

          const offsetX = ((h  & 0xff) / 255 - 0.5) * gridStep * 0.5;
          const offsetY = (((h >> 8) & 0xff) / 255 - 0.5) * gridStep * 0.5;
          const wScale  = 0.55 + ((h >> 16) & 0xff) / 255 * 0.9;
          const dScale  = 0.55 + ((h >> 24) & 0xff) / 255 * 0.9;
          const rotDeg  = (h2 & 0x3) * 45; // 0°, 45°, 90°, 135°
          const hFrac   = ((h2 >> 8) & 0xff) / 255;

          const cx = gx + gridStep / 2 + offsetX;
          const cy = gy + gridStep / 2 + offsetY;

          // Must be inside this landuse polygon
          if (!pointInSimplePolygon({ x: cx, y: cy }, poly)) continue;

          // Skip if an existing real building already occupies this cell
          const [gcx, gcy] = gridCell(cx, cy);
          if (gcx >= 0 && gcy >= 0 && gcx < GRID_SIZE && gcy < GRID_SIZE) {
            const bucket = buildingGrid[gridKey(gcx, gcy)];
            if (bucket) {
              let occupied = false;
              for (const bi of bucket) {
                const bf = buildingFootprints[bi];
                if (cx >= bf.bbox.minX && cx <= bf.bbox.maxX &&
                    cy >= bf.bbox.minY && cy <= bf.bbox.maxY) {
                  occupied = true; break;
                }
              }
              if (occupied) continue;
            }
          }

          // Height range by landuse type
          let minHM = 4, maxHM = 10;
          if (lu === 'commercial' || lu === 'retail' || lu === 'civic') { minHM = 5; maxHM = 20; }
          if (lu === 'industrial') { minHM = 4; maxHM = 7; }

          const heightM  = minHM + hFrac * (maxHM - minHM);
          const heightMM = clamp(heightM * hScale * BUILD_EXAG, MIN_BUILDING_HEIGHT_MM, MAX_BLDG_MM);

          const bldgPoly = makeProceduralRect(cx, cy, bldgW * wScale, bldgD * dScale, rotDeg);
          let clipped;
          try { clipped = clipToHex(bldgPoly, hexInner); } catch { continue; }
          if (!clipped || clipped.length < 3) continue;
          if (minBBoxDimension(clipped) < NOZZLE_MM) continue;

          collectExtrudedPolygon(buildingAcc, clipped, [], BASE, heightMM);
          buildingCount++;
          proceduralCount++;

          if (proceduralCount >= 3000) break;
        }
        if (proceduralCount >= 3000) break;
      }
    }

    console.log(`[Infill] ${proceduralCount} procedural buildings from ${features.landuse.length} landuse zones`);
  }

  // ── 5. Roads — hierarchical extrusion heights ────────────────────────────
  // Each road type is extruded to a height proportional to its importance.
  // motorways are tallest (1.4 mm), residential streets shortest (0.6 mm).
  // All heights are capped below MIN_BUILDING_HEIGHT_MM so roads never appear
  // taller than any building. Building avoidance is applied before placing.

  // ── 5. Roads ─────────────────────────────────────────────────────────────
  //
  // Architecture: roads and buildings are separate Three.js meshes. Depth
  // testing naturally occludes roads behind buildings — no earcut-with-holes
  // or building-avoidance geometry is required.
  //
  const ROAD_SLAB    = NOZZLE_MM;
  const MAX_ROAD_AREA = hexArea * 0.06;

  let roadCount = 0;
  onProgress?.('Building roads…', 80);

  for (const feat of features.roads) {
    if (!feat.points || feat.points.length < 2) continue;
    const hw = feat.tags?.highway || 'residential';
    if (!ROAD_TYPES.has(hw)) continue;

    const realHalf = hScale * (ROAD_WIDTHS_M[hw] ?? ROAD_WIDTHS_M.residential);
    const minHalf  = ROAD_MIN_VISUAL_HALF_MM[hw]  ?? ROAD_MIN_VISUAL_HALF_MM.residential;
    const halfW    = Math.max(realHalf, minHalf);

    const fp = feat.points[0];
    const lp = feat.points[feat.points.length - 1];
    if (Math.hypot(fp.x - lp.x, fp.y - lp.y) < halfW * 2.0) continue;

    const raw = bufferLinestring(feat.points, halfW);
    if (!raw || raw.length < 3) continue;

    const clipped = clipToHex(raw, hexInner);
    if (!clipped || clipped.length < 3) continue;

    const area = Math.abs(signedArea2D(clipped));
    if (area < 0.3 || area > MAX_ROAD_AREA) continue;
    if (minBBoxDimension(clipped) < NOZZLE_MM) continue;

    extrudeSlab(blackAcc, clipped, BASE, ROAD_SLAB);
    roadCount++;
  }

  onProgress?.('Building water areas…', 88);
  for (const poly of waterPolys) {
    extrudeSlab(blackAcc, poly, BASE, ROAD_SLAB);
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

function extrudeSlab(acc, polygon, baseY, height) {
  if (!polygon || polygon.length < 3 || height < 1e-4) return false;
  try {
    const ring = deduplicateRing(polygon);
    if (ring.length < 3) return false;
    if (Math.abs(signedArea2D(ring)) < 0.05) return false;

    const outer = ensureCCW(ring);
    const n     = outer.length;

    const flat = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      flat[i * 2]     = outer[i].x;
      flat[i * 2 + 1] = outer[i].y;
    }

    const tris = earcut(flat, null, 2);
    if (!tris || tris.length < 3) return false;
    if (Math.abs(earcut.deviation(flat, null, 2, tris)) > 0.3) return false;

    const topY = baseY + height;
    const pos  = [];
    const idx  = [];

    for (const p of outer) pos.push(p.x, topY, -p.y);
    for (const t of tris)  idx.push(t);

    for (const p of outer) pos.push(p.x, baseY, -p.y);
    for (let t = 0; t < tris.length; t += 3) {
      idx.push(n + tris[t + 2], n + tris[t + 1], n + tris[t]);
    }

    for (const p of outer) pos.push(p.x, topY,  -p.y);
    for (const p of outer) pos.push(p.x, baseY, -p.y);
    for (let i = 0; i < n; i++) {
      const tl = 2 * n + i, tr = 2 * n + (i + 1) % n;
      const bl = 3 * n + i, br = 3 * n + (i + 1) % n;
      idx.push(tl, tr, bl,  bl, tr, br);
    }

    acc.add(pos, idx);
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

/**
 * Procedural park hill — generates a smooth parabolic dome over a park/forest
 * polygon. The dome peaks at the polygon centroid and tapers to zero at the
 * edges, so it blends naturally into the flat base plate. No external data
 * required — entirely procedural.
 *
 * @param {GeomAccumulator} acc     - base accumulator (white mesh)
 * @param {Array}           polygon - clipped park polygon in model mm
 * @param {number}          maxH    - peak dome height in mm
 */
function collectParkHill(acc, polygon, maxH) {
  if (!polygon || polygon.length < 3 || maxH < 0.5) return;

  // Bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  // Centroid
  let cx = 0, cy = 0;
  for (const p of polygon) { cx += p.x; cy += p.y; }
  cx /= polygon.length;
  cy /= polygon.length;

  // Dome radius — slightly larger than bounding-box half-extent so edges taper to near-zero
  const rx = (maxX - minX) * 0.55 + 0.5;
  const ry = (maxY - minY) * 0.55 + 0.5;

  // Grid resolution — ~2mm steps clamped to [5, 48] cells per axis
  const STEP = 2.0;
  const nx = Math.max(5, Math.min(48, Math.ceil((maxX - minX) / STEP) + 2));
  const ny = Math.max(5, Math.min(48, Math.ceil((maxY - minY) / STEP) + 2));

  const BASE = BASE_THICKNESS_MM;

  function domeHeight(x, y) {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return maxH * Math.max(0, 1 - dx * dx - dy * dy); // parabolic falloff
  }

  // Vertex grid
  const pos = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = minX + (i / (nx - 1)) * (maxX - minX);
      const y = minY + (j / (ny - 1)) * (maxY - minY);
      const inPoly = pointInSimplePolygon({ x, y }, polygon);
      const h = inPoly ? domeHeight(x, y) : 0;
      pos.push(x, BASE + h, -y);
    }
  }

  // Triangles — only cells whose centre is inside the polygon
  const idx = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const ccx = minX + ((i + 0.5) / (nx - 1)) * (maxX - minX);
      const ccy = minY + ((j + 0.5) / (ny - 1)) * (maxY - minY);
      if (!pointInSimplePolygon({ x: ccx, y: ccy }, polygon)) continue;
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx.push(a, b, c,  b, d, c);
    }
  }

  if (idx.length === 0) return;
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
    // Reject sub-nozzle polygons before earcut — they produce visible sliver triangles
    if (Math.abs(signedArea2D(ring)) < 0.08) return;
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

function proceduralHash(gx, gy) {
  const ix = Math.round(gx * 100) & 0xffff;
  const iy = Math.round(gy * 100) & 0xffff;
  let h = (ix * 2654435761 ^ iy * 2246822519) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

function makeProceduralRect(cx, cy, w, d, angleDeg) {
  const r = angleDeg * Math.PI / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const hw = w / 2, hd = d / 2;
  return [
    [-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd],
  ].map(([lx, ly]) => ({
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos,
  }));
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

