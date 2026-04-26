/**
 * process-ms-buildings.mjs
 *
 * Converts a Microsoft Global ML Building Footprints GeoJSON file into
 * zoom-12 tiles and uploads them to Cloudflare R2.
 *
 * SETUP
 * -----
 * 1. Create an R2 bucket named "ms-buildings" in your Cloudflare dashboard.
 * 2. Create an R2 API token: Dashboard → R2 → Manage R2 API tokens → Create token
 *    with Object Read & Write on the "ms-buildings" bucket.
 * 3. Set environment variables:
 *      CLOUDFLARE_ACCOUNT_ID   (from dashboard URL: dash.cloudflare.com/<account-id>)
 *      R2_ACCESS_KEY_ID        (from the API token you just created)
 *      R2_SECRET_ACCESS_KEY    (from the API token you just created)
 * 4. npm install @aws-sdk/client-s3 (one-time, in this project)
 *
 * DOWNLOAD DATA
 * -------------
 * Go to: https://github.com/microsoft/GlobalMLBuildingFootprints
 * Find your country in the table → right-click the download link → copy URL.
 * Download with: curl -L "<url>" -o country.geojson.gz
 * (Files are gzip-compressed .geojson — this script handles that automatically)
 *
 * USAGE
 * -----
 * node scripts/process-ms-buildings.mjs path/to/country.geojson.gz
 * node scripts/process-ms-buildings.mjs path/to/country.geojson
 *
 * Run once per country file. Re-running is safe — tiles are overwritten.
 */

import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

// ── Tile math (Web Mercator, same as Worker) ──────────────────────────────────

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

// ── Stream a (possibly gzipped) GeoJSON file line-by-line ────────────────────
// Microsoft files use newline-delimited GeoJSON (one feature per line).

async function* streamFeatures(filePath) {
  const isGz = filePath.endsWith('.gz');
  const raw = fs.createReadStream(filePath);
  const stream = isGz ? raw.pipe(zlib.createGunzip()) : raw;

  let buf = '';
  for await (const chunk of stream) {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { yield JSON.parse(trimmed); } catch { /* skip malformed lines */ }
    }
  }
  if (buf.trim()) {
    try { yield JSON.parse(buf.trim()); } catch {}
  }
}

// ── Bucket features into tiles ────────────────────────────────────────────────

function centroid(coords) {
  let sumLng = 0, sumLat = 0;
  for (const [lng, lat] of coords) { sumLng += lng; sumLat += lat; }
  return { lat: sumLat / coords.length, lng: sumLng / coords.length };
}

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

async function uploadToR2(tiles) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKey || !secretKey) {
    throw new Error(
      'Missing env vars. Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
    );
  }

  // Lazy-import so the script works even without the package until needed
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });

  const keys = Object.keys(tiles);
  console.log(`\nUploading ${keys.length} tiles to R2 bucket "ms-buildings"…`);

  let done = 0;
  const CONCURRENCY = 20;

  async function uploadOne(key) {
    const fc = { type: 'FeatureCollection', features: tiles[key] };
    await s3.send(new PutObjectCommand({
      Bucket: 'ms-buildings',
      Key: key,
      Body: JSON.stringify(fc),
      ContentType: 'application/json',
    }));
    done++;
    if (done % 100 === 0 || done === keys.length) {
      process.stdout.write(`\r  ${done}/${keys.length} uploaded`);
    }
  }

  // Upload in parallel batches
  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    await Promise.all(keys.slice(i, i + CONCURRENCY).map(uploadOne));
  }
  console.log('\nDone.');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/process-ms-buildings.mjs <path/to/country.geojson.gz>');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Processing: ${path.basename(filePath)}`);

  const tiles = {}; // key → Feature[]
  let total = 0, skipped = 0;

  for await (const feature of streamFeatures(filePath)) {
    total++;
    const tile = featureTile(feature);
    if (!tile) { skipped++; continue; }

    const key = tileKey(tile.x, tile.y);
    if (!tiles[key]) tiles[key] = [];
    tiles[key].push(feature);

    if (total % 100000 === 0) {
      process.stdout.write(`\r  Parsed ${(total / 1e6).toFixed(1)}M features, ${Object.keys(tiles).length} tiles…`);
    }
  }

  console.log(`\n  Total: ${total.toLocaleString()} features, ${skipped} skipped, ${Object.keys(tiles).length} tiles`);

  await uploadToR2(tiles);
}

main().catch(err => { console.error(err); process.exit(1); });
