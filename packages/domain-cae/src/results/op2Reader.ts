/**
 * Nastran OP2 reader (05 §5.7, M5): the Fortran-record container, the table walk and the tables a linear analysis needs: eigenvalues (`LAMA`),
 * displacements / eigenvectors (`OUG*`) and solid stresses (`OES*`, CTETRA). Pure: bytes in, tables out; no I/O.
 *
 * The layout is the one pyNastran documents and reads (single precision, 32-bit integers): every record is `[n][n bytes][n]`; a record of 4 bytes is a
 * MARKER. A table is `[2]` `name(8)` `[-1]`, then logical records `[words] [4*words bytes]` grouped by subtable markers `[-k]` (`-1`, `-2` header; odd `k >= 3` =
 * identification record of one result set; even `k >= 4` = its data), ended by marker `0`. Only hand-built fixtures back this reader here; it has NOT
 * been run against a real MSC / NX OP2. Double-precision files and element types other than CTETRA are reported in `warnings`, never guessed.
 */

import { boundHashes } from './inputBinding';

interface Op2Eigenvalue {
  readonly mode: number;
  readonly order: number;
  /** Eigenvalue: omega^2 (SOL 103) or the buckling load factor (SOL 105). */
  readonly eigenvalue: number;
  readonly radians: number;
  readonly cycles: number;
  readonly generalizedMass: number;
  readonly generalizedStiffness: number;
}

/** One result set of a table: a subcase (and a mode for eigen analyses). */
interface Op2SetHeader {
  readonly subcase: number;
  /** pyNastran `analysis_code`: 1 statics, 2 real eigenvalues, 7 pre-buckling, 8 post-buckling. */
  readonly analysisCode: number;
  /** Eigen sets: mode number and eigenvalue / factor from the identification record. */
  readonly mode?: number;
  readonly eigenvalue?: number;
}

export interface Op2Displacements extends Op2SetHeader {
  /** Grid id -> [t1, t2, t3, r1, r2, r3]. */
  readonly nodes: ReadonlyMap<number, readonly number[]>;
}

export interface Op2SolidStress extends Op2SetHeader {
  /** Element id -> its rows: `grid` 0 is the centroid; `stress` = [sxx, syy, szz, sxy, syz, szx]. */
  readonly elements: ReadonlyMap<number, readonly { readonly grid: number; readonly stress: readonly number[] }[]>;
}

export interface Op2Tables {
  /** Solver text of the file header (e.g. `NX 12.0`), or '' when none was found. */
  readonly producer: string;
  /** Distinct `llull inputHash` markers (16 hex) found in the identification records (the BDF `SUBTITLE`); empty when the file has none. */
  readonly inputHashes: readonly string[];
  readonly eigenvalues: readonly Op2Eigenvalue[];
  readonly displacements: readonly Op2Displacements[];
  readonly stresses: readonly Op2SolidStress[];
  readonly warnings: readonly string[];
}

export type Op2Result = Op2Tables | { readonly code: 'FEA_OP2_INVALID'; readonly message: string };

interface RecordSpan {
  readonly start: number;
  readonly length: number;
}

/** CTETRA stress: element type 39, 109 words per element (4 header + 5 x 21: centroid and the 4 corners). */
const CTETRA_TYPE = 39;
const CTETRA_WORDS = 109;
const STRESS_NODE_WORDS = 21;
/** The identification record of a result set has 146 words; the fields read here are in the first 11. */
const IDENT_MIN_BYTES = 44;
const EIGENVALUE_WORDS = 7;
const DISPLACEMENT_WORDS = 8;
/** Hostile-file guards: records read, bytes decoded as text (producer string, table names), identification-record bytes scanned for the input-hash marker. */
const MAX_RECORDS = 1_000_000;
const MAX_TEXT_BYTES = 128;
const MAX_IDENT_SCAN_BYTES = 4096;

function splitRecords(bytes: Uint8Array): { readonly records: RecordSpan[]; readonly view: DataView; readonly little: boolean } | string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) return 'the file is too short to be an OP2';
  const little = view.getInt32(0, true) === 4;
  if (!little && view.getInt32(0, false) !== 4) return 'the first record is not a 4-byte marker: not an OP2 file';
  const records: RecordSpan[] = [];
  let at = 0;
  while (at + 8 <= bytes.byteLength) {
    if (records.length >= MAX_RECORDS) return `the file has more than ${MAX_RECORDS} records`;
    const length = view.getInt32(at, little);
    if (length < 0 || at + 8 + length > bytes.byteLength)
      return `record ${records.length} is truncated (declared ${length} bytes at offset ${at})`;
    if (view.getInt32(at + 4 + length, little) !== length)
      return `record ${records.length} has different leading and trailing lengths at offset ${at}`;
    records.push({ start: at + 4, length });
    at += length + 8;
  }
  if (at !== bytes.byteLength) return `the file is truncated: ${bytes.byteLength - at} trailing byte(s) after record ${records.length - 1}`;
  return { records, view, little };
}

/** Printable text of a short record; '' for a span above MAX_TEXT_BYTES (a hostile record is never decoded). */
const ascii = (bytes: Uint8Array, span: RecordSpan): string =>
  span.length > MAX_TEXT_BYTES
    ? ''
    : String.fromCharCode(...bytes.subarray(span.start, span.start + span.length))
        .replace(/[^\x20-\x7e]/g, ' ')
        .trim();

/** Input-hash markers in the first bytes of an identification record (the title / subtitle fields; their exact offset is not relied on). */
const markersOf = (ident: Uint8Array): string[] =>
  boundHashes(String.fromCharCode(...ident.subarray(0, MAX_IDENT_SCAN_BYTES)).replace(/[^\x20-\x7e]/g, ' '));

/** Concatenation of the byte ranges of `spans`. */
function joined(bytes: Uint8Array, spans: readonly RecordSpan[]): Uint8Array {
  const out = new Uint8Array(spans.reduce((sum, span) => sum + span.length, 0));
  let at = 0;
  for (const span of spans) {
    out.set(bytes.subarray(span.start, span.start + span.length), at);
    at += span.length;
  }
  return out;
}

interface RawTable {
  readonly name: string;
  /** Subtable number -> the logical data records. */
  readonly subtables: Map<number, RecordSpan[]>;
}

/** The tables of the file, in order. A table that ends in a malformed marker is kept with what was read and a warning. */
function walkTables(bytes: Uint8Array, records: readonly RecordSpan[], view: DataView, little: boolean, warnings: string[]): RawTable[] {
  const marker = (index: number): number | null => {
    const span = records[index];
    return span !== undefined && span.length === 4 ? view.getInt32(span.start, little) : null;
  };
  const tables: RawTable[] = [];
  let at = 0;
  while (at < records.length) {
    const name = records[at + 1];
    if (marker(at) !== 2 || name === undefined || name.length !== 8 || marker(at + 2) !== -1) {
      at++;
      continue;
    }
    const table: RawTable = { name: ascii(bytes, name), subtables: new Map() };
    at += 3;
    let subtable = 1;
    for (;;) {
      const value = marker(at);
      if (value === null) {
        warnings.push(`table ${table.name}: record ${at} is not a marker; the rest of the table is skipped`);
        break;
      }
      at++;
      if (value === 0) break;
      if (value < 0) {
        subtable = -value;
        if (marker(at) === 1 && marker(at + 1) === 0) at += 2;
        continue;
      }
      const data = records[at];
      if (data === undefined || data.length !== 4 * value) {
        warnings.push(`table ${table.name}: a logical record announces ${value} words but the next record does not have them`);
        break;
      }
      const spans = table.subtables.get(subtable);
      if (spans === undefined) table.subtables.set(subtable, [data]);
      else spans.push(data);
      at++;
    }
    tables.push(table);
  }
  return tables;
}

/** The fields of the identification record (words as 32-bit integers / floats). */
function header(
  ident: Uint8Array,
  little: boolean,
): (Op2SetHeader & { readonly tableCode: number; readonly elementType: number; readonly numWide: number }) | null {
  if (ident.byteLength < IDENT_MIN_BYTES) return null;
  const view = new DataView(ident.buffer, ident.byteOffset, ident.byteLength);
  const analysisCode = Math.floor(view.getInt32(0, little) / 10);
  return {
    subcase: view.getInt32(12, little),
    analysisCode,
    tableCode: view.getInt32(4, little),
    elementType: view.getInt32(8, little),
    numWide: view.getInt32(36, little),
    ...(analysisCode === 2 || analysisCode === 8 ? { mode: view.getInt32(16, little), eigenvalue: view.getFloat32(20, little) } : {}),
  };
}

/** Pairs (identification, data) of a table: subtable `k` odd holds the identification, `k + 1` the data. */
function resultSets(bytes: Uint8Array, table: RawTable): { readonly ident: Uint8Array; readonly data: Uint8Array }[] {
  const out: { ident: Uint8Array; data: Uint8Array }[] = [];
  for (const k of [...table.subtables.keys()].filter((key) => key >= 3 && key % 2 === 1).sort((a, b) => a - b)) {
    const ident = table.subtables.get(k)?.[0];
    if (ident !== undefined) out.push({ ident: joined(bytes, [ident]), data: joined(bytes, table.subtables.get(k + 1) ?? []) });
  }
  return out;
}

function decodeDisplacements(
  set: { ident: Uint8Array; data: Uint8Array },
  little: boolean,
  name: string,
  warnings: string[],
): Op2Displacements | null {
  const head = header(set.ident, little);
  if (head === null) return null;
  if (head.numWide !== DISPLACEMENT_WORDS) {
    warnings.push(`table ${name}: ${head.numWide} words per row (double precision or another table layout) is not read`);
    return null;
  }
  const view = new DataView(set.data.buffer, set.data.byteOffset, set.data.byteLength);
  const nodes = new Map<number, readonly number[]>();
  for (let at = 0; at + 4 * DISPLACEMENT_WORDS <= set.data.byteLength; at += 4 * DISPLACEMENT_WORDS)
    nodes.set(
      Math.floor(view.getInt32(at, little) / 10),
      [2, 3, 4, 5, 6, 7].map((word) => view.getFloat32(at + 4 * word, little)),
    );
  return {
    subcase: head.subcase,
    analysisCode: head.analysisCode,
    ...(head.mode !== undefined ? { mode: head.mode } : {}),
    ...(head.eigenvalue !== undefined ? { eigenvalue: head.eigenvalue } : {}),
    nodes,
  };
}

function decodeStresses(
  set: { ident: Uint8Array; data: Uint8Array },
  little: boolean,
  name: string,
  warnings: string[],
): Op2SolidStress | null {
  const head = header(set.ident, little);
  if (head === null) return null;
  if (head.elementType !== CTETRA_TYPE || head.numWide !== CTETRA_WORDS) {
    warnings.push(
      `table ${name}: element type ${head.elementType} with ${head.numWide} words per element is not read (CTETRA, 109 words, single precision only)`,
    );
    return null;
  }
  const view = new DataView(set.data.buffer, set.data.byteOffset, set.data.byteLength);
  const elements = new Map<number, { grid: number; stress: readonly number[] }[]>();
  const rowBytes = 4 * CTETRA_WORDS;
  for (let at = 0; at + rowBytes <= set.data.byteLength; at += rowBytes) {
    const element = Math.floor(view.getInt32(at, little) / 10);
    const nodes = view.getInt32(at + 12, little);
    const rows: { grid: number; stress: readonly number[] }[] = [];
    for (let n = 0; n < Math.min(nodes + 1, 5); n++) {
      const base = at + 16 + n * 4 * STRESS_NODE_WORDS;
      const word = (index: number): number => view.getFloat32(base + 4 * index, little);
      rows.push({ grid: view.getInt32(base, little), stress: [word(1), word(9), word(15), word(2), word(10), word(16)] });
    }
    elements.set(element, rows);
  }
  return {
    subcase: head.subcase,
    analysisCode: head.analysisCode,
    ...(head.mode !== undefined ? { mode: head.mode } : {}),
    ...(head.eigenvalue !== undefined ? { eigenvalue: head.eigenvalue } : {}),
    elements,
  };
}

function decodeEigenvalues(table: RawTable, view: DataView, little: boolean, rows: Op2Eigenvalue[]): void {
  for (const [k, spans] of [...table.subtables].sort((a, b) => a[0] - b[0])) {
    if (k < 4 || k % 2 === 1) continue;
    for (const span of spans) {
      if (span.length % (4 * EIGENVALUE_WORDS) !== 0) continue;
      for (let at = span.start; at < span.start + span.length; at += 4 * EIGENVALUE_WORDS)
        rows.push({
          mode: view.getInt32(at, little),
          order: view.getInt32(at + 4, little),
          eigenvalue: view.getFloat32(at + 8, little),
          radians: view.getFloat32(at + 12, little),
          cycles: view.getFloat32(at + 16, little),
          generalizedMass: view.getFloat32(at + 20, little),
          generalizedStiffness: view.getFloat32(at + 24, little),
        });
    }
  }
}

/**
 * Tables of an OP2 file: eigenvalues (`LAMA`), displacements / eigenvectors (`OUG*`), CTETRA stresses (`OES*`). Other tables are skipped.
 * @invariant pure; never throws; unreadable parts are named in `warnings`
 * @failure not an OP2 (first record not a 4-byte marker, truncated or inconsistent record lengths) -> { code: 'FEA_OP2_INVALID', message }
 */
export function readOp2(bytes: Uint8Array): Op2Result {
  const split = splitRecords(bytes);
  if (typeof split === 'string') return { code: 'FEA_OP2_INVALID', message: split };
  const { records, view, little } = split;
  const warnings: string[] = [];
  const tables = walkTables(bytes, records, view, little, warnings);
  const eigenvalues: Op2Eigenvalue[] = [];
  const displacements: Op2Displacements[] = [];
  const stresses: Op2SolidStress[] = [];
  const markers = new Set<string>();
  for (const table of tables) {
    if (table.name.startsWith('LAMA') || table.name.startsWith('BLAMA')) decodeEigenvalues(table, view, little, eigenvalues);
    else if (table.name.startsWith('OUG'))
      for (const set of resultSets(bytes, table)) {
        for (const marker of markersOf(set.ident)) markers.add(marker);
        const decoded = decodeDisplacements(set, little, table.name, warnings);
        if (decoded !== null) displacements.push(decoded);
      }
    else if (table.name.startsWith('OES'))
      for (const set of resultSets(bytes, table)) {
        for (const marker of markersOf(set.ident)) markers.add(marker);
        const decoded = decodeStresses(set, little, table.name, warnings);
        if (decoded !== null) stresses.push(decoded);
      }
  }
  const producer = records
    .slice(0, 6)
    .map((span) => ascii(bytes, span))
    .find((text) => !/FORT TAPE/i.test(text) && /NX|MSC|NASTRAN|SIEMENS/i.test(text));
  return { producer: (producer ?? '').slice(0, 60), inputHashes: [...markers], eigenvalues, displacements, stresses, warnings };
}
