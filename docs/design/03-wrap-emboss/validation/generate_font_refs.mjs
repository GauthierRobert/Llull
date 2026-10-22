#!/usr/bin/env node
// WRP text-outline reference data from a pinned open font (no npm deps). Minimal TrueType reader: head, maxp, hhea, hmtx, OS/2, cmap
// (formats 4 and 12), loca, glyf (simple + composite glyphs). For each glyph it measures, exactly, the outline area by Green's theorem with
// the closed form of a quadratic Bezier segment, the contour count, the bounding box and the advance; it then cross-checks the exact area
// against an independent nonzero-winding scanline fill (detects overlapping contours, which would make "sum of contour areas" wrong).
//
//   node generate_font_refs.mjs [path/to/FiraSans-Regular.ttf]
//   default font path: data/reference/firasans/FiraSans-Regular.ttf (not committed; fetch it with the URL + sha256 in sources.md)
//   writes data/font_firasans_glyphs.json and data/text_cases.json
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fontPath = process.argv[2] ?? join(here, 'data', 'reference', 'firasans', 'FiraSans-Regular.ttf');
const PINNED_SHA256 = 'c29556a2719bf613ef3d5e070e40d903a8965d9c081beca1375dc1e6e0f93c23';
if (!existsSync(fontPath)) {
  console.error(`font not found: ${fontPath} (download it, see validation/sources.md R24)`);
  process.exit(1);
}
const bytes = readFileSync(fontPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (sha256 !== PINNED_SHA256) console.warn(`warning: sha256 ${sha256} differs from the pinned ${PINNED_SHA256}`);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u16 = (o) => view.getUint16(o);
const i16 = (o) => view.getInt16(o);
const u32 = (o) => view.getUint32(o);

// --- table directory ---------------------------------------------------------------------------------------------------------------
const tables = {};
for (let k = 0, n = u16(4); k < n; k++) {
  const rec = 12 + 16 * k;
  const tag = String.fromCharCode(...bytes.subarray(rec, rec + 4));
  tables[tag] = { offset: u32(rec + 8), length: u32(rec + 12) };
}
for (const tag of ['head', 'maxp', 'hhea', 'hmtx', 'cmap', 'loca', 'glyf'])
  if (tables[tag] === undefined) throw new Error(`missing table ${tag} (only TrueType-outline fonts are supported by this script)`);
const head = tables.head.offset;
const unitsPerEm = u16(head + 18);
const indexToLocFormat = i16(head + 50);
const numGlyphs = u16(tables.maxp.offset + 4);
const numberOfHMetrics = u16(tables.hhea.offset + 34);
const ascender = i16(tables.hhea.offset + 4);
const descender = i16(tables.hhea.offset + 6);
let capHeight = null;
let xHeight = null;
const fsType = tables['OS/2'] === undefined ? null : u16(tables['OS/2'].offset + 8);
if (tables['OS/2'] !== undefined && u16(tables['OS/2'].offset) >= 2) {
  xHeight = i16(tables['OS/2'].offset + 86);
  capHeight = i16(tables['OS/2'].offset + 88);
}
const advance = (g) => u16(tables.hmtx.offset + 4 * Math.min(g, numberOfHMetrics - 1));
const loca = (g) => (indexToLocFormat === 0 ? 2 * u16(tables.loca.offset + 2 * g) : u32(tables.loca.offset + 4 * g));

// --- cmap ----------------------------------------------------------------------------------------------------------------------------
function cmapLookup() {
  const base = tables.cmap.offset;
  const subtables = [];
  for (let k = 0, n = u16(base + 2); k < n; k++) {
    const rec = base + 4 + 8 * k;
    subtables.push({ platform: u16(rec), encoding: u16(rec + 2), offset: base + u32(rec + 4) });
  }
  const pick = (format) => subtables.find((s) => u16(s.offset) === format && (s.platform === 3 || s.platform === 0));
  const f12 = pick(12);
  if (f12 !== undefined) {
    const groups = u32(f12.offset + 12);
    return (cp) => {
      for (let k = 0; k < groups; k++) {
        const g = f12.offset + 16 + 12 * k;
        const start = u32(g);
        const end = u32(g + 4);
        if (cp >= start && cp <= end) return u32(g + 8) + (cp - start);
      }
      return 0;
    };
  }
  const f4 = pick(4);
  if (f4 === undefined) throw new Error('no cmap format 4 or 12');
  const o = f4.offset;
  const segX2 = u16(o + 6);
  const ends = o + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  return (cp) => {
    for (let s = 0; s < segX2 / 2; s++) {
      const end = u16(ends + 2 * s);
      if (cp > end) continue;
      const start = u16(starts + 2 * s);
      if (cp < start) return 0;
      const delta = i16(deltas + 2 * s);
      const rangeOffset = u16(ranges + 2 * s);
      if (rangeOffset === 0) return (cp + delta) & 0xffff;
      const g = u16(ranges + 2 * s + rangeOffset + 2 * (cp - start));
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
}
const glyphOf = cmapLookup();

// --- glyf ----------------------------------------------------------------------------------------------------------------------------
/** Contours of glyph g as arrays of { x, y, on }, composite glyphs flattened with their transforms. */
function contoursOf(g, depth = 0) {
  if (depth > 8) throw new Error('composite glyph too deep');
  const start = loca(g);
  const end = loca(g + 1);
  if (end <= start) return [];
  const o = tables.glyf.offset + start;
  const count = i16(o);
  if (count >= 0) {
    const endPts = [];
    for (let k = 0; k < count; k++) endPts.push(u16(o + 10 + 2 * k));
    const nPts = count === 0 ? 0 : endPts[count - 1] + 1;
    let p = o + 10 + 2 * count;
    p += 2 + u16(p);
    const flags = [];
    while (flags.length < nPts) {
      const f = bytes[p++];
      flags.push(f);
      if (f & 8) for (let r = bytes[p++]; r > 0; r--) flags.push(f);
    }
    const xs = [];
    let x = 0;
    for (const f of flags) {
      if (f & 2) {
        const dx = bytes[p++];
        x += f & 16 ? dx : -dx;
      } else if (!(f & 16)) {
        x += i16(p);
        p += 2;
      }
      xs.push(x);
    }
    const ys = [];
    let y = 0;
    for (const f of flags) {
      if (f & 4) {
        const dy = bytes[p++];
        y += f & 32 ? dy : -dy;
      } else if (!(f & 32)) {
        y += i16(p);
        p += 2;
      }
      ys.push(y);
    }
    const contours = [];
    let first = 0;
    for (const last of endPts) {
      const c = [];
      for (let k = first; k <= last; k++) c.push({ x: xs[k], y: ys[k], on: (flags[k] & 1) === 1 });
      contours.push(c);
      first = last + 1;
    }
    return contours;
  }
  // composite
  const out = [];
  let p = o + 10;
  for (;;) {
    const flags = u16(p);
    const child = u16(p + 2);
    p += 4;
    let dx;
    let dy;
    if (flags & 1) {
      dx = i16(p);
      dy = i16(p + 2);
      p += 4;
    } else {
      dx = view.getInt8(p);
      dy = view.getInt8(p + 1);
      p += 2;
    }
    if (!(flags & 2)) throw new Error('composite point-matching offsets are not supported');
    let [a, b, c, d] = [1, 0, 0, 1];
    const f2dot14 = (q) => i16(q) / 16384;
    if (flags & 8) {
      a = d = f2dot14(p);
      p += 2;
    } else if (flags & 0x40) {
      a = f2dot14(p);
      d = f2dot14(p + 2);
      p += 4;
    } else if (flags & 0x80) {
      a = f2dot14(p);
      b = f2dot14(p + 2);
      c = f2dot14(p + 4);
      d = f2dot14(p + 6);
      p += 8;
    }
    for (const contour of contoursOf(child, depth + 1))
      out.push(contour.map((pt) => ({ x: a * pt.x + c * pt.y + dx, y: b * pt.x + d * pt.y + dy, on: pt.on })));
    if (!(flags & 0x20)) break;
  }
  return out;
}

/** Contour -> segments: lines [p0, p1] and quadratics [p0, c, p1] with implied on-curve midpoints between off points. */
function segmentsOf(contour) {
  const n = contour.length;
  if (n === 0) return [];
  let startIndex = contour.findIndex((pt) => pt.on);
  const pts = [...contour];
  if (startIndex < 0) {
    const a = pts[0];
    const b = pts[1 % n];
    pts.unshift({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
    startIndex = 0;
  }
  const ring = [...pts.slice(startIndex), ...pts.slice(0, startIndex)];
  const segs = [];
  let current = ring[0];
  let control = null;
  for (let k = 1; k <= ring.length; k++) {
    const pt = ring[k % ring.length];
    if (pt.on) {
      segs.push(control === null ? [current, pt] : [current, control, pt]);
      current = pt;
      control = null;
    } else if (control === null) control = pt;
    else {
      const mid = { x: (control.x + pt.x) / 2, y: (control.y + pt.y) / 2, on: true };
      segs.push([current, control, mid]);
      current = mid;
      control = pt;
    }
  }
  return segs;
}

const cross = (p, q) => p.x * q.y - q.x * p.y;
/** Exact signed area (counter-clockwise > 0): 1/2 contour integral of (x dy - y dx); quadratic: (2/3)(P0xC + CxP1) + (1/3)(P0xP1). */
function signedArea(segs) {
  let twice = 0;
  for (const s of segs)
    twice += s.length === 2 ? cross(s[0], s[1]) : (2 / 3) * (cross(s[0], s[1]) + cross(s[1], s[2])) + (1 / 3) * cross(s[0], s[2]);
  return twice / 2;
}
/** Arc length of the outline (quadratics by 64-point Gauss-like dense sampling): engraving tool-path length for the outline. */
function perimeter(segs) {
  let length = 0;
  for (const s of segs) {
    if (s.length === 2) {
      length += Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y);
      continue;
    }
    let prev = s[0];
    for (let k = 1; k <= 256; k++) {
      const t = k / 256;
      const pt = {
        x: (1 - t) ** 2 * s[0].x + 2 * (1 - t) * t * s[1].x + t * t * s[2].x,
        y: (1 - t) ** 2 * s[0].y + 2 * (1 - t) * t * s[1].y + t * t * s[2].y,
      };
      length += Math.hypot(pt.x - prev.x, pt.y - prev.y);
      prev = pt;
    }
  }
  return length;
}
/** Independent check: nonzero-winding fill area by scanlines over the flattened outline (midpoint rule in y). */
function nonzeroFillArea(contourSegs, yMin, yMax, lines = 6000) {
  const edges = [];
  for (const segs of contourSegs)
    for (const s of segs) {
      const pts =
        s.length === 2
          ? s
          : Array.from({ length: 33 }, (_, k) => {
              const t = k / 32;
              return {
                x: (1 - t) ** 2 * s[0].x + 2 * (1 - t) * t * s[1].x + t * t * s[2].x,
                y: (1 - t) ** 2 * s[0].y + 2 * (1 - t) * t * s[1].y + t * t * s[2].y,
              };
            });
      for (let k = 1; k < pts.length; k++) edges.push([pts[k - 1], pts[k]]);
    }
  const h = (yMax - yMin) / lines;
  let area = 0;
  for (let i = 0; i < lines; i++) {
    const y = yMin + (i + 0.5) * h;
    const hits = [];
    for (const [a, b] of edges) {
      if (a.y === b.y || y < Math.min(a.y, b.y) || y >= Math.max(a.y, b.y)) continue;
      hits.push({ x: a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x), w: b.y > a.y ? 1 : -1 });
    }
    hits.sort((p, q) => p.x - q.x);
    let winding = 0;
    for (let k = 0; k < hits.length; k++) {
      const before = winding;
      winding += hits[k].w;
      if (before !== 0 && k > 0) area += (hits[k].x - hits[k - 1].x) * h;
    }
  }
  return area;
}

function measureGlyph(ch) {
  const cp = ch.codePointAt(0);
  const g = glyphOf(cp);
  const contours = contoursOf(g);
  const segs = contours.map(segmentsOf);
  const areas = segs.map(signedArea);
  const all = contours.flat();
  const xMin = Math.min(...all.map((p) => p.x));
  const xMax = Math.max(...all.map((p) => p.x));
  const yMin = Math.min(...all.map((p) => p.y));
  const yMax = Math.max(...all.map((p) => p.y));
  const exact = -areas.reduce((s, a) => s + a, 0); // TrueType outer contours are clockwise
  const fill = contours.length === 0 ? 0 : nonzeroFillArea(segs, yMin, yMax);
  return {
    char: ch,
    codePoint: cp,
    glyphId: g,
    advance: advance(g),
    contours: contours.length,
    outerContours: areas.filter((a) => a < 0).length,
    holes: areas.filter((a) => a > 0).length,
    quadraticSegments: segs.flat().filter((s) => s.length === 3).length,
    lineSegments: segs.flat().filter((s) => s.length === 2).length,
    bbox: contours.length === 0 ? null : [xMin, yMin, xMax, yMax],
    areaFontUnits2: Number(exact.toFixed(6)),
    outlineLengthFontUnits: Number(segs.reduce((s, c) => s + perimeter(c), 0).toFixed(4)),
    check: {
      nonzeroFillArea: Number(fill.toFixed(3)),
      relativeDifference: exact === 0 ? 0 : Number(((fill - exact) / exact).toExponential(3)),
    },
  };
}

const CHARS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'abcdefghijklmnopqrstuvwxyz', ...'0123456789', ...'.-%&#?!', ' '];
const glyphs = CHARS.map(measureGlyph);
const fontRecord = {
  file: 'FiraSans-Regular.ttf',
  sha256,
  pinnedSha256: PINNED_SHA256,
  sizeBytes: bytes.length,
  licence: 'SIL Open Font License 1.1',
  unitsPerEm,
  ascender,
  descender,
  capHeight,
  xHeight,
  fsType,
  embeddingPermission:
    fsType === null ? null : ({ 0: 'installable', 2: 'restricted', 4: 'preview_print', 8: 'editable' }[fsType & 0xf] ?? 'invalid'),
  numGlyphs,
};
mkdirSync(join(here, 'data'), { recursive: true });
writeFileSync(
  join(here, 'data', 'font_firasans_glyphs.json'),
  `${JSON.stringify({ generated: 'generate_font_refs.mjs', font: fontRecord, method: 'exact Green area of TrueType quadratic outlines; nonzero scanline fill as independent check (6000 lines, 32 pieces per quadratic)', glyphs }, null, 1)}\n`,
);

// --- text cases: area of a string at a given cap height, emboss volumes (planar / cylinder isometric wrap) ---------------------------
const byChar = new Map(glyphs.map((g) => [g.char, g]));
function textCase(text, capHeightMm, depth, radius) {
  const scale = capHeightMm / capHeight; // mm per font unit
  const area = [...text].reduce((s, ch) => s + byChar.get(ch).areaFontUnits2, 0) * scale * scale;
  const widthNoKerning = [...text].reduce((s, ch) => s + byChar.get(ch).advance, 0) * scale;
  const loops = [...text].reduce((s, ch) => s + byChar.get(ch).contours, 0);
  const outline = [...text].reduce((s, ch) => s + byChar.get(ch).outlineLengthFontUnits, 0) * scale;
  const fill = [...text].reduce((s, ch) => s + byChar.get(ch).check.nonzeroFillArea, 0) * scale * scale;
  return {
    text,
    font: 'Fira Sans Regular (pinned sha256)',
    capHeightMm,
    scaleMmPerFontUnit: Number(scale.toPrecision(12)),
    loops,
    areaMm2: Number(area.toPrecision(10)),
    outlineLengthMm: Number(outline.toPrecision(8)),
    advanceWidthNoKerningMm: Number(widthNoKerning.toPrecision(10)),
    emboss: {
      depthMm: depth,
      planarVolumeMm3: Number((area * depth).toPrecision(10)),
      cylinderRadiusMm: radius,
      cylinderEmbossVolumeMm3: Number((area * depth * (1 + depth / (2 * radius))).toPrecision(10)),
      cylinderDebossVolumeMm3: Number((area * depth * (1 - depth / (2 * radius))).toPrecision(10)),
      angularSpanRad: Number((widthNoKerning / radius).toPrecision(10)),
      fitsAround: widthNoKerning <= 2 * Math.PI * radius,
    },
    check: { fillAreaMm2: Number(fill.toPrecision(8)) },
  };
}
const cases = [
  textCase('LLULL', 10, 1, 20),
  textCase('WRAP', 10, 1, 20),
  textCase('O', 10, 1, 20),
  textCase('B8%', 10, 0.5, 20),
  textCase('Ag', 10, 1, 20),
  textCase('LLULL CAD 2026', 5, 0.3, 12),
];
writeFileSync(
  join(here, 'data', 'text_cases.json'),
  `${JSON.stringify(
    {
      generated: 'generate_font_refs.mjs',
      derivation:
        'area = sum of glyph outline areas x (capHeightMm / OS2.sCapHeight)^2 (glyphs of a line do not overlap); emboss on a cylinder of radius r ' +
        'with walls normal to the face: V = A d (1 + d/2r), deboss A d (1 - d/2r) (isometric wrap keeps A; data/emboss_volumes.json). Width uses ' +
        'advances only (no GPOS kerning: not parsed here) and is a property of the layout, not of the area.',
      cases,
    },
    null,
    1,
  )}\n`,
);
console.warn(`wrote data/font_firasans_glyphs.json (${glyphs.length} glyphs) and data/text_cases.json; font sha256 ${sha256}`);
