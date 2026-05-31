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
  // tiers by real height (metres)
  let tiers;
  if (heightM >= 200)      tiers = [0.55, 0.78, 1.0];  // 3 setbacks
  else if (heightM >= 120) tiers = [0.7, 1.0];          // 2 setbacks
  else                     tiers = [0.82, 1.0];         // 1 gentle setback
  // tiers array = cumulative HEIGHT fractions; scale shrinks per tier.
  const heights = [];
  let prev = 0;
  for (const f of tiers) { heights.push(f - prev); prev = f; }

  let y = footY;
  let scale = 1.0;
  for (let t = 0; t < heights.length; t++) {
    const segH = bodyH * heights[t];
    const tierPoly = scale < 0.999 ? shrinkPoly(poly, scale) : poly;
    collectPrism(acc, tierPoly, y, segH);
    y += segH;
    // shrink the NEXT tier inward (each step ~12–18% smaller)
    scale *= (heightM >= 200 ? 0.8 : 0.86);
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
    const hMM = Math.max(0.6, hM * vExag);
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
      const seg = clipSegmentToSquare(pts[i], pts[i + 1]);
      if (!seg) { prevB = null; continue; }
      const [a, b] = seg;
      // Joint disc where this segment continues from the previous one.
      if (prevB && Math.hypot(prevB.x - a.x, prevB.y - a.y) < 0.05) joint(a);
      slab(a, b);
      prevB = b;
      any = true;
    }
    if (any) count++;
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
