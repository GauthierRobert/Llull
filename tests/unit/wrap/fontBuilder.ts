/**
 * A tiny TrueType writer for the parser tests (03 WRP): builds an sfnt with exactly the tables, cmap formats, glyph encodings (short vectors, repeats,
 * composites) and OS/2 / name / kern variants a test names, so every branch of `lib/font` is reached by a font whose contents are known.
 */

export interface GlyphPointSpec {
  readonly x: number;
  readonly y: number;
  readonly on: boolean;
}

export type GlyphSpec =
  | { readonly kind: 'empty' }
  | { readonly kind: 'simple'; readonly contours: ReadonlyArray<ReadonlyArray<GlyphPointSpec>> }
  | {
      readonly kind: 'composite';
      readonly components: ReadonlyArray<{
        readonly glyph: number;
        readonly dx: number;
        readonly dy: number;
        readonly words?: boolean;
        readonly transform?: 'scale' | 'xy' | 'matrix' | 'mirror';
        readonly pointMatching?: boolean;
      }>;
    }
  | { readonly kind: 'raw'; readonly bytes: readonly number[] };

export interface FontSpec {
  readonly unitsPerEm?: number;
  readonly glyphs: readonly GlyphSpec[];
  readonly advances?: readonly number[];
  readonly cmap?: 'f4' | 'f4-range' | 'f12' | 'none' | 'f4-bad' | 'f12-bad';
  readonly codePoints?: ReadonlyArray<readonly [number, number]>;
  readonly os2?: { readonly version: number; readonly fsType: number; readonly capHeight?: number } | null;
  readonly names?: ReadonlyArray<{ readonly platform: 1 | 3; readonly id: number; readonly text: string }>;
  readonly kern?: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> | 'vertical' | 'version1';
  /** An OpenType font with CFF outlines: the OTTO sfnt tag. */
  readonly otto?: boolean;
  /** Extra raw tables by tag (e.g. a GPOS from `gposBuilder`). */
  readonly tables?: Readonly<Record<string, readonly number[]>>;
  readonly longLoca?: boolean;
  readonly metrics?: number;
  readonly omit?: readonly string[];
  readonly hmtxLength?: number;
}

class Writer {
  readonly bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value >> 8).u8(value);
  }

  i16(value: number): this {
    return this.u16(value < 0 ? value + 0x10000 : value);
  }

  u32(value: number): this {
    return this.u16(Math.floor(value / 0x10000)).u16(value % 0x10000);
  }

  tag(text: string): this {
    for (const character of text) this.u8(character.charCodeAt(0));
    return this;
  }

  pad(): this {
    while (this.bytes.length % 4 !== 0) this.u8(0);
    return this;
  }
}

function simpleGlyph(contours: ReadonlyArray<ReadonlyArray<GlyphPointSpec>>): number[] {
  const points = contours.flat();
  const out = new Writer();
  out.i16(contours.length).i16(0).i16(0).i16(0).i16(0);
  let end = -1;
  for (const contour of contours) {
    end += contour.length;
    out.u16(end);
  }
  out.u16(0);
  const flags: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  let px = 0;
  let py = 0;
  for (const point of points) {
    const dx = point.x - px;
    const dy = point.y - py;
    let flag = point.on ? 1 : 0;
    if (dx === 0) flag |= 16;
    else if (Math.abs(dx) < 256) {
      flag |= 2 | (dx > 0 ? 16 : 0);
      xs.push(Math.abs(dx));
    } else xs.push(dx);
    if (dy === 0) flag |= 32;
    else if (Math.abs(dy) < 256) {
      flag |= 4 | (dy > 0 ? 32 : 0);
      ys.push(Math.abs(dy));
    } else ys.push(dy);
    flags.push(flag);
    px = point.x;
    py = point.y;
  }
  for (let k = 0; k < flags.length; k++) {
    let repeat = 0;
    while (k + repeat + 1 < flags.length && flags[k + repeat + 1] === flags[k] && repeat < 255) repeat += 1;
    if (repeat > 0) {
      out.u8((flags[k] as number) | 8).u8(repeat);
      k += repeat;
    } else out.u8(flags[k] as number);
  }
  let xi = 0;
  let yi = 0;
  for (const flag of flags) {
    if ((flag & 2) !== 0) out.u8(xs[xi++] as number);
    else if ((flag & 16) === 0) out.i16(xs[xi++] as number);
  }
  for (const flag of flags) {
    if ((flag & 4) !== 0) out.u8(ys[yi++] as number);
    else if ((flag & 32) === 0) out.i16(ys[yi++] as number);
  }
  return out.bytes;
}

function compositeGlyph(components: Extract<GlyphSpec, { kind: 'composite' }>['components']): number[] {
  const out = new Writer();
  out.i16(-1).i16(0).i16(0).i16(0).i16(0);
  components.forEach((component, index) => {
    let flags = component.pointMatching === true ? 0 : 2;
    if (component.words === true) flags |= 1;
    if (component.transform === 'scale') flags |= 8;
    if (component.transform === 'xy' || component.transform === 'mirror') flags |= 0x40;
    if (component.transform === 'matrix') flags |= 0x80;
    if (index < components.length - 1) flags |= 0x20;
    out.u16(flags).u16(component.glyph);
    if (component.words === true) out.i16(component.dx).i16(component.dy);
    else out.u8(component.dx).u8(component.dy);
    const f2dot14 = (value: number): void => void out.i16(Math.round(value * 16384));
    if (component.transform === 'scale') f2dot14(0.5);
    if (component.transform === 'xy') {
      f2dot14(0.5);
      f2dot14(2);
    }
    if (component.transform === 'mirror') [-1, 1].forEach(f2dot14);
    if (component.transform === 'matrix') [1, 0.5, -0.5, 1].forEach(f2dot14);
  });
  return out.bytes;
}

function cmapTable(spec: FontSpec): number[] {
  const codes = spec.codePoints ?? [];
  const out = new Writer();
  if (spec.cmap === 'none') return out.u16(0).u16(0).bytes;
  out
    .u16(0)
    .u16(1)
    .u16(3)
    .u16(spec.cmap === 'f12' || spec.cmap === 'f12-bad' ? 10 : 1)
    .u32(12);
  if (spec.cmap === 'f12' || spec.cmap === 'f12-bad') {
    out
      .u16(12)
      .u16(0)
      .u32(16 + 12 * codes.length)
      .u32(0)
      .u32(spec.cmap === 'f12-bad' ? 1_000_000 : codes.length);
    for (const [code, glyph] of codes) out.u32(code).u32(code).u32(glyph);
    return out.bytes;
  }
  if (spec.cmap === 'f4-bad') return out.u16(4).u16(0).u16(0).u16(0).u16(0).bytes;
  const segments = codes.length + 1;
  const ranged = spec.cmap === 'f4-range';
  const tail = new Writer();
  for (const [code] of codes) tail.u16(code);
  tail.u16(0xffff).u16(0);
  for (const [code] of codes) tail.u16(code);
  tail.u16(0xffff);
  for (const [code, glyph] of codes) tail.i16(ranged ? 0 : glyph - code);
  tail.i16(1);
  const glyphArrayOffset = 2 * segments * 1;
  for (let k = 0; k < codes.length; k++) tail.u16(ranged ? glyphArrayOffset - 2 * k + 2 * k : 0);
  tail.u16(0);
  if (ranged) for (const [, glyph] of codes) tail.u16(glyph);
  out
    .u16(4)
    .u16(14 + tail.bytes.length)
    .u16(0)
    .u16(2 * segments)
    .u16(0)
    .u16(0)
    .u16(0);
  return [...out.bytes, ...tail.bytes];
}

function nameTable(names: NonNullable<FontSpec['names']>): number[] {
  const strings = new Writer();
  const records = new Writer();
  for (const record of names) {
    const start = strings.bytes.length;
    if (record.platform === 3) for (const character of record.text) strings.u16(character.charCodeAt(0));
    else for (const character of record.text) strings.u8(character.charCodeAt(0));
    records
      .u16(record.platform)
      .u16(record.platform === 3 ? 1 : 0)
      .u16(0)
      .u16(record.id)
      .u16(strings.bytes.length - start)
      .u16(start);
  }
  return [
    ...new Writer()
      .u16(0)
      .u16(names.length)
      .u16(6 + 12 * names.length).bytes,
    ...records.bytes,
    ...strings.bytes,
  ];
}

function kernTable(kern: NonNullable<FontSpec['kern']>): number[] {
  if (kern === 'version1') return new Writer().u16(1).u16(0).bytes;
  const subtables = kern === 'vertical' ? [[[1, 2, -50]] as const] : kern;
  const out = new Writer().u16(0).u16(subtables.length);
  for (const pairs of subtables) {
    const sorted = [...pairs].sort((a, b) => a[0] * 65536 + a[1] - (b[0] * 65536 + b[1]));
    out
      .u16(0)
      .u16(14 + 6 * sorted.length)
      .u16(kern === 'vertical' ? 0 : 1)
      .u16(sorted.length)
      .u16(0)
      .u16(0)
      .u16(0);
    for (const [left, right, value] of sorted) out.u16(left).u16(right).i16(value);
  }
  return out.bytes;
}

/** The font bytes of `spec`. */
export function buildFont(spec: FontSpec): Uint8Array {
  const glyphs = spec.glyphs.map((glyph) => {
    if (glyph.kind === 'empty') return [] as number[];
    if (glyph.kind === 'raw') return [...glyph.bytes];
    return glyph.kind === 'simple' ? simpleGlyph(glyph.contours) : compositeGlyph(glyph.components);
  });
  const glyf: number[] = [];
  const offsets: number[] = [0];
  for (const data of glyphs) {
    glyf.push(...data);
    while (glyf.length % 4 !== 0) glyf.push(0);
    offsets.push(glyf.length);
  }
  const loca = new Writer();
  for (const offset of offsets) {
    if (spec.longLoca === true) loca.u32(offset);
    else loca.u16(offset / 2);
  }
  const head = new Writer();
  head
    .u32(0x00010000)
    .u32(0)
    .u32(0)
    .u32(0x5f0f3cf5)
    .u16(0)
    .u16(spec.unitsPerEm ?? 1000);
  while (head.bytes.length < 50) head.u8(0);
  head.i16(spec.longLoca === true ? 1 : 0).u16(0);
  const maxp = new Writer().u32(0x00005000).u16(spec.glyphs.length);
  const metrics = spec.metrics ?? spec.glyphs.length;
  const hhea = new Writer();
  hhea.u32(0x00010000).i16(900).i16(-250).i16(100);
  while (hhea.bytes.length < 34) hhea.u8(0);
  hhea.u16(metrics);
  const hmtx = new Writer();
  for (let k = 0; k < metrics; k++) hmtx.u16(spec.advances?.[k] ?? 500).i16(0);
  for (let k = metrics; k < spec.glyphs.length; k++) hmtx.i16(0);
  const tables: Array<[string, number[]]> = [
    ['head', head.bytes],
    ['maxp', maxp.bytes],
    ['hhea', hhea.bytes],
    ['hmtx', spec.hmtxLength === undefined ? hmtx.bytes : hmtx.bytes.slice(0, spec.hmtxLength)],
    ['cmap', cmapTable(spec)],
    ['loca', loca.bytes],
    ['glyf', glyf],
  ];
  if (spec.os2 !== null) {
    const os2 = new Writer().u16(spec.os2?.version ?? 2);
    while (os2.bytes.length < 8) os2.u8(0);
    os2.u16(spec.os2?.fsType ?? 0);
    while (os2.bytes.length < 88) os2.u8(0);
    os2.i16(spec.os2?.capHeight ?? 700);
    tables.push(['OS/2', spec.os2 !== undefined && spec.os2.version < 2 ? os2.bytes.slice(0, 78) : os2.bytes]);
  }
  if (spec.names !== undefined) tables.push(['name', nameTable(spec.names)]);
  if (spec.kern !== undefined) tables.push(['kern', kernTable(spec.kern)]);
  for (const [tag, data] of Object.entries(spec.tables ?? {})) tables.push([tag, [...data]]);
  const kept = tables.filter(([tag]) => spec.omit?.includes(tag) !== true);
  const out = new Writer()
    .u32(spec.otto === true ? 0x4f54544f : 0x00010000)
    .u16(kept.length)
    .u16(0)
    .u16(0)
    .u16(0);
  let offset = 12 + 16 * kept.length;
  for (const [tag, data] of kept) {
    out.tag(tag).u32(0).u32(offset).u32(data.length);
    offset += Math.ceil(data.length / 4) * 4;
  }
  for (const [, data] of kept) {
    for (const byte of data) out.bytes.push(byte);
    out.pad();
  }
  return new Uint8Array(out.bytes);
}

/** A square contour (clockwise, like a TrueType outer contour) of side `size` at (x, y). */
export const squareContour = (x: number, y: number, size: number): GlyphPointSpec[] => [
  { x, y, on: true },
  { x, y: y + size, on: true },
  { x: x + size, y: y + size, on: true },
  { x: x + size, y, on: true },
];

/** A contour with off-curve points (a lens): exercises implied on-curve midpoints. */
export const lensContour = (): GlyphPointSpec[] => [
  { x: 0, y: 0, on: true },
  { x: 100, y: 300, on: false },
  { x: 200, y: 300, on: false },
  { x: 300, y: 0, on: true },
  { x: 150, y: -200, on: false },
];
