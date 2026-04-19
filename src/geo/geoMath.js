/**
 * Coordinate projection and hexagon geometry.
 *
 * Local coordinate system (2-D):
 *   x = east  (metres, then scaled to model mm)
 *   y = north (metres, then scaled to model mm)
 *
 * Three.js scene:
 *   X = east   (= local x)
 *   Y = up     (elevation)
 *   Z = south  (= -local y, because Three.js looks toward –Z by default)
 */

import { MODEL_RADIUS_MM } from '../utils/helpers.js';

const METERS_PER_DEG_LAT = 111_320; // metres per degree of latitude (constant)

/**
 * Create a projection anchored at a geographic centre point.
 * @param {number} centerLat
 * @param {number} centerLng
 * @param {number} radiusMeters  – real-world hex circumradius in metres
 */
export function createProjection(centerLat, centerLng, radiusMeters) {
  const lat1rad = centerLat * (Math.PI / 180);
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos(lat1rad);
  const horizontalScale = MODEL_RADIUS_MM / radiusMeters; // mm per metre

  return {
    centerLat,
    centerLng,
    radiusMeters,
    horizontalScale,

    /** Convert geographic coords → local 2-D model mm {x, y}. */
    project(lat, lng) {
      return {
        x: (lng - centerLng) * metersPerDegLng * horizontalScale,
        y: (lat - centerLat) * METERS_PER_DEG_LAT * horizontalScale,
      };
    },

    /** Convert local 2-D model mm back to geographic coords. */
    unproject(x, y) {
      return {
        lat: centerLat + (y / horizontalScale) / METERS_PER_DEG_LAT,
        lng: centerLng + (x / horizontalScale) / metersPerDegLng,
      };
    },

    /** Scale a real-world length (metres) to model mm. */
    scaleLength(meters) {
      return meters * horizontalScale;
    },

    /**
     * Bounding box for the Overpass API query.
     * `margin` > 1 adds a safety border around the hex circumscribed circle.
     */
    getBBox(margin = 1.15) {
      const rDegLat = (radiusMeters * margin) / METERS_PER_DEG_LAT;
      const rDegLng = (radiusMeters * margin) / metersPerDegLng;
      return {
        south: centerLat - rDegLat,
        north: centerLat + rDegLat,
        west:  centerLng - rDegLng,
        east:  centerLng + rDegLng,
      };
    },
  };
}

/**
 * Return the 6 vertices of a flat-top regular hexagon in local model mm.
 * Vertices are at angles 0°, 60°, 120°, 180°, 240°, 300° from the +x axis.
 * Wound counter-clockwise.
 *
 * @param {number} radiusMM  circumradius in mm (default = MODEL_RADIUS_MM)
 */
export function getHexVertices(radiusMM = MODEL_RADIUS_MM) {
  const verts = [];
  for (let i = 0; i < 6; i++) {
    const angle = i * (Math.PI / 3); // 0, π/3, 2π/3, π, 4π/3, 5π/3
    verts.push({
      x: radiusMM * Math.cos(angle),
      y: radiusMM * Math.sin(angle),
    });
  }
  return verts;
}

/**
 * Rotate a list of {x,y} vertices by `rad` radians (CCW) around the origin.
 */
function rotateVerts(verts, rad) {
  if (!rad) return verts;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return verts.map(v => ({
    x: v.x * cos - v.y * sin,
    y: v.x * sin + v.y * cos,
  }));
}

/**
 * Return shape vertices for any supported shape type.
 * @param {number} radiusMM
 * @param {string} shape       - 'hexagon', 'circle', or 'square'
 * @param {number} rotationRad - optional CCW rotation in radians (default 0)
 */
export function getShapeVertices(radiusMM = MODEL_RADIUS_MM, shape = 'hexagon', rotationRad = 0) {
  let verts;
  if (shape === 'square') {
    verts = [
      { x:  radiusMM, y:  radiusMM },
      { x: -radiusMM, y:  radiusMM },
      { x: -radiusMM, y: -radiusMM },
      { x:  radiusMM, y: -radiusMM },
    ];
  } else if (shape === 'circle') {
    // Approximate circle with 64 vertices — rotation is a no-op but keep API consistent
    verts = [];
    for (let i = 0; i < 64; i++) {
      const angle = (i / 64) * Math.PI * 2;
      verts.push({
        x: radiusMM * Math.cos(angle),
        y: radiusMM * Math.sin(angle),
      });
    }
  } else {
    // Default: hexagon
    verts = getHexVertices(radiusMM);
  }
  return rotateVerts(verts, rotationRad);
}

/**
 * Return hex vertices in geographic coordinates, suitable for drawing
 * a Leaflet polygon.
 */
export function getHexVerticesGeo(projection) {
  const hexMM = getHexVertices(MODEL_RADIUS_MM);
  return hexMM.map(v => projection.unproject(v.x, v.y));
}

/**
 * Return shape vertices in geographic coordinates.
 * @param {number} rotationRad - optional CCW rotation in radians (default 0)
 */
export function getShapeVerticesGeo(projection, shape = 'hexagon', rotationRad = 0) {
  const verts = getShapeVertices(MODEL_RADIUS_MM, shape, rotationRad);
  return verts.map(v => projection.unproject(v.x, v.y));
}

/**
 * Sample points on a regular grid covering the hex bounding square.
 * Returns [{lat, lng, i, j}, …] for the elevation API.
 */
export function buildElevationSampleGrid(centerLat, centerLng, radiusMeters, N) {
  const lat1rad = centerLat * (Math.PI / 180);
  const metersPerDegLat = METERS_PER_DEG_LAT;
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos(lat1rad);

  const pts = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = (i / (N - 1)) * 2 - 1; // -1 … +1
      const v = (j / (N - 1)) * 2 - 1;
      const xM = u * radiusMeters;
      const yM = v * radiusMeters;
      pts.push({
        lat: centerLat + yM / metersPerDegLat,
        lng: centerLng + xM / metersPerDegLng,
        i,
        j,
      });
    }
  }
  return pts;
}
