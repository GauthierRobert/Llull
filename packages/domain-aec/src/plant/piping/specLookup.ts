/**
 * `SpecLookup` (02 RTE §3.3): the one way routing reads a spec. A thin in-process adapter over 01 PSC's `resolveComponent` over
 * `doc.plant.spec` and the catalogues the spec names (`specCatalogs`); PSC failure codes are mapped to `RTE_SPEC_*`, the catalogue row's
 * trust travels as `unverified` (AF-32). Standard part dimensions come from the catalogue row, never from a formula (§5.2).
 * @invariant pure: the same document and query always give the same row or miss
 */

import type { CadDocument } from '@core/model/types';
import type { EndType, Joint } from '@aec/plant/types';
import type { ComponentType, EndType as CatalogEndType, PipingCatalog } from '../catalog/types';
import { resolveBranch, resolveComponent, type ComponentQuery, type ResolveOutcome } from '../spec/resolve';
import { latestSpec, specCatalogs } from '../spec/store';
import type { BranchFitting, PipeSpec, SpecStatus } from '../spec/types';

/** One resolved catalogue row as routing reads it. `dims` holds the row's dimensions in mm (counts as numbers). */
export interface CatalogueRow {
  /** `<spec>/<component id>/<size key>`, e.g. `CS150/E90-LR/4`. */
  readonly key: string;
  readonly type: ComponentType;
  readonly dn: number;
  readonly dn2?: number;
  /** `CL150` / `PN16` when the row has a class or pn. */
  readonly rating?: string;
  readonly facing?: 'RF' | 'FF' | 'RTJ';
  /** `elbow90` + `LR` for takeoff keys. */
  readonly radius?: string;
  readonly ends: readonly EndType[];
  readonly dims: Readonly<Record<string, number>>;
  /** Not every dimension is grade A, or the catalogue has no row (AF-32). */
  readonly unverified: boolean;
  readonly source: string;
}

export interface SpecMiss {
  readonly miss: 'RTE_SPEC_UNKNOWN' | 'RTE_SPEC_NO_COMPONENT' | 'RTE_SPEC_AMBIGUOUS' | 'RTE_BRANCH_NO_TABLE_ROW';
  /** The PSC code and message, or the routing-side reason. */
  readonly detail: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}

export interface ElbowRule {
  readonly anglesDeg: readonly number[];
  readonly toleranceDeg: number;
  readonly trimmedAllowed: boolean;
  /** The spec declares no `elbowAngles`: angles come from its elbow components, tolerance is the named default. */
  readonly defaulted: boolean;
}

export interface ConnectionRule {
  readonly joint: Joint['kind'];
  /** Weld root gap deducted from each adjoining pipe piece (named default 0: centre-to-end includes the gap, TECHNICAL_SPEC §11.3). */
  readonly gapMm: number;
  /** Component types the joint needs besides its two ends. */
  readonly requires: readonly ComponentType[];
}

export interface PartQuery {
  /** Types tried in this order; the first that resolves wins. */
  readonly types: readonly ComponentType[];
  readonly dn: number;
  readonly dn2?: number;
  /** `CL150` / `PN16`; any other text adds no filter. */
  readonly rating?: string | undefined;
  readonly facing?: 'RF' | 'FF' | 'RTJ' | undefined;
}

/** The fitting the spec's branch table gives for a header x branch size pair. */
export interface BranchChoice {
  /** Branch-table cell: T equal tee, RT reducing tee, W weldolet, S sockolet, TH threadolet, SI stub-in, SIR reinforced stub-in. */
  readonly fitting: BranchFitting;
  readonly fittingName: string;
  /** The fitting's catalogue row; null for a stub-in (no fitting: the branch pipe is welded to the header). */
  readonly row: CatalogueRow | null;
}

/** The insulation a spec's table gives for a line. */
export interface InsulationChoice {
  readonly thicknessMm: number;
  readonly material: string;
  readonly conductivityWmK: number | null;
  /** The table row, named in results (`H dn<=100 T<=200C`). */
  readonly row: string;
}

export interface SpecLookup {
  readonly id: string;
  readonly revision: number;
  status(): SpecStatus;
  pipe(dn: number): CatalogueRow | SpecMiss;
  component(query: PartQuery): CatalogueRow | SpecMiss;
  /** The branch-table fitting for `headerDn` x `branchDn` (PSC `resolveBranch`); a cell-less pair is `RTE_BRANCH_NO_TABLE_ROW`. */
  branch(headerDn: number, branchDn: number): BranchChoice | SpecMiss;
  /** Thickness for insulation `code` on a line of `dn` at `tempC` (02 RTE §5.10): the tightest row (smallest dnMax, then tempMaxC) that covers both. */
  insulation(code: string, dn: number, tempC: number): InsulationChoice | SpecMiss;
  elbowAngles(): ElbowRule;
  connection(a: EndType, b: EndType): ConnectionRule | null;
}

/** Named default of the elbow angle tolerance when a spec declares none, degrees. */
export const DEFAULT_ANGLE_TOLERANCE_DEG = 1;

export const isMiss = (value: object): value is SpecMiss => 'miss' in value;

const END_OF: Readonly<Record<CatalogEndType, EndType>> = {
  BW: 'BW',
  BE: 'BW',
  SW: 'SW',
  THD: 'SC',
  FL: 'FL',
  PE: 'PL',
  LUG: 'LUG',
  WAF: 'WAF',
};

const miss = (kind: SpecMiss['miss'], detail: string, ids: readonly string[] = [], paths: readonly string[] = []): SpecMiss => ({
  miss: kind,
  detail,
  ids,
  paths,
});

const ratingFilter = (rating: string | undefined): { class?: number; pn?: number } => {
  const match = rating === undefined ? null : /^(CL|PN)\s*(\d+(?:\.\d+)?)$/i.exec(rating.trim());
  if (match === null) return {};
  const value = Number(match[2]);
  return (match[1] as string).toUpperCase() === 'CL' ? { class: value } : { pn: value };
};

function rowOf(spec: PipeSpec, outcome: Extract<ResolveOutcome, { ok: true }>, dn: number, dn2: number | undefined): CatalogueRow {
  const { resolved } = outcome;
  const dims: Record<string, number> = {};
  for (const [name, dim] of Object.entries(resolved.dims)) dims[name] = dim.value;
  if (resolved.outsideDiameterMm !== undefined) dims['outsideDiameter'] ??= resolved.outsideDiameterMm;
  if (resolved.wallMm !== undefined) dims['wall'] ??= resolved.wallMm;
  const row = resolved.row;
  const rating = row?.class !== undefined ? `CL${row.class}` : row?.pn !== undefined ? `PN${row.pn}` : undefined;
  const facing = row?.facing === 'RF' || row?.facing === 'FF' || row?.facing === 'RTJ' ? row.facing : undefined;
  return {
    key: `${spec.id}/${resolved.component.id}/${resolved.size.key}`,
    type: resolved.component.type,
    dn,
    ...(dn2 === undefined ? {} : { dn2 }),
    ...(rating === undefined ? {} : { rating }),
    ...(facing === undefined ? {} : { facing }),
    ...(row?.radius === undefined ? {} : { radius: row.radius }),
    ends: (row?.ends ?? (resolved.component.ends === undefined ? [] : [resolved.component.ends])).map((end) => END_OF[end]),
    dims,
    unverified: !resolved.verified,
    source:
      row === null
        ? (resolved.unresolved ?? `spec ${spec.id} component ${resolved.component.id}`)
        : `${row.catalogId}@${row.catalogVersion} ${row.familyId} (${row.standard})`,
  };
}

function missOf(outcome: Extract<ResolveOutcome, { ok: false }>, notes: string): SpecMiss {
  const kind = outcome.code === 'PSC_AMBIGUOUS_COMPONENT' ? 'RTE_SPEC_AMBIGUOUS' : 'RTE_SPEC_NO_COMPONENT';
  return miss(kind, `${outcome.code}: ${outcome.message}${notes}`, outcome.ids, outcome.paths);
}

const CONNECTIONS: ReadonlyArray<readonly [EndType, EndType, ConnectionRule]> = [
  ['BW', 'BW', { joint: 'buttWeld', gapMm: 0, requires: [] }],
  ['FL', 'FL', { joint: 'flanged', gapMm: 0, requires: ['gasketSpiralWound', 'boltSet'] }],
];

function elbowRule(spec: PipeSpec): ElbowRule {
  if (spec.elbowAngles !== undefined) return { ...spec.elbowAngles, defaulted: false };
  const angles = [spec.components.some((c) => c.type === 'elbow90') ? 90 : 0, spec.components.some((c) => c.type === 'elbow45') ? 45 : 0];
  return {
    anglesDeg: angles.filter((angle) => angle > 0),
    toleranceDeg: DEFAULT_ANGLE_TOLERANCE_DEG,
    trimmedAllowed: false,
    defaulted: true,
  };
}

function insulationOf(spec: PipeSpec, code: string, dn: number, tempC: number): InsulationChoice | SpecMiss {
  const rows = (spec.insulation ?? []).filter((row) => row.code === code);
  if (rows.length === 0)
    return miss(
      'RTE_SPEC_NO_COMPONENT',
      `spec ${spec.id} has no insulation table row for code "${code}"${spec.insulation === undefined ? ' (the spec has no insulation table)' : ` (codes: ${[...new Set(spec.insulation.map((row) => row.code))].join(', ')})`}`,
      [spec.id],
      ['insulation'],
    );
  const fits = rows.filter((row) => dn <= row.dnMax && tempC <= row.tempMaxC).sort((a, b) => a.dnMax - b.dnMax || a.tempMaxC - b.tempMaxC);
  const best = fits[0];
  if (best === undefined)
    return miss(
      'RTE_SPEC_NO_COMPONENT',
      `spec ${spec.id} insulation "${code}" has no row for DN${dn} at ${tempC} degC (rows: ${rows.map((row) => `dn<=${row.dnMax} T<=${row.tempMaxC}C`).join(', ')})`,
      [spec.id],
      ['insulation'],
    );
  return {
    thicknessMm: best.thicknessMm,
    material: best.material,
    conductivityWmK: best.conductivityWmK ?? null,
    row: `${best.code} dn<=${best.dnMax} T<=${best.tempMaxC}C`,
  };
}

/**
 * The lookup of spec `specId` (newest revision) in `doc`, or the miss that says why routing cannot read it.
 * @failure no such spec, or a catalogue the spec names is not loaded -> RTE_SPEC_UNKNOWN (a missing catalogue would silently change dimensions)
 */
export function createSpecLookup(doc: Pick<CadDocument, 'plant'>, specId: string): SpecLookup | SpecMiss {
  const spec = latestSpec(doc, specId);
  if (spec === undefined) return miss('RTE_SPEC_UNKNOWN', `PSC_SPEC_UNKNOWN: no spec "${specId}" in the document`, [], ['spec']);
  const { catalogs, missing }: { catalogs: readonly PipingCatalog[]; missing: readonly string[] } = specCatalogs(doc, spec);
  if (missing.length > 0)
    return miss(
      'RTE_SPEC_UNKNOWN',
      `spec ${spec.id} names catalogue(s) ${missing.join(', ')} that are not loaded; routing would read other dimensions`,
      [spec.id],
      ['spec'],
    );
  const resolve = (query: ComponentQuery, dn: number, dn2: number | undefined): CatalogueRow | SpecMiss => {
    const outcome = resolveComponent(spec, catalogs, query);
    return outcome.ok ? rowOf(spec, outcome, dn, dn2) : missOf(outcome, '');
  };
  return {
    id: spec.id,
    revision: spec.revision,
    status: () => spec.status,
    pipe: (dn) => resolve({ type: 'pipe', dn: String(dn) }, dn, undefined),
    component: ({ types, dn, dn2, rating, facing }) => {
      let first: SpecMiss | undefined;
      for (const type of types) {
        const query: ComponentQuery = {
          type,
          dn: String(dn),
          ...(dn2 === undefined ? {} : { branchDn: String(dn2) }),
          ...ratingFilter(rating),
          ...(facing === undefined ? {} : { facing }),
        };
        const found = resolve(query, dn, dn2);
        if (!isMiss(found)) return found;
        first ??= found;
      }
      return first ?? miss('RTE_SPEC_NO_COMPONENT', 'no component type given');
    },
    branch: (headerDn, branchDn) => {
      const outcome = resolveBranch(spec, catalogs, { headerDn: String(headerDn), branchDn: String(branchDn) });
      if (!outcome.ok) {
        const kind = outcome.code === 'PSC_BRANCH_UNDEFINED' ? 'RTE_BRANCH_NO_TABLE_ROW' : 'RTE_SPEC_NO_COMPONENT';
        return miss(kind, `${outcome.code}: ${outcome.message}`, outcome.ids, outcome.paths);
      }
      const { fitting, fittingName, component } = outcome.resolved;
      return { fitting, fittingName, row: component === null ? null : rowOf(spec, { ok: true, resolved: component }, headerDn, branchDn) };
    },
    insulation: (code, dn, tempC) => insulationOf(spec, code, dn, tempC),
    elbowAngles: () => elbowRule(spec),
    connection: (a, b) => CONNECTIONS.find(([x, y]) => x === a && y === b)?.[2] ?? null,
  };
}

/** Outside diameter (mm) of the pipe of spec `specId` at `dn`, or null when the spec or its pipe row is missing. */
export function pipeOutsideDiameter(doc: Pick<CadDocument, 'plant'>, specId: string, dn: number): number | null {
  const lookup = createSpecLookup(doc, specId);
  if (isMiss(lookup)) return null;
  const pipe = lookup.pipe(dn);
  return isMiss(pipe) ? null : (pipe.dims['outsideDiameter'] ?? null);
}
