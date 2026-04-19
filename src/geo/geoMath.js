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
 * @param {number} radiusMeters  – real-world circumradius in metres
 * @param {number} rotationRad  – CCW rotation of the capture area (default 0)
 *
 * Rotation is baked into project/unproject so ALL features (buildings,
 * roads, water) are rotated in model space — not just the clip boundary.
 * The map overlay uses unproject() on the regular shape vertices and
 * therefore automatically shows the correct rotated polygon on the map.
 */
export function createProjection(centerLat, centerLng, radiusMeters, rotationRad = 0) {
  const lat1rad = centerLat * (Math.PI / 180);
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos(lat1rad);
  const horizontalScale = MODEL_RADIUS_MM / radiusMeters; // mm per metre

  const cosR =  Math.cos(rotationRad);
  const sinR =  Math.sin(rotationRad);
  // Inverse rotation coefficients (used in unproject)
  const icosR =  cosR;   // cos(-θ) = cos(θ)
  const isinR = -sinR;   // sin(-θ) = -sin(θ)

  return {
    centerLat,
    centerLng,
    radiusMeters,
    horizontalScale,

    /**
     * Convert geographic coords → local 2-D model mm {x, y}.
     * Applies the user-specified CCW rotation so the model is oriented
     * to match the rotated selection box on the map.
     */
    project(lat, lng) {
      const rawX = (lng - centerLng) * metersPerDegLng * horizontalScale;
      const rawY = (lat - centerLat) * METERS_PER_DEG_LAT * horizontalScale;
      return {
        x: rawX * cosR - rawY * sinR,
        y: rawX * sinR + rawY * cosR,
      };
    },

    /**
     * Convert local 2-D model mm back to geographic coords.
     * Applies the inverse rotation (used by getShapeVerticesGeo to draw
     * the correct rotated outline on the Leaflet map).
     */
    unproject(x, y) {
      const rawX = x * icosR - y * isinR;
      const rawY = x * isinR + y * icosR;
      return {
        lat: centerLat + (rawY / horizontalScale) / METERS_PER_DEG_LAT,
        lng: centerLng + (rawX / horizontalScale) / metersPerDegLng,
      };
    },

    /** Scale a real-world length (metres) to model mm. */
    scaleLength(meters) {
      return meters * horizontalScale;
    },

    /**
     * Bounding box for the Overpass API query — always axis-aligned and
     * large enough to cover the full rotated selection area.
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
