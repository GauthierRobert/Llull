/**
 * The context one run derivation works in: the run, its line, the line's `SpecLookup`, the elbow-angle tolerance, the butt-weld rule and a memo of
 * the spec's pipe row per nominal size (a run changes size at reducers). Also the slot a mid-leg component (valve, reducer, tee) occupies.
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { Joint, PartPort, PipeLine, PipeRun, PortSpec, RoutedPart } from '@aec/plant/types';
import { fail, type DerivationFailure, type DerivedInline, type RunDerivation } from './deriveTypes';
import type { FlangeSet } from './flangeSet';
import type { Interval } from './jointStack';
import { getPiping } from './model';
import { createSpecLookup, isMiss, type CatalogueRow, type ConnectionRule, type SpecLookup } from './specLookup';

export interface PipeInfo {
  readonly row: CatalogueRow;
  readonly od: number;
  readonly wall: number;
}

export interface Env {
  readonly doc: CadDocument;
  readonly run: PipeRun;
  readonly line: PipeLine;
  readonly lookup: SpecLookup;
  readonly tolerance: RunDerivation['angleTolerance'];
  /** BW-BW rule (weld gap); null when the spec has none. */
  readonly weld: ConnectionRule | null;
  /** The spec's pipe at `dn`, or the failure that says why there is none. */
  pipeAt(dn: number): PipeInfo | DerivationFailure;
}

export interface EndSetup {
  /** Interval length occupied next to the end (flange set, branch fitting), mm. */
  readonly length: number;
  readonly gap: number;
  readonly set: FlangeSet | null;
  readonly port: PortSpec | null;
  readonly portId: string | null;
  /** Branch start: the header fitting part the first pipe piece welds to. */
  readonly fittingId?: string;
  /** Branch start on a stub-in: the first piece is not butt welded to the part (the set-on branch weld is the one weld). */
  readonly weldless?: boolean;
}

export const partOf = (
  runId: string,
  id: string,
  kind: RoutedPart['kind'],
  row: CatalogueRow,
  ports: readonly PartPort[],
  extra: Partial<RoutedPart> = {},
): RoutedPart => ({
  id,
  runId,
  kind,
  catalogueKey: row.key,
  typeKey: `${row.type}${row.radius ?? ''}`,
  dn: row.dn,
  ports,
  dims: row.dims,
  unverified: row.unverified,
  ...extra,
});

/** A mid-leg component: the interval it occupies, the parts a neighbouring pipe piece welds to, and how to build its parts at a leg frame. */
export interface Slot {
  readonly interval: Interval;
  readonly leg: number;
  /** Part joined by the pipe piece upstream of the slot. */
  readonly before: string;
  /** Part joined by the pipe piece downstream of the slot. */
  readonly after: string;
  /** Size of the run after the slot (reducers change it). */
  readonly dnOut: number;
  build(origin: Vec3, direction: Vec3): SlotBuild;
}

export interface SlotBuild {
  readonly parts: readonly RoutedPart[];
  /** Joints inside the slot (flanged faces); the welds to the neighbouring pieces are made by the leg walk. */
  readonly joints: ReadonlyArray<Omit<Joint, 'id'>>;
  readonly inline?: DerivedInline;
}

/** Ids minted in route order, one counter per part kind (`<runId>/<kind>-<k>`). */
export type Mint = (kind: RoutedPart['kind']) => string;

export const at = (origin: Vec3, direction: Vec3, distance: number): Vec3 => [
  origin[0] + direction[0] * distance,
  origin[1] + direction[1] * distance,
  origin[2] + direction[2] * distance,
];

/** A butt-weld port of a pipe-like part. */
export const bwPort = (position: Vec3, direction: Vec3, dn: number): PartPort => ({ position, direction, dn, endType: 'BW' });

/**
 * The derivation environment of `run`.
 * @failure unknown line -> RTE_UNKNOWN_LINE; unknown spec / catalogue -> RTE_SPEC_UNKNOWN
 */
export function makeEnv(doc: CadDocument, run: PipeRun): Env | DerivationFailure {
  const line = getPiping(doc).lines[run.lineId];
  if (line === undefined) return fail('RTE_UNKNOWN_LINE', `no pipe line "${run.lineId}"`, [run.lineId], ['lineId']);
  const lookup = createSpecLookup(doc, line.spec);
  if (isMiss(lookup)) return fail(lookup.miss, lookup.detail, [...lookup.ids, line.id], ['lineId']);
  const rule = lookup.elbowAngles();
  const tolerance =
    run.angleToleranceDeg !== undefined
      ? { valueDeg: run.angleToleranceDeg, source: 'run' as const }
      : { valueDeg: rule.toleranceDeg, source: rule.defaulted ? ('default' as const) : ('spec' as const) };
  const memo = new Map<number, PipeInfo | DerivationFailure>();
  const pipeAt = (dn: number): PipeInfo | DerivationFailure => {
    const known = memo.get(dn);
    if (known !== undefined) return known;
    const row = lookup.pipe(dn);
    let result: PipeInfo | DerivationFailure;
    if (isMiss(row)) result = fail(row.miss, row.detail, [...row.ids, line.id], ['lineId']);
    else {
      const od = row.dims['outsideDiameter'];
      const wall = row.dims['wall'];
      result =
        od === undefined || wall === undefined
          ? fail('RTE_SPEC_NO_COMPONENT', `pipe row ${row.key} lacks outsideDiameter / wall (${row.source})`, [row.key], ['lineId'])
          : { row, od, wall };
    }
    memo.set(dn, result);
    return result;
  };
  return { doc, run, line, lookup, tolerance, weld: lookup.connection('BW', 'BW'), pipeAt };
}
