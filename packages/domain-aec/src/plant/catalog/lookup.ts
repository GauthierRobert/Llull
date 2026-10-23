/**
 * Catalogue lookup (TR-PSC-02..04): one size row of a catalogue by component type and nominal size, with derived values computed (never stored)
 * and flagged `derived`. Pipe rows key on (standard, NPS, schedule): `"10"` (B36.10M) and `"10S"` (B36.19M) are distinct.
 * @invariant pure; the same (catalogue, query) always returns the same row
 */

import { sizePair } from './nominal';
import type { ComponentFamily, ComponentSize, ComponentType, Dim, EndType, Facing, NominalSize, PipingCatalog, Provenance } from './types';

/** Bolt hole = bolt diameter + 1/8 in (3.175 mm) for ASME B16.5 flanges (S4). */
const B165_HOLE_CLEARANCE_MM = 3.175;
const MM_PER_INCH = 25.4;

export interface LookupQuery {
  readonly type: ComponentType;
  readonly nps?: string | number | undefined;
  readonly dn?: string | number | undefined;
  readonly smallNps?: string | number | undefined;
  readonly smallDn?: string | number | undefined;
  readonly schedule?: string | undefined;
  readonly class?: number | undefined;
  readonly pn?: number | undefined;
  readonly facing?: Facing | undefined;
  readonly radius?: ComponentFamily['radius'] | undefined;
  readonly standard?: string | undefined;
  readonly ends?: EndType | undefined;
}

export interface ResolvedDim extends Dim {
  readonly derived?: boolean;
  readonly formula?: string;
}

export interface ResolvedRow {
  readonly catalogId: string;
  readonly catalogVersion: string;
  readonly familyId: string;
  readonly type: ComponentType;
  readonly standard: string;
  readonly dimensionalStandard: ComponentFamily['dimensionalStandard'];
  readonly radius?: ComponentFamily['radius'];
  readonly ends: readonly EndType[];
  readonly size: NominalSize;
  readonly smallSize?: NominalSize;
  readonly schedule?: string;
  readonly class?: number;
  readonly pn?: number;
  readonly facing?: Facing;
  readonly dims: Readonly<Record<string, ResolvedDim>>;
  /** Every dimension is grade A. */
  readonly verified: boolean;
  readonly unverifiedDims: readonly string[];
  readonly alternatives: readonly string[];
  readonly note?: string;
}

export type LookupOutcome =
  | { readonly ok: true; readonly row: ResolvedRow }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly ids: readonly string[] };

const fail = (code: string, message: string, ids: readonly string[] = []): LookupOutcome => ({ ok: false, code, message, ids });

const normalise = (text: string): string => text.toLowerCase().replace(/[\s_]+/g, '');

const sameSize = (row: NominalSize, pair: { readonly nps: NominalSize | null; readonly dn: NominalSize | null }): boolean =>
  row.system === 'NPS' ? pair.nps?.key === row.key : pair.dn?.value === row.value;

const sizeLabel = (size: ComponentSize): string =>
  [
    size.size.system === 'NPS' ? `NPS ${size.size.key}` : `DN ${size.size.key}`,
    size.smallSize === undefined ? '' : `x ${size.smallSize.key}`,
    size.schedule === undefined ? '' : `sch ${size.schedule}`,
    size.class === undefined ? '' : `class ${size.class}`,
    size.pn === undefined ? '' : `PN ${size.pn}`,
    size.facing ?? '',
  ]
    .filter((part) => part !== '')
    .join(' ');

function familyMatches(family: ComponentFamily, query: LookupQuery): boolean {
  if (family.type !== query.type) return false;
  if (query.standard !== undefined && !normalise(family.standard).includes(normalise(query.standard)) && family.id !== query.standard)
    return false;
  if (query.radius !== undefined && family.radius !== query.radius) return false;
  return query.ends === undefined || family.ends.length === 0 || family.ends.includes(query.ends);
}

function sizeMatches(
  size: ComponentSize,
  query: LookupQuery,
  main: ReturnType<typeof sizePair>,
  small: ReturnType<typeof sizePair>,
): boolean {
  if (main === null || !sameSize(size.size, main)) return false;
  if (small !== null && size.smallSize !== undefined && !sameSize(size.smallSize, small)) return false;
  if (query.schedule !== undefined && size.schedule !== query.schedule) return false;
  if (query.class !== undefined && size.class !== query.class) return false;
  if (query.pn !== undefined && size.pn !== query.pn) return false;
  return query.facing === undefined || size.facing === query.facing;
}

function derivedDims(family: ComponentFamily, size: ComponentSize): Record<string, ResolvedDim> {
  const derived: Record<string, ResolvedDim> = {};
  const outside = size.dims['outsideDiameter'];
  const wall = size.dims['wall'];
  if (family.type === 'pipe' && outside !== undefined && wall !== undefined)
    derived['insideDiameter'] = {
      value: Math.round((outside.value - 2 * wall.value) * 1e6) / 1e6,
      unit: 'mm',
      verified: outside.verified && wall.verified,
      provenance: outside.provenance,
      derived: true,
      formula: 'insideDiameter = outsideDiameter - 2 x wall',
    };
  const bolt = size.dims['boltDiameter'];
  if (/B16\.5/.test(family.standard) && bolt !== undefined && size.dims['boltHole'] === undefined)
    derived['boltHole'] = {
      value: Math.round((bolt.value + B165_HOLE_CLEARANCE_MM) * 1e6) / 1e6,
      unit: 'mm',
      verified: bolt.verified,
      provenance: { sourceId: 'S4', citation: 'ASME B16.5 bolt hole = bolt diameter + 1/8 in (Engineering ToolBox / Wermac extract)' },
      derived: true,
      formula: 'boltHole = boltDiameter + 3.175 mm (1/8 in)',
    };
  return derived;
}

function resolved(catalog: PipingCatalog, family: ComponentFamily, size: ComponentSize, extra: Partial<ResolvedRow>): ResolvedRow {
  const dims: Record<string, ResolvedDim> = { ...size.dims, ...derivedDims(family, size) };
  const unverifiedDims = Object.keys(dims)
    .filter((name) => dims[name]?.verified !== true)
    .sort();
  return {
    catalogId: catalog.id,
    catalogVersion: catalog.version,
    familyId: family.id,
    type: family.type,
    standard: family.standard,
    dimensionalStandard: family.dimensionalStandard,
    ...(family.radius === undefined ? {} : { radius: family.radius }),
    ends: family.ends,
    size: size.size,
    ...(size.smallSize === undefined ? {} : { smallSize: size.smallSize }),
    ...(size.schedule === undefined ? {} : { schedule: size.schedule }),
    ...(size.class === undefined ? {} : { class: size.class }),
    ...(size.pn === undefined ? {} : { pn: size.pn }),
    ...(size.facing === undefined ? {} : { facing: size.facing }),
    dims,
    verified: unverifiedDims.length === 0,
    unverifiedDims,
    alternatives: [],
    ...extra,
  };
}

/** B16.9 rule rows for a missing size: LR 90 A = 1.5 x NPS (NPS >= 3/4, grade A), SR 90 A = 1.0 x NPS (NPS >= 1, grade B). */
function ruleRow(
  catalog: PipingCatalog,
  families: readonly ComponentFamily[],
  query: LookupQuery,
  nps: NominalSize | null,
): ResolvedRow | null {
  const family = families.find((candidate) => candidate.type === 'elbow90' && /B16\.9/.test(candidate.standard));
  if (family === undefined || nps === null || family.radius === undefined || query.schedule !== undefined) return null;
  const factor = family.radius === 'LR' ? 1.5 : family.radius === 'SR' ? 1 : null;
  if (factor === null || nps.value < (family.radius === 'LR' ? 0.75 : 1)) return null;
  const verified = family.radius === 'LR';
  const provenance: Provenance = {
    sourceId: verified ? 'S8+S9+S10' : 'S9',
    citation: `ASME B16.9 ${family.radius} 90 centre-to-end rule (${factor} x NPS inch); ${verified ? 'three public tables agree' : 'one public extract'}`,
  };
  const dim: ResolvedDim = {
    value: Math.round(factor * nps.value * MM_PER_INCH * 1e6) / 1e6,
    unit: 'mm',
    verified,
    provenance,
    derived: true,
    formula: `centreToEnd = ${factor} x NPS x 25.4 mm`,
  };
  const size: ComponentSize = { size: nps, dims: { centreToEnd: dim } };
  return resolved(catalog, family, size, { note: `no tabulated row: centreToEnd derived from the ${family.radius} rule` });
}

/** The one row of `catalog` matching `query`, or the coded reason there is none. */
export function resolveCatalogRow(catalog: PipingCatalog, query: LookupQuery): LookupOutcome {
  const main = sizePair({ nps: query.nps, dn: query.dn });
  if (main === null)
    return fail('PSC_SIZE_UNKNOWN', 'nps or dn is missing or not a nominal size (NPS in eighths such as "2-1/2" or 2.5, or an integer DN)');
  const small = query.smallNps === undefined && query.smallDn === undefined ? null : sizePair({ nps: query.smallNps, dn: query.smallDn });
  if ((query.smallNps !== undefined || query.smallDn !== undefined) && small === null)
    return fail('PSC_SIZE_UNKNOWN', 'smallNps / smallDn is not a nominal size');
  const families = catalog.families.filter((family) => familyMatches(family, query));
  const label = `${query.type}${query.standard === undefined ? '' : ` ${query.standard}`}`;
  if (families.length === 0) return fail('PSC_CATALOG_ROW_MISSING', `catalogue ${catalog.id} has no ${label} family`);
  const hits = families
    .map((family) => ({ family, sizes: family.sizes.filter((size) => sizeMatches(size, query, main, small)) }))
    .filter((hit) => hit.sizes.length > 0);
  const first = hits[0];
  if (first === undefined) {
    const rule = ruleRow(catalog, families, query, main.nps);
    if (rule !== null) return { ok: true, row: rule };
    const atSize = families.flatMap((family) => family.sizes.filter((size) => sameSize(size.size, main)));
    if (query.schedule !== undefined && atSize.some((size) => size.schedule !== undefined))
      return fail(
        'PSC_SCHEDULE_UNKNOWN',
        `${label} has no schedule "${query.schedule}" at this size; schedules there: ${[...new Set(atSize.flatMap((size) => size.schedule ?? []))].join(', ')}`,
      );
    const listed = families.flatMap((family) => family.sizes.map((size) => `${size.size.key}`));
    return fail(
      'PSC_CATALOG_ROW_MISSING',
      `catalogue ${catalog.id} has no ${label} row for this size (sizes listed: ${[...new Set(listed)].slice(0, 20).join(', ')})`,
    );
  }
  if (first.sizes.length > 1)
    return fail(
      'PSC_AMBIGUOUS_COMPONENT',
      `${first.sizes.length} ${label} rows match (${first.sizes.slice(0, 12).map(sizeLabel).join('; ')}); add schedule, class, pn, facing or standard`,
      [first.family.id],
    );
  const alternatives = hits.slice(1).map((hit) => hit.family.id);
  const schedule = query.schedule;
  const note =
    schedule !== undefined && query.standard === undefined && first.family.type === 'pipe'
      ? `schedule "${schedule}" read in ${first.family.standard}${alternatives.length > 0 ? ` (also ${alternatives.join(', ')})` : ''}; stainless B36.19M schedules carry the S suffix ("10S")`
      : undefined;
  return {
    ok: true,
    row: resolved(catalog, first.family, first.sizes[0] as ComponentSize, { alternatives, ...(note === undefined ? {} : { note }) }),
  };
}

/** Inch fraction text of a length in mm that is a multiple of 1/32 in (`"5/8"`, `"1-1/4"`); null otherwise. */
export function inchFraction(mm: number): string | null {
  const inches = mm / MM_PER_INCH;
  for (const denominator of [1, 2, 4, 8, 16, 32]) {
    const parts = inches * denominator;
    if (Math.abs(parts - Math.round(parts)) > 1e-4) continue;
    const numerator = Math.round(parts);
    const whole = Math.floor(numerator / denominator);
    const rest = numerator - whole * denominator;
    if (rest === 0) return String(whole);
    return whole === 0 ? `${rest}/${denominator}` : `${whole}-${rest}/${denominator}`;
  }
  return null;
}
