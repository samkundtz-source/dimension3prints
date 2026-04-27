// ─── Model configuration ──────────────────────────────────────────────────────

/** Hex circumradius in model millimetres — gives 130mm flat-to-flat */
export const MODEL_RADIUS_MM = 75.06;

/** Solid base plate thickness in mm */
export const BASE_THICKNESS_MM = 1.5;

/** Elevation sample grid dimension (N×N points) */
export const TERRAIN_GRID_SIZE = 20; // 400 pts → 4 API calls to OpenTopoData

/** Default vertical exaggeration factor */
export const DEFAULT_VERT_EXAG = 8;

/** Minimum building height to keep detail printable */
export const MIN_BUILDING_HEIGHT_MM = 2.0;

/** FDM nozzle diameter — nothing in the model can be thinner than this */
export const NOZZLE_MM = 0.4;

// ─── Layer heights above the base plate top (in mm) ──────────────────────────
// These are deliberately exaggerated so features read clearly in the 3D preview
// and produce a good-looking physical print.

export const LAYER = {
  WATER_DEPRESSION: -1.8,  // water clearly recessed below terrain
  TERRAIN_BASE:      0.0,  // flat terrain reference
  PARK_RAISE:        0.7,  // parks visibly raised above base
  PATH_RAISE:        0.9,  // footways / paths above terrain
  ROAD_RAISE:        1.4,  // roads clearly raised — forms ridge on the model
};

// ─── Road real-world half-widths (centre → kerb, in metres) ──────────────────
export const ROAD_WIDTHS_M = {
  motorway:        14,
  motorway_link:    7,
  trunk:           12,
  trunk_link:       6,
  primary:         10,
  primary_link:     5,
  secondary:        8,
  secondary_link:   4,
  tertiary:         7,
  tertiary_link:    3.5,
  unclassified:     5,
  residential:      4,
  service:          3,
  living_street:    3.5,
  pedestrian:       4,
  footway:          1.5,
  path:             1.2,
  cycleway:         1.5,
  steps:            1.5,
};

/**
 * Minimum visual half-widths (mm) in the 3D model.
 *
 * At 1 km radius: hScale = 50/1000 = 0.05 mm/m, so a 4 m residential road
 * = only 0.2 mm half-width from real-world data — totally invisible.
 * These minimums guarantee roads are legible and 3D-printable (≥ 0.4 mm nozzle).
 *
 * Values here are HALF the total road width on the printed model.
 * NO value here is below 0.2 — that gives a full road width ≥ 0.4 mm (one nozzle).
 */
export const ROAD_MIN_VISUAL_HALF_MM = {
  motorway:      2.2,
  motorway_link: 1.4,
  trunk:         2.0,
  trunk_link:    1.2,
  primary:       1.7,
  primary_link:  1.1,
  secondary:     1.3,
  secondary_link:0.9,
  tertiary:      1.0,
  tertiary_link: 0.7,
  unclassified:  0.65,
  residential:   0.6,
  service:       0.4,
  living_street: 0.55,
  pedestrian:    0.6,
  footway:       0.25,
  path:          0.22,
  cycleway:      0.25,
  steps:         0.22,
};

/**
 * Uniform road extrusion height above the base plate (mm).
 * Kept at nozzle diameter (0.4 mm) — thin flat slabs that never appear
 * as tall as buildings (minimum 2.0 mm).
 */
export const ROAD_HEIGHT_MM = 0.4;

// Kept for import compatibility — every road type maps to the same height.
export const ROAD_HEIGHTS_MM = Object.fromEntries(
  ['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
   'secondary','secondary_link','tertiary','tertiary_link','unclassified',
   'residential','living_street','road'].map(k => [k, ROAD_HEIGHT_MM])
);

// ─── Maths helpers ────────────────────────────────────────────────────────────

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
export function lerp(a, b, t)    { return a + (b - a) * t; }

export function vec2(x, y) { return { x, y }; }
export function vecAdd(a, b)    { return { x: a.x + b.x, y: a.y + b.y }; }
export function vecSub(a, b)    { return { x: a.x - b.x, y: a.y - b.y }; }
export function vecScale(a, s)  { return { x: a.x * s,   y: a.y * s   }; }
export function vecLen(a)       { return Math.sqrt(a.x * a.x + a.y * a.y); }
export function vecNorm(a) {
  const l = vecLen(a);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}
export function vecPerp(a)      { return { x: -a.y, y: a.x }; } // CCW 90°
export function vecDot(a, b)    { return a.x * b.x + a.y * b.y; }
export function vecCross(a, b)  { return a.x * b.y - a.y * b.x; }

/**
 * Signed area of a 2-D polygon.
 * Positive → counter-clockwise (math / standard orientation, Y-up).
 */
export function signedArea2D(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return a / 2;
}

/** Return pts in CCW order (positive signed area). */
export function ensureCCW(pts) {
  return signedArea2D(pts) < 0 ? [...pts].reverse() : pts;
}

/** Return pts in CW order (negative signed area) – used for earcut holes. */
export function ensureCW(pts) {
  return signedArea2D(pts) > 0 ? [...pts].reverse() : pts;
}

/**
 * Remove duplicate consecutive vertices and the closing duplicate
 * that OSM closed ways sometimes include.
 */
export function deduplicateRing(pts, tol = 1e-5) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const cur  = pts[i];
    const prev = out[out.length - 1];
    if (!prev ||
        Math.abs(cur.x - prev.x) > tol ||
        Math.abs(cur.y - prev.y) > tol) {
      out.push(cur);
    }
  }
  // Drop closing duplicate
  const first = out[0];
  const last  = out[out.length - 1];
  if (out.length > 1 && first && last &&
      Math.abs(first.x - last.x) < tol &&
      Math.abs(first.y - last.y) < tol) {
    out.pop();
  }
  return out;
}

/**
 * Bilinear interpolation on a flat N×N elevation grid.
 * Grid covers the square [-radiusMM, +radiusMM] × [-radiusMM, +radiusMM].
 * Row-major order: index = j * N + i.
 */
export function bilinearInterp(grid, N, x, y, radiusMM) {
  const nx = ((x / radiusMM) + 1) * 0.5 * (N - 1);
  const ny = ((y / radiusMM) + 1) * 0.5 * (N - 1);
  const i0 = Math.floor(clamp(nx, 0, N - 2));
  const j0 = Math.floor(clamp(ny, 0, N - 2));
  const fx = nx - i0;
  const fy = ny - j0;
  const v00 = grid[ j0      * N + i0    ];
  const v10 = grid[ j0      * N + i0 + 1];
  const v01 = grid[(j0 + 1) * N + i0    ];
  const v11 = grid[(j0 + 1) * N + i0 + 1];
  return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
}

/** Check whether a 2-D point is inside a convex polygon (all edges CCW). */
export function pointInConvexPolygon(pt, polygon) {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    if ((b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x) < -1e-7) {
      return false;
    }
  }
  return true;
}
