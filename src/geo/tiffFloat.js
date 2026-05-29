/**
 * Minimal float-TIFF decoder.
 *
 * Decodes ONLY the single-band 32-bit IEEE-float GeoTIFF that the USGS 3DEP
 * ImageServer `exportImage` endpoint returns when called with
 * `format=tiff&pixelType=F32`. Verified layout (Boulder test tile):
 *   - little-endian (II*), classic TIFF (magic 42)
 *   - Compression = 1 (none)
 *   - BitsPerSample = 32, SampleFormat = 3 (IEEE float)
 *   - SamplesPerPixel = 1
 *   - Tiled (TileWidth/TileLength = 128) OR stripped — both handled
 *
 * This is deliberately NOT a general TIFF reader — we control the request
 * params, so we only support the exact subset 3DEP emits. ~90 lines, no deps.
 *
 * @param {ArrayBuffer} arrayBuffer  Raw .tif bytes
 * @returns {{ width:number, height:number, data:Float32Array }}
 */
export function decodeFloatTIFF(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.byteLength < 8) throw new Error('TIFF too small');

  const le = dv.getUint16(0, true) === 0x4949;        // 'II' = little-endian
  const u16 = o => dv.getUint16(o, le);
  const u32 = o => dv.getUint32(o, le);

  if (u16(2) !== 42) throw new Error('not a classic TIFF');

  const ifd = u32(4);
  const entryCount = u16(ifd);

  // Field-type byte sizes (only the types 3DEP uses)
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };

  // Read a tag's values, following the offset pointer when the payload > 4 bytes.
  const readVals = (type, count, fieldOff) => {
    const sz = TYPE_SIZE[type] || 1;
    const total = sz * count;
    const base = total > 4 ? u32(fieldOff) : fieldOff;
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const o = base + i * sz;
      if (type === 3)      out[i] = u16(o);
      else if (type === 4) out[i] = u32(o);
      else                 out[i] = dv.getUint8(o);
    }
    return out;
  };

  const tags = {};
  for (let i = 0; i < entryCount; i++) {
    const e = ifd + 2 + i * 12;
    tags[u16(e)] = readVals(u16(e + 2), u32(e + 4), e + 8);
  }
  const first = t => (tags[t] ? tags[t][0] : undefined);

  const width       = first(256);
  const height      = first(257);
  const bits        = first(258) ?? 32;
  const compression = first(259) ?? 1;
  const sampleFmt   = first(339) ?? 1;

  if (!width || !height)        throw new Error('TIFF missing dimensions');
  if (compression !== 1)        throw new Error(`unsupported TIFF compression ${compression}`);
  if (bits !== 32 || sampleFmt !== 3) throw new Error('expected 32-bit IEEE float samples');

  const out = new Float32Array(width * height);

  if (tags[322]) {
    // ── Tiled layout ──────────────────────────────────────────────────
    const tw = first(322), th = first(323);
    const offsets = tags[324];
    const tilesAcross = Math.ceil(width / tw);
    const tilesDown   = Math.ceil(height / th);
    let ti = 0;
    for (let tyi = 0; tyi < tilesDown; tyi++) {
      for (let txi = 0; txi < tilesAcross; txi++, ti++) {
        const base = offsets[ti];
        for (let ry = 0; ry < th; ry++) {
          const oy = tyi * th + ry;
          if (oy >= height) break;
          const rowBase = base + ry * tw * 4;
          const outRow  = oy * width;
          for (let rx = 0; rx < tw; rx++) {
            const ox = txi * tw + rx;
            if (ox >= width) break;
            out[outRow + ox] = dv.getFloat32(rowBase + rx * 4, le);
          }
        }
      }
    }
  } else {
    // ── Stripped layout ───────────────────────────────────────────────
    const rowsPerStrip = first(278) ?? height;
    const offsets = tags[273] || [];
    let row = 0;
    for (let s = 0; s < offsets.length && row < height; s++) {
      const base = offsets[s];
      const rows = Math.min(rowsPerStrip, height - row);
      for (let ry = 0; ry < rows; ry++) {
        const rowBase = base + ry * width * 4;
        const outRow  = (row + ry) * width;
        for (let x = 0; x < width; x++) out[outRow + x] = dv.getFloat32(rowBase + x * 4, le);
      }
      row += rows;
    }
  }

  return { width, height, data: out };
}
