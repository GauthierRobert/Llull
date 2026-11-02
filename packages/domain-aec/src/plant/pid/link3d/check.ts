/** P&ID <-> 3D consistency (plant 04 PID §5.6): P&ID equipment / lines / inline items against building equipment, pipe runs and 02 RTE routed lines. */

import { elementsOf } from '@aec/building/model';
import type { BuildingModel } from '@aec/building/types';
import type { PipingModel } from '@aec/plant/types';
import type { PidEquipment, PidInline, PidItem, PidLine, PidModel } from '../model';
import { naturalCompare } from '../lists/sort';
import { compareEquipmentClass, compareInlineClass, type ClassOutcome } from './classCompare';
import { equipmentOf } from './classMap';
import { itemAt, normaliser, text, type Labelled } from './common';
import { makeFinding3d, compareFindings3d, type Finding3d, type Skip3d } from './finding';
import { compareLine } from './lineCompare';
import { collectRuns, inlineObjects } from './lines3d';
import { compareOrder } from './orderCompare';
import { pairUp, type Pairing } from './pairing';

export type Scope3d = 'all' | 'equipment' | 'lines' | 'inline';

export interface UnmatchedPid {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly reason: 'unplaced' | 'ambiguous' | 'stale_link';
}
export interface Unmatched3d {
  readonly ids: readonly string[];
  readonly category: 'equipment' | 'pipe' | 'inline';
  readonly label: string;
  readonly reason: 'not_in_pid' | 'ambiguous';
}
export interface Check3dResult {
  readonly findings: readonly Finding3d[];
  /** Comparisons that could not be made (coded; never a pass). */
  readonly skipped: readonly Skip3d[];
  readonly matched: { readonly equipment: string[]; readonly lines: string[]; readonly inline: string[] };
  readonly unmatchedPid: readonly UnmatchedPid[];
  readonly unmatched3d: readonly Unmatched3d[];
}

interface Collector {
  findings: Finding3d[];
  skipped: Skip3d[];
  unmatchedPid: UnmatchedPid[];
  unmatched3d: Unmatched3d[];
}

function report<P extends PidItem, M extends Labelled>(
  sink: Collector,
  pairing: Pairing<P, M>,
  noun: string,
  category: Unmatched3d['category'],
  labelOf: (item: P) => string,
): void {
  for (const item of pairing.stale) {
    const label = labelOf(item);
    sink.findings.push(
      makeFinding3d({
        code: 'P3D_UNPLACED',
        pidIds: [item.id],
        item: label,
        message: `${noun} ${label}: the explicit link names a 3D element that no longer exists`,
        values: { stale: true },
      }),
    );
    sink.unmatchedPid.push({ id: item.id, kind: item.kind, label, reason: 'stale_link' });
  }
  for (const item of pairing.unplaced) {
    const label = labelOf(item);
    sink.findings.push(
      makeFinding3d({
        code: 'P3D_UNPLACED',
        pidIds: [item.id],
        item: label,
        message: `${noun} ${label} is on the P&ID but not in the 3D model`,
      }),
    );
    sink.unmatchedPid.push({ id: item.id, kind: item.kind, label, reason: 'unplaced' });
  }
  for (const object of pairing.notInPid) {
    sink.findings.push(
      makeFinding3d({
        code: 'P3D_NOT_IN_PID',
        elementIds: object.ids,
        item: object.label,
        message: `3D ${noun} ${object.label} is not on the P&ID`,
      }),
    );
    sink.unmatched3d.push({ ids: object.ids, category, label: object.label, reason: 'not_in_pid' });
  }
  for (const group of pairing.ambiguous) {
    const pidIds = group.pids.map((p) => p.id);
    const elementIds = group.models.flatMap((m) => m.ids);
    sink.findings.push(
      makeFinding3d({
        code: 'P3D_TAG_AMBIGUOUS',
        pidIds,
        elementIds,
        item: group.pids[0] === undefined ? group.key : labelOf(group.pids[0]),
        message: `${noun} tag ${group.key}: ${pidIds.length} P&ID item(s) and ${group.models.length} 3D object(s) are candidates; pair them with link_pid_item`,
        values: { key: group.key, pidCount: pidIds.length, modelCount: group.models.length },
      }),
    );
    for (const item of group.pids) sink.unmatchedPid.push({ id: item.id, kind: item.kind, label: labelOf(item), reason: 'ambiguous' });
    for (const object of group.models) sink.unmatched3d.push({ ids: object.ids, category, label: object.label, reason: 'ambiguous' });
  }
}

const sortLabels = (labels: string[]): string[] => labels.sort(naturalCompare);

const outcome = (sink: Collector, result: ClassOutcome): void => {
  if (result === undefined) return;
  if ('finding' in result) sink.findings.push(result.finding);
  else sink.skipped.push(result.skip);
};

/** Read-only: derives every answer from the models. Linear in both sides (hash join); the inline-order comparison is bounded per line (`MAX_ORDER_CELLS`). */
export function check3d(
  pid: PidModel,
  building: BuildingModel,
  piping: PipingModel,
  scope: Scope3d,
  normaliseTags: boolean,
): Check3dResult {
  const norm = normaliser(normaliseTags);
  const links = pid.links ?? {};
  const sink: Collector = { findings: [], skipped: [], unmatchedPid: [], unmatched3d: [] };
  const matched = { equipment: [] as string[], lines: [] as string[], inline: [] as string[] };
  const items = pid.itemOrder.flatMap((id) => itemAt(pid, id) ?? []);

  if (scope === 'all' || scope === 'equipment') {
    const equipment = items.filter((i): i is PidEquipment => i.kind === 'equipment' && i.parentId === undefined);
    const objects = elementsOf(building, 'equipment').map((e): Labelled => ({ ids: [e.id], label: e.mark }));
    const pairing = pairUp(
      equipment,
      objects,
      (i) => (text(i.tag) === undefined ? undefined : norm(i.tag ?? '')),
      (o) => (text(o.label) === undefined ? undefined : norm(o.label)),
      links,
    );
    report(sink, pairing, 'equipment', 'equipment', (i) => i.tag ?? i.id);
    for (const [item, object] of pairing.pairs) {
      matched.equipment.push(item.tag ?? item.id);
      const element = equipmentOf(building, object.ids[0] ?? '');
      if (element !== undefined) outcome(sink, compareEquipmentClass(item, element));
    }
  }

  if (scope !== 'equipment') {
    const runs = collectRuns(building, piping, norm);
    const lines = items.filter((i): i is PidLine => i.kind === 'line');
    const lineKey = (line: PidLine): string | undefined => (text(line.lineNumber) === undefined ? undefined : norm(line.lineNumber ?? ''));
    const pairing = pairUp(lines, runs, lineKey, (run) => run.key, links);
    if (scope === 'all' || scope === 'lines') {
      report(sink, pairing, 'line', 'pipe', (line) => line.lineNumber ?? line.id);
      for (const [line, run] of pairing.pairs) {
        matched.lines.push(line.lineNumber ?? line.id);
        const compared = compareLine(pid, line, run, norm);
        sink.findings.push(...compared.findings);
        sink.skipped.push(...compared.skips);
      }
    }
    if (scope === 'all' || scope === 'inline') {
      for (const [line, run] of pairing.pairs) {
        const order = compareOrder(pid, line, run, norm);
        sink.findings.push(...order.findings);
        sink.skipped.push(...order.skips);
      }
      const tagged = items.filter((i): i is PidInline => i.kind === 'inline' && text(i.tag) !== undefined);
      const inlinePairing = pairUp(
        tagged,
        inlineObjects(piping),
        (i) => norm(i.tag ?? ''),
        (o) => norm(o.label),
        {},
      );
      report(sink, inlinePairing, 'inline', 'inline', (i) => i.tag ?? i.id);
      for (const [item, component] of inlinePairing.pairs) {
        matched.inline.push(item.tag ?? item.id);
        outcome(sink, compareInlineClass(item, component));
      }
    }
  }

  sortLabels(matched.equipment);
  sortLabels(matched.lines);
  sortLabels(matched.inline);
  return {
    findings: sink.findings.sort(compareFindings3d),
    skipped: sink.skipped.sort((a, b) => naturalCompare(a.item, b.item) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    matched,
    unmatchedPid: sink.unmatchedPid.sort((a, b) => naturalCompare(a.label, b.label)),
    unmatched3d: sink.unmatched3d.sort((a, b) => naturalCompare(a.label, b.label)),
  };
}
