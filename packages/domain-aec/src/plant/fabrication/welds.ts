/**
 * Weld numbering (plant 05 ISO §5.4, TR-ISO-06): every weld joint of a line gets a number that survives edits. A stored weld keeps its number when its joint is found again
 * (same position and components, else same position, else same components); new joints take highest + 1 in depth-first order; a joint that vanished is kept as `orphaned` and
 * its number is never reused (NDE traceability). `renumber` is the explicit full restart. Pure.
 */

import { isWeldJoint, nodeKey, type JointNode, type LineGraph } from './joints';
import type { FabricationModel, FabricationRules, PipingNetwork, WeldKind, WeldRecord } from './model';

export interface WeldEntry {
  readonly joint: JointNode;
  readonly record: WeldRecord;
  /** kept = the number was already stored; assigned = it is new (provisional until number_welds stores it). */
  readonly status: 'kept' | 'assigned';
  readonly componentIds: readonly string[];
}

export interface NumberingPlan {
  readonly entries: readonly WeldEntry[];
  /** Stored welds whose joint is gone (new and earlier ones), kept with their numbers. */
  readonly orphaned: readonly WeldRecord[];
  /** Orphaned welds dropped by an explicit renumber. */
  readonly dropped: readonly WeldRecord[];
  readonly highest: number;
}

export const weldPrefix = (rules: FabricationRules | undefined, kind: WeldKind): string =>
  (kind === 'shop' ? rules?.weldPrefix?.fabrication : rules?.weldPrefix?.erection) ?? 'W';

export const weldRecordId = (lineId: string, n: number): string => `${lineId}#${n}`;

export const storedWelds = (fabrication: FabricationModel, lineId: string): WeldRecord[] =>
  Object.values(fabrication.welds ?? {})
    .filter((weld) => weld.lineId === lineId)
    .sort((a, b) => a.n - b.n);

/** The highest number ever given on the line: stored record, stored counter, or the HIGHEST-WELD-NUMBER of an imported file. */
export function baseHighest(fabrication: FabricationModel, lineId: string, network: PipingNetwork): number {
  const fromFile = Number.parseInt(network.attributes['HIGHEST-WELD-NUMBER'] ?? '', 10);
  return Math.max(
    fabrication.highestWeldNumber?.[lineId] ?? 0,
    Number.isFinite(fromFile) ? fromFile : 0,
    ...storedWelds(fabrication, lineId).map((weld) => weld.n),
  );
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => [...a].sort().join('|') === [...b].sort().join('|');
const keyOf = (xyz: readonly number[]): string => nodeKey([xyz[0] ?? 0, xyz[1] ?? 0, xyz[2] ?? 0]);

export function planNumbering(input: {
  readonly lineId: string;
  readonly network: PipingNetwork;
  readonly graph: LineGraph;
  readonly stored: readonly WeldRecord[];
  readonly rules: FabricationRules | undefined;
  readonly startHighest: number;
  readonly renumber: boolean;
}): NumberingPlan {
  const components = input.network.components;
  const joints = input.graph.joints.filter((joint) => isWeldJoint(joint.joint));
  const idsOf = (joint: JointNode): string[] => joint.members.map((index) => components[index]?.id ?? '');
  const candidates = input.renumber
    ? []
    : [...input.stored].sort((a, b) => Number(a.status === 'orphaned') - Number(b.status === 'orphaned') || a.n - b.n);
  const matched = new Map<number, WeldRecord>();
  const taken = new Set<string>();
  const passes: Array<(record: WeldRecord, joint: JointNode, ids: string[]) => boolean> = [
    (record, joint, ids) => keyOf(record.joint.xyz) === joint.key && sameIds(record.joint.componentIds, ids),
    (record, joint) => keyOf(record.joint.xyz) === joint.key,
    (record, _joint, ids) => sameIds(record.joint.componentIds, ids),
  ];
  for (const pass of passes)
    joints.forEach((joint, position) => {
      if (matched.has(position)) return;
      const found = candidates.find((record) => !taken.has(record.id) && pass(record, joint, idsOf(joint)));
      if (found === undefined) return;
      matched.set(position, found);
      taken.add(found.id);
    });

  let highest = input.renumber ? 0 : input.startHighest;
  const entries = joints.map((joint, position): WeldEntry => {
    const componentIds = idsOf(joint);
    const detected = isWeldJoint(joint.joint) ? joint.joint : 'shop';
    const previous = matched.get(position);
    const shared = { xyz: joint.xyz, componentIds, boreMm: joint.boreMm, endType: joint.endType };
    if (previous !== undefined) {
      const kind = previous.kindSet ? previous.kind : detected;
      return { joint, status: 'kept', componentIds, record: { ...previous, kind, joint: shared, status: 'active' } };
    }
    highest += 1;
    const record: WeldRecord = {
      id: weldRecordId(input.lineId, highest),
      lineId: input.lineId,
      n: highest,
      number: `${weldPrefix(input.rules, detected)}${highest}`,
      kind: detected,
      kindSet: false,
      joint: shared,
      status: 'active',
    };
    return { joint, status: 'assigned', componentIds, record };
  });
  const orphaned = candidates.filter((record) => !taken.has(record.id)).map((record): WeldRecord => ({ ...record, status: 'orphaned' }));
  const dropped = input.renumber ? input.stored.filter((record) => record.status === 'orphaned') : [];
  return { entries, orphaned, dropped, highest };
}
