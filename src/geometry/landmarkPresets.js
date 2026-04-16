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
export const LANDMARK_PRESETS = {

  // ──────────────────────────────────────────────────────────────────────────
  // Burj Khalifa — Y-shaped trilobal tower with spiral wing retractions
  //
  // The real building has 3 wings at 120° around a hexagonal core.
  // Each wing is ~55m wide at the base. As the tower rises, ONE wing
  // retracts at each setback tier in a rotating A→B→C→A spiral, giving
  // an asymmetric stepped silhouette. 27 setbacks total (~every 7 floors).
  //
  // We generate this as:
  //   - A hexagonal core column that runs the full body height
  //   - 3 wing prisms that each retract independently at staggered heights
  //   - A needle spire on top (~24% of total = 200m of 828m)
  //
  // This approach creates the distinctive asymmetric Y-shape where
  // different sides of the building step back at different levels.
  // ──────────────────────────────────────────────────────────────────────────
  burjKhalifa: {
    name: 'Burj Khalifa',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const { collectExtrudedPolygon, minBBoxDimension } = ctx;

      // Find centroid and bounding dimensions of the OSM footprint
      let cx = 0, cy = 0;
      for (const p of polygon) { cx += p.x; cy += p.y; }
      cx /= polygon.length;
      cy /= polygon.length;

      const dim = minBBoxDimension(polygon);

      // ── Proportions based on the real building ──────────────────────
      // Total: 828m. Spire: 200m (pinnacle pipe). Body: 628m.
      const spireFrac = 0.24;
      const bodyH  = totalH * (1.0 - spireFrac);
      const spireH = totalH * spireFrac;

      // Core radius and wing dimensions relative to footprint
      const coreR  = dim * 0.18;  // hexagonal core ~18% of footprint width
      const wingL  = dim * 0.42;  // wing length from core center outward
      const wingW  = dim * 0.14;  // wing half-width

      // ── Build the hexagonal core (runs full body height) ───────────
      const coreSegs = 6;
      {
        const pos = [], idx = [];
        // Top cap center + ring
        pos.push(cx, baseY + bodyH, -cy); // v0 = top center
        for (let s = 0; s < coreSegs; s++) {
          const a = (Math.PI * 2 * s) / coreSegs;
          pos.push(cx + Math.cos(a) * coreR, baseY + bodyH, -(cy + Math.sin(a) * coreR));
        }
        // Bottom cap center + ring
        const bc = coreSegs + 1;
        pos.push(cx, baseY, -cy); // bottom center
        for (let s = 0; s < coreSegs; s++) {
          const a = (Math.PI * 2 * s) / coreSegs;
          pos.push(cx + Math.cos(a) * coreR, baseY, -(cy + Math.sin(a) * coreR));
        }
        // Top cap tris
        for (let s = 0; s < coreSegs; s++) {
          idx.push(0, 1 + s, 1 + (s + 1) % coreSegs);
        }
        // Bottom cap tris (reversed)
        for (let s = 0; s < coreSegs; s++) {
          idx.push(bc, bc + 1 + (s + 1) % coreSegs, bc + 1 + s);
        }
        // Side walls
        for (let s = 0; s < coreSegs; s++) {
          const t0 = 1 + s, t1 = 1 + (s + 1) % coreSegs;
          const b0 = bc + 1 + s, b1 = bc + 1 + (s + 1) % coreSegs;
          idx.push(t0, t1, b1, t0, b1, b0);
        }
        acc.add(pos, idx);
      }

      // ── 3 wings at 120° intervals ─────────────────────────────────
      // Each wing has 9 setback tiers (27 total / 3 wings). The spiral
      // pattern staggers them: wing 0 sets back at tiers 0,3,6,9,...
      // wing 1 at tiers 1,4,7,10,...  wing 2 at tiers 2,5,8,11,...
      //
      // Real building: wings retract progressively, each wing going from
      // full length at the base to fully retracted (just the core) at
      // roughly 75% of body height, staggered so each wing terminates
      // at a different elevation.

      const TOTAL_SETBACKS = 27;
      const SETBACKS_PER_WING = 9;

      for (let w = 0; w < 3; w++) {
        // Wing direction (120° apart, starting at 90° so one points "up")
        const wingAngle = (Math.PI / 2) + (w * Math.PI * 2 / 3);
        const dx = Math.cos(wingAngle);
        const dy = Math.sin(wingAngle);
        // Perpendicular for wing width
        const nx = -dy;
        const ny = dx;

        // Each wing's setbacks are staggered in the spiral:
        // Wing 0 starts retracting at tier w=0, wing 1 at tier 1, wing 2 at tier 2
        // This means wing 0 terminates lowest, wing 2 terminates highest
        const wingStartRetract = (w / TOTAL_SETBACKS) * bodyH;
        // Each wing terminates at a different height (staggered by ~8% of body)
        const wingEndFrac = 0.55 + w * 0.10; // wing 0: 55%, wing 1: 65%, wing 2: 75%
        const wingEndH = bodyH * wingEndFrac;

        // Build wing as stacked slices, each shorter than the last
        for (let s = 0; s < SETBACKS_PER_WING; s++) {
          // Height fraction within this wing's retraction schedule
          const t = s / SETBACKS_PER_WING;
          // Wing length decreases from full to 0 as we go up
          const wingScale = 1.0 - t;
          const curWingL = wingL * wingScale;
          if (curWingL < 0.05) continue;

          // Vertical span for this slice
          const sliceBot = baseY + wingStartRetract + (wingEndH - wingStartRetract) * (s / SETBACKS_PER_WING);
          const sliceTop = baseY + wingStartRetract + (wingEndH - wingStartRetract) * ((s + 1) / SETBACKS_PER_WING);
          const sliceH = sliceTop - sliceBot;
          if (sliceH < 0.01) continue;

          // Wing quad: 4 corners of a rectangle extending from core edge outward
          const coreEdge = coreR * 0.85; // slight overlap with core for watertight join
          const wingPoly = [
            { x: cx + dx * coreEdge + nx * wingW, y: cy + dy * coreEdge + ny * wingW },
            { x: cx + dx * (coreEdge + curWingL) + nx * wingW * wingScale, y: cy + dy * (coreEdge + curWingL) + ny * wingW * wingScale },
            { x: cx + dx * (coreEdge + curWingL) - nx * wingW * wingScale, y: cy + dy * (coreEdge + curWingL) - ny * wingW * wingScale },
            { x: cx + dx * coreEdge - nx * wingW, y: cy + dy * coreEdge - ny * wingW },
          ];

          collectExtrudedPolygon(acc, wingPoly, [], sliceBot, sliceH);
        }
      }

      // ── Needle spire — tapered hexagonal prism ─────────────────────
      if (spireH > 0.2) {
        const sBaseR = coreR * 0.6;
        const sTopR  = sBaseR * 0.04;
        const segs   = 6;
        const pos    = [];
        const idx    = [];

        pos.push(cx, baseY + bodyH, -cy);               // v0 = bottom center
        pos.push(cx, baseY + bodyH + spireH, -cy);      // v1 = top center

        const ringB = 2;
        for (let s = 0; s < segs; s++) {
          const a = (Math.PI * 2 * s) / segs;
          pos.push(cx + Math.cos(a) * sBaseR, baseY + bodyH, -(cy + Math.sin(a) * sBaseR));
        }
        const ringT = ringB + segs;
        for (let s = 0; s < segs; s++) {
          const a = (Math.PI * 2 * s) / segs;
          pos.push(cx + Math.cos(a) * sTopR, baseY + bodyH + spireH, -(cy + Math.sin(a) * sTopR));
        }

        for (let s = 0; s < segs; s++) {
          const n = (s + 1) % segs;
          idx.push(0, ringB + n, ringB + s);
          idx.push(1, ringT + s, ringT + n);
          idx.push(ringB + s, ringB + n, ringT + n);
          idx.push(ringB + s, ringT + n, ringT + s);
        }
        acc.add(pos, idx);
      }
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Empire State Building -- Art deco stepped tower with 5 setback tiers + antenna
  // ──────────────────────────────────────────────────────────────────────────
  empireStateBuilding: {
    name: 'Empire State Building',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const {
        collectExtrudedPolygon, shrinkToCentroid,
        collectBandedBuilding, collectSpire,
        deterministicFrac, minBBoxDimension,
      } = ctx;

      const frac = deterministicFrac(polygon);

      // Art deco stepped massing: 5 major tiers + antenna
      // Proportions loosely based on the real building's setback schedule
      const tiers = [
        { hFrac: 0.30, scale: 1.00 },  // base / lower floors (full footprint)
        { hFrac: 0.20, scale: 0.80 },  // first setback
        { hFrac: 0.18, scale: 0.62 },  // second setback
        { hFrac: 0.12, scale: 0.48 },  // third setback
        { hFrac: 0.08, scale: 0.35 },  // observation deck / crown
      ];

      const antennaFrac = 0.12; // antenna is ~12% of total
      const bodyH = totalH * (1.0 - antennaFrac);
      const antennaH = totalH * antennaFrac;

      let y = baseY;
      for (const tier of tiers) {
        const tierH = bodyH * tier.hFrac;
        const tierPoly = shrinkToCentroid(polygon, tier.scale);
        if (tierPoly && tierH > 0.05) {
          const bands = Math.max(1, Math.round(tierH / 1.2));
          collectBandedBuilding(acc, tierPoly, y, tierH, bands, 0.92, 0.25);
        }
        y += tierH;
      }

      // Antenna / broadcast tower
      if (antennaH > 0.3) {
        collectSpire(acc, polygon, y, antennaH, frac);
      }
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Generic supertall -- simple tapered box with 2-3 setback stages
  // Reused as fallback for known supertalls that lack a bespoke preset.
  // ──────────────────────────────────────────────────────────────────────────
  genericSupertall: {
    name: 'Generic Supertall',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const {
        collectExtrudedPolygon, shrinkToCentroid,
        collectBandedBuilding, collectSpire,
        deterministicFrac,
      } = ctx;

      const frac = deterministicFrac(polygon);

      // 3-stage setback: base, mid, crown + optional spire
      const stages = [
        { hFrac: 0.45, scale: 1.00 },
        { hFrac: 0.30, scale: 0.82 },
        { hFrac: 0.17, scale: 0.65 },
      ];

      const spireFrac = 0.08;
      const bodyH = totalH * (1.0 - spireFrac);
      const spireH = totalH * spireFrac;

      let y = baseY;
      for (const stage of stages) {
        const stageH = bodyH * stage.hFrac;
        const stagePoly = shrinkToCentroid(polygon, stage.scale);
        if (stagePoly && stageH > 0.05) {
          const bands = Math.max(2, Math.round(stageH / 1.5));
          collectBandedBuilding(acc, stagePoly, y, stageH, bands, 0.93, 0.25);
        }
        y += stageH;
      }

      // Spire / pinnacle
      if (spireH > 0.2) {
        collectSpire(acc, polygon, y, spireH, frac);
      }
    },
  },
};

// ── Alias mappings -- landmarks.json references these camelCase names,
//    map them to the preset keys above. Landmarks without a bespoke
//    generator fall through to genericSupertall.
const PRESET_ALIASES = {
  burjKhalifa:           'burjKhalifa',
  empireStateBuilding:   'empireStateBuilding',
  oneWorldTradeCenter:   'genericSupertall',
  willisTower:           'genericSupertall',
  cnTower:               'genericSupertall',
  taipei101:             'genericSupertall',
  petronasTowers:        'genericSupertall',
  shanghaiTower:         'genericSupertall',
  lotteWorldTower:       'genericSupertall',
  tokyoSkytree:          'genericSupertall',
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
