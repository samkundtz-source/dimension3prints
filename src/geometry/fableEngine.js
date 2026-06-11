/**
 * fableEngine.js — the FABLE generation system (admin beta).
 *
 * Design synthesis from the strongest published pipelines:
 *   • TouchTerrain (Harding & Hasiuk, Iowa State): raster grid → top mesh +
 *     walls + floor = watertight BY CONSTRUCTION. The most print-reliable
 *     approach known — but terrain-only, no feature classes.
 *   • Map2Model / OSM2World: crisp vector extrusion per feature — beautiful
 *     buildings, but the documented failure mode is exactly what we saw:
 *     overlapping parts and non-manifold contacts needing repair.
 *
 * FABLE'S THESIS — take the best of both:
 *   The GROUND is a single MUTUALLY-EXCLUSIVE class raster (road > water >
 *   park, one owner per cell, so overlaps and z-fighting between ground
 *   features are impossible by construction), extracted as smooth conforming
 *   solids; BUILDINGS stay sharp vector prisms on top.
 *
 *   1. One 384² grid over the tile. Roads stamp a true signed-distance field
 *      (max-union capsules → rounded joins). Water and park polygons scanline-
 *      fill indicator fields, then get one smoothing pass so shorelines round
 *      off instead of stair-stepping.
 *   2. Priority masking: water loses to roads (bridges/causeways read
 *      continuous), parks lose to both. One owner per cell.
 *   3. Each class becomes ONE manifold draped solid via the grid-conforming
 *      extractor (netMesh.buildFieldMesh — verified 0 non-manifold edges on
 *      axis grids, spaghetti networks, and hex boards).
 *   4. Heights: roads ride a longitudinally-smoothed grade clamped above sea
 *      level; water lies flat at its stamped level; parks drape the terrain.
 *   5. Terrain + buildings come from the proven V2 path (blackLayer:false),
 *      so prints keep the same white body, base, and M3 pockets.
 */

import * as THREE from 'three';
import { MODEL_RADIUS_MM, BASE_THICKNESS_MM, ensureCCW } from '../utils/helpers.js';
import { getShapeVertices } from '../geo/geoMath.js';
import { buildMapModelV2, makeHeightField, Acc, ROAD_HALF_W } from './mapEngine.js';
import { rasterizeNetwork, buildFieldMesh } from './netMesh.js';

const R = MODEL_RADIUS_MM;
const BASE = BASE_THICKNESS_MM;
const N = 384;                       // ground raster (0.34mm cells < nozzle)
const SEA_LEVEL_Y = BASE + 0.2;      // mirrors the V2 constant

// ── small helpers ────────────────────────────────────────────────────────────
function boardInsideFn(shape) {
  if (shape !== 'hexagon' && shape !== 'circle') {
    const CLIP = R - 0.05;
    return (x, y) => Math.min(CLIP - Math.abs(x), CLIP - Math.abs(y));
  }
  const ring = ensureCCW(getShapeVertices(R - 0.05, shape, 0));
  return (x, y) => {
    let d = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      const ex = b.x - a.x, ey = b.y - a.y;
      const L = Math.hypot(ex, ey) || 1;
      const c = (ex * (y - a.y) - ey * (x - a.x)) / L;
      if (c < d) d = c;
    }
    return d;
  };
}

// Scanline-fill a polygon into grid cells (even-odd). Calls set(k) per cell.
function fillPolygon(ring, set) {
  const step = (2 * R) / (N - 1);
  let minY = Infinity, maxY = -Infinity;
  for (const p of ring) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  const j0 = Math.max(0, Math.ceil((minY + R) / step));
  const j1 = Math.min(N - 1, Math.floor((maxY + R) / step));
  for (let j = j0; j <= j1; j++) {
    const y = -R + j * step;
    const xs = [];
    for (let i = 0, q = ring.length - 1; i < ring.length; q = i++) {
      const a = ring[q], b = ring[i];
      if ((a.y > y) !== (b.y > y)) {
        xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
      }
    }
    xs.sort((p, qq) => p - qq);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] + R) / step));
      const i1 = Math.min(N - 1, Math.floor((xs[s + 1] + R) / step));
      for (let i = i0; i <= i1; i++) set(j * N + i);
    }
  }
}

// One 3×3 smoothing pass over a ±1 indicator → zero-crossing between cells →
// marching squares interpolates a rounded shoreline instead of stair-steps.
function smoothIndicator(src) {
  const out = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let sum = 0, cnt = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= N) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= N) continue;
          sum += src[jj * N + ii]; cnt++;
        }
      }
      out[j * N + i] = sum / cnt;
    }
  }
  return out;
}

// ── public entry — same signature as buildMapModelV2 ────────────────────────
export function buildMapModelFable(features, terrainOptions, projection, vertExag, onProgress, shape = 'square') {
  onProgress?.('Fable: white body (terrain + buildings)…', 62);

  // 1. Terrain + buildings + base from the proven V2 path. Water features are
  //    still passed so the sea carve under the surface happens as usual.
  const white = buildMapModelV2(features, terrainOptions, projection, vertExag,
    () => {}, shape, { blackLayer: false });

  // Height field for class heights (same parameters V2 used internally).
  const mmPerM = projection.horizontalScale * Math.max(1, vertExag);
  let hf = null;
  if (terrainOptions?.elevGrid && terrainOptions.gridSize) {
    hf = makeHeightField(terrainOptions.elevGrid, terrainOptions.gridSize, mmPerM, terrainOptions.norm || null);
  }
  const groundAt = (x, y) => (hf ? hf.heightAt(x, y) : BASE);

  const inside = boardInsideFn(shape);
  const step = (2 * R) / (N - 1);

  onProgress?.('Fable: rasterising ground classes…', 68);

  // 2a. ROADS — true SDF (smooth, per-class widths), wins every cell it touches.
  const allRoads = [...(features.roads || []), ...(features.paths || [])];
  const roadF = rasterizeNetwork(allRoads, N, R,
    (road) => ROAD_HALF_W[road.tags?.highway] ?? 0.55, inside);

  // 2b. WATER — indicator + per-cell level (flat per polygon: sea at the fixed
  //     sea line, inland lakes at their local low percentile, like V2).
  const PLATE_AREA = (2 * R) * (2 * R);
  const waterInd = new Float32Array(N * N).fill(-1);
  const waterLvl = new Float32Array(N * N).fill(SEA_LEVEL_Y);
  let nWaterPolys = 0;
  for (const w of (features.water || [])) {
    const poly = w.polygon;
    if (!poly || poly.length < 3) continue;
    let area = 0;
    for (let i = 0, q = poly.length - 1; i < poly.length; q = i++) {
      area += (poly[q].x + poly[i].x) * (poly[q].y - poly[i].y);
    }
    area = Math.abs(area / 2);
    if (!w.isSea && area > PLATE_AREA * 0.92) continue;   // blanket guard
    let level = SEA_LEVEL_Y;
    if (!w.isSea && hf) {
      const hs = [];
      for (const p of poly) hs.push(hf.heightAt(p.x, p.y));
      hs.sort((a, b) => a - b);
      level = hs[Math.floor(hs.length * 0.2)] + 0.15;
    }
    fillPolygon(poly, (k) => { waterInd[k] = 1; waterLvl[k] = level; });
    nWaterPolys++;
  }

  // 2c. PARKS — indicator.
  const parkInd = new Float32Array(N * N).fill(-1);
  let nParkPolys = 0;
  for (const pk of (features.parks || [])) {
    const poly = pk.polygon;
    if (!poly || poly.length < 3) continue;
    fillPolygon(poly, (k) => { parkInd[k] = 1; });
    nParkPolys++;
  }

  // 3. Priority masking → one owner per cell → overlaps impossible.
  //    (Applied BEFORE smoothing so the smoothed shoreline respects roads.)
  for (let k = 0; k < N * N; k++) {
    if (roadF[k] > 0) { waterInd[k] = -1; parkInd[k] = -1; }
    else if (waterInd[k] > 0) parkInd[k] = -1;
  }
  const waterS = smoothIndicator(waterInd);
  const parkS = smoothIndicator(parkInd);
  // Board + road re-clamp after smoothing (blur bleeds half a cell).
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const b = inside(-R + i * step, -R + j * step);
      if (b < 0) { waterS[k] = -1; parkS[k] = -1; }
      if (roadF[k] > 0.05) { waterS[k] = -1; parkS[k] = -1; }
    }
  }

  onProgress?.('Fable: extracting unified ground solids…', 78);

  // 4. Heights + extraction — three manifold solids in the detail colour.
  const blackAcc = new Acc();

  const floorY = SEA_LEVEL_Y + 0.25;
  const roadTop = (x, y) => {
    if (!hf) return BASE + 1.0;
    const d = 1.4;
    let h = (hf.heightAt(x, y) + hf.heightAt(x + d, y) + hf.heightAt(x - d, y)
           + hf.heightAt(x, y + d) + hf.heightAt(x, y - d)) / 5;
    if (h < floorY) h = floorY;
    return h + 1.0;
  };
  const roadCells = buildFieldMesh(blackAcc, roadF, {
    R, gridN: N, topAt: roadTop, bottomDrop: 1.6,
  });

  const lvlAt = (x, y) => {
    let i = Math.round((x + R) / step), j = Math.round((y + R) / step);
    if (i < 0) i = 0; else if (i > N - 1) i = N - 1;
    if (j < 0) j = 0; else if (j > N - 1) j = N - 1;
    return waterLvl[j * N + i];
  };
  const waterCells = buildFieldMesh(blackAcc, waterS, {
    R, gridN: N, topAt: lvlAt, bottomDrop: 0.8,
  });

  const parkCells = buildFieldMesh(blackAcc, parkS, {
    R, gridN: N, topAt: (x, y) => groundAt(x, y) + 0.35, bottomDrop: 1.2,
  });

  const blackMesh = blackAcc.build('road');

  const group = new THREE.Group();
  group.add(white.group);
  if (blackMesh) group.add(blackMesh);

  onProgress?.('Fable: done', 92);
  return {
    group,
    stats: {
      ...white.stats,
      roads: allRoads.length,
      water: nWaterPolys,
      parks: nParkPolys,
      groundCells: roadCells + waterCells + parkCells,
      engine: 'fable-beta',
    },
    norm: white.norm,
  };
}
