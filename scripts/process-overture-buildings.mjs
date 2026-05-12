/**
 * process-overture-buildings.mjs
 *
 * Converts an Overture Maps building GeoJSON file into zoom-12 tiles and
 * uploads them to the Cloudflare R2 bucket "overture-buildings".
 *
 * SETUP
 * -----
 * 1. Create the R2 bucket:
 *      wrangler r2 bucket create overture-buildings
 * 2. Make sure wrangler.jsonc has the OVERTURE_BUILDINGS r2_buckets binding,
 *    then redeploy: `npx wrangler deploy`
 * 3. Create an R2 API token (Dashboard → R2 → Manage R2 API tokens) with
 *    Object Read & Write on "overture-buildings".
 * 4. Set environment variables (PowerShell):
 *      $env:CLOUDFLARE_ACCOUNT_ID="..."
 *      $env:R2_ACCESS_KEY_ID="..."
 *      $env:R2_SECRET_ACCESS_KEY="..."
 * 5. npm install @aws-sdk/client-s3 (one-time, in this project)
 *
 * DOWNLOAD DATA
 * -------------
 *      pip install overturemaps
 *      overturemaps download \
 *        --bbox=-74.05,40.65,-73.85,40.85 \
 *        --type=building \
 *        -f geojson \
 *        -o nyc_buildings.geojson
 *
 * Buildings are LARGE — pick small bboxes per city, not whole countries.
 * Manhattan alone is ~50 MB.  Whole US would be 30+ GB and overflow free tier.
 *
 * Suggested per-city bboxes:
 *   NYC          --bbox=-74.05,40.65,-73.85,40.85
 *   SF           --bbox=-122.55,37.70,-122.35,37.85
 *   London       --bbox=-0.25,51.40,0.10,51.62
 *   Tokyo central --bbox=139.65,35.62,139.85,35.78
 *
 * USAGE
 * -----
 *      node scripts/process-overture-buildings.mjs path/to/buildings.geojson
 *
 * Re-running is safe — tiles are merged (not overwritten) so you can run
 * the script multiple times for different cities and accumulate coverage.
 */

import fs from 'fs';
import path from 'path';

// ── Tile math (Web Mercator z12 — same as Worker) ─────────────────────────────

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

function centroid(coords) {
  let sumLng = 0, sumLat = 0;
  for (const [lng, lat] of coords) { sumLng += lng; sumLat += lat; }
  return { lat: sumLat / coords.length, lng: sumLng / coords.length };
}

// Buildings are small — assign each to its centroid tile (no need to spread
// across multiple tiles like ocean polygons).
function featureTile(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;
  const ring = geom.type === 'Polygon'      ? geom.coordinates[0]
             : geom.type === 'MultiPolygon' ? geom.coordinates[0][0]
             : null;
  if (!ring || ring.length === 0) return null;
  const c = centroid(ring);
  if (c.lat < -85 || c.lat > 85) return null;
  return latLngToTile(c.lat, c.lng);
}

// ── R2 upload via S3-compatible API ──────────────────────────────────────────
// Buildings get MERGED with any existing tile contents so multiple bbox runs
// (different cities) accumulate rather than overwrite.

async function uploadToR2(tiles) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKey || !secretKey) {
    throw new Error(
      'Missing env vars. Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
    );
  }

  const { S3Client, PutObjectCommand, GetObjectCommand, NoSuchKey } = await import('@aws-sdk/client-s3');

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });

  const keys = Object.keys(tiles);
  console.log(`\nUploading ${keys.length} tiles to R2 bucket "overture-buildings"…`);

  let done = 0;
  const CONCURRENCY = 20;

  async function uploadOne(key) {
    // Try to fetch the existing tile so we can merge
    let existing = [];
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: 'overture-buildings', Key: key }));
      const text = await obj.Body.transformToString();
      const fc = JSON.parse(text);
      if (Array.isArray(fc?.features)) existing = fc.features;
    } catch (e) {
      if (e?.name !== 'NoSuchKey' && e?.$metadata?.httpStatusCode !== 404) {
        // unexpected — log but continue with empty existing
      }
    }

    // Dedup by feature id (Overture features have stable IDs)
    const byId = new Map();
    for (const f of existing) byId.set(f.id || JSON.stringify(f.geometry), f);
    for (const f of tiles[key]) byId.set(f.id || JSON.stringify(f.geometry), f);

    const fc = { type: 'FeatureCollection', features: Array.from(byId.values()) };
    await s3.send(new PutObjectCommand({
      Bucket: 'overture-buildings',
      Key: key,
      Body: JSON.stringify(fc),
      ContentType: 'application/json',
    }));
    done++;
    if (done % 25 === 0 || done === keys.length) {
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
    console.error('Usage: node scripts/process-overture-buildings.mjs <path/to/buildings.geojson>');
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
  console.log(`  ${features.length.toLocaleString()} buildings parsed`);

  const tiles = {};
  let skipped = 0;

  for (const feature of features) {
    const tile = featureTile(feature);
    if (!tile) { skipped++; continue; }
    const key = tileKey(tile.x, tile.y);
    if (!tiles[key]) tiles[key] = [];
    tiles[key].push(feature);
  }

  console.log(`  ${Object.keys(tiles).length.toLocaleString()} tiles, ${skipped} skipped`);
  await uploadToR2(tiles);
}

main().catch(err => { console.error(err); process.exit(1); });
