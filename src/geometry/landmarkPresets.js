/**
 * landmarkPresets.js -- 3-tier building classification and landmark geometry presets
 *
 * Tier 1 (landmark):    Identified by the LandmarkRegistry via OSM ID, name, or wikidata.
 *                       Has a dedicated geometry generator (preset).
 *                       Height alone NEVER triggers tier 1.
 *
 * Tier 2 (tall-tower):  HeightM >= 100 with no preset match.
 *                       Gets enhanced generic supertall geometry.
 *
 * Tier 3 (standard):    Everything else -- delegates to the normal buildMap classifiers.
 *
 * All geometry functions receive a context object (`ctx`) that carries the host
 * module's helpers so we avoid circular imports:
 *
 *   ctx = {
 *     collectExtrudedPolygon, shrinkToCentroid, collectSpire,
 *     collectBandedBuilding, minBBoxDimension, deterministicFrac,
 *   }
 */

import landmarkData from './landmarks.json';

// ─── Landmark Registry ──────────────────────────────────────────────────────

/**
 * Looks up OSM features against a JSON config of known landmarks.
 * Resolution order: osmWayId -> osmRelationId -> name -> wikidata -> tag heuristics.
 */
export class LandmarkRegistry {
  constructor(config = landmarkData) {
    this._wayIds      = config.osmWayIds      || {};
    this._relationIds = config.osmRelationIds || {};
    this._wikidataIds = config.wikidataIds    || {};
    this._knownNames  = config.knownNames     || {};
    this._tagRules    = config.landmarkTags   || [];
  }

  /**
   * Identify a feature by its OSM tags and ID.
   *
   * @param {Object} tags  - OSM key/value tags
   * @param {string} osmId - Full OSM id string, e.g. "way/263884958"
   * @returns {{ tier: string, presetName: string|null, confidence: string }}
   */
  identify(tags, osmId) {
    // 1. Exact OSM way ID match
    if (osmId && this._wayIds[osmId]) {
      const preset = this._wayIds[osmId];
      return { tier: 'landmark', presetName: preset, confidence: 'preset' };
    }

    // 2. Exact OSM relation ID match
    if (osmId && this._relationIds[osmId]) {
      const preset = this._relationIds[osmId];
      return { tier: 'landmark', presetName: preset, confidence: 'preset' };
    }

    // 3. Name match (case-insensitive)
    const name = (tags?.name || '').toLowerCase().trim();
    if (name && this._knownNames[name]) {
      const preset = this._knownNames[name];
      return { tier: 'landmark', presetName: preset, confidence: 'name-match' };
    }

    // 4. Wikidata match
    const wikidata = tags?.wikidata || '';
    if (wikidata && this._wikidataIds[wikidata]) {
      const preset = this._wikidataIds[wikidata];
      return { tier: 'landmark', presetName: preset, confidence: 'preset' };
    }

    // 5. Tag-based heuristic rules
    if (this._matchesTagRules(tags)) {
      return { tier: 'landmark', presetName: null, confidence: 'tag-match' };
    }

    // 6. No match
    return { tier: 'standard', presetName: null, confidence: 'none' };
  }

  /**
   * Select the right generator tier for a building.
   * Combines registry lookup with height-based logic.
   *
   * @param {Object}  tags     - OSM tags
   * @param {string}  osmId    - OSM feature id
   * @param {number}  heightM  - Real-world height in metres
   * @param {Array}   polygon  - Projected footprint vertices [{x, y}, ...]
   * @returns {{ tier: string, presetName: string|null, confidence: string }}
   */
  selectGenerator(tags, osmId, heightM, polygon) {
    const result = this.identify(tags, osmId);

    // Tier 1: registry returned a concrete preset
    if (result.presetName && LANDMARK_PRESETS[result.presetName]) {
      return { ...result, tier: 'landmark' };
    }

    // Tier 2: very tall but no preset -- enhanced generic supertall
    if (heightM >= 100 && !result.presetName) {
      return { tier: 'tall-tower', presetName: null, confidence: result.confidence };
    }

    // Tier 3: everything else
    return { tier: 'standard', presetName: null, confidence: result.confidence };
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Check whether the given tags satisfy any of the landmark tag rules.
   * A rule is an object like { "tourism": "attraction", "building": "*" }.
   * Every key in the rule must exist on the feature; value "*" means any value.
   */
  _matchesTagRules(tags) {
    if (!tags) return false;
    for (const rule of this._tagRules) {
      let matches = true;
      for (const [key, value] of Object.entries(rule)) {
        if (!tags[key]) { matches = false; break; }
        if (value !== '*' && tags[key] !== value) { matches = false; break; }
      }
      if (matches) return true;
    }
    return false;
  }
}

// Singleton instance for convenience
const registry = new LandmarkRegistry();

// ─── Landmark Presets ───────────────────────────────────────────────────────

/**
 * Each preset maps a name to { name, generate(ctx, acc, polygon, baseY, totalH, heightM) }.
 *
 * `ctx` carries the host helpers from buildMap.js:
 *   collectExtrudedPolygon(acc, polygon, holes, baseY, heightMM)
 *   shrinkToCentroid(polygon, scale)
 *   collectSpire(acc, polygon, baseY, height, frac)
 *   collectBandedBuilding(acc, polygon, baseY, totalH, bandCount, insetScale, bandFrac)
 *   minBBoxDimension(polygon)
 *   deterministicFrac(polygon)
 */
// ─── Shared geometry helper: tapered hexagonal prism (spire/antenna) ────────
function buildSpire(acc, cx, cy, baseY, height, baseR, topR) {
  const segs = 6, pos = [], idx = [];
  pos.push(cx, baseY, -cy);
  pos.push(cx, baseY + height, -cy);
  const rB = 2;
  for (let s = 0; s < segs; s++) {
    const a = (Math.PI * 2 * s) / segs;
    pos.push(cx + Math.cos(a) * baseR, baseY, -(cy + Math.sin(a) * baseR));
  }
  const rT = rB + segs;
  for (let s = 0; s < segs; s++) {
    const a = (Math.PI * 2 * s) / segs;
    pos.push(cx + Math.cos(a) * topR, baseY + height, -(cy + Math.sin(a) * topR));
  }
  for (let s = 0; s < segs; s++) {
    const n = (s + 1) % segs;
    idx.push(0, rB + n, rB + s);
    idx.push(1, rT + s, rT + n);
    idx.push(rB + s, rB + n, rT + n, rB + s, rT + n, rT + s);
  }
  acc.add(pos, idx);
}

function centroid(polygon) {
  let cx = 0, cy = 0;
  for (const p of polygon) { cx += p.x; cy += p.y; }
  return { cx: cx / polygon.length, cy: cy / polygon.length };
}

export const LANDMARK_PRESETS = {

  // ──────────────────────────────────────────────────────────────────────────
  // BURJ KHALIFA — 828m total. Y-shaped plan, 3 wings at 120°.
  //
  // Real data (SOM / CTBUH):
  //   - 3 wings each ~55m wide at base around hexagonal core
  //   - 27 setbacks in spiral: one wing retracts per tier (A→B→C→A...)
  //   - Body to ~636m (roof), spire/pinnacle 200m pipe above that
  //   - Concrete structure to level 156 (585m), steel above
  //   - Wings terminate at staggered heights in spiral pattern
  // ──────────────────────────────────────────────────────────────────────────
  burjKhalifa: {
    name: 'Burj Khalifa',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const { collectExtrudedPolygon, minBBoxDimension } = ctx;
      const { cx, cy } = centroid(polygon);
      const dim = minBBoxDimension(polygon);

      // Real proportions: 828m total, 636m roof, 200m spire
      const spireH = totalH * (200 / 828);
      const bodyH  = totalH - spireH;

      // Core and wing dimensions relative to OSM footprint
      const coreR = dim * 0.18;
      const wingL = dim * 0.42;
      const wingW = dim * 0.14;

      // Hexagonal core — full body height
      const cSegs = 6;
      const pos = [], idx = [];
      pos.push(cx, baseY + bodyH, -cy);
      for (let s = 0; s < cSegs; s++) {
        const a = (Math.PI * 2 * s) / cSegs;
        pos.push(cx + Math.cos(a) * coreR, baseY + bodyH, -(cy + Math.sin(a) * coreR));
      }
      const bc = cSegs + 1;
      pos.push(cx, baseY, -cy);
      for (let s = 0; s < cSegs; s++) {
        const a = (Math.PI * 2 * s) / cSegs;
        pos.push(cx + Math.cos(a) * coreR, baseY, -(cy + Math.sin(a) * coreR));
      }
      for (let s = 0; s < cSegs; s++) {
        idx.push(0, 1 + s, 1 + (s + 1) % cSegs);
        idx.push(bc, bc + 1 + (s + 1) % cSegs, bc + 1 + s);
        const t0 = 1 + s, t1 = 1 + (s + 1) % cSegs;
        const b0 = bc + 1 + s, b1 = bc + 1 + (s + 1) % cSegs;
        idx.push(t0, t1, b1, t0, b1, b0);
      }
      acc.add(pos, idx);

      // 3 wings, 9 setback tiers each (27 total), spiral staggered.
      // Wing termination heights based on real building:
      // Wing A terminates ~level 109 (460m = 55% of 828m)
      // Wing B terminates ~level 136 (530m = 64%)
      // Wing C terminates ~level 156 (585m = 71%)
      const wingEndFracs = [460 / 828, 530 / 828, 585 / 828];

      for (let w = 0; w < 3; w++) {
        const angle = (Math.PI / 2) + (w * Math.PI * 2 / 3);
        const dx = Math.cos(angle), dy = Math.sin(angle);
        const nx = -dy, ny = dx;
        const endH = bodyH * (wingEndFracs[w] / (1 - 200 / 828));
        const clampedEndH = Math.min(endH, bodyH);
        const SLICES = 9;

        for (let s = 0; s < SLICES; s++) {
          const t = s / SLICES;
          const wingScale = 1.0 - t;
          const curL = wingL * wingScale;
          if (curL < 0.03) continue;
          const sliceBot = baseY + clampedEndH * (s / SLICES);
          const sliceH = clampedEndH / SLICES;
          if (sliceH < 0.01) continue;
          const edge = coreR * 0.85;
          const ww = wingW * wingScale;
          const wingPoly = [
            { x: cx + dx * edge + nx * wingW, y: cy + dy * edge + ny * wingW },
            { x: cx + dx * (edge + curL) + nx * ww, y: cy + dy * (edge + curL) + ny * ww },
            { x: cx + dx * (edge + curL) - nx * ww, y: cy + dy * (edge + curL) - ny * ww },
            { x: cx + dx * edge - nx * wingW, y: cy + dy * edge - ny * wingW },
          ];
          collectExtrudedPolygon(acc, wingPoly, [], sliceBot, sliceH);
        }
      }

      // Spire: 200m pinnacle pipe
      if (spireH > 0.1) {
        buildSpire(acc, cx, cy, baseY + bodyH, spireH, coreR * 0.5, coreR * 0.02);
      }
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // EMPIRE STATE BUILDING — 443m total. Art deco stepped tower.
  //
  // Real data (Wikipedia / ESB fact sheet):
  //   - Base footprint: 129m × 57m (424ft × 187ft)
  //   - Setback above 5th floor: 18m (60ft) deep on all sides
  //   - Setbacks at floors: 6, 25, 30, 72, 81, 85
  //   - Roof height: 381m (1,250ft) at floor 86
  //   - Antenna mast: 62m (204ft) above roof = 443m total
  //   - Interior depth max 8.5m from windows (elevator core constraint)
  //
  //   Height fractions (of 443m total):
  //     Floor 6:  ~25m  = 0.056    (first big setback, 18m deep)
  //     Floor 25: ~96m  = 0.217
  //     Floor 30: ~115m = 0.260
  //     Floor 72: ~275m = 0.621
  //     Floor 85: ~325m = 0.734
  //     Roof 86:  381m  = 0.860
  //     Antenna:  443m  = 1.000
  // ──────────────────────────────────────────────────────────────────────────
  empireStateBuilding: {
    name: 'Empire State Building',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const { collectExtrudedPolygon, shrinkToCentroid } = ctx;

      // Real setback schedule as height fractions and remaining width fractions.
      // The base is rectangular 129×57m. Setback at floor 6 is 18m deep on all
      // sides, so 93×21m = ~72% × ~37% of base. Upper tower narrows further.
      const antennaFrac = 62 / 443; // antenna is 14% of total
      const bodyH = totalH * (1 - antennaFrac);
      const antennaH = totalH * antennaFrac;

      const tiers = [
        { hFrac: 25 / 381,           scale: 1.00 },  // ground to floor 6
        { hFrac: (96 - 25) / 381,    scale: 0.72 },  // floor 6-25 (after 18m setback)
        { hFrac: (115 - 96) / 381,   scale: 0.62 },  // floor 25-30
        { hFrac: (275 - 115) / 381,  scale: 0.50 },  // floor 30-72 (main shaft)
        { hFrac: (325 - 275) / 381,  scale: 0.38 },  // floor 72-85
        { hFrac: (381 - 325) / 381,  scale: 0.28 },  // floor 85-86 (crown/observatory)
      ];

      let y = baseY;
      for (const tier of tiers) {
        const tierH = bodyH * tier.hFrac;
        if (tierH < 0.02) continue;
        const tierPoly = tier.scale < 0.99 ? shrinkToCentroid(polygon, tier.scale) : polygon;
        if (tierPoly) collectExtrudedPolygon(acc, tierPoly, [], y, tierH);
        y += tierH;
      }

      // Antenna mast
      if (antennaH > 0.1) {
        const { cx, cy } = centroid(polygon);
        const dim = minBBoxDimension(polygon);
        buildSpire(acc, cx, cy, y, antennaH, dim * 0.08, dim * 0.01);
      }
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // WILLIS TOWER (Sears Tower) — 527m total. Bundled tube structure.
  //
  // Real data (Wikipedia / SOM):
  //   - Base: 225×225ft (68.6m) square = 9 tubes, each 75×75ft (22.9m)
  //   - Floor 1-50:  all 9 tubes (full square)
  //   - Floor 51-66: 7 tubes (NW + SE tubes drop off)
  //   - Floor 67-90: 5 tubes (cross shape, NE + SW also drop)
  //   - Floor 91-108: 2 tubes (west + center only)
  //   - Roof: 442m. Antennas: up to 527m
  //   - 108 floors, 4.13m per floor average
  //
  //   Height fractions (of 527m):
  //     Floor 50:  ~207m = 0.393  (50 × 4.13)
  //     Floor 66:  ~273m = 0.518
  //     Floor 90:  ~372m = 0.706
  //     Roof 108:  442m  = 0.839
  //     Antenna:   527m  = 1.000
  // ──────────────────────────────────────────────────────────────────────────
  willisTower: {
    name: 'Willis Tower',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const { collectExtrudedPolygon, shrinkToCentroid, minBBoxDimension } = ctx;
      const { cx, cy } = centroid(polygon);
      const dim = minBBoxDimension(polygon);

      // Real height fractions
      const antennaFrac = (527 - 442) / 527;
      const bodyH = totalH * (1 - antennaFrac);
      const antennaH = totalH * antennaFrac;

      // Tube unit = 1/3 of building width
      const unit = dim / 3;

      // The 9 tubes in a 3×3 grid. We define which are present at each tier.
      // Grid positions: (col, row) where 0=west, 1=center, 2=east; 0=south, 1=center, 2=north
      //
      // Floors 1-50: all 9 (full square)
      // Floors 51-66: drop NW(0,2) and SE(2,0) = 7 tubes
      // Floors 67-90: also drop NE(2,2) and SW(0,0) = 5 tubes (cross)
      // Floors 91-108: only W-center(0,1) and center(1,1) = 2 tubes
      const tiers = [
        { hFrac: 207 / 442, scale: 1.00 },  // all 9 tubes = full footprint
        { hFrac: (273 - 207) / 442, scale: 0.88 },  // 7 tubes ≈ 78% area
        { hFrac: (372 - 273) / 442, scale: 0.74 },  // 5 tubes (cross) ≈ 56% area
        { hFrac: (442 - 372) / 442, scale: 0.47 },  // 2 tubes ≈ 22% area
      ];

      let y = baseY;
      for (const tier of tiers) {
        const tierH = bodyH * tier.hFrac;
        if (tierH < 0.02) continue;
        const tierPoly = tier.scale < 0.99 ? shrinkToCentroid(polygon, tier.scale) : polygon;
        if (tierPoly) collectExtrudedPolygon(acc, tierPoly, [], y, tierH);
        y += tierH;
      }

      // Antenna towers
      if (antennaH > 0.1) {
        buildSpire(acc, cx, cy, y, antennaH, dim * 0.06, dim * 0.01);
      }
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ONE WORLD TRADE CENTER — 541m total. Chamfered square taper.
  //
  // Real data (WikiArquitectura / Wikipedia):
  //   - Base: 61×61m square (200ft)
  //   - From floor 20 upward, edges bevel inward forming octagonal cross-section
  //   - Roof: 417m, capped by 46×46m square rotated 45° from base
  //   - Spire: 124m sculpted mast (417m to 541m)
  //   - Concrete base (windowless) to 57m height
  //   - 104 floors. Office floors 20-90.
  //
  //   Height fractions (of 541m):
  //     Floor 20:  ~83m  = 0.153  (bevel starts)
  //     Roof:      417m  = 0.771
  //     Spire top: 541m  = 1.000
  // ──────────────────────────────────────────────────────────────────────────
  oneWorldTradeCenter: {
    name: 'One World Trade Center',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const { collectExtrudedPolygon, shrinkToCentroid, minBBoxDimension } = ctx;
      const { cx, cy } = centroid(polygon);
      const dim = minBBoxDimension(polygon);

      const spireFrac = 124 / 541;
      const bodyH = totalH * (1 - spireFrac);
      const spireH = totalH * spireFrac;

      // Square base to floor 20 (concrete podium)
      const podiumH = bodyH * (83 / 417);
      collectExtrudedPolygon(acc, polygon, [], baseY, podiumH);

      // Floors 20 to roof: gradual taper from 61m to 46m (scale 0.754)
      // The taper is linear — 8 isosceles triangles on the facade
      const taperH = bodyH - podiumH;
      const TAPER_SLICES = 8;
      const sliceH = taperH / TAPER_SLICES;
      for (let i = 0; i < TAPER_SLICES; i++) {
        const t = i / TAPER_SLICES;
        const scale = 1.0 - t * (1.0 - 46 / 61); // 1.0 → 0.754
        const tierPoly = shrinkToCentroid(polygon, scale);
        if (tierPoly) {
          collectExtrudedPolygon(acc, tierPoly, [], baseY + podiumH + i * sliceH, sliceH);
        }
      }

      // Spire
      if (spireH > 0.1) {
        buildSpire(acc, cx, cy, baseY + bodyH, spireH, dim * 0.10, dim * 0.015);
      }
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // CN TOWER — 553m total. Concrete hexagonal shaft + SkyPod + antenna.
  //
  // Real data (Wikipedia):
  //   - Hexagonal concrete shaft with Y-shaped base legs
  //   - Main observation pod at 342-351m (donut-shaped)
  //   - SkyPod at 447m
  //   - Antenna: 96m (457m to 553m)
  //   - Shaft tapers continuously from base to pod
  //   - Base Y-legs ~30m across, shaft narrows to ~15m at pod level
  // ──────────────────────────────────────────────────────────────────────────
  cnTower: {
    name: 'CN Tower',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const { minBBoxDimension } = ctx;
      const { cx, cy } = centroid(polygon);
      const dim = minBBoxDimension(polygon);

      // Real proportions
      const podFrac    = 346 / 553;  // main pod at 63%
      const skyPodFrac = 447 / 553;  // skypod at 81%
      const antFrac    = 96 / 553;   // antenna 17%

      const podH    = totalH * podFrac;
      const skyPodY = totalH * skyPodFrac;
      const antH    = totalH * antFrac;
      const bodyH   = totalH - antH;

      // Tapered hexagonal shaft from base to pod
      const baseR = dim * 0.45;
      const podR  = dim * 0.22;
      const SHAFT_SLICES = 10;
      const shaftSliceH = podH / SHAFT_SLICES;
      for (let i = 0; i < SHAFT_SLICES; i++) {
        const t = i / SHAFT_SLICES;
        const r = baseR + (podR - baseR) * t;
        const segs = 6, pos = [], idx = [];
        const r2 = baseR + (podR - baseR) * ((i + 1) / SHAFT_SLICES);
        const y0 = baseY + i * shaftSliceH;
        // Bottom ring
        pos.push(cx, y0, -cy);
        for (let s = 0; s < segs; s++) {
          const a = (Math.PI * 2 * s) / segs;
          pos.push(cx + Math.cos(a) * r, y0, -(cy + Math.sin(a) * r));
        }
        // Top ring
        const tc = segs + 1;
        pos.push(cx, y0 + shaftSliceH, -cy);
        for (let s = 0; s < segs; s++) {
          const a = (Math.PI * 2 * s) / segs;
          pos.push(cx + Math.cos(a) * r2, y0 + shaftSliceH, -(cy + Math.sin(a) * r2));
        }
        for (let s = 0; s < segs; s++) {
          const n = (s + 1) % segs;
          idx.push(0, 1 + s, 1 + n);
          idx.push(tc, tc + 1 + n, tc + 1 + s);
          idx.push(1 + s, 1 + n, tc + 1 + n, 1 + s, tc + 1 + n, tc + 1 + s);
        }
        acc.add(pos, idx);
      }

      // Observation pod (wider donut) at 342-351m
      const podBulgeR = podR * 1.8;
      const podThick = totalH * (9 / 553);
      buildSpire(acc, cx, cy, baseY + podH, podThick, podBulgeR, podBulgeR);

      // Narrow shaft from pod to SkyPod
      const midH = skyPodY - podH - podThick;
      if (midH > 0.05) {
        buildSpire(acc, cx, cy, baseY + podH + podThick, midH, podR * 0.7, podR * 0.5);
      }

      // SkyPod (small wider section)
      const skyThick = totalH * (5 / 553);
      buildSpire(acc, cx, cy, baseY + skyPodY, skyThick, podR * 1.1, podR * 1.1);

      // Shaft from SkyPod to antenna base
      const topShaftH = bodyH - skyPodY - skyThick;
      if (topShaftH > 0.05) {
        buildSpire(acc, cx, cy, baseY + skyPodY + skyThick, topShaftH, podR * 0.4, podR * 0.25);
      }

      // Antenna
      if (antH > 0.1) {
        buildSpire(acc, cx, cy, baseY + bodyH, antH, podR * 0.25, podR * 0.02);
      }
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // TAIPEI 101 — 508m total. 8 modules of 8 floors each, bamboo/pagoda form.
  //
  // Real data (Wikipedia / CTBUH):
  //   - 8 identical 8-story modules stacked, each flares outward at top
  //   - Floor plate: 2,500–4,300 m². Story height: 4.2m
  //   - Base ~62m wide, each module widens then steps back
  //   - Spire: ~60m (448m to 508m)
  //   - Roof: 449.2m
  //   - Each module: 8 floors × 4.2m = 33.6m tall
  //   - Below modules: 8-story base/podium (floors 1-8, then 9-16 start modules)
  // ──────────────────────────────────────────────────────────────────────────
  taipei101: {
    name: 'Taipei 101',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const { collectExtrudedPolygon, shrinkToCentroid, minBBoxDimension } = ctx;
      const { cx, cy } = centroid(polygon);
      const dim = minBBoxDimension(polygon);

      const spireFrac = 60 / 508;
      const bodyH = totalH * (1 - spireFrac);
      const spireH = totalH * spireFrac;

      // Base podium (floors 1-8): ~34m of 448m roof = 7.6%
      const podiumFrac = 34 / 448;
      const podiumH = bodyH * podiumFrac;
      collectExtrudedPolygon(acc, polygon, [], baseY, podiumH);

      // 8 pagoda modules, each flares outward then steps back
      const moduleH = (bodyH - podiumH) / 8;
      for (let m = 0; m < 8; m++) {
        const y0 = baseY + podiumH + m * moduleH;
        // Each module tapers inward slightly as building rises
        const baseScale = 1.0 - m * 0.04; // top module is ~68% of base
        const topScale = baseScale * 1.06; // flare: each module widens 6% at top

        // Lower 80% of module (main body, slightly narrower)
        const lowerH = moduleH * 0.8;
        const lowerPoly = shrinkToCentroid(polygon, baseScale);
        if (lowerPoly) collectExtrudedPolygon(acc, lowerPoly, [], y0, lowerH);

        // Upper 20% (flared cap, slightly wider)
        const upperH = moduleH * 0.2;
        const upperPoly = shrinkToCentroid(polygon, Math.min(topScale, 1.0));
        if (upperPoly) collectExtrudedPolygon(acc, upperPoly, [], y0 + lowerH, upperH);
      }

      // Spire
      if (spireH > 0.1) {
        buildSpire(acc, cx, cy, baseY + bodyH, spireH, dim * 0.08, dim * 0.01);
      }
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PETRONAS TOWERS — 452m total. Twin towers with skybridge.
  //
  // Real data (Wikipedia):
  //   - Floor plan: 8-pointed star (Rub el Hizb) with circular arcs
  //   - Core: 23×23m (75×75ft)
  //   - Skybridge at floors 41-42 (170m height), 58.4m long
  //   - Roof: 405m. Spire: 46m (to 452m)
  //   - 88 floors. Setbacks at upper floors.
  //   - Building uses the OSM footprint which is the star shape
  // ──────────────────────────────────────────────────────────────────────────
  petronasTowers: {
    name: 'Petronas Towers',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const { collectExtrudedPolygon, shrinkToCentroid, minBBoxDimension } = ctx;
      const { cx, cy } = centroid(polygon);
      const dim = minBBoxDimension(polygon);

      const spireFrac = 46 / 452;
      const bodyH = totalH * (1 - spireFrac);
      const spireH = totalH * spireFrac;

      // Main tower body to roof — gradual taper with few setbacks
      // Real building has subtle setbacks at upper floors
      const tiers = [
        { hFrac: 0.60, scale: 1.00 },  // lower 60% full width
        { hFrac: 0.20, scale: 0.90 },  // mild setback
        { hFrac: 0.12, scale: 0.78 },  // upper setback
        { hFrac: 0.08, scale: 0.60 },  // crown
      ];

      let y = baseY;
      for (const tier of tiers) {
        const tierH = bodyH * tier.hFrac;
        if (tierH < 0.02) continue;
        const tierPoly = tier.scale < 0.99 ? shrinkToCentroid(polygon, tier.scale) : polygon;
        if (tierPoly) collectExtrudedPolygon(acc, tierPoly, [], y, tierH);
        y += tierH;
      }

      // Spire
      if (spireH > 0.1) {
        buildSpire(acc, cx, cy, y, spireH, dim * 0.10, dim * 0.01);
      }
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Generic supertall fallback — for landmarks in the registry without a
  // bespoke preset. Uses the OSM footprint with simple proportional setbacks.
  // ──────────────────────────────────────────────────────────────────────────
  genericSupertall: {
    name: 'Generic Supertall',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const { collectExtrudedPolygon, shrinkToCentroid, minBBoxDimension } = ctx;
      const { cx, cy } = centroid(polygon);
      const dim = minBBoxDimension(polygon);

      const spireFrac = 0.08;
      const bodyH = totalH * (1 - spireFrac);
      const spireH = totalH * spireFrac;

      const tiers = [
        { hFrac: 0.50, scale: 1.00 },
        { hFrac: 0.30, scale: 0.85 },
        { hFrac: 0.20, scale: 0.65 },
      ];

      let y = baseY;
      for (const tier of tiers) {
        const tierH = bodyH * tier.hFrac;
        if (tierH < 0.02) continue;
        const tierPoly = tier.scale < 0.99 ? shrinkToCentroid(polygon, tier.scale) : polygon;
        if (tierPoly) collectExtrudedPolygon(acc, tierPoly, [], y, tierH);
        y += tierH;
      }

      if (spireH > 0.1) {
        buildSpire(acc, cx, cy, y, spireH, dim * 0.07, dim * 0.01);
      }
    },
  },
};

// ── Alias mappings ──────────────────────────────────────────────────────────
// Each landmark in landmarks.json maps to one of the presets above.
const PRESET_ALIASES = {
  burjKhalifa:         'burjKhalifa',
  empireStateBuilding: 'empireStateBuilding',
  oneWorldTradeCenter: 'oneWorldTradeCenter',
  willisTower:         'willisTower',
  cnTower:             'cnTower',
  taipei101:           'taipei101',
  petronasTowers:      'petronasTowers',
  shanghaiTower:       'genericSupertall',
  lotteWorldTower:     'genericSupertall',
  tokyoSkytree:        'cnTower', // similar profile: tapered shaft + observation pod + antenna
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate landmark-specific geometry for a known preset.
 *
 * @param {Object} ctx         - Host helper context from buildMap.js
 * @param {string} presetName  - Key from landmarks.json (e.g. "burjKhalifa")
 * @param {Array}  polygon     - Projected footprint [{x,y}, ...]
 * @param {number} baseY       - Y origin (mm above base plate)
 * @param {number} totalH      - Total model height (mm)
 * @param {number} heightM     - Real-world height (metres), for proportion decisions
 * @returns {boolean} true if a preset was applied, false if not found
 */
export function generateLandmarkBuilding(ctx, presetName, polygon, baseY, totalH, heightM) {
  // Resolve alias to actual preset key
  const resolvedKey = PRESET_ALIASES[presetName] || presetName;
  const preset = LANDMARK_PRESETS[resolvedKey];

  if (!preset) {
    return false;
  }

  // ctx carries both the GeomAccumulator (ctx.acc) and all helper functions.
  // Presets receive (ctx, acc, polygon, baseY, totalH, heightM).
  const acc = ctx.acc;
  preset.generate(ctx, acc, polygon, baseY, totalH, heightM);
  return true;
}

export { registry as landmarkRegistry };
