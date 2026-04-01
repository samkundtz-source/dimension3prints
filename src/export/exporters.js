/**
 * Export functions — STL and Bambu-compatible coloured 3MF.
 *
 * 3MF structure matches map2model reference:
 *   • Separate <object> per feature type
 *   • model_settings.config assigns each part to an extruder
 *   • project_settings.config defines filament colours
 *   • 5 extruders: blue(base), black(roads), green(parks), grey(buildings), white(water)
 */

import * as fflate from 'fflate';
import { FEATURE_COLORS } from '../geometry/buildMap.js';

// ─── Colour buckets (derived from FEATURE_COLORS at export time) ─────────────

function getBuckets() {
  // Convert hex int to CSS hex string
  const toHex = (n) => '#' + n.toString(16).padStart(6, '0').toUpperCase();
  const inverted = FEATURE_COLORS.base === 0x1A1A1A;
  return [
    { label: 'Structure', color: toHex(FEATURE_COLORS.base), extruder: inverted ? 1 : 2, types: new Set(['base','terrain','building']) },
    { label: 'Roads',     color: toHex(FEATURE_COLORS.road), extruder: inverted ? 2 : 1, types: new Set(['road','path','water','park']) },
  ];
}

// ─── Coordinate transform ─────────────────────────────────────────────────────
// Three.js: Y-up. STL/3MF: Z-up.
// Transform: exportX = threeX, exportY = -threeZ, exportZ = threeY

function transformVertex(mat, x, y, z) {
  // Apply world matrix first
  const wx = mat[0]*x + mat[4]*y + mat[8]*z  + mat[12];
  const wy = mat[1]*x + mat[5]*y + mat[9]*z  + mat[13];
  const wz = mat[2]*x + mat[6]*y + mat[10]*z + mat[14];
  // Swap Y↔Z for Z-up coordinate system
  return [wx, -wz, wy];
}

// ─── Binary STL ───────────────────────────────────────────────────────────────

export function exportSTL(modelGroup, filename = 'map-model.stl') {
  if (!modelGroup) return;

  const allPos = [];
  const allIdx = [];
  let   vBase  = 0;

  modelGroup.updateMatrixWorld(true);
  modelGroup.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    const pos = obj.geometry.attributes.position.array;
    const idx = obj.geometry.index?.array;
    const mat = obj.matrixWorld.elements;
    const n   = pos.length / 3;

    for (let i = 0; i < n; i++) {
      const [ex, ey, ez] = transformVertex(mat, pos[i*3], pos[i*3+1], pos[i*3+2]);
      allPos.push(ex, ey, ez);
    }
    if (idx) {
      for (let i = 0; i < idx.length; i++) allIdx.push(idx[i] + vBase);
    } else {
      for (let i = 0; i < n; i++) allIdx.push(vBase + i);
    }
    vBase += n;
  });

  const numTris = allIdx.length / 3;
  const buf     = new ArrayBuffer(84 + numTris * 50);
  const view    = new DataView(buf);

  const header = 'Dimension3Prints - map-model.stl';
  for (let i = 0; i < 80; i++) {
    view.setUint8(i, i < header.length ? header.charCodeAt(i) : 0);
  }
  view.setUint32(80, numTris, true);

  let off = 84;
  for (let t = 0; t < numTris; t++) {
    const i0 = allIdx[t*3], i1 = allIdx[t*3+1], i2 = allIdx[t*3+2];
    const ax = allPos[i0*3], ay = allPos[i0*3+1], az = allPos[i0*3+2];
    const bx = allPos[i1*3], by = allPos[i1*3+1], bz = allPos[i1*3+2];
    const cx = allPos[i2*3], cy = allPos[i2*3+1], cz = allPos[i2*3+2];
    const ux = bx-ax, uy = by-ay, uz = bz-az;
    const vx = cx-ax, vy = cy-ay, vz = cz-az;
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const nl = Math.sqrt(nx*nx+ny*ny+nz*nz);
    if (nl > 1e-9) { nx/=nl; ny/=nl; nz/=nl; }
    view.setFloat32(off, nx, true); off+=4;
    view.setFloat32(off, ny, true); off+=4;
    view.setFloat32(off, nz, true); off+=4;
    view.setFloat32(off, ax, true); off+=4; view.setFloat32(off, ay, true); off+=4; view.setFloat32(off, az, true); off+=4;
    view.setFloat32(off, bx, true); off+=4; view.setFloat32(off, by, true); off+=4; view.setFloat32(off, bz, true); off+=4;
    view.setFloat32(off, cx, true); off+=4; view.setFloat32(off, cy, true); off+=4; view.setFloat32(off, cz, true); off+=4;
    view.setUint16(off, 0, true); off+=2;
  }

  triggerDownload(new Uint8Array(buf), filename, 'application/octet-stream');
}

// ─── Coloured 3MF (Bambu Studio compatible) ─────────────────────────────────

/**
 * Export as Bambu Studio-compatible 3MF with multi-extruder parts.
 * Matches the map2model reference structure:
 *   - object-1.model contains all geometry objects
 *   - 3dmodel.model is the assembly referencing them
 *   - model_settings.config assigns extruders per part
 *   - project_settings.config defines filament colours
 */
export function export3MF(modelGroup, filename = 'map-model.3mf') {
  if (!modelGroup) return;

  // ── 1. Collect geometry into colour buckets ─────────────────────────────
  const BUCKETS     = getBuckets();
  const bucketPos   = BUCKETS.map(() => []);
  const bucketIdx   = BUCKETS.map(() => []);
  const bucketVBase = BUCKETS.map(() => 0);

  modelGroup.updateMatrixWorld(true);
  modelGroup.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    const type = obj.userData.featureType || 'base';
    const bi   = BUCKETS.findIndex(b => b.types.has(type));
    if (bi < 0) return;

    const pos = obj.geometry.attributes.position.array;
    const idx = obj.geometry.index?.array;
    const mat = obj.matrixWorld.elements;
    const n   = pos.length / 3;

    for (let i = 0; i < n; i++) {
      const [ex, ey, ez] = transformVertex(mat, pos[i*3], pos[i*3+1], pos[i*3+2]);
      bucketPos[bi].push(ex, ey, ez);
    }
    if (idx) {
      for (let i = 0; i < idx.length; i++) {
        bucketIdx[bi].push(idx[i] + bucketVBase[bi]);
      }
    } else {
      for (let i = 0; i < n; i++) bucketIdx[bi].push(bucketVBase[bi] + i);
    }
    bucketVBase[bi] += n;
  });

  // ── 2. Build object-1.model (geometry file) ────────────────────────────
  const partIds = []; // { id, bucketIndex }
  let objectsXML = '';
  let partId = 0;

  for (let bi = 0; bi < BUCKETS.length; bi++) {
    const pos = bucketPos[bi];
    const idx = bucketIdx[bi];
    if (pos.length === 0 || idx.length < 3) continue;

    partId++;
    partIds.push({ id: partId, bi });

    const vLines = [];
    for (let i = 0; i < pos.length; i += 3) {
      vLines.push(`<vertex x="${pos[i].toFixed(5)}" y="${pos[i+1].toFixed(5)}" z="${pos[i+2].toFixed(5)}"/>`);
    }

    const tLines = [];
    for (let i = 0; i < idx.length; i += 3) {
      if (idx[i] === idx[i+1] || idx[i+1] === idx[i+2] || idx[i] === idx[i+2]) continue;
      tLines.push(`<triangle v1="${idx[i]}" v2="${idx[i+1]}" v3="${idx[i+2]}"/>`);
    }

    if (tLines.length === 0) { partId--; partIds.pop(); continue; }

    objectsXML += `<object id="${partId}" type="model"><mesh><vertices>${vLines.join('')}</vertices><triangles>${tLines.join('')}</triangles></mesh></object>`;
  }

  // Assembly object that references all parts
  const assemblyId = partId + 1;
  const componentsXML = partIds.map(p =>
    `<component p:path="/3D/Objects/object-1.model" objectid="${p.id}"/>`
  ).join('');

  const objectModelXML =
`<?xml version="1.0" encoding="UTF-8"?>` +
`<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">` +
`<resources>${objectsXML}</resources></model>`;

  // ── 3. Build 3dmodel.model (assembly file) ────────────────────────────
  const mainModelXML =
`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
  <metadata name="Application">Dimension3Prints</metadata>
  <metadata name="Title">Exported 3D Model</metadata>
  <resources>
    <object id="${assemblyId}" type="model">
      <components>
        ${componentsXML}
      </components>
    </object>
  </resources>
  <build>
    <item objectid="${assemblyId}" printable="1"/>
  </build>
</model>`;

  // ── 4. Build model_settings.config (extruder assignments) ──────────────
  const partSettingsXML = partIds.map(p => {
    const bucket = BUCKETS[p.bi];
    return `    <part id="${p.id}" subtype="normal_part">
      <metadata key="name" value="${bucket.label}"/>
      <metadata key="extruder" value="${bucket.extruder}"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>`;
  }).join('\n');

  const modelSettingsXML =
`<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${assemblyId}">
    <metadata key="name" value="Dimension3Prints.3mf"/>
    <metadata key="extruder" value="1"/>
    <metadata key="thumbnail_file" value=""/>
${partSettingsXML}
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="plate-1"/>
    <model_instance>
      <metadata key="object_id" value="${assemblyId}"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="1"/>
    </model_instance>
  </plate>
  <assemble>
    <assemble_item object_id="${assemblyId}" instance_id="0" offset="0 0 0"/>
  </assemble>
</config>`;

  // ── 5. Build project_settings.config (filament colours) ────────────────
  // filament_colour must be ordered by extruder number (1-based), not bucket order
  const maxExtruder = Math.max(...BUCKETS.map(b => b.extruder));
  const filamentColors = new Array(maxExtruder).fill('#808080');
  const filamentIds    = new Array(maxExtruder).fill('Bambu PLA Basic @BBL A1');
  const filamentDiam   = new Array(maxExtruder).fill('1.75');
  const filamentSupp   = new Array(maxExtruder).fill('0');
  for (const b of BUCKETS) {
    filamentColors[b.extruder - 1] = b.color.toLowerCase();
  }
  const projectSettingsJSON = JSON.stringify({
    print_settings_id: "0.20mm Standard @BBL A1",
    filament_colour: filamentColors,
    filament_settings_id: filamentIds,
    filament_diameter: filamentDiam,
    filament_is_support: filamentSupp,
    printer_model: "Bambu Lab A1",
    layer_height: "0.2",
    enable_support: "0",
  });

  // ── 6. Build rels files ─────────────────────────────────────────────────
  const modelRels =
`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/Objects/object-1.model" Id="rel1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  // ── 7. Package as valid 3MF ZIP ────────────────────────────────────────
  const enc = new TextEncoder();

  const contentTypes =
`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="text/xml"/>
</Types>`;

  const rels =
`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0"
    Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  const zip = fflate.zipSync({
    '[Content_Types].xml':                enc.encode(contentTypes),
    '_rels/.rels':                        enc.encode(rels),
    '3D/3dmodel.model':                   enc.encode(mainModelXML),
    '3D/Objects/object-1.model':          enc.encode(objectModelXML),
    '3D/_rels/3dmodel.model.rels':        enc.encode(modelRels),
    'Metadata/model_settings.config':     enc.encode(modelSettingsXML),
    'Metadata/project_settings.config':   enc.encode(projectSettingsJSON),
  }, { level: 6 });

  triggerDownload(zip, filename, 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function triggerDownload(data, filename, mimeType) {
  const blob = new Blob([data], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
