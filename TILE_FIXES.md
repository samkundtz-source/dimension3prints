# Three tile/terrain fixes (diagnosed) — baseline d1f22d6

## Issue 1 — terrain "hill then a huge jump" (looks wrong)
ROOT CAUSE: makeHeightField (src/geometry/mapEngine.js ~216) uses ROBUST 5th/95th
percentile lo/hi, then heightAt() CLAMPS elevation into [lo,hi]. Everything below
the 5th pct floors to lo and everything above the 95th pct snaps to hi → gradual
hills get squashed and then there's a hard plateau/cliff (the "jump").
FIX: don't hard-clamp. Use full (or 2nd/98th) min/max for normalization and let
the height vary continuously across the whole range. Keep MAX_RELIEF_MM cap for
total height (filament/thin-base) but apply it as a smooth scale, not a clamp.
Re-test NYC (flat, thin base must stay) AND a hilly city (SF) — relief should be
smooth, no cliffs.

## Issue 2 — square border bigger than the generation (ugly gap/lines)
ROOT CAUSE: terrain/base plate is built to full ±R, but features clip to
CLIP = R − 0.5 and water/coastline insets add more gap → a ring of empty plate
around the city + seam lines. The plate edge and the feature-clip boundary don't
match.
FIX: make the plate/terrain extent and the feature clip use the SAME boundary
(either build terrain to CLIP, or clip features to R). Simplest: set CLIP = R
(no inset) for square so features fill the plate; keep walls flush. Verify no
features poke past the edge after.

## Issue 3 — each grid tile must be its OWN printable export (PRODUCT BLOCKER)
A 3×3 combined model won't fit on a printer. User wants the combined PREVIEW
(keep as-is) BUT export = one printable file per tile.
PLAN:
- In generate(), when building tiles, KEEP a module-level array of per-tile
  groups WITH their cell ids, e.g. lastTiles = [{cell, group}] (anchor = {0,0}).
  Currently they're merged into `combined` and only scene.group is kept.
- exporters.js exportSTL already takes a group → reuse per tile.
- doExportSTL / doExport3MF (main.js ~728/735): if lastTiles.length > 1, export
  EACH tile as its own STL and bundle into a ZIP (fflate is already a dep —
  used by export3MF). Filename per tile e.g. tile_r{row}_c{col}.stl. If single
  tile, keep current single-file behaviour.
- Order/checkout already prices per tile (tileCount). The PHYSICAL deliverable is
  N separate prints — that's consistent with "each grid as a printable option".
- Each exported tile must be centred at origin (subtract its offset) so it prints
  on its own plate, not offset into space. When building combined preview we set
  tileGroup.position = offset; for export, clone + zero the position (or export
  from the un-offset group). Easiest: keep each tile's ORIGINAL group (position 0)
  in lastTiles for export, and a separate positioned clone for the preview.

VERIFY each: node --check, npm run build, deploy, live hash == build. Keep edits
SMALL (channel has been flaky; big multi-line edits keep silently failing — use
short unique old_strings and re-grep after each).
