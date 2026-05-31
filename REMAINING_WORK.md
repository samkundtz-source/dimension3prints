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
## PHASE 3 — Multi-structure shop + 3D previews (UI feature)
═══════════════════════════════════════════════════════════════════════════
User wants: a feature to print MULTIPLE connected structures OR buy separate
structures, each with a 3D preview; nice UI; functions well.

Open question to confirm with user before building (ask via AskUserQuestion):
  • "Connected" = physically tiling adjacent map areas into one continuous model
    (grid of neighboring captures that align at edges), vs. "separate" = a cart
    of independent models each bought on its own?  Build whichever they confirm;
    likely BOTH: a cart that holds N saved models, with a "connect adjacent"
    option when their capture areas are neighbors.

SUGGESTED BUILD:
- A "cart"/collection: each entry = saved generation params (lat,lng,radius,
  shape,rotation,elevation) + a thumbnail. Persist in localStorage.
- Per-entry 3D preview: reuse SceneManager (src/preview/scene.js) to render each
  saved model in a small canvas, or render one at a time in the main viewport.
- "Connected" mode: detect when saved capture bboxes are edge-adjacent; offer to
  generate them on one shared base plate (the thin uniform base from the engine
  already supports tiling — MAX_RELIEF_MM keeps it flat/connectable).
- Checkout: extend the existing Stripe flow (worker /api/create-checkout +
  netlify removed already) to accept multiple line items (one per structure, or
  one bundle for a connected set). Price = per-structure × count, or bundle price.
- UI: clean cart panel, thumbnails, qty, total, "Order all" / "Order separately".
  Match the AirPods-Pro black/white aesthetic already in index.html / style.css.

NOTE: confirm payment/line-item details with the user before wiring Stripe.
Prohibited to enter card data; the existing checkout already redirects to Stripe.
