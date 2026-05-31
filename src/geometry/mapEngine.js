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

const R = MODEL_RADIUS_MM;           // model half-width (mm)
const BASE = BASE_THICKNESS_MM;      // solid floor thickness (mm)

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
const CLIP = R - 0.5;

// Sutherland–Hodgman polygon clip against the axis-aligned square [-CLIP, CLIP].
function clipPolyToSquare(poly) {
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

// Clip a polyline to the square, returning an array of inside sub-segments
// [{x,y},{x,y}] so roads stop cleanly at the border instead of shooting past.
function clipSegmentToSquare(a, b) {
  // Liang–Barsky against [-CLIP, CLIP]²
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x + CLIP, CLIP - a.x, a.y + CLIP, CLIP - a.y];
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
function makeHeightField(elevGrid, N, vScaleMMperM) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < elevGrid.length; k++) {
    const e = elevGrid[k];
    if (e < lo) lo = e; if (e > hi) hi = e;
  }
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 0; }
  const baseTop = BASE;
  return {
    lo, hi,
    heightAt(x, y) {
      // bilinearInterp expects MODEL-space x,y in [-R,R] plus the radius R; it
      // normalises internally. The previous call pre-normalised to [0,1] AND
      // omitted the radius arg → x/undefined = NaN → every vertex NaN → Three
      // dropped the whole mesh → black screen.
      const e = bilinearInterp(elevGrid, N, x, y, R);
      const h = baseTop + (e - lo) * vScaleMMperM;
      return Number.isFinite(h) ? h : baseTop;   // never emit NaN into geometry
    },
  };
}

// ─── Terrain surface mesh (square) ──────────────────────────────────────────
// Displaced grid top + perimeter walls + flat floor = solid printable block.
function collectTerrain(acc, hf, GN) {
  const step = (2 * R) / GN;
  const xy = (i) => -R + i * step;

  // Top surface vertices
  const topIdx = [];
  for (let j = 0; j <= GN; j++) {
    for (let i = 0; i <= GN; i++) {
      const x = xy(i), y = xy(j);
      topIdx.push(acc.n);
      acc.pos.push(x, hf.heightAt(x, y), -y);
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

  // Floor (flat at y=0), reversed winding to face down
  const floorIdx = [];
  for (let j = 0; j <= GN; j++) {
    for (let i = 0; i <= GN; i++) {
      const x = xy(i), y = xy(j);
      floorIdx.push(acc.n);
      acc.pos.push(x, 0, -y);
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

// ─── Flat base (no-terrain fallback) ────────────────────────────────────────
function collectFlatBase(acc) {
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

// ─── Buildings draped on terrain ────────────────────────────────────────────
function collectBuildings(acc, buildings, hf, vExag) {
  let count = 0;
  for (const bld of (buildings || [])) {
    let poly = bld.polygon;
    if (!poly || poly.length < 3) continue;
    // Clip footprint to the border so nothing hangs off the terrain edge.
    poly = clipPolyToSquare(poly);
    if (!poly || poly.length < 3) continue;
    const c = centroidOf(poly);
    const ground = hf ? hf.heightAt(c.x, c.y) : BASE;
    const hM = parseHeightM(bld.tags);
    const hMM = Math.max(0.6, hM * vExag);
    // sink the foot below terrain so it stays grounded on slopes
    collectPrism(acc, poly, ground - 1.0, hMM + 1.0);
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
  const HW = 0.85;       // half-width (mm) — wider so roads read as solid ribbons
  const RISE = 1.0;      // height of road top above terrain (mm)
  let count = 0, drawn = 0;
  for (const road of (roads || [])) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    let any = false;
    for (let i = 0; i < pts.length - 1; i++) {
      const seg = clipSegmentToSquare(pts[i], pts[i + 1]);  // ← stop at border
      if (!seg) continue;
      const [a, b] = seg;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-3) continue;
      const nx = -dy / len * HW, ny = dx / len * HW;
      const ga = (hf ? hf.heightAt(a.x, a.y) : BASE);
      const gb = (hf ? hf.heightAt(b.x, b.y) : BASE);
      // 8 verts: top quad (raised) + bottom quad (at terrain) → a solid slab
      const s = acc.n;
      // top
      acc.pos.push(a.x + nx, ga + RISE, -(a.y + ny));
      acc.pos.push(b.x + nx, gb + RISE, -(b.y + ny));
      acc.pos.push(b.x - nx, gb + RISE, -(b.y - ny));
      acc.pos.push(a.x - nx, ga + RISE, -(a.y - ny));
      // bottom (sits slightly into the terrain so no gap underneath)
      acc.pos.push(a.x + nx, ga - 0.3, -(a.y + ny));
      acc.pos.push(b.x + nx, gb - 0.3, -(b.y + ny));
      acc.pos.push(b.x - nx, gb - 0.3, -(b.y - ny));
      acc.pos.push(a.x - nx, ga - 0.3, -(a.y - ny));
      acc.n += 8;
      // top face
      acc.idx.push(s, s + 1, s + 2,  s, s + 2, s + 3);
      // two side walls (left edge, right edge)
      acc.idx.push(s, s + 4, s + 5,  s, s + 5, s + 1);   // +n side
      acc.idx.push(s + 3, s + 2, s + 6,  s + 3, s + 6, s + 7); // -n side
      // end caps
      acc.idx.push(s, s + 3, s + 7,  s, s + 7, s + 4);
      acc.idx.push(s + 1, s + 5, s + 6,  s + 1, s + 6, s + 2);
      any = true;
    }
    if (any) { count++; drawn++; }
  }
  return count;
}

// ─── Water draped flat-ish on terrain ───────────────────────────────────────
function collectWater(acc, water, hf) {
  let count = 0;
  for (const w of (water || [])) {
    let poly = w.polygon;
    if (!poly || poly.length < 3) continue;
    poly = clipPolyToSquare(poly);            // ← clip to border
    if (!poly || poly.length < 3) continue;
    const ring = ensureCCW(poly);
    const flat = [];
    for (const p of ring) flat.push(p.x, p.y);
    const tris = earcut(flat, [], 2);
    if (!tris.length) continue;
    const s = acc.n;
    for (const p of ring) {
      const g = (hf ? hf.heightAt(p.x, p.y) : BASE) + 0.3;
      acc.pos.push(p.x, g, -p.y); acc.n++;
    }
    for (let t = 0; t < tris.length; t += 3) acc.idx.push(s + tris[t], s + tris[t + 1], s + tris[t + 2]);
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
export function buildMapModelV2(features, terrainOptions, projection, vertExag, onProgress) {
  onProgress?.('New engine: building terrain…', 62);
  const group = new THREE.Group();

  const whiteAcc = new Acc();  // terrain + base + buildings
  const blackAcc = new Acc();  // roads + water

  // Vertical scale: convert real metres → model mm. horizontalScale is mm/m;
  // multiply by vertExag so relief/buildings read clearly at model scale.
  const mmPerM = projection.horizontalScale * Math.max(1, vertExag);

  let hf = null;
  if (terrainOptions?.elevGrid && terrainOptions.gridSize) {
    hf = makeHeightField(terrainOptions.elevGrid, terrainOptions.gridSize, mmPerM);
    collectTerrain(whiteAcc, hf, 96);   // 96×96 surface
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
  const nW = collectWater(blackAcc, features.water, hf);
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
  };
}
