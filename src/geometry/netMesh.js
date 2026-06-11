/**
 * netMesh.js — unified network meshing via signed-distance rasterization.
 *
 * The road problem with per-segment ribbons: every street is its own box, so
 * intersections overlap, coplanar tops z-fight (the dark blotches), widths
 * collide, and the result is neither smooth nor one object. The fix:
 *
 *   1. RASTERIZE the whole network into a signed-distance field: for every
 *      grid cell, max over all road capsules of (halfWidth − dist). The
 *      max-union gives perfectly rounded joins at every intersection.
 *   2. EXTRACT the covered region with a GRID-CONFORMING tessellation
 *      (marching-squares cell polygons, vertices welded across cells), the
 *      same construction TouchTerrain uses for watertight terrain. The cap
 *      triangulation and the boundary walls are built from the SAME contour
 *      points, so every edge is shared by exactly two faces BY CONSTRUCTION —
 *      no polygon triangulator, no degenerate slivers, manifold guaranteed.
 *   3. DRAPE the top on the terrain per welded vertex (interior vertices are
 *      grid corners, so even wide intersections follow the ground), with the
 *      bottom a parallel surface sunk `bottomDrop` below.
 *
 * One connected street network → ONE smooth solid. No overlaps, no
 * z-fighting, constant per-class widths, rounded corners everywhere.
 */

// ─── 1. SDF rasterization ────────────────────────────────────────────────────
// Capsule union: field[cell] = max(halfWidth − distanceToSegment).
// `insideBoard(x, y)` is the signed inside-distance to the board edge — the
// field is min()'d with it so the region closes cleanly along the border.
function rasterizeNetwork(roads, N, R, halfWidthOf, insideBoard) {
  const field = new Float32Array(N * N).fill(-1e9);
  const step = (2 * R) / (N - 1);
  const xOf = (i) => -R + i * step;

  for (const road of (roads || [])) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const hw = halfWidthOf(road);
    const pad = hw + step * 1.5;
    for (let s = 0; s < pts.length - 1; s++) {
      const a = pts[s], b = pts[s + 1];
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y) ||
          !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      const minX = Math.min(a.x, b.x) - pad, maxX = Math.max(a.x, b.x) + pad;
      const minY = Math.min(a.y, b.y) - pad, maxY = Math.max(a.y, b.y) + pad;
      if (maxX < -R || minX > R || maxY < -R || minY > R) continue;
      const i0 = Math.max(0, Math.floor((minX + R) / step));
      const i1 = Math.min(N - 1, Math.ceil((maxX + R) / step));
      const j0 = Math.max(0, Math.floor((minY + R) / step));
      const j1 = Math.min(N - 1, Math.ceil((maxY + R) / step));
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      for (let j = j0; j <= j1; j++) {
        const y = xOf(j);
        for (let i = i0; i <= i1; i++) {
          const x = xOf(i);
          let t = len2 > 1e-12 ? ((x - a.x) * dx + (y - a.y) * dy) / len2 : 0;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const ex = x - (a.x + dx * t), ey = y - (a.y + dy * t);
          const v = hw - Math.sqrt(ex * ex + ey * ey);
          const k = j * N + i;
          if (v > field[k]) field[k] = v;
        }
      }
    }
  }

  // Intersect with the board so contours close along the edge.
  for (let j = 0; j < N; j++) {
    const y = xOf(j);
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (field[k] <= -1e8) continue;
      const b = insideBoard(xOf(i), y);
      if (b < field[k]) field[k] = b;
    }
  }
  return field;
}

// Export the rasterizer too — the Fable engine builds its own class fields
// (water/park indicators intersected with NOT-road) and feeds them straight
// into buildFieldMesh.
export { rasterizeNetwork };

// Scanline-fill a polygon into the N×N grid (even-odd rule); calls set(k) for
// every covered cell index. Shared by the building mask and the Fable engine's
// water/park rasterization.
export function scanlineFillPolygon(ring, N, R, set) {
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

// ─── 2+3. Grid-conforming solid extraction ──────────────────────────────────
/**
 * Build the unified network solid into `acc` (an {pos[], idx[], n} accumulator).
 * opts: { R, gridN, boundaryInside(x,y), halfWidthOf(road), topAt(x,y),
 *         bottomDrop }
 * Returns the number of covered grid cells (0 → nothing emitted).
 */
export function buildNetworkMesh(acc, roads, opts) {
  const { R, boundaryInside, halfWidthOf, gridN = 384, maskPolys } = opts;
  const field = rasterizeNetwork(roads, gridN, R, halfWidthOf, boundaryInside);
  // Mask polygons (building footprints) carve the network: a road may run UP
  // TO a building but never through it — buildings own their ground.
  if (maskPolys) {
    for (const poly of maskPolys) {
      if (!poly || poly.length < 3) continue;
      scanlineFillPolygon(poly, gridN, R, (k) => { if (field[k] > -0.05) field[k] = -0.05; });
    }
  }
  return buildFieldMesh(acc, field, opts);
}

/**
 * Extract ANY positive region of a scalar field as one manifold draped solid
 * (grid-conforming marching-squares tessellation — see header).
 * opts: { R, gridN, topAt(x,y), bottomDrop }
 */
export function buildFieldMesh(acc, field, opts) {
  const { R, gridN = 384, topAt, bottomDrop = 1.6 } = opts;
  const N = gridN;
  const step = (2 * R) / (N - 1);
  const xOf = (i) => -R + i * step;

  // Welded vertex pool: one entry per unique 2D point; each holds the TOP and
  // BOTTOM mesh-vertex indices (created lazily). Quantize at 0.2µm — interp
  // points are bit-identical across the two cells sharing an edge.
  const pool = new Map();
  const vTop = (x, y) => {
    const k = `${Math.round(x * 5000)},${Math.round(y * 5000)}`;
    let e = pool.get(k);
    if (!e) {
      const t = topAt(x, y);
      const ti = acc.n; acc.pos.push(x, t, -y); acc.n++;
      const bi = acc.n; acc.pos.push(x, t - bottomDrop, -y); acc.n++;
      e = { ti, bi };
      pool.set(k, e);
    }
    return e;
  };

  let covered = 0;

  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const v00 = field[j * N + i],       v10 = field[j * N + i + 1];
      const v01 = field[(j + 1) * N + i], v11 = field[(j + 1) * N + i + 1];
      let c = 0;
      if (v00 > 0) c |= 1;
      if (v10 > 0) c |= 2;
      if (v11 > 0) c |= 4;
      if (v01 > 0) c |= 8;
      if (c === 0) continue;
      covered++;

      const x0 = xOf(i), x1 = xOf(i + 1), y0 = xOf(j), y1 = xOf(j + 1);
      // Cell corners (CCW, y-up): C00 → C10 → C11 → C01
      const C00 = [x0, y0], C10 = [x1, y0], C11 = [x1, y1], C01 = [x0, y1];
      const lerp = (xa, ya, va, xb, yb, vb) => {
        const t = va / (va - vb);
        return [xa + (xb - xa) * t, ya + (yb - ya) * t];
      };
      const eS = () => lerp(x0, y0, v00, x1, y0, v10);
      const eE = () => lerp(x1, y0, v10, x1, y1, v11);
      const eN = () => lerp(x0, y1, v01, x1, y1, v11);
      const eW = () => lerp(x0, y0, v00, x0, y1, v01);

      // Inside polygon(s) (CCW) + boundary contour segment(s) (inside-left)
      // per marching-squares case. Caps and walls share these exact points.
      let polys = null, segs = null;
      switch (c) {
        case 1:  { const s = eS(), w = eW(); polys = [[C00, s, w]];            segs = [[w, s]]; break; }
        case 2:  { const s = eS(), e = eE(); polys = [[s, C10, e]];            segs = [[s, e]]; break; }
        case 3:  { const w = eW(), e = eE(); polys = [[C00, C10, e, w]];       segs = [[w, e]]; break; }
        case 4:  { const e = eE(), n = eN(); polys = [[e, C11, n]];            segs = [[e, n]]; break; }
        case 5:  { const s = eS(), e = eE(), n = eN(), w = eW();
                   const ctr = (v00 + v10 + v11 + v01) / 4;
                   if (ctr > 0) { polys = [[C00, s, e, C11, n, w]];            segs = [[w, n], [e, s]]; }
                   else         { polys = [[C00, s, w], [e, C11, n]];          segs = [[w, s], [e, n]]; }
                   break; }
        case 6:  { const s = eS(), n = eN(); polys = [[s, C10, C11, n]];       segs = [[s, n]]; break; }
        case 7:  { const w = eW(), n = eN(); polys = [[C00, C10, C11, n, w]];  segs = [[w, n]]; break; }
        case 8:  { const n = eN(), w = eW(); polys = [[n, C01, w]];            segs = [[n, w]]; break; }
        case 9:  { const s = eS(), n = eN(); polys = [[C00, s, n, C01]];       segs = [[n, s]]; break; }
        case 10: { const s = eS(), e = eE(), n = eN(), w = eW();
                   const ctr = (v00 + v10 + v11 + v01) / 4;
                   if (ctr > 0) { polys = [[s, C10, e, n, C01, w]];            segs = [[n, e], [s, w]]; }
                   else         { polys = [[s, C10, e], [n, C01, w]];          segs = [[n, w], [s, e]]; }
                   break; }
        case 11: { const e = eE(), n = eN(); polys = [[C00, C10, e, n, C01]];  segs = [[n, e]]; break; }
        case 12: { const e = eE(), w = eW(); polys = [[e, C11, C01, w]];       segs = [[e, w]]; break; }
        case 13: { const s = eS(), e = eE(); polys = [[C00, s, e, C11, C01]];  segs = [[e, s]]; break; }
        case 14: { const s = eS(), w = eW(); polys = [[s, C10, C11, C01, w]];  segs = [[s, w]]; break; }
        case 15: { polys = [[C00, C10, C11, C01]]; segs = []; break; }
      }

      // Caps: fan-triangulate each (convex) cell polygon — top up, bottom down.
      for (const poly of polys) {
        const vs = [];
        for (const p of poly) {
          const e = vTop(p[0], p[1]);
          if (!vs.length || vs[vs.length - 1] !== e) vs.push(e); // drop dup pts
        }
        if (vs.length > 1 && vs[0] === vs[vs.length - 1]) vs.pop();
        for (let t = 1; t < vs.length - 1; t++) {
          acc.idx.push(vs[0].ti, vs[t].ti, vs[t + 1].ti);
          acc.idx.push(vs[0].bi, vs[t + 1].bi, vs[t].bi);
        }
      }
      // Walls: one quad per contour segment (inside on the LEFT → outward
      // normals with this winding). Vertical edges weld via the shared pool.
      for (const [A, B] of segs) {
        const a = vTop(A[0], A[1]), b = vTop(B[0], B[1]);
        if (a === b) continue; // contour grazed a corner — zero-length
        acc.idx.push(a.ti, b.ti, b.bi,  a.ti, b.bi, a.bi);
      }
    }
  }

  return covered;
}
