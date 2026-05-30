# Subway / Transit Mode — build spec (admin feature)

Status: **data layer de-risked & proven. Rendering + integration not yet built.**
Paused because the session that scoped this ran out of context to safely read the
projection/mesh/export internals. Start a fresh session and follow this.

## Proven facts (do NOT re-investigate — already verified live)
- Overpass query for Paris Métro returns rich, precise data:
  - `way["railway"="subway"](bbox)` → track segments (central-Paris test: 1,622 ways, ~16,586 vertices)
  - `node["station"="subway"](bbox)` → stations (central test: 119, with `name` tags)
  - Many ways carry a `colour` tag = official line colour (12 distinct in central Paris, e.g. `#FFCD00`)
- Full Métro fits within the existing 10 km radius cap (Paris ≈ 10×8 km inside the Périphérique).
- RER regional lines sprawl 50 km+ → out of scope for a single model; Métro-only for v1.
- `out geom;` returns way geometry inline as `[{lat,lon},...]` — easiest to parse, no node resolution.

## Architecture (keep it SELF-CONTAINED — do not modify the working city parse/render)
Mirror how `/api/elevation` + `src/geo/elevationData.js` were added this session.

### 1. Worker route `/api/subway-data` (worker/index.js)
- POST `{south,west,north,east}`. Reuse `validateBbox`, `validateBboxSize`, `checkPublicRateLimit(env, ip, 'subway', 15, 60)`.
- Build Overpass query:
  `[out:json][timeout:25];(way["railway"="subway"](S,W,N,E);node["station"="subway"](S,W,N,E););out geom;`
- Reuse `fetchOverpassServer` + `OVERPASS_SERVERS_WORKER` (Promise.any race), like `handleOSMData`.
- Normalize → return JSON:
  `{ lines:[{ pts:[[lat,lng],...], colour:"#RRGGBB"|null, ref:"4"|null }], stations:[{lat,lng,name}] }`
- Edge-cache via `caches.default` keyed by normalized bbox (subway data is static). Register case in the `switch`.

### 2. Client `src/geo/subwayData.js`
- `fetchSubway({south,west,north,east})` → POST `/api/subway-data` → returns `{lines, stations}`.

### 3. Mesh `src/geometry/subwayMesh.js`
- `buildSubwayGroup(lines, stations, project, shapeVerts, opts) -> THREE.Group`
  - IMPORTANT: take a `project(lat,lng)->{x,y}` callback passed in from main.js so this module
    never needs to know the projection's internal API. (CHECK how main.js's `projection` converts
    a geo point — read geoMath.js `createProjection` return shape; pass the right adapter.)
  - For each line: project pts → model XY, clip to shapeVerts, build a raised **tube/ribbon**
    (extruded thin prism along the polyline, height ~ a few mm above base). Consider
    Douglas–Peucker simplify (epsilon ~ 1–2 m) to cut the ~50k vertices and keep triangles sane.
  - Stations: small cylinders at projected points, slightly taller than the tubes.
  - Colour: map `colour` tag → material. For preview, per-line mesh colour. For 3MF multicolor,
    reuse the AMS material/wipe-tower path in `src/export/exporters.js` (`export3MF`).
  - Base plate: reuse the shape/base approach from buildMap (read how baseAcc builds the plate),
    or generate a simple shape-extruded plate from shapeVerts.

### 4. UI `app.html` (inside `#test-mode-section`, admin only)
- Toggle `#subway-mode` "🚇 Subway / Transit". Sub-options (show when on):
  - `#subway-include-city` "Include city above" (default off)
  - optional `#subway-colored` "Colour-code lines (AMS)"

### 5. Wire `src/main.js`
- Read toggles. When subway-mode on:
  - fetch subway data for the current bbox (compute bbox from selectedCenter + radius like the OSM path)
  - build subway group via `buildSubwayGroup(..., project, shapeVerts, ...)`
  - if "include city": also run the normal city build and add both groups; else show subway+base only
  - `scene.setModel(group)`. Export (STL/3MF) traverses the scene group → should work unchanged.

## Print/QA caveats to remember
- Thin tubes are fragile → give them enough width/height to print.
- Single-material printers: colour shows only as relief; colour-coding needs AMS 3MF path.
- "City above" can't be translucent on FDM — render city as outline/optional layer, subway as hero.

## Test locations
- Paris (Métro): centre ~48.8566, 2.3522, radius ~6–7 km.
- Also sanity-check London Underground + NYC Subway (same `railway=subway` tagging).
