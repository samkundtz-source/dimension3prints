# Remaining work — hex/circle shapes + multi-structure shop

Baseline (DONE, shipped, verified): commit `4d9f1a2`, HEAD==origin/main, clean.
- New terrain-fused engine (`buildMapModelV2` in src/geometry/mapEngine.js) is the
  ONLY engine now — old buildMapModel path removed from main.js generate().
- Removed the "Detailed buildings", "Procedural infill", "Extended building data"
  toggles from app.html. Settings now = Shape, Rotation, Elevation Scale only
  (matches the screenshot the user approved).
- Water is locked & working: coastal SEA renders flat at SEA_LEVEL_Y with terrain
  clamped under sea polygons (point-in-polygon, scoped to isSea); inland water
  unchanged. DO NOT touch water again unless the user reports a specific bug.

Deploy = `npm run build` then `npx wrangler deploy` (BOTH). Auto-push origin/main.
VERIFY each step: node --check, build, deploy, then confirm live JS hash == built
hash (PowerShell Invoke-WebRequest on app.html with a cache-buster). The bash
channel has been flaky — prefer PowerShell for verification; keep edits SMALL
(big multi-line Edits keep silently failing on whitespace — make unique, short
old_strings and re-grep after each).

═══════════════════════════════════════════════════════════════════════════
## PHASE 2 — Hexagon & Circle board shapes (new engine)
═══════════════════════════════════════════════════════════════════════════
The new engine currently renders SQUARE only. `buildMapModelV2(features,
terrainOptions, projection, vertExag, onProgress)` does NOT yet accept shape
(main.js already passes `currentShape` as a 6th arg — it's ignored). The square
is hardcoded in three places in src/geometry/mapEngine.js:
  1. `const CLIP = R - 0.5` + `clipPolyToSquare()` (Sutherland–Hodgman vs square)
     and `clipSegmentToSquare()` (Liang–Barsky vs square) — used by buildings,
     water, roads.
  2. `collectTerrain(acc, hf, GN, seaRings, clampY)` — builds a full GN×GN square
     top grid + flat floor + 4 straight perimeter walls.
  3. `collectFlatBase(acc)` — square plate fallback when no terrain.

PLAN (keep square behaviour identical; add hex/circle as the same code path):
- Add `boundaryPoly` = `getShapeVertices(MODEL_RADIUS_MM - 0.5, shape, 0)` from
  '../geo/geoMath.js' (already imported pattern available). Square shape returns
  the 4 corners → identical to today.
- Generic `clipPolyToConvex(poly, boundary)` (Sutherland–Hodgman against an
  arbitrary CONVEX boundary — hex & circle are convex) replaces clipPolyToSquare.
  Generic `clipSegmentToConvex(a,b,boundary,margin)` replaces clipSegmentToSquare
  (clip the segment against each boundary edge / half-plane).
- Shaped terrain: for each GN×GN cell, clip the cell quad to `boundaryPoly`
  (skip if fully outside; pass through if fully inside via a quick all-corners-in
  test for speed; clip+fan-triangulate boundary cells). Floor = earcut of
  boundaryPoly at y=0. Walls = extrude each boundaryPoly edge from y=0 up to
  hf.heightAt(vertex). This yields SMOOTH hex/circle edges (no blocky steps).
  Circle = getShapeVertices returns 64 verts → smooth.
- Thread `shape` through buildMapModelV2 → pass boundaryPoly to terrain + clip
  helpers. TEST SQUARE FIRST (must look identical to 4d9f1a2), then hex, then
  circle. Screenshot each.

═══════════════════════════════════════════════════════════════════════════
## PHASE 3 — Grid tile system (CONFIRMED SPEC) + 3D previews
═══════════════════════════════════════════════════════════════════════════
USER'S EXACT INTENT (confirmed): think of a GRID. You select a square (one map
capture), then you can pick a square NEXT TO it and build off it — extending up
to a 3×3 grid (MAX 9 tiles total) — so it becomes ONE uniform, bigger map. Each
NEW square added costs +$35 (base model + $35 per extra tile). Each with 3D
previews. NOTE: grid cap is 3×3 (=9 tiles), NOT 9×9.

So this is NOT a cart of unrelated models. It's contiguous map TILING:
  • A tile = one capture area of fixed real-world size (= current radius/shape).
  • Tiles are grid-adjacent (share an edge). Selecting builds a bigger uniform map.
  • Grid max 3×3. Pricing: BASE_PRICE (existing $29.99) + $35 × (tileCount − 1).

BUILD PLAN:
1. Tile grid model:
   - Anchor tile = the user's chosen center. Define a tile step = 2×radius in
     real-world metres so neighbours abut exactly (no gap/overlap). Use geoMath:
     metresPerDegLat/Lng to convert the step to lat/lng offsets.
   - Track selected cells as integer (col,row) offsets from the anchor; enforce
     adjacency (a new cell must touch an existing one) and the 3×3 bound.
2. Selection UI (on the Leaflet map):
   - Draw the grid of candidate tiles around the selection as rectangles; clicked
     = selected (filled), neighbours of selected = "addable" (outline). Click to
     add/remove. Show live count + price ("3 tiles · $99.99").
   - Keep it on the AirPods-Pro black/white aesthetic.
3. Generation:
   - For each selected tile, fetch OSM (+ terrain) for that tile's bbox and build
     with buildMapModelV2, then OFFSET the resulting group in model space by the
     tile's (col,row) × tileSizeMM so they sit edge-to-edge as one uniform map.
   - The engine's thin uniform base (MAX_RELIEF_MM, flat floor at y=0) already
     makes tiles line up flush — good. Verify seams: adjacent tiles must share
     the same base height and border inset so they connect cleanly.
   - Performance: N tiles = N fetches/builds; cap at 3×3 = 9 tiles max.
3D PREVIEW: reuse SceneManager; render the combined multi-tile group in the main
   viewport (and optionally a small per-tile thumbnail in the grid UI).
PRICING + CHECKOUT:
   - Price label updates live: 29.99 + 35×(n−1).
   - Extend worker /api/create-checkout to take tileCount and compute the total
     (server-side authoritative price — don't trust client). One Stripe line item
     "Custom 3D map — N tiles" at the computed total, or N line items. Confirm
     exact line-item shape with user before wiring. (Card entry stays on Stripe.)

WHY A FRESH SESSION IS RECOMMENDED FOR THIS:
   This is a large multi-file feature (Leaflet grid UI + multi-bbox generation +
   mesh offaset/stitch + Stripe pricing). The current session is very long and
   the bash channel has been intermittently hanging, which makes big edits risky.
   A fresh session with a clean channel is the safe place to build it. Phases 1,
   2 and the water/shape fixes are all DONE, verified, and deployed — stable
   baseline to start from.
