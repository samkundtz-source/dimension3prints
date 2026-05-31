# Deep Audit & Polish — Handoff Brief

**Read this first in the fresh session.** The user requested a thorough, take-your-time
audit of the WHOLE app: find bugs, fix UI issues, min/max every detail, security review,
remove Netlify. Work methodically, verify each change (syntax-check → build → deploy),
and use the browser (Claude in Chrome) to *watch* fixes when possible — several bugs this
session could not be confirmed because the browser connection was down.

Live URL: https://dimension3prints.samkundtz.workers.dev/app.html
Deploy: `npm run build` then `npx wrangler deploy` (BOTH, from the worktree dir).
Auto-deploy + push to origin/main after every verified change (user's standing rule).
Admin unlock: Ctrl+Shift+E → password. Test Mode + Super Detail + Subway live in the panel.

Current clean baseline at time of handoff: commit `4d82974`.

---

## PRIORITY 1 — Search bar (VITAL, user reports it still broken)

**Status:** Structure fix IS deployed. `#search-results` was a sibling of `.search-row`
(only positioned ancestor), so its absolute `left/right` resolved against `#app` and the
dropdown rendered full-app-width / mispositioned. Last commit moved it INSIDE `.search-row`
(app.html ~line 52) and CSS uses `top:100%; left:0; right:0; z-index:4000`
(src/style.css ~line 238). The geocode API works (verified: `/api/geocode` returns Paris).

**If user STILL reports broken after a hard refresh (Ctrl+Shift+R):**
1. Open the live page in Claude in Chrome. Type in #search-input. Read the CONSOLE.
2. Prime suspect: a JS error in `initControls()` (src/main.js ~line 605) BEFORE the search
   wiring would abort the whole function and unbind everything. But search is wired FIRST
   (line 610), and other controls (sliders, generate) work, so initControls is running.
3. Check: is `doSearch()` (main.js ~144) actually firing? Add a temporary console.log.
   Is `.search-results:empty { display:none }` (style.css ~255) hiding a populated list?
   Is the Leaflet map's stacking context covering it despite z-index:4000?
4. Confirm the user isn't on cached JS — the asset hash changes each build; check the
   loaded app-*.js hash matches the latest dist.
DO NOT claim it's fixed without watching it work in the browser this time.

---

## PRIORITY 2 — Remove Netlify (user: "i dont use netfly anymore")

Stale, superseded by `worker/index.js`. Safe to delete:
- `netlify/functions/admin-orders.js`
- `netlify/functions/admin-update-order.js`
- `netlify/functions/admin-verify.js`
- `netlify/functions/create-checkout.js`
Also check for / remove: `netlify.toml`, any `netlify` mentions in package.json scripts,
README, or docs. Verify nothing in worker/ or src/ imports from netlify/ (it shouldn't).
`git rm` them, build, deploy, push.

---

## PRIORITY 3 — Subway / Transit polish (gift project — Paris Métro)

Current: lines render as black tubes + small station dots into the BLACK accumulator on a
white base. Code: `collectSubway()` in src/geometry/buildMap.js (~line 1436), data in
src/geo/subwayData.js (direct browser Overpass fetch — worker egress is blocked by Overpass,
returns 503; this is intentional, mirrors fetchOSMDirect). Admin toggle + "include city".

User feedback to address:
- Stations still clump in dense central Paris → consider de-duplicating station dots that
  are within Nmm of each other, or merging into the line tube; tune STN_R/HALF_W.
- "Some rail roads are missing" → investigate: are segments being over-clipped by the
  Cyrus–Beck inset (INSET=2.0mm)? Is Douglas–Peucker (eps 0.3) dropping short segments?
  Is the bbox capturing all lines (whole Métro spans ~18km; admin radius now allows 20km)?
- Make it MORE detailed / realistic (user wants the real network look — see their ref image
  of the official colored Métro map).
- COLOR-CODE LINES (the big win): OSM ways carry a `colour` tag (verified present). Plumb
  `line.colour` through to a per-line material. For the 3D preview, add materials keyed by
  hex. For 3MF/AMS multicolor export, reuse the wipe-tower/material path in
  src/export/exporters.js (`export3MF`). This makes it a genuine colored-metro display piece.

---

## PRIORITY 4 — Generation bugs (buildings) — min/max every detail

- Overlap resolver `resolveOverlaps()` in src/geo/osmData.js (~line 933): re-verify it's
  not over- or under-deleting. Unit-test harness pattern used earlier:
  `node --input-type=module -e "import {resolveOverlaps} ..."`.
- `dropEnvelopeBuildings()` (osmData.js ~749): Pass 1/Pass 2 heuristics — sanity check.
- Building extrusion + z-fighting: confirm fixed across dense cities (NYC, London, Chicago,
  Tokyo). renderOrder/polygonOffset config in src/preview/scene.js (~line 262).
- Landmark presets (landmarkPresets.js): spot-check Burj Khalifa, Eiffel still fire.

## PRIORITY 5 — Super Detail / LiDAR terrain
- User earlier said terrain "looked the same" as Terrarium. Verify 3DEP path actually
  engages (src/geo/elevationData.js + /api/elevation worker route). Test a hilly US city
  (Boulder, SF) and confirm the hi-res grid is visibly sharper than the Terrarium fallback.

## PRIORITY 6 — Security review
- Run the security-review skill on the full worker/index.js + new routes (/api/elevation,
  /api/subway-data). Check: rate limiting, bbox validation, admin token handling, Stripe
  checkout (create-checkout), no secrets in client, CSP in app.html covers all fetch hosts.

## PRIORITY 7 — General UI / perf
- Audit all `el('id').addEventListener` calls in main.js for missing null-guards (an
  unguarded one on a missing element throws and aborts init — exactly the search-bar class
  of bug). Make initControls() resilient.
- Bundle is ~715KB (warned >500KB). Consider code-splitting Three.js if worth it.
- Mobile layout pass.

---

## Hard-won facts (don't re-derive)
- Overpass blocks Cloudflare Worker egress → subway + OSM fetch run client-side direct.
- 3DEP exportImage returns tiled F32 GeoTIFF; custom decoder in src/geo/tiffFloat.js.
- Whole Paris Métro bbox fetch ≈ 1.9MB, ~1390 ways + 390 stations, HTTP 200 via fr mirror.
- Build bundles BOTH client and worker via Vite — ALWAYS `npm run build` before deploy or
  the worker ships stale (caused a 405 on /api/subway-data earlier).
- Editing gotcha this session: reading files via Bash (sed/awk/node) does NOT satisfy the
  Edit tool's "must Read first" — use the Read tool before Edit, and DON'T batch 20+ tool
  calls in one message (one failure cancels the rest).
