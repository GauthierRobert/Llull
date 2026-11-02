/**
 * Plant 3D spec sheet -> llull spec sheet (plant 01 PSC M5). The Spec Editor CSV schema is not published (sources P3, P9: only the file roles are), so
 * this is a documented best-effort mapping, not a claim of fidelity: headers are matched by name (case, spaces and punctuation ignored) through the
 * alias table below or the caller's `columns`; the part category goes through the type table or the caller's `typeMap`; a sheet row is one part at
 * one size (from = to). Every column that maps to nothing is kept verbatim in `extra`; a value that cannot be mapped (ends, facing, class, radius)
 * is kept in `extra` too and counted in `unmapped`, never guessed. An unknown part category refuses the row.
 * @invariant pure, never throws; ids are the sheet ids or `<type>-<size>[.n]`, deterministic
 */

import { canonicalJson } from '@lib/canonicalJson';
import { BEND_RADII, COMPONENT_TYPES, END_TYPES, FACINGS, type ComponentType } from '../catalog/types';
import { parseDn, parseNps } from '../catalog/nominal';
import { isHostileName, type Sheet, type SheetRow } from '../catalog/sheetRead';
import type { SheetProblem } from '../catalog/sheetImport';

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Our column -> squashed Plant 3D header names that map to it (first header found in file order wins). */
const COLUMN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  component: ['component', 'id', 'partid', 'itemid'],
  type: ['type', 'partcategory', 'partfamily', 'componenttype'],
  size: ['size', 'nominalsize', 'nominaldiameter'],
  ends: ['ends', 'endtype', 'port1endtype', 'connection'],
  class: ['class', 'pressureclass', 'rating', 'pressurerating'],
  facing: ['facing', 'facetype'],
  radius: ['radius', 'bendradius'],
  schedule: ['schedule', 'sch'],
  wallMm: ['wallmm'],
  catalogRef: ['catalogref', 'catalog'],
  commodityCode: ['commoditycode', 'itemcode', 'partnumber'],
  description: ['description', 'shortdescription'],
  material: ['material', 'materialcode'],
};

/** Squashed part-category names -> our type (our own type names are added). */
const TYPE_SYNONYMS: Readonly<Record<string, ComponentType>> = {
  tube: 'pipe',
  '90elbow': 'elbow90',
  elbow90deg: 'elbow90',
  '90degelbow': 'elbow90',
  elbow90lr: 'elbow90',
  '45elbow': 'elbow45',
  elbow45deg: 'elbow45',
  equaltee: 'tee',
  straighttee: 'tee',
  teereducing: 'reducingTee',
  concentricreducer: 'reducerConcentric',
  eccentricreducer: 'reducerEccentric',
  weldneckflange: 'flangeWeldNeck',
  wnflange: 'flangeWeldNeck',
  sliponflange: 'flangeSlipOn',
  blindflange: 'flangeBlind',
  socketweldflange: 'flangeSocketWeld',
  threadedflange: 'flangeThreaded',
  lapjointflange: 'flangeLapJoint',
  gatevalve: 'valveGate',
  globevalve: 'valveGlobe',
  checkvalve: 'valveCheck',
  ballvalve: 'valveBall',
  butterflyvalve: 'valveButterfly',
  plugvalve: 'valvePlug',
};
const TYPE_TABLE: ReadonlyMap<string, ComponentType> = new Map([
  ...COMPONENT_TYPES.map((type): [string, ComponentType] => [squash(type), type]),
  ...Object.entries(TYPE_SYNONYMS),
]);

const END_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['buttweld', 'BW'],
  ['buttwelded', 'BW'],
  ['socketweld', 'SW'],
  ['threaded', 'THD'],
  ['npt', 'THD'],
  ['screwed', 'THD'],
  ['flanged', 'FL'],
  ['plainend', 'PE'],
  ['bevelend', 'BE'],
  ['beveled', 'BE'],
]);

export interface Plant3dOptions {
  /** Size system of a bare number in the size column. */
  readonly sizeSystem: 'NPS' | 'DN';
  /** File part-category value (exact) -> our type. */
  readonly typeMap?: Readonly<Record<string, string>> | undefined;
  /** Catalogue reference of rows that have none. */
  readonly catalogRef?: string | undefined;
}

export interface Plant3dResult {
  readonly sheet: Sheet;
  /** Values kept in `extra` because they match no allowed value: `{ column, value, count }`. */
  readonly unmapped: readonly { readonly column: string; readonly count: number }[];
}

/** `"6\""`, `"2 1/2"`, `"NPS 6"`, `"DN100"` or a bare number -> `"NPS 6"` / `"DN 100"`, or null. */
function sizeText(cell: string, system: 'NPS' | 'DN'): string | null {
  const text = cell
    .trim()
    .replace(/"$/, '')
    .replace(/\s*(in|inch)$/i, '')
    .trim();
  const match = /^(NPS|DN)?\s*(.+)$/i.exec(text);
  if (match === null) return null;
  const chosen = match[1] === undefined ? system : (match[1].toUpperCase() as 'NPS' | 'DN');
  const key = (match[2] as string).trim().replace(/\s+/, '-');
  const size = chosen === 'NPS' ? parseNps(key) : parseDn(key);
  return size === null ? null : `${size.system} ${size.key}`;
}

const mapEnd = (cell: string): string | null => {
  const code = cell.trim().toUpperCase();
  if ((END_TYPES as readonly string[]).includes(code)) return code;
  return END_SYNONYMS.get(squash(cell)) ?? null;
};
const mapFacing = (cell: string): string | null =>
  (FACINGS as readonly string[]).includes(cell.trim().toUpperCase()) ? cell.trim().toUpperCase() : null;
const mapRadius = (cell: string): string | null =>
  (BEND_RADII as readonly string[]).includes(cell.trim().toUpperCase()) ? cell.trim().toUpperCase() : null;
const mapClass = (cell: string): string | null => (/^(class\s*)?#?\d+\s*#?$/i.exec(cell.trim()) === null ? null : cell.replace(/\D/g, ''));

/** Converts a Plant 3D sheet into a llull spec sheet, or says which row cannot be converted. */
export function plant3dToSheet(
  sheet: Sheet,
  options: Plant3dOptions,
  columns: Readonly<Record<string, string>> | undefined,
): { readonly result: Plant3dResult } | { readonly problems: readonly SheetProblem[] } {
  const problems: SheetProblem[] = [];
  const chosen = new Map<string, string>();
  const claimed = new Set<string>();
  const explicit = new Map(Object.entries(columns ?? {}));
  for (const [ours, theirs] of explicit) {
    if (!sheet.headers.includes(theirs)) problems.push({ row: 1, message: `columns.${ours}: the file has no column "${theirs}"` });
    else {
      chosen.set(ours, theirs);
      claimed.add(theirs);
    }
  }
  for (const [ours, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (chosen.has(ours)) continue;
    const found = sheet.headers.find((header) => !claimed.has(header) && aliases.includes(squash(header)));
    if (found !== undefined) {
      chosen.set(ours, found);
      claimed.add(found);
    }
  }
  for (const needed of ['type', 'size'])
    if (!chosen.has(needed))
      problems.push({
        row: 1,
        message: `no ${needed} column found (columns: ${sheet.headers.join(', ')}); map it with columns: { "${needed}": "<your header>" }`,
      });
  if (options.catalogRef === undefined && !chosen.has('catalogRef'))
    problems.push({ row: 1, message: 'no catalogRef column and no catalogRef param: say which catalogue family the rows come from' });
  if (problems.length > 0) return { problems };
  const typeMap = new Map(Object.entries(options.typeMap ?? {}));
  const unmapped = new Map<string, number>();
  const taken = new Set<string>();
  const outHeaders = [
    'component',
    'type',
    'from',
    'to',
    'ends',
    'class',
    'facing',
    'radius',
    'schedule',
    'wallMm',
    'catalogRef',
    'commodityCode',
    'description',
    'material',
    'extra',
  ];
  const rows: SheetRow[] = [];
  const get = (row: SheetRow, ours: string): string => {
    const header = chosen.get(ours);
    return header === undefined ? '' : (row.cells.get(header) ?? '');
  };
  for (const row of sheet.rows) {
    const typeCell = get(row, 'type').trim();
    const typeName = typeMap.get(typeCell) ?? TYPE_TABLE.get(squash(typeCell));
    if (typeName === undefined || !(COMPONENT_TYPES as readonly string[]).includes(typeName)) {
      problems.push({
        row: row.line,
        column: chosen.get('type') ?? 'type',
        message: `part category "${typeCell}" is not a component type (map it with typeMap)`,
      });
      continue;
    }
    const size = sizeText(get(row, 'size'), options.sizeSystem);
    if (size === null) {
      problems.push({
        row: row.line,
        column: chosen.get('size') ?? 'size',
        message: `size "${get(row, 'size')}" is not an ${options.sizeSystem === 'NPS' ? 'NPS' : 'DN'} size`,
      });
      continue;
    }
    const extra = new Map<string, string>();
    const keep = (header: string, value: string): void => {
      if (value !== '') extra.set(header, value);
    };
    const mapped = (ours: string, convert: (cell: string) => string | null): string => {
      const cell = get(row, ours);
      if (cell.trim() === '') return '';
      const value = convert(cell);
      if (value === null) {
        keep(chosen.get(ours) as string, cell);
        unmapped.set(ours, (unmapped.get(ours) ?? 0) + 1);
        return '';
      }
      return value;
    };
    for (const header of sheet.headers) if (!claimed.has(header)) keep(header, row.cells.get(header) ?? '');
    const hostile = [...extra.keys()].find(isHostileName);
    if (hostile !== undefined) {
      problems.push({ row: row.line, column: hostile, message: `the column name "${hostile}" is not allowed` });
      continue;
    }
    const base =
      get(row, 'component').trim() === '' ? `${typeName}-${size.split(' ')[1]?.replace(/[^A-Za-z0-9.-]/g, '_')}` : get(row, 'component');
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}.${n}`;
    taken.add(id);
    const cells: Record<string, string> = {
      component: id,
      type: typeName,
      from: size,
      to: size,
      ends: mapped('ends', mapEnd),
      class: mapped('class', mapClass),
      facing: mapped('facing', mapFacing),
      radius: mapped('radius', mapRadius),
      schedule: get(row, 'schedule'),
      wallMm: get(row, 'wallMm'),
      catalogRef: get(row, 'catalogRef') === '' ? (options.catalogRef ?? '') : get(row, 'catalogRef'),
      commodityCode: get(row, 'commodityCode'),
      description: get(row, 'description'),
      material: get(row, 'material'),
      extra: extra.size === 0 ? '' : canonicalJson(Object.fromEntries(extra)),
    };
    rows.push({ line: row.line, cells: new Map(outHeaders.map((header) => [header, cells[header] ?? ''])) });
  }
  if (problems.length > 0) return { problems };
  return { result: { sheet: { headers: outHeaders, rows }, unmapped: [...unmapped].map(([column, count]) => ({ column, count })) } };
}
