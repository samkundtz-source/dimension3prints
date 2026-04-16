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
  // Burj Khalifa -- slender stepped tower with needle spire
  // The real building is a Y-shaped plan that stays relatively wide through
  // its lower 60%, then the 3 wings retract at key setback levels while the
  // central core continues upward. At print scale (~75mm model radius for a
  // 1km capture) the footprint is tiny, so we use just 5 visible setback
  // tiers to keep the silhouette clean and the geometry printable, plus a
  // tall needle spire for the top ~25%.
  // ──────────────────────────────────────────────────────────────────────────
  burjKhalifa: {
    name: 'Burj Khalifa',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const {
        collectExtrudedPolygon, shrinkToCentroid,
        minBBoxDimension,
      } = ctx;

      // The real Burj Khalifa's spire (above the top occupied floor at ~585m)
      // is roughly 244m of the 828m total = ~29%. We use ~25% for the spire.
      const spireFrac = 0.25;
      const bodyH  = totalH * (1.0 - spireFrac);
      const spireH = totalH * spireFrac;

      // 5 setback tiers — the building stays nearly full-width for the
      // bottom section, then steps in at key heights. Scale values are
      // much more conservative than before to avoid the pyramid look.
      const tiers = [
        { hFrac: 0.35, scale: 1.00 },  // lower body — full Y-shaped footprint
        { hFrac: 0.20, scale: 0.92 },  // first wing retraction
        { hFrac: 0.15, scale: 0.82 },  // second wing retraction
        { hFrac: 0.18, scale: 0.68 },  // third retraction — core + partial wings
        { hFrac: 0.12, scale: 0.50 },  // top section — mostly core
      ];

      let y = baseY;
      for (const tier of tiers) {
        const tierH = bodyH * tier.hFrac;
        if (tierH < 0.02) continue;
        const tierPoly = tier.scale < 0.99
          ? shrinkToCentroid(polygon, tier.scale)
          : polygon;
        if (tierPoly) {
          collectExtrudedPolygon(acc, tierPoly, [], y, tierH);
        }
        y += tierH;
      }

      // Needle spire — tall hexagonal tapered prism from centroid
      if (spireH > 0.2) {
        let cx = 0, cy = 0;
        for (const p of polygon) { cx += p.x; cy += p.y; }
        cx /= polygon.length;
        cy /= polygon.length;

        const dim = minBBoxDimension(polygon);
        const baseR = dim * 0.18;  // spire base ~18% of footprint width
        const topR  = baseR * 0.05; // very sharp needle point
        const segs  = 6;
        const pos   = [];
        const idx   = [];

        pos.push(cx, y, -cy);                // v0 = bottom center
        pos.push(cx, y + spireH, -cy);       // v1 = top center

        const ringB = 2;
        for (let s = 0; s < segs; s++) {
          const a = (Math.PI * 2 * s) / segs;
          pos.push(cx + Math.cos(a) * baseR, y, -(cy + Math.sin(a) * baseR));
        }
        const ringT = ringB + segs;
        for (let s = 0; s < segs; s++) {
          const a = (Math.PI * 2 * s) / segs;
          pos.push(cx + Math.cos(a) * topR, y + spireH, -(cy + Math.sin(a) * topR));
        }

        for (let s = 0; s < segs; s++) {
          const n = (s + 1) % segs;
          idx.push(0, ringB + n, ringB + s);           // bottom cap
          idx.push(1, ringT + s, ringT + n);           // top cap
          idx.push(ringB + s, ringB + n, ringT + n);   // side
          idx.push(ringB + s, ringT + n, ringT + s);   // side
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
