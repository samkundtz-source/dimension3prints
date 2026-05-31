# Realism Pass — make models go "WOW" (real geometry, not boxes)

User mandate (verbatim intent): "find a model that makes me go wow — that's the Eiffel
Tower, those are the struts of the pillar, that's that tree. I need to know instantly. No
more boxes/houses, I want REAL geometry, as real as possible — like a 3D modeler spent
time modeling." User chose order: **1) Eiffel Tower, 2) roofs on all houses, 3) trees.**

Baseline commit at handoff: `6c48f27`. Live: https://dimension3prints.samkundtz.workers.dev/app.html
Deploy = `npm run build` && `npx wrangler deploy` (BOTH). Auto-push origin/main after each verified step.
Admin: Ctrl+Shift+E. Use Claude in Chrome to SCREENSHOT each result before claiming done.

## CRITICAL HONESTY (tell the user, don't pretend otherwise)
- There is NO free high-res surface LiDAR for Paris / most of the world. USGS 3DEP (the
  Super Detail source) is US-only AND bare-earth (ground, never buildings). Paris is flat,
  so Super Detail legitimately does nothing visible there. The road to "wow" is BETTER
  PROCEDURAL GEOMETRY, not LiDAR. Do not promise LiDAR buildings for Paris.

---

## BUG FOUND THIS SESSION (root cause of the "Eiffel = cylinder" screenshot)
Two separate bugs:

1. **Landmark/detailed geometry only runs when the "Detailed buildings" toggle is ON.**
   `src/geometry/buildMap.js` ~line 380: `if (detailedBuildings) { ...3-tier system... }
   else { collectExtrudedPolygon(...) }`. The user had it OFF, so the Eiffel's small OSM
   platform footprint was extruded straight to 324 m → the tall cylinder/pillar they saw.
   **USER DECISION (do this):** keep landmarks GATED behind the "Detailed buildings"
   toggle — the user explicitly chose this over always-on. So the fix is: DEFAULT THE
   TOGGLE ON (and/or auto-enable it the first time a known landmark like the Eiffel is in
   view), and make sure the user understands landmarks need that toggle. Do NOT make
   landmarks fire unconditionally. Implementation: set the `#detailed-buildings` checkbox
   `checked` by default in app.html, and ensure `detailedBuildings` reads true on first
   generate. Optionally show a hint when a landmark is detected but the toggle is off.

2. **The Eiffel preset itself is crude** — 4 stacked flat squares + a thin spire
   (`landmarkPresets.js` ~line 651, `eiffelTower.generate`). No legs, no arch, no lattice.
   Needs a real model (below).

---

## STEP 1 — Eiffel Tower preset (the hero)
File: `src/geometry/landmarkPresets.js`, `LANDMARK_PRESETS.eiffelTower.generate(ctx, acc, polygon, baseY, totalH, heightM)`.
Helpers available via ctx: collectExtrudedPolygon, shrinkToCentroid, collectSpire,
collectBandedBuilding, minBBoxDimension, deterministicFrac, acc. Also `buildSpire(acc,cx,cy,y,h,r0,r1)`
and `centroid(polygon)` exist in the module. Axis: 2D (x,y) -> 3D (x, height, -y), Y up.

Build a recognizable Eiffel from primitives (all via collectExtrudedPolygon prisms):
- **4 legs**: at the 4 corners of a square of half-width ~ dim*0.5. Each leg is a column
  that TAPERS and LEANS INWARD as it rises (sample the curve in ~8-12 vertical segments;
  at each segment the leg's x/z position lerps toward the center and its cross-section
  shrinks). The inward curve is the Eiffel signature.
- **Arch suggestion**: between the legs at the 1st-platform level, optionally a thin cross
  member / leave open space so legs read as 4 separate splayed legs (the open base is iconic).
- **Platform 1** (~57m, 17.6%): a wide flat square slab spanning the legs.
- **Platform 2** (~115m, 35.5%): a smaller slab; legs have merged toward center by here.
- Above plat2 the 4 legs have converged into a single tapering **lattice shaft** up to
  **Platform 3** (~276m, 85%): small observation slab.
- **Spire/antenna** 276->324m: thin tapered spire via buildSpire.
- Scale everything off `dim = max(minBBoxDimension(polygon), totalH*0.38)` and `totalH`.
- Keep triangle count sane (legs in ~10 segments × 4 = fine). Print-safe: no sub-0.8mm parts.
VERIFY: search "Eiffel Tower", generate, SCREENSHOT — must read as the Eiffel at a glance.
Also confirm it fires with Detailed-buildings OFF (after Bug 1 fix).

## STEP 2 — Roofs on all houses (de-box the city)
File: `src/geometry/buildMap.js` — the standard/Tier-3 path (`collectDetailedBuilding`, ~1553)
and/or the plain path (line 415). Goal: replace flat tops with simple pitched/hipped roofs.
- For a building footprint below some height (houses, not towers), add a roof: gable or hip.
  Simple approach: inset the top ring slightly and raise a ridge line, or add a low pyramid
  cap for near-square footprints and a ridged prism for elongated ones.
- Respect OSM `roof:shape` / `roof:height` tags when present; else infer from footprint
  aspect ratio. Keep it cheap (no per-building earcut explosions for huge cities).
- Must not regress z-fighting or the overlap resolver. Test dense city (London) for tri count.
VERIFY: generate a residential area, SCREENSHOT — rooftops visible, not flat boxes.

## STEP 3 — Trees + greenery
`features.trees` already parsed (natural=tree nodes) in osmData.js -> `{x,y,tags}`.
Currently NOT rendered. Add a `collectTrees(acc, trees, baseTop)` in buildMap.js:
- Each tree = a small trunk prism + a faceted canopy (low-poly sphere/icosa or stacked
  tapered prisms). Keep them tiny + cheap; cap count (e.g. sample if >N trees).
- Parks (features.parks) could get a subtle raised/!textured fill to read as green space.
VERIFY: generate near a park, SCREENSHOT — little trees visible.

## General rules
- Read files with the Read tool before Edit (Bash/node reads don't satisfy Edit's guard).
- Don't batch 20+ tool calls; one Windows /tmp failure cancels the whole batch.
- Build BOTH client+worker (Vite bundles worker too) before every deploy.
- Screenshot-verify each step in-browser; the user has been burned by "fixed" claims that weren't.
