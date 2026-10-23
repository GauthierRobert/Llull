/**
 * Spec resolution (TR-PSC-06, §5.5): the one component a spec allows for a type and nominal size, its catalogue row, schedule and wall, and the
 * branch fitting of a header x branch pair. Pure functions over a `PipeSpec` and the catalogues it searches (`specCatalogs`); the commands
 * `resolve_spec_component` / `resolve_branch` and the 02 RTE `SpecLookup` adapter call these directly.
 * @invariant the same (spec revision, catalogues, query) always gives the same outcome; misses are coded failures, never throws
 */

import { en10220OutsideDiameter, sizePair } from '../catalog/nominal';
import { resolveCatalogRow, type LookupQuery, type ResolvedDim, type ResolvedRow } from '../catalog/lookup';
import type {
  BendRadius,
  ComponentFamily,
  ComponentType,
  DimensionalStandard,
  EndType,
  Facing,
  NominalSize,
  PipingCatalog,
} from '../catalog/types';
import { inRange, keyIn, querySize, sizeLabel } from './size';
import { DEFAULT_PRIORITY, type BranchFitting, type PipeSpec, type SpecComponent } from './types';

/** A component query: type and size (NPS or DN), optional branch size (reducing tee, olet, reducer small end) and filters. */
export interface ComponentQuery {
  readonly type: ComponentType;
  readonly nps?: string | number | undefined;
  readonly dn?: string | number | undefined;
  readonly branchNps?: string | number | undefined;
  readonly branchDn?: string | number | undefined;
  readonly ends?: EndType | undefined;
  readonly facing?: Facing | undefined;
  readonly radius?: BendRadius | undefined;
  readonly class?: number | undefined;
  readonly pn?: number | undefined;
}

/** The spec's pipe at the size, when a fitting takes its schedule from it. */
export interface PipeBasis {
  readonly componentId: string;
  readonly schedule?: string;
  readonly wallMm?: number;
  readonly outsideDiameterMm?: number;
  readonly verified: boolean;
}

export interface ResolvedComponent {
  readonly component: SpecComponent;
  readonly size: NominalSize;
  readonly branchSize?: NominalSize;
  readonly schedule?: string;
  readonly wallMm?: number;
  readonly outsideDiameterMm?: number;
  /** The catalogue row, or null when no catalogue of the spec has a family for `catalogRef` (import-only standard) or the row is synthetic. */
  readonly row: ResolvedRow | null;
  readonly dims: Readonly<Record<string, ResolvedDim>>;
  readonly dimensionalStandard?: DimensionalStandard;
  readonly pipe?: PipeBasis;
  /** All dimensions are grade A, including the pipe wall of a `scheduleFromPipe` fitting; false when there is no row. */
  readonly verified: boolean;
  readonly unverifiedDims: readonly string[];
  /** Why there is no catalogue row (the answer is then unverified). */
  readonly unresolved?: string;
}

export interface ResolveFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}

export type ResolveOutcome = { readonly ok: true; readonly resolved: ResolvedComponent } | ResolveFailure;

const failure = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): ResolveFailure => ({
  ok: false,
  code,
  message,
  ids,
  paths,
});

const alnum = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const sizeQuery = (size: NominalSize): { nps?: string; dn?: string } => (size.system === 'NPS' ? { nps: size.key } : { dn: size.key });
const priorityOf = (component: SpecComponent): number => component.priority ?? DEFAULT_PRIORITY;
const range = (spec: PipeSpec): string => `${sizeLabel(spec.sizeRange.from)} to ${sizeLabel(spec.sizeRange.to)}`;

const sameAlias = (id: string, reference: string): boolean => {
  const family = id.toLowerCase();
  const alias = reference.toLowerCase();
  return family === alias || family.startsWith(`${alias}-`);
};

/** Families of `catalog` that a spec's `catalogRef` names for `type`: the family id equals the alias or starts with it followed by `-`, or the standard equals it. */
function referencedFamilies(catalog: PipingCatalog, component: SpecComponent): ComponentFamily[] {
  const key = alnum(component.catalogRef);
  return catalog.families.filter(
    (family) => family.type === component.type && (sameAlias(family.id, component.catalogRef) || alnum(family.standard) === key),
  );
}

const keyed = (families: readonly ComponentFamily[], field: 'class' | 'pn' | 'facing'): boolean =>
  families.some((family) => family.sizes.some((size) => size[field] !== undefined));

type RowSearch = { readonly kind: 'row'; readonly row: ResolvedRow } | { readonly kind: 'none' } | ResolveFailure;

/** First catalogue (in the spec's order) whose family named by `catalogRef` has the row. */
function searchRow(
  catalogs: readonly PipingCatalog[],
  component: SpecComponent,
  size: NominalSize,
  branch: NominalSize | undefined,
  query: ComponentQuery,
): RowSearch {
  let firstFailure: ResolveFailure | undefined;
  let found = false;
  for (const catalog of catalogs) {
    const families = referencedFamilies(catalog, component);
    if (families.length === 0) continue;
    found = true;
    const lookup: LookupQuery = {
      type: component.type,
      ...sizeQuery(size),
      ...(branch === undefined
        ? {}
        : { smallNps: branch.system === 'NPS' ? branch.key : undefined, smallDn: branch.system === 'DN' ? branch.key : undefined }),
      schedule: component.type === 'pipe' ? component.schedule : undefined,
      class: keyed(families, 'class') ? (component.class ?? query.class) : undefined,
      pn: keyed(families, 'pn') ? (component.pn ?? query.pn) : undefined,
      facing: keyed(families, 'facing') ? (component.facing ?? query.facing) : undefined,
      radius: component.radius ?? query.radius,
    };
    const outcome = resolveCatalogRow({ ...catalog, families }, lookup);
    if (outcome.ok) return { kind: 'row', row: outcome.row };
    firstFailure ??= failure(outcome.code, outcome.message, [component.id, ...outcome.ids], ['catalogRef']);
  }
  return found ? (firstFailure as ResolveFailure) : { kind: 'none' };
}

const EN_REFERENCE = /\b(en|din)[\s-]?\d|10220/i;

/** EN 10220 pipe with no catalogue family: OD from the series (grade A to DN125), wall from the spec component (not verified). */
function syntheticEnPipe(component: SpecComponent, size: NominalSize): Record<string, ResolvedDim> | null {
  if (component.type !== 'pipe' || !EN_REFERENCE.test(`${component.catalogRef} ${component.standard ?? ''}`)) return null;
  const dn = size.system === 'DN' ? size : (sizePair({ nps: size.key })?.dn ?? null);
  const od = dn === null ? null : en10220OutsideDiameter(dn);
  if (dn === null || od === null) return null;
  const provenance = {
    sourceId: 'S25+S26',
    citation: 'EN 10220 outside diameter series (validation pack component_references.json en10220Diameters)',
  };
  return {
    outsideDiameter: { value: od, unit: 'mm', verified: dn.value <= 125, provenance },
    ...(component.wallMm === undefined
      ? {}
      : {
          wall: { value: component.wallMm, unit: 'mm', verified: false, provenance: { citation: `spec component ${component.id} wallMm` } },
        }),
  };
}

function pipeBasis(resolved: ResolvedComponent): PipeBasis {
  const od = resolved.dims['outsideDiameter']?.value;
  return {
    componentId: resolved.component.id,
    ...(resolved.schedule === undefined ? {} : { schedule: resolved.schedule }),
    ...(resolved.wallMm === undefined ? {} : { wallMm: resolved.wallMm }),
    ...(od === undefined ? {} : { outsideDiameterMm: od }),
    verified: resolved.verified,
  };
}

/** Resolves `component` at `size` (and `branch`): schedule from the pipe when asked, then the catalogue row; the row-level step of `resolveComponent`. */
export function resolveChosen(
  spec: PipeSpec,
  catalogs: readonly PipingCatalog[],
  component: SpecComponent,
  size: NominalSize,
  branch: NominalSize | undefined,
  query: ComponentQuery,
): ResolveOutcome {
  let schedule = component.schedule;
  let pipe: PipeBasis | undefined;
  if (component.type !== 'pipe' && component.scheduleFromPipe === true) {
    const piped = resolveComponent(spec, catalogs, { type: 'pipe', ...sizeQuery(size) });
    if (!piped.ok) return piped;
    pipe = pipeBasis(piped.resolved);
    schedule = pipe.schedule;
  }
  const search = searchRow(catalogs, component, size, branch, query);
  if ('ok' in search) return search;
  const synthetic = search.kind === 'none' ? syntheticEnPipe(component, size) : null;
  const dims: Record<string, ResolvedDim> = search.kind === 'row' ? { ...search.row.dims } : (synthetic ?? {});
  const row = search.kind === 'row' ? search.row : null;
  const unverified = [
    ...Object.keys(dims).filter((name) => dims[name]?.verified !== true),
    ...(pipe !== undefined && !pipe.verified ? ['pipe.wall'] : []),
  ];
  if (synthetic !== null && dims['wall'] === undefined) unverified.push('wall');
  unverified.sort();
  const unresolved =
    search.kind === 'none' && synthetic === null
      ? `no catalogue of the spec has a ${component.type} family for catalogRef "${component.catalogRef}" (import-only standard): dimensions unknown`
      : undefined;
  const wallMm = component.type === 'pipe' ? (dims['wall']?.value ?? component.wallMm) : (pipe?.wallMm ?? component.wallMm);
  const outside = dims['outsideDiameter']?.value ?? pipe?.outsideDiameterMm;
  return {
    ok: true,
    resolved: {
      component,
      size,
      ...(branch === undefined ? {} : { branchSize: branch }),
      ...((row?.schedule ?? schedule) === undefined ? {} : { schedule: (row?.schedule ?? schedule) as string }),
      ...(wallMm === undefined ? {} : { wallMm }),
      ...(outside === undefined ? {} : { outsideDiameterMm: outside }),
      row,
      dims,
      ...(row !== null
        ? { dimensionalStandard: row.dimensionalStandard }
        : synthetic === null
          ? {}
          : { dimensionalStandard: 'EN' as const }),
      ...(pipe === undefined ? {} : { pipe }),
      verified: row !== null || synthetic !== null ? unverified.length === 0 : false,
      unverifiedDims: unverified,
      ...(unresolved === undefined ? {} : { unresolved }),
    },
  };
}

const filterMatches = <T>(wanted: T | undefined, actual: T | undefined): boolean =>
  wanted === undefined || actual === undefined || wanted === actual;

/**
 * The one component of `spec` for `query`, with its row. Order: size in the spec range -> components of the type covering the size (and the branch)
 * and the filters -> lowest priority -> one left, else ambiguous -> schedule (own, or the pipe's) -> catalogue row.
 */
export function resolveComponent(spec: PipeSpec, catalogs: readonly PipingCatalog[], query: ComponentQuery): ResolveOutcome {
  const size = querySize(query);
  if (size === null)
    return failure(
      'PSC_SIZE_UNKNOWN',
      'nps or dn is missing or not a nominal size (NPS in eighths such as "2-1/2" or 2.5, or an integer DN)',
      [],
      ['nps'],
    );
  const branchGiven = query.branchNps !== undefined || query.branchDn !== undefined;
  const branch = branchGiven ? querySize({ nps: query.branchNps, dn: query.branchDn }) : undefined;
  if (branch === null) return failure('PSC_SIZE_UNKNOWN', 'branchNps / branchDn is not a nominal size', [], ['branchNps']);
  if (!inRange(size, spec.sizeRange.from, spec.sizeRange.to))
    return failure(
      'PSC_SIZE_OUT_OF_RANGE',
      `${sizeLabel(size)} is outside the size range of spec ${spec.id}: ${range(spec)}`,
      [spec.id],
      ['nps'],
    );
  const covering = spec.components.filter((component) => inRange(size, component.from, component.to));
  const matching = covering.filter(
    (component) =>
      component.type === query.type &&
      (component.branchFrom === undefined ||
        component.branchTo === undefined ||
        (branch !== undefined && inRange(branch, component.branchFrom, component.branchTo))) &&
      filterMatches(query.ends, component.ends) &&
      filterMatches(query.facing, component.facing) &&
      filterMatches(query.radius, component.radius) &&
      filterMatches(query.class, component.class) &&
      filterMatches(query.pn, component.pn),
  );
  if (matching.length === 0) {
    const types = [...new Set(covering.map((component) => component.type))];
    const needsBranch = covering.some((component) => component.type === query.type && component.branchFrom !== undefined);
    return failure(
      'PSC_NO_COMPONENT',
      `spec ${spec.id} has no ${query.type} component for ${sizeLabel(size)}${branch === undefined ? '' : ` x ${sizeLabel(branch)}`} with these filters (types defined at this size: ${types.join(', ') || 'none'})${needsBranch && branch === undefined ? '; give branchNps / branchDn' : ''}`,
      covering.filter((component) => component.type === query.type).map((component) => component.id),
      ['type'],
    );
  }
  const best = Math.min(...matching.map(priorityOf));
  const winners = matching.filter((component) => priorityOf(component) === best);
  const first = winners[0] as SpecComponent;
  if (winners.length > 1)
    return failure(
      'PSC_AMBIGUOUS_COMPONENT',
      `${winners.length} ${query.type} components of spec ${spec.id} match ${sizeLabel(size)} at priority ${best}: ${winners.map((component) => component.id).join(', ')}`,
      winners.map((component) => component.id),
      ['type'],
    );
  return resolveChosen(spec, catalogs, first, size, branch ?? undefined, query);
}

/** Branch-table fitting kind -> the component type that makes it (`null`: stub-in, no fitting). */
const FITTING_TYPE: Readonly<Record<BranchFitting, ComponentType | null>> = {
  T: 'tee',
  RT: 'reducingTee',
  W: 'weldolet',
  S: 'sockolet',
  TH: 'threadolet',
  SI: null,
  SIR: null,
};

export const FITTING_NAMES: Readonly<Record<BranchFitting, string>> = {
  T: 'equal tee',
  RT: 'reducing tee',
  W: 'weldolet',
  S: 'sockolet',
  TH: 'threadolet',
  SI: 'stub-in',
  SIR: 'reinforced stub-in',
};

export interface BranchQuery {
  readonly headerNps?: string | number | undefined;
  readonly headerDn?: string | number | undefined;
  readonly branchNps?: string | number | undefined;
  readonly branchDn?: string | number | undefined;
}

export interface ResolvedBranch {
  readonly fitting: BranchFitting;
  readonly fittingName: string;
  readonly header: NominalSize;
  readonly branch: NominalSize;
  /** The fitting component; null for a stub-in (no fitting: the reinforcement check is 07 PST). */
  readonly component: ResolvedComponent | null;
}

export type BranchOutcome = { readonly ok: true; readonly resolved: ResolvedBranch } | ResolveFailure;

/** The fitting the branch table gives for `header` x `branch` and the component that makes it. */
export function resolveBranch(spec: PipeSpec, catalogs: readonly PipingCatalog[], query: BranchQuery): BranchOutcome {
  const header = querySize({ nps: query.headerNps, dn: query.headerDn });
  const branch = querySize({ nps: query.branchNps, dn: query.branchDn });
  if (header === null || branch === null)
    return failure(
      'PSC_SIZE_UNKNOWN',
      'headerNps / headerDn and branchNps / branchDn must be nominal sizes',
      [],
      ['headerNps', 'branchNps'],
    );
  for (const [size, path] of [
    [header, 'headerNps'],
    [branch, 'branchNps'],
  ] as const)
    if (!inRange(size, spec.sizeRange.from, spec.sizeRange.to))
      return failure(
        'PSC_SIZE_OUT_OF_RANGE',
        `${sizeLabel(size)} is outside the size range of spec ${spec.id}: ${range(spec)}`,
        [spec.id],
        [path],
      );
  const table = spec.branchTable;
  if (table === undefined) return failure('PSC_BRANCH_UNDEFINED', `spec ${spec.id} has no branch table`, [spec.id], ['branchTable']);
  const headerKey = keyIn(header, table.system);
  const branchKey = keyIn(branch, table.system);
  const fitting = headerKey === null || branchKey === null ? undefined : table.cells[headerKey]?.[branchKey];
  if (fitting === undefined) {
    const defined = headerKey === null ? [] : Object.keys(table.cells[headerKey] ?? {});
    return failure(
      'PSC_BRANCH_UNDEFINED',
      `spec ${spec.id} has no branch-table cell for header ${sizeLabel(header)} x branch ${sizeLabel(branch)} (branches defined for this header: ${defined.join(', ') || 'none'}; a branch larger than its header is never defined)`,
      [spec.id],
      ['branchTable'],
    );
  }
  const type = FITTING_TYPE[fitting];
  const base = { fitting, fittingName: FITTING_NAMES[fitting], header, branch };
  if (type === null) return { ok: true, resolved: { ...base, component: null } };
  const outcome = resolveComponent(spec, catalogs, {
    type,
    ...sizeQuery(header),
    ...(type === 'tee'
      ? {}
      : { branchNps: branch.system === 'NPS' ? branch.key : undefined, branchDn: branch.system === 'DN' ? branch.key : undefined }),
  });
  return outcome.ok ? { ok: true, resolved: { ...base, component: outcome.resolved } } : outcome;
}
