/** A tiny GPOS writer for the kerning tests (03 WRP M4): a `kern` feature over the pair adjustment lookups a test names (formats 1 and 2, extension lookups). */

/** A device table of a value record: a VariationIndex (delta row of the GDEF store) or a ppem device (deltaFormat 2, which a variable layout ignores). */
type GposDevice = { readonly outer: number; readonly inner: number } | { readonly ppem: true };

type GposPair = readonly [left: number, right: number, xAdvance: number, xAdvDevice?: GposDevice];

type GposSubtable =
  | { readonly format: 1; readonly pairs: readonly GposPair[]; readonly coverage?: 1 | 2; readonly valueFormat?: number }
  | {
      readonly format: 2;
      /** Glyph ranges [first, last, class] of the first glyph (class 0 = unlisted). */
      readonly firstClasses: ReadonlyArray<readonly [number, number, number]>;
      /** Glyph ranges of the second glyph, as ClassDef format 2 or 1 (`secondFormat1`). */
      readonly secondClasses: ReadonlyArray<readonly [number, number, number]>;
      readonly secondFormat1?: boolean;
      /** x advance by [class1][class2]. */
      readonly values: ReadonlyArray<readonly number[]>;
      /** ValueFormat of the first / second glyph's record (default 4 / 0); the fields a format names besides the x advance and its device are decoys the reader must skip. */
      readonly valueFormat1?: number;
      readonly valueFormat2?: number;
      /** XAdvDevice by [class1][class2] (needs bit 0x40 in valueFormat1). */
      readonly devices?: ReadonlyArray<ReadonlyArray<GposDevice | undefined>>;
      /** Coverage of the first glyphs. */
      readonly covered: readonly number[];
    };

export interface GposLookup {
  /** 2 = pair adjustment, 9 = extension wrapping pair adjustment, 1 = single adjustment (ignored by the reader). */
  readonly type: 1 | 2 | 9;
  readonly subtables: readonly GposSubtable[];
}

class Bytes {
  readonly data: number[] = [];

  u16(value: number): this {
    this.data.push((value >> 8) & 0xff, value & 0xff);
    return this;
  }

  i16(value: number): this {
    return this.u16(value < 0 ? value + 0x10000 : value);
  }

  u32(value: number): this {
    return this.u16(Math.floor(value / 0x10000)).u16(value % 0x10000);
  }

  tag(text: string): this {
    for (const c of text) this.data.push(c.charCodeAt(0));
    return this;
  }
}

const DEVICE_BLOCK = 8;
/** Decoy device deltas live at row 0 of the store: a reader that applied a placement / YAdvance device would move the kerning. */
const DECOY: GposDevice = { outer: 0, inner: 0 };

/** The device tables of one subtable, appended after its body: block 0 is the decoy, the others follow in the order they are added. */
class DevicePool {
  readonly blocks: GposDevice[] = [DECOY];
  readonly patches: Array<{ readonly at: number; readonly block: number }> = [];

  /** Writes the value record of `format` into `out` (record start = `base` + out.data.length) and registers the device offsets to patch. */
  record(out: Bytes, base: number, format: number, xAdvance: number, device: GposDevice | undefined): void {
    const field = (bit: number, write: () => void): void => {
      if ((format & bit) !== 0) write();
    };
    const offsetOf = (bit: number, real: GposDevice | undefined): void =>
      field(bit, () => {
        if (real === undefined && bit === 0x40) out.u16(0);
        else {
          this.blocks.push(real ?? DECOY);
          this.patches.push({ at: base + out.data.length, block: real === undefined ? 0 : this.blocks.length - 1 });
          out.u16(0);
        }
      });
    field(0x1, () => out.i16(17));
    field(0x2, () => out.i16(23));
    field(0x4, () => out.i16(xAdvance));
    field(0x8, () => out.i16(31));
    offsetOf(0x10, undefined);
    offsetOf(0x20, undefined);
    offsetOf(0x40, device);
    offsetOf(0x80, undefined);
  }

  /** The subtable bytes with the pool appended and every device offset patched (offsets count from the subtable start). */
  finish(body: number[]): number[] {
    const out = [...body];
    for (const patch of this.patches) {
      const target = body.length + DEVICE_BLOCK * patch.block;
      out[patch.at] = (target >> 8) & 0xff;
      out[patch.at + 1] = target & 0xff;
    }
    for (const device of this.blocks) {
      const block = new Bytes();
      if ('ppem' in device) block.u16(9).u16(12).u16(2).u16(0);
      else block.u16(device.outer).u16(device.inner).u16(0x8000).u16(0);
      out.push(...block.data);
    }
    return out;
  }
}

function coverage(glyphs: readonly number[], format: 1 | 2): number[] {
  const sorted = [...new Set(glyphs)].sort((a, b) => a - b);
  const out = new Bytes();
  if (format === 1) {
    out.u16(1).u16(sorted.length);
    for (const g of sorted) out.u16(g);
  } else {
    out.u16(2).u16(sorted.length);
    sorted.forEach((g, k) => out.u16(g).u16(g).u16(k));
  }
  return out.data;
}

function pairSubtable(table: Extract<GposSubtable, { format: 1 }>): number[] {
  const lefts = [...new Set(table.pairs.map(([left]) => left))].sort((a, b) => a - b);
  const format = table.valueFormat ?? 4;
  const pool = new DevicePool();
  const head = 10 + 2 * lefts.length;
  const sets: number[][] = [];
  let setAt = head;
  for (const left of lefts) {
    const own = table.pairs.filter(([l]) => l === left).sort((a, b) => a[1] - b[1]);
    const set = new Bytes().u16(own.length);
    for (const [, right, value, device] of own) {
      set.u16(right);
      pool.record(set, setAt, format, value, device);
    }
    sets.push(set.data);
    setAt += set.data.length;
  }
  const cover = coverage(lefts, table.coverage ?? 1);
  const out = new Bytes().u16(1).u16(setAt).u16(format).u16(0).u16(lefts.length);
  let offset = head;
  for (const set of sets) {
    out.u16(offset);
    offset += set.length;
  }
  return pool.finish([...out.data, ...sets.flat(), ...cover]);
}

function classDef(ranges: ReadonlyArray<readonly [number, number, number]>, format1: boolean): number[] {
  const out = new Bytes();
  if (format1) {
    const start = ranges[0]?.[0] ?? 0;
    const end = ranges[ranges.length - 1]?.[1] ?? 0;
    out
      .u16(1)
      .u16(start)
      .u16(end - start + 1);
    for (let g = start; g <= end; g++) out.u16(ranges.find(([a, b]) => g >= a && g <= b)?.[2] ?? 0);
  } else {
    out.u16(2).u16(ranges.length);
    for (const [a, b, c] of ranges) out.u16(a).u16(b).u16(c);
  }
  return out.data;
}

function classSubtable(table: Extract<GposSubtable, { format: 2 }>): number[] {
  const cover = coverage(table.covered, 1);
  const first = classDef(table.firstClasses, false);
  const second = classDef(table.secondClasses, table.secondFormat1 === true);
  const format1 = table.valueFormat1 ?? 4;
  const format2 = table.valueFormat2 ?? 0;
  const pool = new DevicePool();
  const records = new Bytes();
  const recordsAt = 16;
  table.values.forEach((row, c1) =>
    row.forEach((value, c2) => {
      pool.record(records, recordsAt, format1, value, table.devices?.[c1]?.[c2]);
      pool.record(records, recordsAt, format2, 0, undefined);
    }),
  );
  const head = 16 + records.data.length;
  const class1 = Math.max(...table.firstClasses.map(([, , c]) => c), 0) + 1;
  const class2 = Math.max(...table.secondClasses.map(([, , c]) => c), 0) + 1;
  const out = new Bytes()
    .u16(2)
    .u16(head)
    .u16(format1)
    .u16(format2)
    .u16(head + cover.length)
    .u16(head + cover.length + first.length)
    .u16(class1)
    .u16(class2);
  return pool.finish([...out.data, ...records.data, ...cover, ...first, ...second]);
}

const subtableBytes = (table: GposSubtable): number[] => (table.format === 1 ? pairSubtable(table) : classSubtable(table));

/** A GPOS table with one `kern` feature naming every lookup, in order (`feature` renames the tag to build a font without kerning). */
export function buildGpos(lookups: readonly GposLookup[], feature = 'kern'): number[] {
  const lookupTables = lookups.map((lookup) => {
    const subs = lookup.subtables.map(subtableBytes);
    if (lookup.type === 9) {
      // extension: header (6 + 2 * n) then each extension subtable (8 bytes) followed by its pair subtable
      const head = new Bytes().u16(9).u16(0).u16(subs.length);
      let offset = 6 + 2 * subs.length;
      const body: number[] = [];
      for (const sub of subs) {
        head.u16(offset);
        const ext = new Bytes().u16(1).u16(2).u32(8).data;
        body.push(...ext, ...sub);
        offset += ext.length + sub.length;
      }
      return [...head.data, ...body];
    }
    const head = new Bytes().u16(lookup.type).u16(0).u16(subs.length);
    let offset = 6 + 2 * subs.length;
    for (const sub of subs) {
      head.u16(offset);
      offset += sub.length;
    }
    return [...head.data, ...subs.flat()];
  });
  const list = new Bytes().u16(lookupTables.length);
  let offset = 2 + 2 * lookupTables.length;
  for (const table of lookupTables) {
    list.u16(offset);
    offset += table.length;
  }
  const lookupList = [...list.data, ...lookupTables.flat()];
  const featureTable = new Bytes().u16(0).u16(lookups.length);
  lookups.forEach((_, k) => featureTable.u16(k));
  const featureList = new Bytes().u16(1).tag(feature).u16(8).data.concat(featureTable.data);
  const scriptList = new Bytes().u16(0).data;
  const head = 10;
  return [
    ...new Bytes()
      .u16(1)
      .u16(0)
      .u16(head)
      .u16(head + scriptList.length)
      .u16(head + scriptList.length + featureList.length).data,
    ...scriptList,
    ...featureList,
    ...lookupList,
  ];
}

/** A `GDEF` version 1.3 whose item variation store is `store` (bytes of an ItemVariationStore); `minor` 2 writes an older header without the store offset. */
export function buildGdef(store: readonly number[], minor = 3): number[] {
  const head = new Bytes().u16(1).u16(minor).u16(0).u16(0).u16(0).u16(0);
  if (minor >= 2) head.u16(0);
  if (minor >= 3) head.u32(18);
  return [...head.data, ...(minor >= 3 ? store : [])];
}
