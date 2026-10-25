/**
 * PCF reader (plant 05 ISO §5.1, §6.1): lexed lines to a `PcfLineData` in millimetres. Header units scale coordinates and bores (a missing unit is
 * refused, never assumed); `COMPONENT-IDENTIFIER` is dropped (the writer renumbers); `UNIQUE-COMPONENT-IDENTIFIER` is the component id; every
 * attribute and record the model does not know is kept (`extra`, `unknownRecords`) and written back verbatim. One pipeline per file.
 */

import type { Vec3 } from '@core/model/vectors';
import { isoIssue } from '../codes';
import {
  isPcfComponentType,
  type ComponentCategory,
  type IsoIssue,
  type NetworkComponent,
  type NetworkPoint,
  type PcfComponentType,
  type PcfLineData,
  type PcfMaterial,
  type PcfUnknownRecord,
  type WeldKind,
} from '../model';
import { lexPcf, type LexLine, type LexRefusal } from './pcfLexer';

export type PcfUnit = 'MM' | 'INCH';

export interface PcfRead {
  readonly file: PcfLineData;
  /** Units the file declared (the stored data is millimetres). */
  readonly sourceUnits: { readonly bore: PcfUnit; readonly coords: PcfUnit };
  readonly warnings: readonly IsoIssue[];
}

export type PcfReadResult = ({ readonly ok: true } & PcfRead) | LexRefusal;

const MM_PER_INCH = 25.4;
const LENGTH_UNIT_KEYS = ['UNITS-BORE', 'UNITS-CO-ORDS', 'UNITS-BOLT-DIA', 'UNITS-BOLT-LENGTH'] as const;
const WELD_KINDS: Readonly<Record<string, WeldKind>> = { WW: 'shop', WS: 'site', WF: 'field_fit' };
const CATEGORY_FLAGS: Readonly<Record<string, ComponentCategory>> = {
  'FABRICATION-ITEM': 'fabrication',
  'ERECTION-ITEM': 'erection',
  'OFFSHORE-ITEM': 'offshore',
};
/** Component types that always have two END-POINTs. */
const TWO_ENDS: ReadonlySet<PcfComponentType> = new Set(['PIPE', 'ELBOW', 'BEND', 'TEE', 'REDUCER-CONCENTRIC', 'REDUCER-ECCENTRIC']);

class PcfInvalid extends Error {
  constructor(
    readonly line: number,
    detail: string,
  ) {
    super(detail);
  }
}

class PcfMissingUnits extends Error {
  constructor(readonly key: string) {
    super(key);
  }
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function num(word: string | undefined, line: LexLine, what: string): number {
  if (word === undefined || !NUMBER.test(word)) throw new PcfInvalid(line.n, `${line.key} on line ${line.n}: ${what} must be a number`);
  return Number(word);
}

const words = (line: LexLine): string[] => (line.rest === '' ? [] : line.rest.split(/\s+/));

function unitOf(line: LexLine): PcfUnit {
  const word = line.rest.toUpperCase();
  if (word === 'MM') return 'MM';
  if (word === 'INCH' || word === 'INCHES') return 'INCH';
  throw new PcfInvalid(line.n, `${line.key} on line ${line.n}: unit must be MM or INCH`);
}

function point(line: LexLine, withBore: boolean, coordFactor: number, boreFactor: number): NetworkPoint {
  const parts = words(line);
  const count = withBore ? 4 : 3;
  if (parts.length < count || parts.length > (withBore ? 5 : 3))
    throw new PcfInvalid(line.n, `${line.key} on line ${line.n} must be: x y z${withBore ? ' bore [end type]' : ''}`);
  const xyz: Vec3 = [
    num(parts[0], line, 'x') * coordFactor,
    num(parts[1], line, 'y') * coordFactor,
    num(parts[2], line, 'z') * coordFactor,
  ];
  const endType = parts[4];
  return { xyz, boreMm: withBore ? num(parts[3], line, 'bore') * boreFactor : 0, ...(endType === undefined ? {} : { endType }) };
}

interface Scale {
  readonly coord: number;
  readonly bore: number;
}

interface Builder {
  id: string | undefined;
  ends: NetworkPoint[];
  centre: Vec3 | undefined;
  branch: NetworkPoint | undefined;
  coords: Vec3 | undefined;
  skey: string | undefined;
  itemCode: string | undefined;
  weightKg: number | undefined;
  category: ComponentCategory | undefined;
  extra: Record<string, string>;
}

function single<T>(slot: T | undefined, line: LexLine): void {
  if (slot !== undefined) throw new PcfInvalid(line.n, `${line.key} on line ${line.n} is given twice`);
}

function component(
  head: LexLine,
  body: readonly LexLine[],
  type: PcfComponentType,
  lineId: string,
  position: number,
  scale: Scale,
): NetworkComponent {
  const b: Builder = {
    id: undefined,
    ends: [],
    centre: undefined,
    branch: undefined,
    coords: undefined,
    skey: undefined,
    itemCode: undefined,
    weightKg: undefined,
    category: undefined,
    extra: {},
  };
  for (const line of body) {
    switch (line.key) {
      case 'COMPONENT-IDENTIFIER':
        break;
      case 'UNIQUE-COMPONENT-IDENTIFIER':
        single(b.id, line);
        b.id = line.rest;
        break;
      case 'END-POINT':
        if (b.ends.length === 2) throw new PcfInvalid(line.n, `${type} on line ${head.n} has more than two END-POINT records`);
        b.ends.push(point(line, true, scale.coord, scale.bore));
        break;
      case 'BRANCH1-POINT':
        single(b.branch, line);
        b.branch = point(line, true, scale.coord, scale.bore);
        break;
      case 'CENTRE-POINT':
        single(b.centre, line);
        b.centre = point(line, false, scale.coord, scale.bore).xyz;
        break;
      case 'CO-ORDS':
        single(b.coords, line);
        b.coords = point(line, false, scale.coord, scale.bore).xyz;
        break;
      case 'SKEY':
        single(b.skey, line);
        b.skey = line.rest;
        break;
      case 'ITEM-CODE':
        single(b.itemCode, line);
        b.itemCode = line.rest;
        break;
      case 'WEIGHT':
        single(b.weightKg, line);
        b.weightKg = num(line.rest, line, 'the weight');
        break;
      default: {
        const category = CATEGORY_FLAGS[line.key];
        if (category !== undefined && line.rest === '') {
          single(b.category, line);
          b.category = category;
        } else if (line.key in b.extra) throw new PcfInvalid(line.n, `${line.key} on line ${line.n} is given twice`);
        else b.extra[line.key] = line.rest;
      }
    }
  }
  if (TWO_ENDS.has(type) && b.ends.length !== 2) throw new PcfInvalid(head.n, `${type} on line ${head.n} needs two END-POINT records`);
  const weldKind = type === 'WELD' && b.skey !== undefined ? WELD_KINDS[b.skey] : undefined;
  return {
    id: b.id ?? `pcf:${lineId}:${position}`,
    type,
    ends: b.ends,
    ...(b.centre === undefined ? {} : { centre: b.centre }),
    ...(b.branch === undefined ? {} : { branch: b.branch }),
    ...(b.coords === undefined ? {} : { coords: b.coords }),
    ...(b.skey === undefined ? {} : { skey: b.skey }),
    ...(b.itemCode === undefined ? {} : { itemCode: b.itemCode }),
    ...(b.category === undefined ? {} : { category: b.category }),
    ...(weldKind === undefined ? {} : { weldKind }),
    ...(b.weightKg === undefined ? {} : { weightKg: b.weightKg }),
    ...(Object.keys(b.extra).length === 0 ? {} : { extra: b.extra }),
  };
}

interface RawRecord {
  readonly head: LexLine;
  readonly body: LexLine[];
}

/** Lines after the header grouped into records: a column-1 line and the indented lines that follow it. */
function records(lines: readonly LexLine[]): RawRecord[] {
  const out: RawRecord[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (!line.indented) out.push({ head: line, body: [] });
    else if (last === undefined) throw new PcfInvalid(line.n, `attribute ${line.key} on line ${line.n} is outside a record`);
    else last.body.push(line);
  }
  return out;
}

function fields(body: readonly LexLine[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body) {
    if (line.key in out) throw new PcfInvalid(line.n, `${line.key} on line ${line.n} is given twice`);
    out[line.key] = line.rest;
  }
  return out;
}

function parse(lines: readonly LexLine[]): PcfRead {
  const header: Record<string, string> = {};
  const units = new Map<string, PcfUnit>();
  let cursor = 0;
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor] as LexLine;
    if (line.indented) throw new PcfInvalid(line.n, `attribute ${line.key} on line ${line.n} is outside a record`);
    if (line.key === 'PIPELINE-REFERENCE') break;
    if (line.key === 'ISOGEN-FILES' || line.key.startsWith('UNITS-')) {
      if (line.key in header || units.has(line.key)) throw new PcfInvalid(line.n, `${line.key} on line ${line.n} is given twice`);
      if ((LENGTH_UNIT_KEYS as readonly string[]).includes(line.key)) units.set(line.key, unitOf(line));
      else header[line.key] = line.rest;
    } else throw new PcfInvalid(line.n, `${line.key} on line ${line.n} comes before PIPELINE-REFERENCE`);
  }
  const bore = units.get('UNITS-BORE');
  const coords = units.get('UNITS-CO-ORDS');
  if (bore === undefined || coords === undefined) throw new PcfMissingUnits(bore === undefined ? 'UNITS-BORE' : 'UNITS-CO-ORDS');
  const scale: Scale = { coord: coords === 'INCH' ? MM_PER_INCH : 1, bore: bore === 'INCH' ? MM_PER_INCH : 1 };
  const all = records(lines.slice(cursor));
  const first = all[0];
  if (first === undefined) throw new PcfInvalid(lines[lines.length - 1]?.n ?? 1, 'the file has no PIPELINE-REFERENCE');
  if (first.head.rest === '') throw new PcfInvalid(first.head.n, `PIPELINE-REFERENCE on line ${first.head.n} needs a line number`);
  const lineId = first.head.rest;
  const attributes = fields(first.body);
  const components: NetworkComponent[] = [];
  const materials: PcfMaterial[] = [];
  const unknownRecords: PcfUnknownRecord[] = [];
  const warnings: IsoIssue[] = [];
  const ids = new Set<string>();
  let inMaterials = false;
  for (const record of all.slice(1)) {
    const { head, body } = record;
    if (head.key === 'PIPELINE-REFERENCE')
      throw new PcfInvalid(head.n, `a second PIPELINE-REFERENCE on line ${head.n}: one pipeline per file`);
    if (head.key === 'MATERIALS') {
      if (body.length > 0 || head.rest !== '') throw new PcfInvalid(head.n, `MATERIALS on line ${head.n} takes no attributes`);
      inMaterials = true;
    } else if (head.key === 'ITEM-CODE' && inMaterials) {
      if (head.rest === '') throw new PcfInvalid(head.n, `ITEM-CODE on line ${head.n} needs a code`);
      if (materials.some((entry) => entry.itemCode === head.rest))
        throw new PcfInvalid(head.n, `ITEM-CODE ${head.rest} on line ${head.n} is listed twice`);
      materials.push({ itemCode: head.rest, fields: fields(body) });
    } else if (isPcfComponentType(head.key) && head.rest === '') {
      const made = component(head, body, head.key, lineId, components.length + 1, scale);
      if (ids.has(made.id)) throw new PcfInvalid(head.n, `component id ${made.id} on line ${head.n} is used twice`);
      ids.add(made.id);
      components.push(made);
    } else {
      unknownRecords.push({ type: head.key, line: head.n, after: components.length, text: [head.raw, ...body.map((line) => line.raw)] });
      warnings.push(
        isoIssue(
          'ISO_PCF_UNKNOWN_RECORD',
          'warning',
          `record ${head.key} on line ${head.n} is not read by llull; it is kept verbatim`,
          [],
          [`line ${head.n}`],
        ),
      );
    }
  }
  return { file: { lineId, header, attributes, components, materials, unknownRecords }, sourceUnits: { bore, coords }, warnings };
}

/**
 * The PCF text as a `PcfLineData` in mm.
 * @failure TAB / over 1024 characters / missing header / over the size caps / missing UNITS-BORE or UNITS-CO-ORDS / a point or record that cannot be read -> the coded refusal with its `line N` path
 */
export function readPcf(text: string): PcfReadResult {
  const lexed = lexPcf(text);
  if (!lexed.ok) return lexed;
  try {
    return { ok: true, ...parse(lexed.lines) };
  } catch (error) {
    if (error instanceof PcfInvalid)
      return { ok: false, code: 'ISO_PCF_RECORD_INVALID', message: error.message, paths: [`line ${error.line}`] };
    if (error instanceof PcfMissingUnits)
      return { ok: false, code: 'ISO_PCF_UNITS_MISSING', message: `${error.key} is missing from the header`, paths: [error.key] };
    throw error;
  }
}
