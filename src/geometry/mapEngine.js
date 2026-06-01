/**
 * mapEngine.js — NEW terrain-fused map engine (from-scratch rewrite, beta).
 *
 * Core idea that the old pipeline lacked: every feature is DRAPED onto a real
 * elevation surface, producing one cohesive 3-D landscape instead of flat
 * boxes on a flat plate. Data (OSM or Overture) + terrain elevation → mesh.
 *
 *   1. Terrain surface  — N×N displaced grid from the elevation field, walls +
 *      floor make it a solid printable block.
 *   2. Buildings        — extruded from the terrain height under their footprint
 *      (so they sit ON the hills, never float, never sink).
 *   3. Roads / water    — draped polylines/polygons that follow the terrain.
 *
 * Returns the SAME contract as buildMapModel: { group, stats }. Meshes are
 * tagged with userData.featureType so the existing SceneManager materials apply.
 *
 * Phase 1 targets the SQUARE shape (regular grid → perfectly clean edges).
 * Hex/circle terrain clipping is the next step.
 */

import * as THREE from 'three';
import earcut from 'earcut';
import { MODEL_RADIUS_MM, BASE_THICKNESS_MM, bilinearInterp } from '../utils/helpers.js';
import { getShapeVertices } from '../geo/geoMath.js';

const R = MODEL_RADIUS_MM;           // model half-width (mm)
const BASE = BASE_THICKNESS_MM;      // solid floor thickness (mm)
const BUILDING_VSCALE = 0.5;         // halve building height (raw was too tall)

// ─── Geometry accumulator (same pattern as buildMap) ────────────────────────
class Acc {
  constructor() { this.pos = []; this.idx = []; this.n = 0; }
  add(pos, idx) {
    const base = this.n;
    for (let i = 0; i < pos.length; i++) this.pos.push(pos[i]);
    for (let i = 0; i < idx.length; i++) this.idx.push(idx[i] + base);
    this.n += pos.length / 3;
  }
  build(featureType) {
    if (!this.pos.length || !this.idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(this.pos), 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array(this.idx), 1));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo);
    mesh.userData.featureType = featureType;
    return mesh;
  }
}

// ─── Small helpers ──────────────────────────────────────────────────────────
function centroidOf(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p.x; y += p.y; }
  return { x: x / poly.length, y: y / poly.length };
}

function parseHeightM(tags) {
  if (tags?.height) { const v = parseFloat(tags.height); if (v > 0) return v; }
  if (tags?.['building:levels']) { const v = parseFloat(tags['building:levels']); if (v > 0) return v * 3.2; }
  return 8; // default ~2.5 storeys
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
function ensureCCW(poly) { return signedArea(poly) < 0 ? poly.slice().reverse() : poly; }

// ── Clip boundary (inset a hair so features never poke past the terrain wall) ──
// Phase 1 = square; swapping this polygon to a hexagon/circle is all that's
// needed for those shapes later.
// Feature clip inset. Was R−0.5, which left an empty ring of plate around the
// generation (ugly border bigger than the city). ~R so features fill the plate
// edge-to-edge; a hair of inset keeps cut walls from z-fighting the plate wall.
const CLIP = R - 0.05;

// Active board boundary (CCW convex polygon in model mm). null = square (the
// fast axis-aligned path below). Set per-build by buildMapModelV2 for hex/circle.
let BOUNDARY = null;

// Clip a polygon to the active board shape. Square → fast axis path; otherwise
// the generic convex clipper against BOUNDARY.
function clipPolyToSquare(poly) {
  if (BOUNDARY) return clipPolyToConvex(poly, BOUNDARY);
  let out = poly;
  const edges = [
    (p) => p.x >= -CLIP, (a, b) => lerpAt(a, b, 'x', -CLIP),
    (p) => p.x <=  CLIP, (a, b) => lerpAt(a, b, 'x',  CLIP),
    (p) => p.y >= -CLIP, (a, b) => lerpAt(a, b, 'y', -CLIP),
    (p) => p.y <=  CLIP, (a, b) => lerpAt(a, b, 'y',  CLIP),
  ];
  for (let e = 0; e < edges.length; e += 2) {
    const inside = edges[e], isect = edges[e + 1];
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const A = out[i], B = out[(i + 1) % out.length];
      const aIn = inside(A), bIn = inside(B);
      if (aIn) next.push(A);
      if (aIn !== bIn) next.push(isect(A, B));
    }
    out = next;
    if (out.length < 3) return null;
  }
  return out;
}
function lerpAt(a, b, axis, val) {
  const other = axis === 'x' ? 'y' : 'x';
  const t = (val - a[axis]) / ((b[axis] - a[axis]) || 1e-9);
  return { [axis]: val, [other]: a[other] + (b[other] - a[other]) * t };
}

// ── Generic convex-boundary clipping (for hexagon / circle board shapes) ─────
// `boundary` is a CCW convex polygon (hex = 6 verts, circle = 64). These mirror
// the square clippers but work for any convex shape, so buildings/roads/water/
// terrain all stop cleanly at a hex or circle edge.
function insideEdge(p, a, b) {
  // CCW polygon: inside = left of edge a→b (cross ≥ 0)
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1e-9;
}
function edgeIntersect(p1, p2, a, b) {
  const r = { x: p2.x - p1.x, y: p2.y - p1.y };
  const s = { x: b.x - a.x, y: b.y - a.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-12) return { ...p2 };
  const t = ((a.x - p1.x) * s.y - (a.y - p1.y) * s.x) / denom;
  return { x: p1.x + t * r.x, y: p1.y + t * r.y };
}
// Sutherland–Hodgman against an arbitrary CCW convex boundary.
function clipPolyToConvex(poly, boundary) {
  let out = poly;
  const n = boundary.length;
  for (let e = 0; e < n; e++) {
    const a = boundary[e], b = boundary[(e + 1) % n];
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const A = out[i], B = out[(i + 1) % out.length];
      const aIn = insideEdge(A, a, b), bIn = insideEdge(B, a, b);
      if (aIn) next.push(A);
      if (aIn !== bIn) next.push(edgeIntersect(A, B, a, b));
    }
    out = next;
    if (out.length < 3) return null;
  }
  return out;
}
// Clip a segment to a convex boundary (optionally inset by `margin`).
function clipSegmentToConvex(a, b, boundary, margin) {
  // Inset the boundary toward its centroid by margin, then Liang–Barsky-style
  // half-plane clip against each inset edge.
  let cx = 0, cy = 0;
  for (const v of boundary) { cx += v.x; cy += v.y; }
  cx /= boundary.length; cy /= boundary.length;
  const m = margin || 0;
  let p0 = { ...a }, p1 = { ...b };
  const n = boundary.length;
  for (let e = 0; e < n; e++) {
    let A = boundary[e], B = boundary[(e + 1) % n];
    if (m) {
      const push = (v) => { const dx = cx - v.x, dy = cy - v.y, L = Math.hypot(dx, dy) || 1; return { x: v.x + dx / L * m, y: v.y + dy / L * m }; };
      A = push(A); B = push(B);
    }
    const in0 = insideEdge(p0, A, B), in1 = insideEdge(p1, A, B);
    if (!in0 && !in1) return null;
    if (in0 && !in1) p1 = edgeIntersect(p0, p1, A, B);
    else if (!in0 && in1) p0 = edgeIntersect(p0, p1, A, B);
  }
  return [p0, p1];
}
function polyCentroidConvex(poly) {
  let cx = 0, cy = 0; for (const p of poly) { cx += p.x; cy += p.y; }
  return { x: cx / poly.length, y: cy / poly.length };
}

// Clip a polyline to the square, returning an array of inside sub-segments
// [{x,y},{x,y}] so roads stop cleanly at the border instead of shooting past.
function clipSegmentToSquare(a, b, clipMargin) {
  if (BOUNDARY) return clipSegmentToConvex(a, b, BOUNDARY, clipMargin || 0);
  // Liang–Barsky against [-(CLIP-margin), CLIP-margin]². The margin lets road
  // slabs (which add ±half-width perpendicular to the centreline) keep their
  // EDGES inside the border instead of poking past it.
  const lim = CLIP - (clipMargin || 0);
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x + lim, lim - a.x, a.y + lim, lim - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; }
    else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else          { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy },
  ];
}

// ─── Terrain height field ───────────────────────────────────────────────────
// Maps model (x,y) ∈ [-R,R]² → surface height (mm). elevGrid is the raw metres
// field (N×N, row-major). We normalise so the lowest point sits at `baseTop`.
// MAX_RELIEF_MM caps how tall the terrain RELIEF can get, independent of the
// raw elevation × vScale product. Without this, a city on a plateau (NYC) or a
// big vertExag balloons the surface — and since the printed base hangs below
// it, the whole model becomes a giant solid block wasting filament. We scale
// the real relief into this budget instead.
// Keep terrain relief small so the model stays a thin, tile-able slab. Coastal
// cities have sea at elevation 0, which would otherwise push all the land up
// onto a tall plateau. 5mm of relief is plenty to read hills while keeping the
// base thin enough to print many and connect them.
const MAX_RELIEF_MM = 5;    // tallest terrain bump above the lowest point

// Box-blur an N×N row-major grid `passes` times → smooths sharp elevation
// steps so terrain reads as gradual slopes, not printed cliffs.
function boxBlurGrid(grid, N, passes) {
  // Fill missing/NaN cells with the MEAN of valid cells (not 0) — using 0 made
  // any data gap collapse to sea level, punching false pits/drops into elevated
  // terrain. The mean keeps gaps flush with their surroundings.
  let sum0 = 0, cnt0 = 0;
  for (let k = 0; k < grid.length; k++) { if (Number.isFinite(grid[k])) { sum0 += grid[k]; cnt0++; } }
  const fill = cnt0 ? sum0 / cnt0 : 0;
  let cur = Array.from(grid, v => (Number.isFinite(v) ? v : fill));
  for (let p = 0; p < passes; p++) {
    const next = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let sum = 0, cnt = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = i + di, nj = j + dj;
            if (ni < 0 || ni >= N || nj < 0 || nj >= N) continue;
            sum += cur[nj * N + ni]; cnt++;
          }
        }
        next[j * N + i] = sum / cnt;
      }
    }
    cur = next;
  }
  return cur;
}

function makeHeightField(elevGrid, N, vScaleMMperM, normOverride = null) {
  // Use ROBUST low/high (5th/95th percentile) instead of absolute min/max so a
  // patch of sea (elevation 0) or a single spike doesn't drag the whole land
  // onto a plateau / flatten the relief. This keeps coastal cities thin.
  // Normalise against the 2nd/98th percentile — wide enough to keep the FULL
  // gradual relief (so hills flow continuously, no squash), but trims only
  // extreme single-cell spikes. We do NOT hard-clamp per vertex (that caused
  // the "hill then a sudden cliff/jump"); instead the whole range is scaled
  // smoothly and capped only in total height by MAX_RELIEF_MM.
  // Smooth the elevation grid with a few box-blur passes so real-world steps
  // (cliffs, sudden drops near water/edges) flow into gradual slopes instead of
  // printing as vertical walls. N = grid dim. Operates on a copy.
  elevGrid = boxBlurGrid(elevGrid, N, 4);

  let lo, hi;
  if (normOverride && Number.isFinite(normOverride.lo) && Number.isFinite(normOverride.hi)) {
    // CONNECTED TILES: every tile shares ONE elevation mapping (the anchor's lo/
    // hi) so a given real elevation → the same model height in every tile. This
    // is what makes the surface continuous across seams — no step/drop where two
    // printed tiles meet.
    lo = normOverride.lo; hi = normOverride.hi;
  } else {
    const sorted = Array.from(elevGrid).filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length) {
      lo = sorted[Math.floor(sorted.length * 0.02)];
      hi = sorted[Math.floor(sorted.length * 0.98)];
    } else { lo = 0; hi = 0; }
  }
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 0; }
  if (hi < lo) hi = lo;
  const span = hi - lo;
  // Relief scale: use vScale, but clamp so total relief never exceeds the
  // budget. Flat cities (NYC ≈ a few m of span) get ~0 relief → thin base.
  let relief = span * vScaleMMperM;
  const reliefScale = relief > MAX_RELIEF_MM ? (MAX_RELIEF_MM / relief) : 1;
  const effScale = vScaleMMperM * reliefScale;
  const baseTop = BASE;   // terrain low point sits exactly at the base-plate top
  return {
    lo, hi,
    reliefMM: Math.min(relief, MAX_RELIEF_MM),
    heightAt(x, y) {
      const e = bilinearInterp(elevGrid, N, x, y, R);
      // Continuous mapping (no hard clamp → no cliffs). Only clamp the FLOOR at
      // the base so terrain never dips below the plate; the top is free to vary
      // smoothly (total height already bounded by effScale/MAX_RELIEF_MM).
      let h = baseTop + (e - lo) * effScale;
      if (h < baseTop) h = baseTop;
      return Number.isFinite(h) ? h : baseTop;
    },
  };
}

// ─── Terrain surface mesh (square) ──────────────────────────────────────────
// Displaced grid top + perimeter walls + flat floor = solid printable block.
// pointInPolys: true if (x,y) is inside ANY of the given polygons (ray cast).
function pointInPolys(x, y, polys) {
  for (const poly of polys) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

// Build a LAND mask from building footprints: grid vertices on/near a building
// are land → water is forbidden there. Dilated so dense city blocks read as
// solid land, not flooded between buildings. idx = j*(GN+1)+i.
function buildLandMask(buildings, GN) {
  const W = GN + 1;
  const mask = new Uint8Array(W * W);
  const toI = (v) => Math.round((v + R) / (2 * R) * GN);
  for (const b of (buildings || [])) {
    const poly = b.polygon;
    if (!poly || poly.length < 3) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const i0 = Math.max(0, toI(minX) - 1), i1 = Math.min(GN, toI(maxX) + 1);
    const j0 = Math.max(0, toI(minY) - 1), j1 = Math.min(GN, toI(maxY) + 1);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) mask[j * W + i] = 1;
  }
  // Dilate by 1 cell so water keeps a margin from the city.
  const out = mask.slice();
  for (let j = 0; j <= GN; j++)
    for (let i = 0; i <= GN; i++) {
      if (!mask[j * W + i]) continue;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ni = i + di, nj = j + dj;
          if (ni >= 0 && ni <= GN && nj >= 0 && nj <= GN) out[nj * W + ni] = 1;
        }
    }
  return out;
}

// Compute a WATER mask: a grid vertex is water iff it's inside a water polygon
// AND not land (buildings). idx = j*(GN+1)+i.
function buildWaterMask(GN, waterPolys, landMask) {
  const W = GN + 1;
  const mask = new Uint8Array(W * W);
  if (!waterPolys || !waterPolys.length) return mask;
  const step = (2 * R) / GN;
  for (let j = 0; j <= GN; j++) {
    for (let i = 0; i <= GN; i++) {
      const idx = j * W + i;
      if (landMask[idx]) continue;                       // city/land → never water
      const x = -R + i * step, y = -R + j * step;
      if (pointInPolys(x, y, waterPolys)) mask[idx] = 1;
    }
  }
  return mask;
}

// collectTerrain CARVES the surface down to `carveY` at any vertex flagged in
// waterMask, so flat water fills the depression and detailed terrain can't poke
// through. Land/building cells keep their normal height.
// `seaRings` (optional): clamp terrain height DOWN to `clampY` wherever a grid
// vertex falls inside a SEA polygon, so coastal humps don't poke through the
// flat sea. Uses point-in-polygon against the real (smooth) sea polygon, so the
// clamp boundary matches the water exactly. Clamp = min(h, clampY): natural
// low seabed is kept, only humps are lowered. When seaRings is empty (inland
// cities), the terrain is completely untouched.
function collectTerrain(acc, hf, GN, seaRings, clampY) {
  // Hex/circle board: build a SHAPED terrain (clipped top + shaped floor +
  // boundary walls). Square keeps the fast original path below.
  if (BOUNDARY) { collectTerrainShaped(acc, hf, GN, seaRings, clampY, BOUNDARY); return; }
  const step = (2 * R) / GN;
  const xy = (i) => -R + i * step;
  const hasSea = seaRings && seaRings.length > 0;

  // Top surface vertices (clamped down inside sea polygons)
  const topIdx = [];
  for (let j = 0; j <= GN; j++) {
    for (let i = 0; i <= GN; i++) {
      const x = xy(i), y = xy(j);
      let h = hf.heightAt(x, y);
      if (hasSea && h > clampY && pointInPolys(x, y, seaRings)) h = clampY;
      topIdx.push(acc.n);
      acc.pos.push(x, h, -y);
      acc.n++;
    }
  }
  const at = (i, j) => topIdx[j * (GN + 1) + i];
  // Top triangles
  for (let j = 0; j < GN; j++) {
    for (let i = 0; i < GN; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      acc.idx.push(a, c, b,  a, d, c);
    }
  }

  // Floor: a THIN slab — sits just below the terrain low point, NOT at y=0.
  // Terrain low point is at BASE (1.5mm); floor at 0 → only ~1.5mm of solid
  // base under the lowest terrain, instead of a tens-of-mm block. This is the
  // filament-saving fix: base thickness is now constant regardless of how high
  // the city's elevation reads.
  const FLOOR_Y = 0;   // base-plate bottom (terrain low point is at BASE above it)
  const floorIdx = [];
  for (let j = 0; j <= GN; j++) {
    for (let i = 0; i <= GN; i++) {
      const x = xy(i), y = xy(j);
      floorIdx.push(acc.n);
      acc.pos.push(x, FLOOR_Y, -y);
      acc.n++;
    }
  }
  const fat = (i, j) => floorIdx[j * (GN + 1) + i];
  for (let j = 0; j < GN; j++) {
    for (let i = 0; i < GN; i++) {
      const a = fat(i, j), b = fat(i + 1, j), c = fat(i + 1, j + 1), d = fat(i, j + 1);
      acc.idx.push(a, b, c,  a, c, d);
    }
  }

  // Perimeter walls: connect top edge ring to floor edge ring
  const wall = (i0, j0, i1, j1) => {
    const t0 = at(i0, j0), t1 = at(i1, j1), b0 = fat(i0, j0), b1 = fat(i1, j1);
    acc.idx.push(t0, b0, t1,  t1, b0, b1);
  };
  for (let i = 0; i < GN; i++) wall(i + 1, 0, i, 0);      // south edge (y=-R)
  for (let i = 0; i < GN; i++) wall(i, GN, i + 1, GN);    // north edge (y=+R)
  for (let j = 0; j < GN; j++) wall(0, j, 0, j + 1);      // west edge (x=-R)
  for (let j = 0; j < GN; j++) wall(GN, j + 1, GN, j);    // east edge (x=+R)
}

// Shaped terrain for hex/circle boards. Top = grid cells clipped to the convex
// boundary (smooth edge); floor = boundary at y=0; walls = boundary edges from
// floor up to the terrain height. DoubleSide material → winding-agnostic.
function collectTerrainShaped(acc, hf, GN, seaRings, clampY, boundary) {
  const step = (2 * R) / GN;
  const xy = (i) => -R + i * step;
  const hasSea = seaRings && seaRings.length > 0;
  const hAt = (x, y) => {
    let h = hf.heightAt(x, y);
    if (hasSea && h > clampY && pointInPolys(x, y, seaRings)) h = clampY;
    return h;
  };
  // ── Top surface: clip each cell to the boundary ──
  for (let j = 0; j < GN; j++) {
    for (let i = 0; i < GN; i++) {
      const x0 = xy(i), x1 = xy(i + 1), y0 = xy(j), y1 = xy(j + 1);
      const cell = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      const poly = clipPolyToConvex(cell, boundary);
      if (!poly || poly.length < 3) continue;
      const s = acc.n;
      for (const p of poly) { acc.pos.push(p.x, hAt(p.x, p.y), -p.y); acc.n++; }
      for (let t = 1; t < poly.length - 1; t++) acc.idx.push(s, s + t, s + t + 1);
    }
  }

  // ── Floor (boundary at y=0) ──
  const bflat = [];
  for (const p of boundary) bflat.push(p.x, p.y);
  const btris = earcut(bflat, [], 2);
  const fs = acc.n;
  for (const p of boundary) { acc.pos.push(p.x, 0, -p.y); acc.n++; }
  for (let t = 0; t < btris.length; t += 3) acc.idx.push(fs + btris[t + 2], fs + btris[t + 1], fs + btris[t]);

  // ── Walls along each boundary edge (floor → terrain height) ──
  const n = boundary.length;
  for (let e = 0; e < n; e++) {
    const a = boundary[e], b = boundary[(e + 1) % n];
    const k = acc.n;
    acc.pos.push(a.x, hAt(a.x, a.y), -a.y);
    acc.pos.push(b.x, hAt(b.x, b.y), -b.y);
    acc.pos.push(b.x, 0, -b.y);
    acc.pos.push(a.x, 0, -a.y);
    acc.n += 4;
    acc.idx.push(k, k + 1, k + 2,  k, k + 2, k + 3);
  }
}

// ─── Flat base (no-terrain fallback) ────────────────────────────────────────
function collectFlatBase(acc) {
  // Hex/circle → shaped plate; square → original.
  if (BOUNDARY) { collectPrism(acc, BOUNDARY, 0, BASE); return; }
  const sq = [
    { x: -R, y: -R }, { x: R, y: -R }, { x: R, y: R }, { x: -R, y: R },
  ];
  collectPrism(acc, sq, 0, BASE);
}

// ─── Generic prism extrusion (footprint from baseY up by h) ─────────────────
// Walls use INDEPENDENT vertices (not shared with the top/bottom caps) so
// computeVertexNormals produces flat, crisp edges instead of a melted look.
function collectPrism(acc, poly, baseY, h) {
  const ring = ensureCCW(poly);
  if (ring.length < 3) return;
  // Guard: any non-finite coord or base/height blanks the whole mesh in Three.
  if (!Number.isFinite(baseY) || !Number.isFinite(h)) return;
  for (const p of ring) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  const flat = [];
  for (const p of ring) flat.push(p.x, p.y);
  const tris = earcut(flat, [], 2);
  if (!tris.length) return;
  const top = baseY + h;
  const nV = ring.length;

  // ── Top cap (own verts) ──
  const topStart = acc.n;
  for (const p of ring) { acc.pos.push(p.x, top, -p.y); acc.n++; }
  for (let t = 0; t < tris.length; t += 3) {
    acc.idx.push(topStart + tris[t], topStart + tris[t + 1], topStart + tris[t + 2]);
  }
  // ── Bottom cap (own verts, reversed winding) ──
  const botStart = acc.n;
  for (const p of ring) { acc.pos.push(p.x, baseY, -p.y); acc.n++; }
  for (let t = 0; t < tris.length; t += 3) {
    acc.idx.push(botStart + tris[t + 2], botStart + tris[t + 1], botStart + tris[t]);
  }
  // ── Walls: each quad gets its own 4 verts → flat-shaded crisp faces.
  // Buildings render DoubleSide, so winding can't cause see-through walls. ──
  for (let i = 0; i < nV; i++) {
    const a = ring[i], c = ring[(i + 1) % nV];
    const s = acc.n;
    acc.pos.push(a.x, top,   -a.y);   // 0 top-a
    acc.pos.push(c.x, top,   -c.y);   // 1 top-c
    acc.pos.push(c.x, baseY, -c.y);   // 2 bot-c
    acc.pos.push(a.x, baseY, -a.y);   // 3 bot-a
    acc.n += 4;
    acc.idx.push(s, s + 1, s + 2,  s, s + 2, s + 3);
  }
}

// ─── Building shape classification (DATA-DRIVEN, never random) ───────────────
// Decides each building's form from its real OSM tags + footprint geometry.
// A building only gets a non-box shape when the data actually supports it.

function bboxOf(poly) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
}
function polyArea(poly) { return Math.abs(signedArea(poly)); }

// Is this footprint genuinely round? True circle area / bbox area ≈ π/4 (0.785),
// the bbox is near-square, AND OSM gave us many vertices (circles are digitised
// with lots of points). All three must hold → no false positives on rectangles.
function isRoundFootprint(poly) {
  const bb = bboxOf(poly);
  if (bb.w < 1e-3 || bb.h < 1e-3) return false;
  const aspect = Math.min(bb.w, bb.h) / Math.max(bb.w, bb.h);
  if (aspect < 0.8) return false;                       // must be near-square
  if (poly.length < 8) return false;                    // circles are many-sided
  const fill = polyArea(poly) / (bb.w * bb.h);
  return fill > 0.7 && fill < 0.88;                     // ≈ π/4 → a disc
}

// Read an explicit roof shape from tags. Returns 'dome'|'pyramid'|'flat'|null.
function roofShapeFromTags(tags) {
  const rs = (tags?.['roof:shape'] || '').toLowerCase();
  if (!rs) return null;
  if (rs === 'dome' || rs === 'onion') return 'dome';
  if (rs === 'pyramidal' || rs === 'conical' || rs === 'cone') return 'pyramid';
  if (rs === 'flat') return 'flat';
  return null; // gabled/hipped/etc handled later in the roof phase
}

// Shrink a polygon toward its centroid by factor s (0..1). s=0.85 → 85% size.
function shrinkPoly(poly, s) {
  const c = centroidOf(poly);
  return poly.map(p => ({ x: c.x + (p.x - c.x) * s, y: c.y + (p.y - c.y) * s }));
}

// Regular N-gon footprint centred on (cx,cy) with radius r (for cylinders).
function ngon(cx, cy, r, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

// Dome cap: stacked shrinking rings from (cx,cy) radius r0 at y0 up to a point.
// Starts at L=0 so the BASE ring (full radius r0, at y0) is included — without
// it the dome started narrow and high, appearing to float above the cylinder.
function collectDome(acc, cx, cy, y0, r0, height, sides = 20, layers = 6) {
  let prevRing = null, prevY = y0;
  for (let L = 0; L <= layers; L++) {
    const t = L / layers;                 // 0 (base) … 1 (apex)
    const ringR = r0 * Math.cos(t * Math.PI / 2);   // r0 at base → 0 at apex
    const ringY = y0 + height * Math.sin(t * Math.PI / 2);
    const ring = ngon(cx, cy, Math.max(ringR, 0.02), sides);
    if (prevRing) {
      for (let i = 0; i < sides; i++) {
        const ni = (i + 1) % sides;
        const s = acc.n;
        acc.pos.push(prevRing[i].x, prevY, -prevRing[i].y);
        acc.pos.push(prevRing[ni].x, prevY, -prevRing[ni].y);
        acc.pos.push(ring[ni].x, ringY, -ring[ni].y);
        acc.pos.push(ring[i].x, ringY, -ring[i].y);
        acc.n += 4;
        acc.idx.push(s, s + 1, s + 2,  s, s + 2, s + 3);
      }
    }
    prevRing = ring; prevY = ringY;
  }
}

// Pyramid / cone cap: single ring at y0 → apex point.
function collectPyramidCap(acc, ring, y0, height) {
  const c = centroidOf(ring);
  const apexY = y0 + height;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const s = acc.n;
    acc.pos.push(a.x, y0, -a.y);
    acc.pos.push(b.x, y0, -b.y);
    acc.pos.push(c.x, apexY, -c.y);
    acc.n += 3;
    acc.idx.push(s, s + 1, s + 2);
  }
}

// Setback tower: tall buildings step INWARD as they rise (classic skyscraper
// silhouette). Data-driven — only called for genuinely tall buildings. The
// number of tiers scales with real height so a 60 m block gets 1 step and a
// 250 m supertall gets several.
function collectSetbackTower(acc, poly, footY, bodyH, heightM) {
  // Smooth continuous taper (frustum) instead of stacked boxes: the footprint
  // shrinks gradually from base → top, so the walls are smooth sloped triangles.
  // Taller buildings taper more. ringScale = footprint size at the top.
  const topScale = heightM >= 200 ? 0.55
                 : heightM >= 120 ? 0.68
                 :                  0.80;
  collectTaperedPrism(acc, poly, footY, bodyH, topScale);
}

// Tapered prism (frustum): bottom ring at full size, top ring shrunk to
// topScale, walls are sloped quads → smooth angled sides, not stacked boxes.
// `steps` vertical segments keep the slope clean and let tall towers curve
// slightly (each step uses an eased scale for a subtle entasis).
function collectTaperedPrism(acc, poly, baseY, h, topScale, steps = 6) {
  const ring = ensureCCW(poly);
  if (ring.length < 3) return;
  if (!Number.isFinite(baseY) || !Number.isFinite(h)) return;
  for (const p of ring) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  const c = centroidOf(ring);
  const nV = ring.length;

  // Scale at a given height fraction t (0..1): smooth ease so the taper is
  // gentle near the base and stronger up top (reads more natural than linear).
  const scaleAt = (t) => 1 + (topScale - 1) * (t * t * (3 - 2 * t)); // smoothstep

  // Build each vertical band as sloped wall quads (own verts → crisp facets
  // that still read as one smooth slope).
  for (let s = 0; s < steps; s++) {
    const t0 = s / steps, t1 = (s + 1) / steps;
    const y0 = baseY + h * t0, y1 = baseY + h * t1;
    const sc0 = scaleAt(t0), sc1 = scaleAt(t1);
    for (let i = 0; i < nV; i++) {
      const a = ring[i], b = ring[(i + 1) % nV];
      const ax0 = c.x + (a.x - c.x) * sc0, ay0 = c.y + (a.y - c.y) * sc0;
      const bx0 = c.x + (b.x - c.x) * sc0, by0 = c.y + (b.y - c.y) * sc0;
      const ax1 = c.x + (a.x - c.x) * sc1, ay1 = c.y + (a.y - c.y) * sc1;
      const bx1 = c.x + (b.x - c.x) * sc1, by1 = c.y + (b.y - c.y) * sc1;
      const k = acc.n;
      acc.pos.push(ax1, y1, -ay1);  // 0 top-a
      acc.pos.push(bx1, y1, -by1);  // 1 top-b
      acc.pos.push(bx0, y0, -by0);  // 2 bot-b
      acc.pos.push(ax0, y0, -ay0);  // 3 bot-a
      acc.n += 4;
      acc.idx.push(k, k + 1, k + 2,  k, k + 2, k + 3);
    }
  }

  // Top cap (shrunk) + bottom cap (full) so the frustum is closed/solid.
  const flat = []; for (const p of ring) flat.push(p.x, p.y);
  const tris = earcut(flat, [], 2);
  if (tris.length) {
    const topSc = scaleAt(1), topY = baseY + h;
    const ts = acc.n;
    for (const p of ring) acc.pos.push(c.x + (p.x - c.x) * topSc, topY, -(c.y + (p.y - c.y) * topSc));
    acc.n += nV;
    for (let t = 0; t < tris.length; t += 3) acc.idx.push(ts + tris[t], ts + tris[t + 1], ts + tris[t + 2]);
    const bs = acc.n;
    for (const p of ring) acc.pos.push(p.x, baseY, -p.y);
    acc.n += nV;
    for (let t = 0; t < tris.length; t += 3) acc.idx.push(bs + tris[t + 2], bs + tris[t + 1], bs + tris[t]);
  }
}

// ─── Buildings draped on terrain ────────────────────────────────────────────
function collectBuildings(acc, buildings, hf, vExag) {
  let count = 0, cyl = 0, dome = 0, pyr = 0, setback = 0;
  for (const bld of (buildings || [])) {
    let poly = bld.polygon;
    if (!poly || poly.length < 3) continue;
    // Clip footprint to the border so nothing hangs off the terrain edge.
    poly = clipPolyToSquare(poly);
    if (!poly || poly.length < 3) continue;

    const c = centroidOf(poly);
    const ground = hf ? hf.heightAt(c.x, c.y) : BASE;
    const hM = parseHeightM(bld.tags);
    // BUILDING_VSCALE halves building height — the raw extrusion read too tall
    // and unrealistic. Tune this 0..1 multiplier to taste.
    const hMM = Math.max(0.6, hM * vExag * BUILDING_VSCALE);
    const footY = ground - 1.0;          // sink foot below terrain on slopes
    const bodyH = hMM + 1.0;
    const topY = footY + bodyH;

    const tags = bld.tags || {};
    const roof = roofShapeFromTags(tags);
    const round = isRoundFootprint(poly);

    // ── Round footprint → real cylinder (smooth tower/rotunda) ──────────────
    if (round) {
      const bb = bboxOf(poly);
      const r = Math.min(bb.w, bb.h) / 2;
      const cylPoly = ngon(c.x, c.y, r, 28);   // 28-gon ≈ smooth circle
      collectPrism(acc, cylPoly, footY, bodyH);
      // domed top if tagged, else flat
      if (roof === 'dome')        { collectDome(acc, c.x, c.y, topY, r, r * 0.8); dome++; }
      else if (roof === 'pyramid'){ collectPyramidCap(acc, cylPoly, topY, r * 1.2); pyr++; }
      cyl++; count++;
      continue;
    }

    // ── Tall building with no explicit roof → stepped setback tower ──────────
    // Data-driven: only genuinely tall buildings (≥55 m real) get setbacks,
    // so ordinary houses/blocks stay simple. Skip if a roof shape is tagged
    // (that takes precedence below).
    if (!roof && hM >= 55) {
      collectSetbackTower(acc, poly, footY, bodyH, hM);
      setback++; count++;
      continue;
    }

    // ── Explicit roof tags / normal footprint ───────────────────────────────
    collectPrism(acc, poly, footY, bodyH);
    if (roof === 'dome') {
      const bb = bboxOf(poly);
      const r = Math.min(bb.w, bb.h) / 2;
      collectDome(acc, c.x, c.y, topY, r, r * 0.7);
      dome++;
    } else if (roof === 'pyramid') {
      const bb = bboxOf(poly);
      collectPyramidCap(acc, ensureCCW(poly), topY, Math.min(bb.w, bb.h) * 0.5);
      pyr++;
    }
    count++;
  }
  return count;
}

// ─── Roads draped on terrain ────────────────────────────────────────────────
// Solid raised ribbons clipped to the border. Each segment is a thin BOX (top +
// 2 sides) sitting ON the terrain — not a paper-thin double-sided quad — so it
// reads clearly and never culls. RISE is well above the building foot-sink so
// roads always sit on top of the surface.
function collectRoads(acc, roads, hf) {
  const HW = 0.8;        // half-width (mm)
  const RISE = 1.0;      // height of road top above terrain (mm)
  const BOT = 0.3;       // how far the slab sinks into the terrain

  // One solid slab segment between a→b (already clipped, finite).
  const slab = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) return;
    const nx = -dy / len * HW, ny = dx / len * HW;
    const ga = hf ? hf.heightAt(a.x, a.y) : BASE;
    const gb = hf ? hf.heightAt(b.x, b.y) : BASE;
    const s = acc.n;
    acc.pos.push(a.x + nx, ga + RISE, -(a.y + ny));
    acc.pos.push(b.x + nx, gb + RISE, -(b.y + ny));
    acc.pos.push(b.x - nx, gb + RISE, -(b.y - ny));
    acc.pos.push(a.x - nx, ga + RISE, -(a.y - ny));
    acc.pos.push(a.x + nx, ga - BOT, -(a.y + ny));
    acc.pos.push(b.x + nx, gb - BOT, -(b.y + ny));
    acc.pos.push(b.x - nx, gb - BOT, -(b.y - ny));
    acc.pos.push(a.x - nx, ga - BOT, -(a.y - ny));
    acc.n += 8;
    acc.idx.push(s, s + 1, s + 2,  s, s + 2, s + 3);                 // top
    acc.idx.push(s, s + 4, s + 5,  s, s + 5, s + 1);                 // +n side
    acc.idx.push(s + 3, s + 2, s + 6,  s + 3, s + 6, s + 7);         // -n side
    acc.idx.push(s, s + 3, s + 7,  s, s + 7, s + 4);                 // end a
    acc.idx.push(s + 1, s + 5, s + 6,  s + 1, s + 6, s + 2);         // end b
  };

  // Round joint disc at an interior vertex → fills the wedge gap between two
  // segments so the road reads as ONE continuous ribbon, not bent boxes.
  const joint = (p) => {
    const g = hf ? hf.heightAt(p.x, p.y) : BASE;
    const sides = 10;
    const ring = ngon(p.x, p.y, HW, sides);
    const cTop = acc.n;
    acc.pos.push(p.x, g + RISE, -p.y); acc.n++;          // top centre
    const topStart = acc.n;
    for (const q of ring) { acc.pos.push(q.x, g + RISE, -q.y); acc.n++; }
    for (let i = 0; i < sides; i++) {
      acc.idx.push(cTop, topStart + i, topStart + (i + 1) % sides);  // top fan
    }
  };

  let count = 0;
  for (const road of (roads || [])) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    let any = false;
    let prevB = null;   // end of previous in-bounds segment (for joint placement)
    for (let i = 0; i < pts.length - 1; i++) {
      const seg = clipSegmentToSquare(pts[i], pts[i + 1], HW + 0.2);  // keep slab edges inside
      if (!seg) { prevB = null; continue; }
      const [a, b] = seg;
      // Joint disc where this segment continues from the previous one — but
      // ONLY if the vertex is comfortably inside the border, else the full-
      // radius disc spills past the edge (the overhang bug).
      const inB = Math.abs(a.x) < CLIP - HW && Math.abs(a.y) < CLIP - HW;
      if (prevB && inB && Math.hypot(prevB.x - a.x, prevB.y - a.y) < 0.05) joint(a);
      slab(a, b);
      prevB = b;
      any = true;
    }
    if (any) count++;
  }
  return count;
}

// ─── Water from REAL OSM polygons, rendered FLAT (smooth shorelines) ─────────
// User insight: NYC's elevation data has humps where water should be flat, so
// draping water on the terrain made it ride up over the bumps. Fix: render the
// real OSM water polygon as a FLAT slab at a fixed `surfaceY`, and (in
// collectTerrain) FLATTEN the terrain under water cells to just below that.
// Smooth real-polygon shape on flattened ground = clean flat water, no humps.
function collectWaterPolys(acc, polys, hf, seaLevelY) {
  const THK = 0.5;            // slab thickness
  let count = 0;
  for (const wp of (polys || [])) {
    const ring = wp.ring;
    if (!ring || ring.length < 3) continue;
    const nV = ring.length;
    const flat = [];
    for (const p of ring) flat.push(p.x, p.y);
    let tris;
    try { tris = earcut(flat, [], 2); } catch { continue; }
    if (!tris.length) continue;

    // Level: SEA polygons use one fixed low sea level (terrain under them is
    // clamped to match → no poke-through, big polygon stays flat). INLAND water
    // keeps the natural per-polygon low-percentile level that already looks
    // good — this branch is unchanged for the cities that work.
    let topY;
    if (wp.isSea) {
      topY = seaLevelY;
    } else if (hf) {
      const hs = [];
      for (const p of ring) hs.push(hf.heightAt(p.x, p.y));
      let cx = 0, cy = 0; for (const p of ring) { cx += p.x; cy += p.y; }
      hs.push(hf.heightAt(cx / nV, cy / nV));
      hs.sort((a, b) => a - b);
      topY = hs[Math.floor(hs.length * 0.2)] + 0.15;
    } else {
      topY = BASE + 0.2;
    }
    const botY = topY - THK;

    // top face (smooth real shoreline, FLAT)
    const s = acc.n;
    for (let i = 0; i < nV; i++) acc.pos.push(ring[i].x, topY, -ring[i].y);
    acc.n += nV;
    for (let t = 0; t < tris.length; t += 3) acc.idx.push(s + tris[t], s + tris[t + 1], s + tris[t + 2]);
    // floor (reversed)
    const b = acc.n;
    for (let i = 0; i < nV; i++) acc.pos.push(ring[i].x, botY, -ring[i].y);
    acc.n += nV;
    for (let t = 0; t < tris.length; t += 3) acc.idx.push(b + tris[t + 2], b + tris[t + 1], b + tris[t]);
    // edge walls (smooth bank along the real polygon)
    for (let i = 0; i < nV; i++) {
      const ni = (i + 1) % nV;
      const k = acc.n;
      acc.pos.push(ring[i].x, topY, -ring[i].y);
      acc.pos.push(ring[ni].x, topY, -ring[ni].y);
      acc.pos.push(ring[ni].x, botY, -ring[ni].y);
      acc.pos.push(ring[i].x, botY, -ring[i].y);
      acc.n += 4;
      acc.idx.push(k, k + 1, k + 2,  k, k + 2, k + 3);
    }
    count++;
  }
  return count;
}

// ─── Public entry point ─────────────────────────────────────────────────────
/**
 * @param {Object} features  { buildings:[{polygon,tags}], roads:[{points,tags}], water:[{polygon}] }
 * @param {Object|null} terrainOptions  { elevGrid:Float32Array, gridSize:N } or null (flat)
 * @param {Object} projection  (for scaleLength)
 * @param {number} vertExag  building vertical exaggeration (1..5 from UI)
 * @param {Function} onProgress
 * @returns {{ group: THREE.Group, stats: Object }}
 */
export function buildMapModelV2(features, terrainOptions, projection, vertExag, onProgress, shape = 'square') {
  onProgress?.('New engine: building terrain…', 62);
  const group = new THREE.Group();

  // Board boundary: square uses the fast axis path (BOUNDARY=null); hexagon and
  // circle use a CCW convex polygon that every clipper + the terrain follow, so
  // edges come out smooth. Inset a hair so nothing pokes past the wall.
  if (shape === 'hexagon' || shape === 'circle') {
    BOUNDARY = ensureCCW(getShapeVertices(R - 0.05, shape, 0));
  } else {
    BOUNDARY = null;
  }

  const whiteAcc = new Acc();  // terrain + base + buildings
  const blackAcc = new Acc();  // roads + water

  // Vertical scale: convert real metres → model mm. horizontalScale is mm/m;
  // multiply by vertExag so relief/buildings read clearly at model scale.
  const mmPerM = projection.horizontalScale * Math.max(1, vertExag);

  // ── Prepare water polygons ONCE: clip to border + size/isSea filter. Used
  //    for BOTH carving the terrain and filling it with flat water, so they
  //    always match.
  const PLATE_AREA = (2 * R) * (2 * R);
  const waterPolys = [];   // [{ ring, isSea }]
  const seaRings = [];     // sea rings only, for terrain clamp
  for (const w of (features.water || [])) {
    let poly = w.polygon;
    if (!poly || poly.length < 3) continue;
    poly = clipPolyToSquare(poly);
    if (!poly || poly.length < 3) continue;
    if (!w.isSea && polyArea(poly) > PLATE_AREA * 0.92) continue;
    const ring = ensureCCW(poly);
    waterPolys.push({ ring, isSea: !!w.isSea });
    if (w.isSea) seaRings.push(ring);
  }

  // Coastal SEA sits at one fixed low level (true sea level); inland water
  // keeps its natural per-polygon level. Terrain under sea is clamped just
  // below this so no humps poke through — scoped to sea only, so inland cities
  // are completely untouched.
  const SEA_LEVEL_Y  = BASE + 0.2;
  const SEA_CLAMP_Y  = BASE - 0.3;

  // Water levels — the key to "smooth + no land coverage + no poke-through":
  //   • WATER_SURFACE_Y sits just BELOW land level (BASE). On land/city the
  //     opaque terrain is higher, so it hides the water → water can never
  //     appear on land, even though we render the full real polygon shape.
  //   • CARVE_Y digs the riverbed BELOW the water surface. In real water areas
  //     the terrain is carved down, so the water surface shows in the channel.
  // Result: real OSM polygons → smooth realistic shorelines; physics hides
  // water on land and reveals it only in carved channels.
  // Water surface sits a hair above the flattened bed; FLATTEN_Y is where the
  // terrain humps under water get levelled to. The water slab's floor (surface
  // - thickness) lands at FLATTEN_Y, so terrain and water meet flush — no humps
  // poke through, no gap.
  const GN = 96;

  // Land mask from buildings → water is forbidden on the city. Water mask =
  // inside a water polygon AND not land. Both carve and fill use this mask, so
  // water and city are mutually exclusive — water can never cover buildings.

  let hf = null;
  if (terrainOptions?.elevGrid && terrainOptions.gridSize) {
    hf = makeHeightField(terrainOptions.elevGrid, terrainOptions.gridSize, mmPerM, terrainOptions.norm || null);
    collectTerrain(whiteAcc, hf, GN, seaRings, SEA_CLAMP_Y);   // clamp terrain under SEA only
    onProgress?.(`New engine: terrain relief ${(hf.hi - hf.lo).toFixed(0)} m`, 68);
  } else {
    collectFlatBase(whiteAcc);
  }

  // Buildings get their OWN accumulator/mesh so they receive the crisp
  // 'building' material instead of terrain's smooth shading.
  const bldgAcc = new Acc();
  const nB = collectBuildings(bldgAcc, features.buildings, hf, mmPerM);
  onProgress?.(`New engine: ${nB} buildings draped`, 78);
  const nR = collectRoads(blackAcc, features.roads, hf);
  // Render the REAL water polygons (smooth OSM shorelines) draped on the
  // terrain surface so they're always visible and follow the ground — the
  // natural-looking system. Size/isSea filter keeps oceans from blanketing land.
  const nW = collectWaterPolys(blackAcc, waterPolys, hf, SEA_LEVEL_Y);
  onProgress?.('New engine: finalising…', 90);

  const terrainMesh  = whiteAcc.build(hf ? 'terrain' : 'base');
  const buildingMesh = bldgAcc.build('building');
  const blackMesh    = blackAcc.build('road');
  if (terrainMesh)  group.add(terrainMesh);
  if (buildingMesh) group.add(buildingMesh);
  if (blackMesh)    group.add(blackMesh);

  return {
    group,
    stats: { buildings: nB, roads: nR, water: nW, engine: 'v2-terrain-fused' },
    // Elevation mapping used — connected tiles reuse this so their terrain is
    // continuous across seams (passed back as terrainOptions.norm to siblings).
    norm: hf ? { lo: hf.lo, hi: hf.hi } : null,
  };
}
