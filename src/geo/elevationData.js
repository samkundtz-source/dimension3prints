/**
 * Super-Detail elevation — real LiDAR-grade terrain from USGS 3DEP.
 *
 * Admin-only. Pulls a single high-resolution bare-earth (DTM) raster from the
 * USGS 3DEP ImageServer (1 m where flown, keyless, US coverage) via our worker
 * proxy at /api/elevation, decodes the float TIFF, and resamples it into the
 * SAME model-space Float32Array grid that terrain.js produces — so the existing
 * mesh pipeline (terrainOptions.elevGrid) renders it with no changes.
 *
 * Coverage is US-only; checkSuperDetailCoverage() lets the caller fall back to
 * the global Terrarium path (terrain.js) when 3DEP has nothing for the area.
 */

import { decodeFloatTIFF } from './tiffFloat.js';

// 3DEP encodes "no data" as a large-magnitude sentinel; treat anything beyond
// the plausible Earth-elevation envelope as missing.
const NODATA_LIMIT = 1e5;

/**
 * Is there 3DEP elevation data at this point?
 * @returns {Promise<{covered:boolean, value:(number|null)}>}
 */
export async function checkSuperDetailCoverage(lat, lng) {
  try {
    const r = await fetch('/api/elevation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ probe: { lat, lng } }),
    });
    if (!r.ok) return { covered: false, value: null };
    const j = await r.json();
    return { covered: !!j.covered, value: Number.isFinite(j.value) ? j.value : null };
  } catch {
    return { covered: false, value: null };
  }
}

/**
 * Fetch a high-resolution elevation grid in model space.
 *
 * Drop-in shape-compatible with terrain.js → fetchElevationForModel(): returns
 * Float32Array[gridSize*gridSize] where grid[j*N+i] is the elevation (metres) at
 *   x = (i/(N-1)*2 - 1)*radiusMM,  y = (j/(N-1)*2 - 1)*radiusMM.
 *
 * @param {number} centerLat
 * @param {number} centerLng
 * @param {number} radiusMeters  model radius, real-world metres
 * @param {number} radiusMM      model radius in mm (MODEL_RADIUS_MM)
 * @param {number} gridSize      output grid resolution (default 192)
 * @param {function} [onProgress]
 * @returns {Promise<Float32Array>}
 */
export async function fetchHiResElevationForModel(
  centerLat, centerLng, radiusMeters, radiusMM, gridSize = 192, onProgress,
) {
  onProgress?.('Fetching LiDAR elevation (USGS 3DEP)…');

  const cosLat = Math.cos(centerLat * Math.PI / 180);
  // 60% margin so rotation never samples outside the fetched raster (matches terrain.js)
  const radiusDeg = (radiusMeters * 1.6) / 111320;
  const minLat = centerLat - radiusDeg;
  const maxLat = centerLat + radiusDeg;
  const minLng = centerLng - radiusDeg / cosLat;
  const maxLng = centerLng + radiusDeg / cosLat;

  // Request the raster at ~2× the output grid so resampling has headroom.
  // Clamped server-side to [16, 512]; 512 over a ~4 km span ≈ 8 m/px.
  const reqSize = Math.max(96, Math.min(512, Math.round(gridSize * 2)));

  const resp = await fetch('/api/elevation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ south: minLat, north: maxLat, west: minLng, east: maxLng, size: reqSize }),
  });
  if (!resp.ok) {
    let msg = `elevation ${resp.status}`;
    try { const j = await resp.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }

  const buf = await resp.arrayBuffer();
  onProgress?.('Decoding elevation raster…');
  const { width, height, data } = decodeFloatTIFF(buf);

  // Replace NoData sentinels with the mean of valid samples (keeps the surface
  // continuous; areas of partial coverage degrade gracefully instead of spiking).
  let valid = 0, sum = 0;
  for (let k = 0; k < data.length; k++) {
    if (Math.abs(data[k]) < NODATA_LIMIT) { valid++; sum += data[k]; }
  }
  if (valid === 0) throw new Error('no elevation data for this area');
  const mean = sum / valid;
  for (let k = 0; k < data.length; k++) {
    if (Math.abs(data[k]) >= NODATA_LIMIT) data[k] = mean;
  }

  // Resample the north-up raster (covers [minLng,maxLng] × [minLat,maxLat]) into
  // the model-space grid with bilinear interpolation.
  onProgress?.('Resampling elevation grid…');
  const mPerMM     = radiusMeters / radiusMM;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * cosLat;
  const lngSpan = maxLng - minLng;
  const latSpan = maxLat - minLat;

  const grid = new Float32Array(gridSize * gridSize);
  for (let j = 0; j < gridSize; j++) {
    for (let i = 0; i < gridSize; i++) {
      const modelX = (i / (gridSize - 1) * 2 - 1) * radiusMM;
      const modelY = (j / (gridSize - 1) * 2 - 1) * radiusMM;
      const lat = centerLat + modelY * mPerMM / mPerDegLat;
      const lng = centerLng + modelX * mPerMM / mPerDegLng;

      const px = (lng - minLng) / lngSpan * (width - 1);
      const py = (maxLat - lat) / latSpan * (height - 1); // raster top = maxLat

      const x0 = Math.max(0, Math.min(width - 1, Math.floor(px)));
      const y0 = Math.max(0, Math.min(height - 1, Math.floor(py)));
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const fx = px - x0, fy = py - y0;

      grid[j * gridSize + i] =
        data[y0 * width + x0] * (1 - fx) * (1 - fy) +
        data[y0 * width + x1] *      fx  * (1 - fy) +
        data[y1 * width + x0] * (1 - fx) *      fy  +
        data[y1 * width + x1] *      fx  *      fy;
    }
  }

  return grid;
}
