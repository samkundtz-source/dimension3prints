/**
 * tileGrid.js — connected-tile topology for the multi-tile ("bigger map") feature.
 *
 * Per-shape tiling (as specified):
 *   • square   → rectangular grid (tiles abut edge-to-edge: N/S/E/W)
 *   • hexagon  → honeycomb (flat-top hexes, 6 edge-neighbours)
 *   • circle   → NOT tileable (circles can't tessellate) → no neighbours
 *
 * A "cell" is an integer coordinate pair {a, b} identifying a tile relative to
 * the anchor cell {a:0, b:0}. This module is pure math (no DOM / network) so it
 * can be unit-tested in isolation.
 *
 * Coordinate conventions:
 *   - Model space: each tile is the usual ±R box/shape. R = MODEL_RADIUS_MM.
 *   - cellToModelOffset → where a tile's CENTRE sits in the combined model (mm).
 *   - cellToGeoCenter   → the real-world lat/lng to capture for that tile, so
 *     neighbouring tiles abut exactly on the ground.
 */

import { MODEL_RADIUS_MM } from '../utils/helpers.js';

const R = MODEL_RADIUS_MM;
const SQRT3 = Math.sqrt(3);

export const MAX_TILES = 9;            // 3×3 cap (9 tiles total)
export const PRICE_BASE = 29.99;       // first tile
export const PRICE_PER_EXTRA = 35;     // each additional tile

/** Is this shape tileable into a bigger connected map? */
export function isTileable(shape) {
  return shape === 'square' || shape === 'hexagon';
}

/** Total price for N tiles. Server re-computes authoritatively at checkout. */
export function priceForTiles(n) {
  if (n <= 1) return PRICE_BASE;
  return PRICE_BASE + PRICE_PER_EXTRA * (n - 1);
}

const cellKey = (c) => `${c.a},${c.b}`;

/**
 * Edge-neighbour deltas for a shape.
 *   square  → 4 (N/S/E/W)
 *   hexagon → 6 (flat-top axial: vertices at 0°/180°, flat top/bottom edges)
 *   circle  → none
 */
export function neighborDeltas(shape) {
  if (shape === 'square') {
    return [ { a: 1, b: 0 }, { a: -1, b: 0 }, { a: 0, b: 1 }, { a: 0, b: -1 } ];
  }
  if (shape === 'hexagon') {
    // Axial neighbours for flat-top hexes (basis e1=up-right, e2=down-right).
    return [
      { a: 1, b: 0 }, { a: -1, b: 0 },
      { a: 0, b: 1 }, { a: 0, b: -1 },
      { a: 1, b: -1 }, { a: -1, b: 1 },
    ];
  }
  return [];
}

/** Cells adjacent to `cell` for this shape. */
export function neighborsOf(shape, cell) {
  return neighborDeltas(shape).map(d => ({ a: cell.a + d.a, b: cell.b + d.b }));
}

/**
 * Centre of a tile in combined MODEL space (mm). The anchor {0,0} is at origin.
 *   square : full tile is 2R wide → offset = (a·2R, b·2R) so tiles abut.
 *   hexagon: flat-top honeycomb. e1 = up-right, e2 = down-right.
 *            offset = a·e1 + b·e2 = ((a+b)·1.5R, (a−b)·(R√3/2)).
 */
export function cellToModelOffset(shape, cell) {
  if (shape === 'hexagon') {
    return {
      x: (cell.a + cell.b) * 1.5 * R,
      y: (cell.a - cell.b) * (R * SQRT3 / 2),
    };
  }
  // square (default)
  return { x: cell.a * 2 * R, y: cell.b * 2 * R };
}

/**
 * Real-world capture centre for a tile, so neighbours abut on the ground.
 * Converts the model-mm offset back to metres (× radiusMeters / R) then to
 * lat/lng around the anchor.
 */
export function cellToGeoCenter(shape, cell, anchorLat, anchorLng, radiusMeters, rotRad = 0) {
  let off = cellToModelOffset(shape, cell);
  // Rotate the grid offset around the ANCHOR so the whole tile grid turns as
  // one rigid block (not each tile around its own centre).
  if (rotRad) {
    const c = Math.cos(rotRad), s = Math.sin(rotRad);
    off = { x: off.x * c - off.y * s, y: off.x * s + off.y * c };
  }
  const mPerMM = radiusMeters / R;
  const dxM = off.x * mPerMM;
  const dyM = off.y * mPerMM;
  const dLat = dyM / 111320;
  const dLng = dxM / (111320 * Math.cos(anchorLat * Math.PI / 180));
  return { lat: anchorLat + dLat, lng: anchorLng + dLng };
}

/**
 * Validate a selected set of cells:
 *   - within MAX_TILES
 *   - all edge-connected to the anchor (one contiguous blob, no diagonal-only)
 * Returns { ok, reason }.
 */
export function validateSelection(shape, cells) {
  if (!isTileable(shape)) return { ok: false, reason: 'shape not tileable' };
  if (!cells.length) return { ok: false, reason: 'no tiles' };
  if (cells.length > MAX_TILES) return { ok: false, reason: `max ${MAX_TILES} tiles` };
  const set = new Set(cells.map(cellKey));
  if (!set.has('0,0')) return { ok: false, reason: 'must include anchor' };
  // BFS from anchor over edge-neighbours; every cell must be reachable.
  const seen = new Set(['0,0']);
  const queue = [{ a: 0, b: 0 }];
  while (queue.length) {
    const c = queue.shift();
    for (const nb of neighborsOf(shape, c)) {
      const k = cellKey(nb);
      if (set.has(k) && !seen.has(k)) { seen.add(k); queue.push(nb); }
    }
  }
  if (seen.size !== set.size) return { ok: false, reason: 'tiles not all connected' };
  return { ok: true };
}

/**
 * Human-friendly name for a tile, relative to the MIDDLE (anchor) piece — used
 * for print/export filenames so they're obvious to assemble. The anchor is
 * always "middle"; others are described by steps up/down/left/right from it.
 *   square : {0,0}→"middle", {1,0}→"1-right", {0,1}→"1-up",
 *            {-1,0}→"1-left", {0,-1}→"1-down", {1,1}→"1-up-1-right",
 *            {-1,-1}→"1-down-1-left", {2,-1}→"1-down-2-right"
 *   hexagon: uses the tile's real model offset → "up", "down", "up-right",
 *            "up-left", "down-right", "down-left" (further rings may repeat;
 *            the exporter de-duplicates filenames, so that's fine).
 * b = rows (north +), a = columns (east +).
 */
export function tileLabel(shape, cell) {
  if (cell.a === 0 && cell.b === 0) return 'middle';
  if (shape === 'hexagon') {
    const off = cellToModelOffset('hexagon', cell);
    const ud = off.y > 1 ? 'up' : off.y < -1 ? 'down' : '';
    const lr = off.x > 1 ? 'right' : off.x < -1 ? 'left' : '';
    return [ud, lr].filter(Boolean).join('-') || 'middle';
  }
  // square grid
  const parts = [];
  if (cell.b > 0)      parts.push(`${cell.b}-up`);
  else if (cell.b < 0) parts.push(`${-cell.b}-down`);
  if (cell.a > 0)      parts.push(`${cell.a}-right`);
  else if (cell.a < 0) parts.push(`${-cell.a}-left`);
  return parts.join('-') || 'middle';
}
