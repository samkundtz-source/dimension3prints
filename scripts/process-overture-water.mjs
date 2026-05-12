/**
 * process-overture-water.mjs
 *
 * Converts an Overture Maps water polygon GeoJSON file into zoom-12 tiles
 * and uploads them to a Cloudflare R2 bucket named "overture-water".
 *
 * SETUP
 * -----
 * 1. Create an R2 bucket named "overture-water":
 *      wrangler r2 bucket create overture-water
 * 2. Uncomment the r2_buckets block in wrangler.jsonc and redeploy.
 * 3. Create an R2 API token (Dashboard → R2 → Manage R2 API tokens) with
 *    Object Read & Write on "overture-water".
 * 4. Set environment variables:
 *      CLOUDFLARE_ACCOUNT_ID   (from dashboard URL)
 *      R2_ACCESS_KEY_ID        (from the API token)
 *      R2_SECRET_ACCESS_KEY    (from the API token)
 * 5. npm install @aws-sdk/client-s3 (one-time, in this project)
 *
 * DOWNLOAD DATA
 * -------------
 *      pip install overturemaps
 *      overturemaps download \
 *        --bbox=-130,24,-65,50 \
 *        --type=water \
 *        -f geojson \
 *        -o us_water.geojson
 *
 * Pick a bbox covering the regions you want printable cities for.  The whole
 * USA is roughly --bbox=-130,24,-65,50.  For Europe try --bbox=-12,35,32,71.
 * Smaller bboxes = smaller download = fewer R2 storage costs.
 *
 * USAGE
 * -----
 *      node scripts/process-overture-water.mjs path/to/water.geojson
 *
 * Re-running is safe — tiles are overwritten.  Re-run when Overture publishes
 * a new monthly release if you want updated coastlines.
 */

import fs from 'fs';
import path from 'path';

// ── Tile math (Web Mercator z12 — same as Worker / MS Buildings) ──────────────

const ZOOM = 12;

function latLngToTile(lat, lng) {
  const n = 1 << ZOOM;
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const sinLat = Math.sin(latRad);
  const y = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

function tileKey(x, y) {
  return `${ZOOM}/${x}/${y}.json`;
}

// ── Feature bbox + tile-set computation ──────────────────────────────────────
// Water polygons (especially oceans, large lakes) span many tiles.  We assign
// each feature to every tile its bbox intersects so a model-bbox lookup finds
// the polygon regardless of where in the polygon the lookup falls.

function getFeatureBbox(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;

  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;

  function ring(coords) {
    for (const [lng, lat] of coords) {
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
    }
  }

  if (geom.type === 'Polygon')           geom.coordinates.forEach(ring);
  else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(p => p.forEach(ring));
  else return null;

  if (!isFinite(minLat)) return null;
  // Clamp out-of-range latitudes (Overture sometimes has bbox = world)
  return {
    minLat: Math.max(-85, minLat),
    maxLat: Math.min( 85, maxLat),
    minLng: Math.max(-180, minLng),
    maxLng: Math.min( 180, maxLng),
  };
}

// Skip features whose bbox covers an absurd number of tiles — these are
// usually ocean-class polygons that would balloon every tile they touch.
// 200 tiles × ~1 KB per polygon entry ≈ 200 KB extra per feature, acceptable.
const MAX_TILES_PER_FEATURE = 200;

function tilesForFeature(feature) {
  const bbox = getFeatureBbox(feature);
  if (!bbox) return null;

  const tl = latLngToTile(bbox.maxLat, bbox.minLng); // top-left
  const br = latLngToTile(bbox.minLat, bbox.maxLng); // bottom-right

  const xCount = br.x - tl.x + 1;
  const yCount = br.y - tl.y + 1;
  if (xCount * yCount > MAX_TILES_PER_FEATURE) return 'too-large';

  const tiles = [];
  for (let x = tl.x; x <= br.x; x++) {
    for (let y = tl.y; y <= br.y; y++) tiles.push({ x, y });
  }
  return tiles;
}

// ── R2 upload via S3-compatible API ──────────────────────────────────────────

async function uploadToR2(tiles) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKey || !secretKey) {
    throw new Error(
      'Missing env vars. Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
    );
  }

  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });

  const keys = Object.keys(tiles);
  console.log(`\nUploading ${keys.length} tiles to R2 bucket "overture-water"…`);

  let done = 0;
  const CONCURRENCY = 20;

  async function uploadOne(key) {
    const fc = { type: 'FeatureCollection', features: tiles[key] };
    await s3.send(new PutObjectCommand({
      Bucket: 'overture-water',
      Key: key,
      Body: JSON.stringify(fc),
      ContentType: 'application/json',
    }));
    done++;
    if (done % 50 === 0 || done === keys.length) {
      process.stdout.write(`\r  ${done}/${keys.length} uploaded`);
    }
  }

  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    await Promise.all(keys.slice(i, i + CONCURRENCY).map(uploadOne));
  }
  console.log('\nDone.');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/process-overture-water.mjs <path/to/water.geojson>');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Loading: ${path.basename(filePath)}`);
  const text = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(text);
  const features = Array.isArray(data) ? data
                 : Array.isArray(data?.features) ? data.features
                 : [];
  console.log(`  ${features.length.toLocaleString()} features parsed`);

  const tiles = {};
  let skippedNoBbox = 0, skippedTooLarge = 0;

  for (const feature of features) {
    const result = tilesForFeature(feature);
    if (!result) { skippedNoBbox++; continue; }
    if (result === 'too-large') { skippedTooLarge++; continue; }

    for (const t of result) {
      const key = tileKey(t.x, t.y);
      if (!tiles[key]) tiles[key] = [];
      tiles[key].push(feature);
    }
  }

  console.log(
    `  ${Object.keys(tiles).length.toLocaleString()} tiles, ` +
    `${skippedNoBbox} features without bbox, ` +
    `${skippedTooLarge} features too large (>${MAX_TILES_PER_FEATURE} tiles)`
  );

  await uploadToR2(tiles);
}

main().catch(err => { console.error(err); process.exit(1); });
