/**
 * Comparison of an isometric with its last issued revision (plant 05 ISO §13.6, VC-ISO-23). At issue time a compact snapshot of what the human signed for is stored
 * (`doc.plant.fabrication.issueSnapshots`: a fingerprint and a position per component, the numbered welds, the dimension strings, the BOM rows); `deltaOf` diffs a later
 * snapshot against it. The sheet draws clouds on what was added or changed. Pure, deterministic.
 */

import type { Vec3 } from '@core/model/vectors';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import type { LineAnalysis } from './analysis';
import { bomRows } from './bom';
import { mmText, runDimensions } from './iso/isoDimensions';
import { buildIsoGraph } from './iso/isoGraph';
import type { FabricationModel, IssuedIsometric, IssueSnapshot, NetworkComponent } from './model';

const pointText = (point: readonly number[]): string => point.map(mmText).join(',');

const positionOf = (component: NetworkComponent): Vec3 => component.ends[0]?.xyz ?? component.centre ?? component.coords ?? [0, 0, 0];

/** What a human signs for, in the compact form kept with the issue stamp. */
export function snapshotOf(analysis: LineAnalysis): IssueSnapshot {
  const network = analysis.read.network;
  const dimensions: Record<string, { overallMm: number; to: string }> = {};
  for (const dimension of runDimensions(buildIsoGraph(network))) {
    const first = dimension.points[0];
    const last = dimension.points[dimension.points.length - 1];
    if (first === undefined || last === undefined) continue;
    let key = `${dimension.axis}@${pointText(first)}`;
    for (let copy = 2; Object.hasOwn(dimensions, key); copy++) key = `${dimension.axis}@${pointText(first)}#${copy}`;
    dimensions[key] = { overallMm: dimension.overall, to: pointText(last) };
  }
  return {
    components: Object.fromEntries(
      network.components.map((component) => [
        component.id,
        { type: component.type, fp: sha256Hex(jcsJson(component)).slice(0, 16), at: positionOf(component) },
      ]),
    ),
    welds: Object.fromEntries(
      analysis.numbering.entries.map((entry) => [entry.record.number, { kind: entry.record.kind, at: entry.record.joint.xyz }]),
    ),
    dimensions,
    bom: Object.fromEntries(
      bomRows(network.components, () => true).rows.map((row) => [row.itemCode, { quantity: row.quantity, unit: row.unit }]),
    ),
  };
}

/** The snapshots after `issue` is stored: its own, and none of the earlier issues of the same line (compareToIssue only reads the latest). */
export function withLatestSnapshot(
  fabrication: FabricationModel,
  issue: IssuedIsometric,
  snapshot: IssueSnapshot,
): Record<string, IssueSnapshot> {
  const kept = Object.entries(fabrication.issueSnapshots ?? {}).filter(([id]) => fabrication.issues?.[id]?.lineId !== issue.lineId);
  return { ...Object.fromEntries(kept), [issue.id]: snapshot };
}

export interface ChangeSet {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/** Differences between an issued snapshot and the current one, each list sorted. */
export interface IssueDelta {
  readonly components: ChangeSet;
  readonly welds: ChangeSet;
  readonly dimensions: ChangeSet;
  readonly bom: ChangeSet;
  /** BOM rows that differ, with both quantities (null = not in that revision). */
  readonly bomChanges: readonly {
    readonly itemCode: string;
    readonly issued: number | null;
    readonly current: number | null;
    readonly unit: string;
  }[];
  /** Total number of differences. */
  readonly total: number;
}

function diffRecords<T>(
  issued: Readonly<Record<string, T>>,
  current: Readonly<Record<string, T>>,
  same: (a: T, b: T) => boolean,
): ChangeSet {
  const keys = (record: Readonly<Record<string, T>>): string[] => Object.keys(record).sort();
  return {
    added: keys(current).filter((key) => !Object.hasOwn(issued, key)),
    removed: keys(issued).filter((key) => !Object.hasOwn(current, key)),
    changed: keys(current).filter((key) => Object.hasOwn(issued, key) && !same(issued[key] as T, current[key] as T)),
  };
}

export function deltaOf(issued: IssueSnapshot, current: IssueSnapshot): IssueDelta {
  const components = diffRecords(issued.components, current.components, (a, b) => a.fp === b.fp);
  const welds = diffRecords(issued.welds, current.welds, (a, b) => a.kind === b.kind && pointText(a.at) === pointText(b.at));
  const dimensions = diffRecords(issued.dimensions, current.dimensions, (a, b) => a.overallMm === b.overallMm && a.to === b.to);
  const bom = diffRecords(issued.bom, current.bom, (a, b) => a.quantity === b.quantity && a.unit === b.unit);
  const bomChanges = [...bom.added, ...bom.removed, ...bom.changed]
    .sort()
    .map((itemCode) => ({
      itemCode,
      issued: issued.bom[itemCode]?.quantity ?? null,
      current: current.bom[itemCode]?.quantity ?? null,
      unit: (current.bom[itemCode] ?? issued.bom[itemCode])?.unit ?? 'ea',
    }));
  const total = [components, welds, dimensions, bom].reduce(
    (sum, set) => sum + set.added.length + set.removed.length + set.changed.length,
    0,
  );
  return { components, welds, dimensions, bom, bomChanges, total };
}
