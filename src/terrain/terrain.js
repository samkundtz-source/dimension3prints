/**
 * Real-terrain elevation from Terrarium tiles (AWS/Mapzen).
 * Free, no API key required, CORS-enabled.
 * Used only when Test Mode is active (admin-only).
 */

const TILE_SZ = 256;

function lng2tx(lng, z) { return Math.floor((lng + 180) / 360 * (1 << z)); }
function lat2ty(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z));
}
function tx2lng(tx, z) { return tx / (1 << z) * 360 - 180; }
function ty2lat(ty, z) {
  const n = Math.PI - 2 * Math.PI * ty / (1 << z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
function decodeTerr(r, g, b) { return (r * 256 + g + b / 256) - 32768; }

// Tile sources — tried in order until one succeeds
const TILE_SOURCES = [
  (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  (z, x, y) => `https://tile.nextzen.org/tilezen/terrain/v1/terrarium/${z}/${x}/${y}.png`,
];

async function fetchTilePixels(tx, ty, zoom) {
  // Use fetch() → createObjectURL trick: loading from a blob: URL means the
  // canvas is never considered cross-origin, so getImageData() never throws a
  // SecurityError even when the server's CORS headers are misconfigured.
  let lastErr;
  for (const src of TILE_SOURCES) {
    try {
      const url  = src(zoom, tx, ty);
      const resp = await fetch(url, { mode: 'cors', cache: 'force-cache' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob    = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload  = () => { URL.revokeObjectURL(blobUrl); res(im); };
        im.onerror = () => { URL.revokeObjectURL(blobUrl); rej(new Error('img load')); };
        im.src = blobUrl;
      });
      const c = document.createElement('canvas');
      c.width = c.height = TILE_SZ;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.getContext('2d').getImageData(0, 0, TILE_SZ, TILE_SZ).data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Tile ${zoom}/${tx}/${ty}: ${lastErr?.message}`);
}

/**
 * Fetch an elevation grid in model-space coordinates.
 *
 * The returned Float32Array[gridSize*gridSize] is compatible with
 * helpers.bilinearInterp: grid[j*N + i] is the elevation (metres) at the
 * model point  x = (i/(N-1)*2 - 1)*radiusMM,  y = (j/(N-1)*2 - 1)*radiusMM.
 *
 * @param {number} centerLat   Geographic centre latitude
 * @param {number} centerLng   Geographic centre longitude
 * @param {number} radiusMeters  Model radius in real-world metres
 * @param {number} radiusMM    Model radius in mm (MODEL_RADIUS_MM)
 * @param {number} gridSize    Output grid resolution (default 64)
 * @param {function} onProgress  Optional progress callback(msg)
 */
export async function fetchElevationForModel(centerLat, centerLng, radiusMeters, radiusMM, gridSize = 64, onProgress) {
  onProgress?.('Fetching terrain tiles…');

  const cosLat = Math.cos(centerLat * Math.PI / 180);
  const radiusDeg = (radiusMeters * 1.6) / 111320; // 60% margin handles rotation

  const bounds = {
    minLat: centerLat - radiusDeg,
    maxLat: centerLat + radiusDeg,
    minLng: centerLng - radiusDeg / cosLat,
    maxLng: centerLng + radiusDeg / cosLat,
  };

  const zoom = radiusMeters > 8000 ? 11 : radiusMeters > 3500 ? 12 : 13;
  const maxT = (1 << zoom) - 1;

  const txMin = Math.max(0, lng2tx(bounds.minLng, zoom));
  const txMax = Math.min(maxT, lng2tx(bounds.maxLng, zoom));
  const tyMin = Math.max(0, lat2ty(bounds.maxLat, zoom)); // NW = smaller ty
  const tyMax = Math.min(maxT, lat2ty(bounds.minLat, zoom)); // SE = larger ty

  // Fetch all tiles in parallel — allSettled so a single bad tile doesn't
  // abort the whole operation (missing tiles are left as 0 / interpolated later)
  const fetches = [];
  for (let ty = tyMin; ty <= tyMax; ty++)
    for (let tx = txMin; tx <= txMax; tx++)
      fetches.push(fetchTilePixels(tx, ty, zoom).then(p => ({ tx, ty, p })));
  const results = await Promise.allSettled(fetches);
  const tiles = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (tiles.length === 0) throw new Error('All terrain tiles failed to load');
  onProgress?.(`Terrain: ${tiles.length}/${fetches.length} tiles loaded (zoom ${zoom})`);

  // Stitch into one float image
  const nTX = txMax - txMin + 1;
  const nTY = tyMax - tyMin + 1;
  const fullW = nTX * TILE_SZ;
  const fullH = nTY * TILE_SZ;
  const stitched = new Float32Array(fullW * fullH);

  for (const { tx, ty, p } of tiles) {
    const ox = (tx - txMin) * TILE_SZ;
    const oy = (ty - tyMin) * TILE_SZ;
    for (let py = 0; py < TILE_SZ; py++) {
      for (let px = 0; px < TILE_SZ; px++) {
        const pi = (py * TILE_SZ + px) * 4;
        stitched[(oy + py) * fullW + (ox + px)] = decodeTerr(p[pi], p[pi + 1], p[pi + 2]);
      }
    }
  }

  // Geographic extents of stitched image
  const imgW0 = tx2lng(txMin, zoom);
  const imgW1 = tx2lng(txMax + 1, zoom);
  const imgN  = ty2lat(tyMin, zoom);
  const imgS  = ty2lat(tyMax + 1, zoom);
  const lngSpan = imgW1 - imgW0;
  const latSpan = imgN - imgS;

  const mPerMM     = radiusMeters / radiusMM;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * cosLat;

  // Resample to gridSize×gridSize, aligned to model space
  onProgress?.('Resampling elevation grid…');
  let grid = new Float32Array(gridSize * gridSize);

  for (let j = 0; j < gridSize; j++) {
    for (let i = 0; i < gridSize; i++) {
      const modelX = (i / (gridSize - 1) * 2 - 1) * radiusMM;
      const modelY = (j / (gridSize - 1) * 2 - 1) * radiusMM;

      // Approximate geographic position (ignores rotation — acceptable for preview)
      const lat = centerLat + modelY * mPerMM / mPerDegLat;
      const lng = centerLng + modelX * mPerMM / mPerDegLng;

      // Fractional pixel in stitched image
      const px = (lng - imgW0) / lngSpan * fullW;
      const py = (imgN - lat) / latSpan * fullH;

      const x0 = Math.max(0, Math.min(fullW - 1, Math.floor(px)));
      const y0 = Math.max(0, Math.min(fullH - 1, Math.floor(py)));
      const x1 = Math.min(fullW - 1, x0 + 1);
      const y1 = Math.min(fullH - 1, y0 + 1);
      const fx = px - x0, fy = py - y0;

      grid[j * gridSize + i] =
        stitched[y0 * fullW + x0] * (1 - fx) * (1 - fy) +
        stitched[y0 * fullW + x1] *      fx  * (1 - fy) +
        stitched[y1 * fullW + x0] * (1 - fx) *      fy  +
        stitched[y1 * fullW + x1] *      fx  *      fy;
    }
  }

  // Smooth the grid with 2 passes of a weighted kernel (Gaussian-like) to
  // remove tile-boundary stair-steps while preserving enough detail for
  // visible terrain relief in the final print.
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(gridSize * gridSize);
    for (let j = 0; j < gridSize; j++) {
      for (let i = 0; i < gridSize; i++) {
        let sum = 0, wt = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = i + di, nj = j + dj;
            if (ni < 0 || ni >= gridSize || nj < 0 || nj >= gridSize) continue;
            // Centre=4, edges=2, corners=1 (matches a 3×3 Gaussian kernel)
            const w = (di === 0 && dj === 0) ? 4 : (di !== 0 && dj !== 0) ? 1 : 2;
            sum += grid[nj * gridSize + ni] * w;
            wt  += w;
          }
        }
        tmp[j * gridSize + i] = sum / wt;
      }
    }
    grid = tmp;
  }

  return grid;
}
