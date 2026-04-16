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
  // Burj Khalifa -- Y-shaped trilobal tower with 27 progressive setback stages
  // ──────────────────────────────────────────────────────────────────────────
  burjKhalifa: {
    name: 'Burj Khalifa',
    generate(ctx, acc, polygon, baseY, totalH, heightM) {
      const {
        collectExtrudedPolygon, shrinkToCentroid,
        minBBoxDimension, deterministicFrac,
      } = ctx;

      // 27-stage height curve (fraction of total height where each setback begins)
      const heightCurve = [
        0, 0.04, 0.08, 0.12, 0.16, 0.20, 0.24, 0.28,
        0.32, 0.36, 0.40, 0.44, 0.48, 0.52, 0.56, 0.60,
        0.62, 0.64, 0.66, 0.68, 0.70, 0.73, 0.76, 0.80,
        0.84, 0.88, 0.92,
      ];

      // Corresponding footprint scale factors (1.0 = full OSM footprint)
      const scaleCurve = [
        1.00, 0.98, 0.96, 0.94, 0.92, 0.90, 0.88, 0.86,
        0.84, 0.82, 0.79, 0.76, 0.73, 0.70, 0.67, 0.64,
        0.60, 0.56, 0.52, 0.48, 0.44, 0.40, 0.36, 0.32,
        0.28, 0.24, 0.20,
      ];

      const spireStart = 0.85; // spire covers top ~15% of total height
      const bodyH = totalH * spireStart;
      const spireH = totalH - bodyH;
      const frac = deterministicFrac(polygon);

      // Extrude each setback stage as a shrunk slice of the original footprint.
      // Alternating inset/outset ribbing is achieved by toggling the scale
      // slightly between adjacent stages.
      for (let i = 0; i < heightCurve.length; i++) {
        const hFrac0 = heightCurve[i];
        const hFrac1 = i + 1 < heightCurve.length ? heightCurve[i + 1] : spireStart;

        // Stage vertical span (clamped to body height)
        const y0 = baseY + hFrac0 * bodyH;
        const y1 = baseY + hFrac1 * bodyH;
        const stageH = y1 - y0;
        if (stageH < 0.01) continue;

        // Alternate ribbing: odd stages get a slight extra inset
        const ribScale = (i % 2 === 0) ? 1.0 : 0.97;
        const scale = scaleCurve[i] * ribScale;

        const stagePoly = shrinkToCentroid(polygon, scale);
        if (stagePoly) {
          collectExtrudedPolygon(acc, stagePoly, [], y0, stageH);
        }
      }

      // Needle spire -- hexagonal tapered prism from the centroid
      if (spireH > 0.2) {
        let cx = 0, cy = 0;
        for (const p of polygon) { cx += p.x; cy += p.y; }
        cx /= polygon.length;
        cy /= polygon.length;

        const dim = minBBoxDimension(polygon);
        const baseR = dim * 0.12;
        const topR = baseR * 0.08; // very sharp taper
        const segs = 6;
        const pos = [];
        const idx = [];

        // Two center vertices (bottom / top of spire)
        pos.push(cx, baseY + bodyH, -cy);              // v0 = bottom center
        pos.push(cx, baseY + bodyH + spireH, -cy);     // v1 = top center

        // Bottom ring (v2 .. v2+segs-1)
        const ringB = 2;
        for (let s = 0; s < segs; s++) {
          const a = (Math.PI * 2 * s) / segs;
          pos.push(cx + Math.cos(a) * baseR, baseY + bodyH, -(cy + Math.sin(a) * baseR));
        }

        // Top ring (v2+segs .. v2+2*segs-1)
        const ringT = ringB + segs;
        for (let s = 0; s < segs; s++) {
          const a = (Math.PI * 2 * s) / segs;
          pos.push(cx + Math.cos(a) * topR, baseY + bodyH + spireH, -(cy + Math.sin(a) * topR));
        }

        // Bottom cap triangles
        for (let s = 0; s < segs; s++) {
          const n = (s + 1) % segs;
          idx.push(0, ringB + n, ringB + s);
        }

        // Top cap triangles
        for (let s = 0; s < segs; s++) {
          const n = (s + 1) % segs;
          idx.push(1, ringT + s, ringT + n);
        }

        // Side quads (two triangles each)
        for (let s = 0; s < segs; s++) {
          const n = (s + 1) % segs;
          const b0 = ringB + s, b1 = ringB + n;
          const t0 = ringT + s, t1 = ringT + n;
          idx.push(b0, b1, t1);
          idx.push(b0, t1, t0);
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
