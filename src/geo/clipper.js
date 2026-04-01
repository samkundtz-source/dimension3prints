/**
 * Sutherland-Hodgman polygon clipping against a convex boundary (hex).
 * Also provides linestring buffering (road → polygon).
 */

import { vecSub, vecCross } from '../utils/helpers.js';

// ─── Polygon clipping ─────────────────────────────────────────────────────────

/**
 * Clip `polygon` (array of {x,y}) against the convex `hexVertices` (CCW).
 * Returns the clipped polygon, or null if the result is degenerate (< 3 pts).
 */
export function clipToHex(polygon, hexVertices) {
  let output = polygon.slice();

  for (let i = 0; i < hexVertices.length; i++) {
    if (output.length < 3) return null;
    const A = hexVertices[i];
    const B = hexVertices[(i + 1) % hexVertices.length];
    output = sutherlandHodgmanStep(output, A, B);
  }

  return output.length >= 3 ? output : null;
}

function sutherlandHodgmanStep(polygon, A, B) {
  const output = [];
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const P = polygon[i];
    const Q = polygon[(i + 1) % n];
    const pIn = isInsideEdge(P, A, B);
    const qIn = isInsideEdge(Q, A, B);

    if (pIn) {
      output.push(P);
      if (!qIn) output.push(edgeIntersect(A, B, P, Q));
    } else if (qIn) {
      output.push(edgeIntersect(A, B, P, Q));
    }
  }

  return output;
}

/** Is point P on the left (inside) of directed edge A→B? */
function isInsideEdge(P, A, B) {
  return (B.x - A.x) * (P.y - A.y) - (B.y - A.y) * (P.x - A.x) >= -1e-9;
}

/** Intersection of edge P→Q with the infinite line through A and B. */
function edgeIntersect(A, B, P, Q) {
  const AB = vecSub(B, A);
  const PQ = vecSub(Q, P);
  const AP = vecSub(P, A);
  const denom = vecCross(AB, PQ);
  if (Math.abs(denom) < 1e-12) return P; // parallel: return P as fallback
  const t = vecCross(AP, PQ) / denom;
  return { x: A.x + AB.x * t, y: A.y + AB.y * t };
}

// ─── Linestring buffering ─────────────────────────────────────────────────────

/**
 * Buffer a linestring (array of {x,y}) by `halfWidthMM` on each side.
 * Returns a simple polygon (outer boundary only), or null on failure.
 *
 * The algorithm builds per-vertex perpendicular offsets with miter joints,
 * capped at 2× halfWidth to prevent spike artefacts at sharp bends.
 */
export function bufferLinestring(points, halfWidthMM) {
  if (!points || points.length < 2 || halfWidthMM < 1e-4) return null;

  // Extend endpoints by halfWidth so adjacent road segments overlap at
  // intersections — eliminates the "short segment" gaps between ways.
  const ext = points.map(p => ({ x: p.x, y: p.y }));
  const d0  = dirNorm(points[0], points[1]);
  const dn  = dirNorm(points[points.length - 2], points[points.length - 1]);
  ext[0]               = { x: points[0].x               - d0.x * halfWidthMM,
                            y: points[0].y               - d0.y * halfWidthMM };
  ext[points.length-1] = { x: points[points.length-1].x + dn.x * halfWidthMM,
                            y: points[points.length-1].y + dn.y * halfWidthMM };

  const offsets = buildMiterOffsets(ext, halfWidthMM);
  if (!offsets) return null;

  const left  = offsets.map(o => o.left);
  const right = offsets.map(o => o.right).reverse();
  return [...left, ...right];
}

function dirNorm(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l  = Math.sqrt(dx * dx + dy * dy);
  return l < 1e-9 ? { x: 1, y: 0 } : { x: dx / l, y: dy / l };
}

function buildMiterOffsets(points, halfWidth) {
  const n = points.length;
  const result = [];
  const MAX_MITER = halfWidth * 4;

  for (let i = 0; i < n; i++) {
    const P = points[i];

    // Tangent direction at vertex i
    let tangent;
    if (i === 0) {
      tangent = vecSub(points[1], points[0]);
    } else if (i === n - 1) {
      tangent = vecSub(points[n - 1], points[n - 2]);
    } else {
      // Average of normalised in-segment and out-segment directions
      const t1 = vecSub(points[i],     points[i - 1]);
      const t2 = vecSub(points[i + 1], points[i]);
      const l1 = Math.sqrt(t1.x * t1.x + t1.y * t1.y);
      const l2 = Math.sqrt(t2.x * t2.x + t2.y * t2.y);
      if (l1 < 1e-9 && l2 < 1e-9) return null;
      tangent = {
        x: (l1 > 1e-9 ? t1.x / l1 : 0) + (l2 > 1e-9 ? t2.x / l2 : 0),
        y: (l1 > 1e-9 ? t1.y / l1 : 0) + (l2 > 1e-9 ? t2.y / l2 : 0),
      };
    }

    const tLen = Math.sqrt(tangent.x * tangent.x + tangent.y * tangent.y);
    if (tLen < 1e-9) continue;

    const norm = { x: tangent.x / tLen, y: tangent.y / tLen };
    // CCW perpendicular (left normal)
    const perp = { x: -norm.y, y: norm.x };

    // Clamp offset magnitude to prevent extreme miters
    const clamp_scale = Math.min(1, MAX_MITER / halfWidth);

    result.push({
      left:  { x: P.x + perp.x * halfWidth * clamp_scale,
               y: P.y + perp.y * halfWidth * clamp_scale },
      right: { x: P.x - perp.x * halfWidth * clamp_scale,
               y: P.y - perp.y * halfWidth * clamp_scale },
    });
  }

  return result.length >= 2 ? result : null;
}
