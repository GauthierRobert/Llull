/** Hand-built OP2 files (layout of `@cae/results/op2Reader`: pyNastran's table / marker structure, single precision). Not produced by Nastran. */

export interface Word {
  readonly int?: number;
  readonly float?: number;
  readonly text?: string;
}

const i = (value: number): Word => ({ int: value });
const f = (value: number): Word => ({ float: value });
const t = (value: string): Word => ({ text: value });

export const word = { i, f, t };

function wordsToBytes(words: readonly Word[], little: boolean): Uint8Array {
  const out = new Uint8Array(words.length * 4);
  const view = new DataView(out.buffer);
  words.forEach((entry, index) => {
    if (entry.float !== undefined) view.setFloat32(index * 4, entry.float, little);
    else if (entry.text !== undefined) for (let c = 0; c < 4; c++) out[index * 4 + c] = entry.text.charCodeAt(c) || 32;
    else view.setInt32(index * 4, entry.int ?? 0, little);
  });
  return out;
}

/** `[n][payload][n]`. */
function record(payload: Uint8Array, little: boolean): Uint8Array {
  const out = new Uint8Array(payload.length + 8);
  const view = new DataView(out.buffer);
  view.setInt32(0, payload.length, little);
  out.set(payload, 4);
  view.setInt32(4 + payload.length, payload.length, little);
  return out;
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export interface Op2Set {
  /** Words of the 146-word identification record are filled from these. */
  readonly approach: number;
  readonly tableCode: number;
  readonly elementType?: number;
  readonly subcase: number;
  readonly mode?: number;
  readonly eigenvalue?: number;
  readonly numWide: number;
  /** Data words, split into `chunks` logical records (default one). */
  readonly data: readonly Word[];
  readonly chunks?: number;
  /** Text written into the identification record (where Nastran puts the title / subtitle), from word 60. */
  readonly title?: string;
}

export class Op2Builder {
  private readonly parts: Uint8Array[] = [];

  constructor(
    private readonly little = true,
    producer: string | null = 'NX 12.0',
  ) {
    this.marker(3);
    this.words([t('NAST'), t('RAN '), t('FORT'), t(' TAP'), t('E ID'), t(' COD'), t('E - ')]);
    this.marker(1);
    if (producer !== null) this.words(wordsOf(producer));
  }

  private words(words: readonly Word[]): void {
    this.parts.push(record(wordsToBytes(words, this.little), this.little));
  }

  marker(value: number): void {
    this.words([i(value)]);
  }

  /** A logical record: its word count marker, then the data record. */
  logical(words: readonly Word[]): void {
    this.marker(words.length);
    this.words(words);
  }

  /** `[2] name [-1] [7 words] [-2 1 0] [2] name`, then each result set as the identification / data subtable pair, then `[0]`. */
  table(name: string, sets: readonly Op2Set[], raw?: (builder: Op2Builder) => void): void {
    this.marker(2);
    this.words([t(name.slice(0, 4).padEnd(4)), t(name.slice(4, 8).padEnd(4))]);
    this.marker(-1);
    this.logical([i(101), i(0), i(0), i(0), i(0), i(0), i(7)]);
    this.marker(-2);
    this.marker(1);
    this.marker(0);
    this.logical([t(name.slice(0, 4).padEnd(4)), t(name.slice(4, 8).padEnd(4))]);
    sets.forEach((set, index) => {
      const ident = Array.from({ length: 146 }, () => i(0));
      ident[0] = i(set.approach);
      ident[1] = i(set.tableCode);
      ident[2] = i(set.elementType ?? 0);
      ident[3] = i(set.subcase);
      ident[4] = i(set.mode ?? 0);
      ident[5] = f(set.eigenvalue ?? 0);
      ident[8] = i(1);
      ident[9] = i(set.numWide);
      wordsOf(set.title ?? '').forEach((entry, at) => void (ident[60 + at] = entry));
      this.marker(-3 - 2 * index);
      this.marker(1);
      this.marker(0);
      this.logical(ident);
      this.marker(-4 - 2 * index);
      this.marker(1);
      this.marker(0);
      const chunks = Math.max(1, set.chunks ?? 1);
      const size = Math.ceil(set.data.length / chunks / set.numWide) * set.numWide;
      for (let at = 0; at < set.data.length; at += size) this.logical(set.data.slice(at, at + size));
    });
    raw?.(this);
    this.marker(0);
  }

  /** The LAMA-style table: no identification subtable, rows in subtable 4. */
  eigenTable(name: string, rows: readonly (readonly Word[])[]): void {
    this.marker(2);
    this.words([t(name.padEnd(8).slice(0, 4)), t(name.padEnd(8).slice(4, 8))]);
    this.marker(-1);
    this.logical([i(101), i(0), i(0), i(0), i(0), i(0), i(7)]);
    this.marker(-2);
    this.marker(1);
    this.marker(0);
    this.logical([t(name.padEnd(8).slice(0, 4)), t(name.padEnd(8).slice(4, 8))]);
    this.marker(-3);
    this.marker(1);
    this.marker(0);
    this.logical(Array.from({ length: 146 }, () => i(0)));
    this.marker(-4);
    this.marker(1);
    this.marker(0);
    for (const row of rows) this.logical(row);
    this.marker(0);
  }

  build(): Uint8Array {
    return concat(this.parts);
  }
}

function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  for (let at = 0; at < text.length; at += 4) out.push(t(text.slice(at, at + 4).padEnd(4)));
  return out;
}

/** A displacement row: grid id x 10 + device code 1, grid type, six values. */
export const displacementRow = (grid: number, values: readonly number[]): Word[] => [i(grid * 10 + 1), i(1), ...values.map(f)];

/** A CTETRA stress element: header words, then the centroid (grid 0) and each corner with `stress` = [sxx, syy, szz, sxy, syz, szx]. */
export function tetStressElement(element: number, corners: readonly number[], stress: readonly number[], centroidOnly = false): Word[] {
  const [sxx = 0, syy = 0, szz = 0, sxy = 0, syz = 0, szx = 0] = stress;
  const node = (grid: number): Word[] => [
    i(grid),
    f(sxx),
    f(sxy),
    f(0),
    f(0),
    f(0),
    f(0),
    f(0),
    f(0),
    f(syy),
    f(syz),
    f(0),
    f(0),
    f(0),
    f(0),
    f(szz),
    f(szx),
    f(0),
    f(0),
    f(0),
    f(0),
  ];
  return [
    i(element * 10 + 1),
    i(0),
    t('CEN/'),
    i(4),
    ...node(0),
    ...corners.flatMap((corner) =>
      centroidOnly ? Array.from({ length: 21 }, () => i(0)).map((entry, index) => (index === 0 ? i(0) : entry)) : node(corner),
    ),
  ];
}
