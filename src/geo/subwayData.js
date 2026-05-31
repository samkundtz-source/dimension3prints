/**
 * Subway / transit network fetch (admin Subway mode).
 *
 * Queries OSM `railway=subway` lines + subway station nodes for a bbox.
 *
 * IMPORTANT: this runs DIRECTLY in the browser against the Overpass mirrors,
 * not through our Cloudflare worker. Overpass blocks Cloudflare egress IPs
 * (the worker route reliably returns 503), exactly like the main OSM fetch
 * which falls back to `fetchOSMDirect`. The app's CSP already whitelists these
 * mirror domains for connect-src.
 */

const SUBWAY_MIRRORS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

function subwayQuery({ south, west, north, east }) {
  const bb = `${south},${west},${north},${east}`;
  // Generous timeout — whole-metro captures cover a large bbox.
  return `[out:json][timeout:90];(` +
    `way["railway"="subway"](${bb});` +
    `node["station"="subway"](${bb});` +
    `);out geom;`;
}

/**
 * @returns {Promise<{ lines:{pts:[number,number][], colour:string|null}[],
 *                      stations:{lat:number,lng:number,name:string|null}[] }>}
 */
export async function fetchSubway(bbox, onProgress) {
  onProgress?.('Fetching subway network…');
  const body = 'data=' + encodeURIComponent(subwayQuery(bbox));

  let data = null, lastErr = null;
  for (const url of SUBWAY_MIRRORS) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const j = await resp.json();
      if (!Array.isArray(j.elements)) throw new Error('bad response');
      data = j;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!data) throw new Error(`subway data unavailable (${lastErr?.message || 'all mirrors failed'})`);

  const lines = [];
  const stations = [];
  for (const el of data.elements) {
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      const pts = el.geometry.filter(Boolean).map(g => [g.lat, g.lon]);
      if (pts.length >= 2) {
        lines.push({ pts, colour: el.tags?.colour || el.tags?.color || null });
      }
    } else if (el.type === 'node' && el.lat != null && el.lon != null) {
      stations.push({ lat: el.lat, lng: el.lon, name: el.tags?.name || null });
    }
  }
  return { lines, stations };
}
