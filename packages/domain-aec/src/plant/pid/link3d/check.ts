/** P&ID <-> 3D consistency (plant 04 PID §5.6, MVP subset): P&ID equipment / lines / inline items against building equipment and pipe runs. */

import { elementsOf } from '@aec/building/model';
import type { BuildingModel, PipeElement } from '@aec/building/types';
import type { PidEndpoint, PidEquipment, PidItem, PidLine, PidModel, PidSegment } from '../model';
import { naturalCompare } from '../lists/sort';
import { makeFinding3d, compareFindings3d, type Finding3d } from './finding';
import { pairUp, type ModelObject, type Pairing } from './pairing';

export type Scope3d = 'all' | 'equipment' | 'lines' | 'inline';

export interface UnmatchedPid {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly reason: 'unplaced' | 'ambiguous' | 'stale_link';
}
export interface Unmatched3d {
  readonly ids: readonly string[];
  readonly category: 'equipment' | 'pipe';
  readonly label: string;
  readonly reason: 'not_in_pid' | 'ambiguous';
}
export interface Check3dResult {
  readonly findings: readonly Finding3d[];
  readonly matched: { readonly equipment: string[]; readonly lines: string[]; readonly inline: string[] };
  readonly unmatchedPid: readonly UnmatchedPid[];
  readonly unmatched3d: readonly Unmatched3d[];
}

interface Labelled extends ModelObject {
  readonly label: string;
}
interface Run extends Labelled {
  readonly pipes: readonly PipeElement[];
}

const normaliser = (normaliseTags: boolean): ((text: string) => string) =>
  normaliseTags ? (text) => text.toUpperCase().replace(/[\s_-]+/g, '') : (text) => text.trim();

const itemAt = (pid: PidModel, id: string): PidItem | undefined => (Object.hasOwn(pid.items, id) ? pid.items[id] : undefined);
const text = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value.trim());

interface End {
  readonly tag: string;
  readonly nozzle: string | undefined;
  /** The tag and sub-tag as written, for messages. */
  readonly shown: string;
}

/** `{ equipment tag, nozzle sub-tag }` of a segment end on a nozzle; any other end (free, branch, inline, off-page) is not compared. */
function pidEnd(pid: PidModel, end: PidEndpoint, norm: (text: string) => string): End | undefined {
  if (end.type !== 'nozzle') return undefined;
  const nozzle = itemAt(pid, end.itemId);
  if (nozzle?.kind !== 'nozzle') return undefined;
  let owner = itemAt(pid, nozzle.equipmentId);
  for (let depth = 0; depth < 16 && owner?.kind === 'equipment' && owner.parentId !== undefined; depth++)
    owner = itemAt(pid, owner.parentId);
  if (owner?.kind !== 'equipment' || owner.tag === undefined) return undefined;
  return { tag: norm(owner.tag), nozzle: norm(nozzle.subTag), shown: `${owner.tag}/${nozzle.subTag}` };
}

/** `TAG` or `TAG:NOZZLE` (the 03 EQP port id) of a pipe's from / to. */
function modelEnd(value: string | undefined, norm: (text: string) => string): End | undefined {
  const clean = text(value);
  if (clean === undefined) return undefined;
  const cut = clean.indexOf(':');
  return cut < 0
    ? { tag: norm(clean), nozzle: undefined, shown: clean }
    : { tag: norm(clean.slice(0, cut)), nozzle: norm(clean.slice(cut + 1)), shown: `${clean.slice(0, cut)}/${clean.slice(cut + 1)}` };
}

const sameEnd = (pidSide: End, modelSide: End): boolean =>
  pidSide.tag === modelSide.tag && (modelSide.nozzle === undefined || modelSide.nozzle === pidSide.nozzle);

const segmentsOf = (pid: PidModel, line: PidLine): PidSegment[] =>
  line.segmentIds.flatMap((id) => {
    const segment = itemAt(pid, id);
    return segment?.kind === 'segment' ? [segment] : [];
  });

const dnList = (values: ReadonlyArray<number | undefined>): number[] =>
  [...new Set(values.filter((n): n is number => n !== undefined))].sort((a, b) => a - b);

function compareLine(pid: PidModel, line: PidLine, run: Run, norm: (text: string) => string): Finding3d[] {
  const findings: Finding3d[] = [];
  const label = line.lineNumber ?? line.id;
  const segments = segmentsOf(pid, line);
  const pidDn = dnList(segments.map((s) => s.dn ?? line.dn));
  const modelDn = dnList(run.pipes.map((p) => p.dn));
  if (pidDn.length > 0 && modelDn.length > 0 && pidDn.join(',') !== modelDn.join(','))
    findings.push(
      makeFinding3d({
        code: 'P3D_SIZE_MISMATCH',
        pidIds: [line.id],
        elementIds: run.ids,
        item: label,
        message: `line ${label}: P&ID DN ${pidDn.join('/')} but 3D DN ${modelDn.join('/')}`,
        values: { pidDn: pidDn.join(','), modelDn: modelDn.join(',') },
      }),
    );
  const first = segments[0];
  const last = segments[segments.length - 1];
  const a = first === undefined ? undefined : pidEnd(pid, first.from, norm);
  const b = last === undefined ? undefined : pidEnd(pid, last.to, norm);
  const c = modelEnd(run.pipes[0]?.from, norm);
  const d = modelEnd(run.pipes[run.pipes.length - 1]?.to, norm);
  if (
    a !== undefined &&
    b !== undefined &&
    c !== undefined &&
    d !== undefined &&
    !((sameEnd(a, c) && sameEnd(b, d)) || (sameEnd(a, d) && sameEnd(b, c)))
  ) {
    findings.push(
      makeFinding3d({
        code: 'P3D_CONNECTIVITY_MISMATCH',
        pidIds: [line.id],
        elementIds: run.ids,
        item: label,
        message: `line ${label}: P&ID connects ${a.shown} and ${b.shown} but the 3D run goes ${c.shown} to ${d.shown}`,
        values: { pidEnds: `${a.shown} | ${b.shown}`, modelEnds: `${c.shown} | ${d.shown}` },
      }),
    );
  }
  return findings;
}

interface Collector {
  findings: Finding3d[];
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

/** Read-only: derives every answer from the two models. Linear in both sides (hash join). */
export function check3d(pid: PidModel, building: BuildingModel, scope: Scope3d, normaliseTags: boolean): Check3dResult {
  const norm = normaliser(normaliseTags);
  const links = pid.links ?? {};
  const sink: Collector = { findings: [], unmatchedPid: [], unmatched3d: [] };
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
    for (const [item] of pairing.pairs) matched.equipment.push(item.tag ?? item.id);
  }

  if (scope === 'all' || scope === 'lines') {
    const groups = new Map<string, PipeElement[]>();
    const runs: Run[] = [];
    for (const pipe of elementsOf(building, 'pipe')) {
      const number = text(pipe.line);
      const key = number === undefined ? undefined : norm(number);
      const group = key === undefined ? undefined : groups.get(key);
      if (group !== undefined) group.push(pipe);
      else {
        const created = [pipe];
        if (key !== undefined) groups.set(key, created);
        runs.push({ ids: [], label: number ?? pipe.mark, pipes: created });
      }
    }
    const objects = runs.map((run): Run => ({ ...run, ids: run.pipes.map((p) => p.id) }));
    const lines = items.filter((i): i is PidLine => i.kind === 'line');
    const lineKey = (line: PidLine): string | undefined => (text(line.lineNumber) === undefined ? undefined : norm(line.lineNumber ?? ''));
    const pairing = pairUp(
      lines,
      objects,
      lineKey,
      (run) => (text(run.pipes[0]?.line) === undefined ? undefined : norm(run.pipes[0]?.line ?? '')),
      links,
    );
    report(sink, pairing, 'line', 'pipe', (line) => line.lineNumber ?? line.id);
    for (const [line, run] of pairing.pairs) {
      matched.lines.push(line.lineNumber ?? line.id);
      sink.findings.push(...compareLine(pid, line, run, norm));
    }
  }

  if (scope === 'all' || scope === 'inline') {
    for (const item of items) {
      if (item.kind !== 'inline' || text(item.tag) === undefined) continue;
      const label = item.tag ?? item.id;
      sink.findings.push(
        makeFinding3d({
          code: 'P3D_UNPLACED',
          pidIds: [item.id],
          item: label,
          message: `inline ${label} is on the P&ID; the 3D model has no inline components yet (02 RTE), so it cannot be placed`,
          values: { dexpiClass: item.dexpiClass },
        }),
      );
      sink.unmatchedPid.push({ id: item.id, kind: 'inline', label, reason: 'unplaced' });
    }
  }

  sortLabels(matched.equipment);
  sortLabels(matched.lines);
  return {
    findings: sink.findings.sort(compareFindings3d),
    matched,
    unmatchedPid: sink.unmatchedPid.sort((a, b) => naturalCompare(a.label, b.label)),
    unmatched3d: sink.unmatched3d.sort((a, b) => naturalCompare(a.label, b.label)),
  };
}
