/** The 3D side of the line checks: legacy `add_pipe_run` pipes and 02 RTE routed lines (lines, runs, inline components) as one list of runs. */

import { elementsOf } from '@aec/building/model';
import type { BuildingModel, PipeElement } from '@aec/building/types';
import type { InlineComponent, PipeLine, PipeRun, PipingModel } from '@aec/plant/types';
import { text, type Inline3d, type Norm, type Run } from './common';

const byRoute = (a: InlineComponent, b: InlineComponent): number => a.leg - b.leg || a.centreDistance - b.centreDistance;
const isBranchRun = (run: PipeRun): boolean => run.start.ref?.kind === 'branch';

const inlineOf = (run: PipeRun, component: InlineComponent): Inline3d | undefined =>
  text(component.tag) === undefined
    ? undefined
    : {
        ids: [component.id],
        label: (component.tag ?? '').trim(),
        componentId: component.id,
        type: component.type,
        runId: run.id,
        lineId: run.lineId,
      };

/** Every tagged inline component of the routed runs, in route order (the objects `check_pid_3d` pairs with P&ID inline tags). */
export function inlineObjects(piping: PipingModel): Inline3d[] {
  return piping.runOrder.flatMap((id) => {
    const run = Object.hasOwn(piping.runs, id) ? piping.runs[id] : undefined;
    return run === undefined ? [] : [...(run.inline ?? [])].sort(byRoute).flatMap((c) => inlineOf(run, c) ?? []);
  });
}

/** `TAG:NOZZLE` of a nozzle port, the tag of a tie-in, else the line's own from / to text. */
function routedEnd(
  piping: PipingModel,
  building: BuildingModel,
  run: PipeRun | undefined,
  end: 'start' | 'end',
  fallback: string | undefined,
): string | undefined {
  const ref = run === undefined ? undefined : run[end].ref;
  if (ref?.kind === 'nozzle') {
    const element = Object.hasOwn(building.elements, ref.equipmentId) ? building.elements[ref.equipmentId] : undefined;
    if (element?.category === 'equipment') return `${element.mark}:${ref.nozzleId}`;
  }
  if (ref?.kind === 'tieIn' && Object.hasOwn(piping.tieIns, ref.id)) return piping.tieIns[ref.id]?.tag;
  return fallback;
}

interface Draft {
  readonly key: string | undefined;
  readonly pipes: PipeElement[];
  readonly lines: PipeLine[];
}

function finalise(draft: Draft, piping: PipingModel, building: BuildingModel, runsByLine: ReadonlyMap<string, PipeRun[]>): Run {
  const routed = draft.lines.map((line) => ({ line, runs: runsByLine.get(line.id) ?? [] }));
  const dns = [
    ...draft.pipes.map((p) => p.dn),
    ...routed.flatMap(({ line, runs }) => runs.flatMap((r) => [r.dn ?? line.dn, ...(r.inline ?? []).map((c) => c.dn2)])),
  ].filter((n): n is number => n !== undefined);
  const specs = [...draft.pipes.flatMap((p) => (p.spec === undefined ? [] : [p.spec.specId])), ...draft.lines.map((line) => line.spec)];
  const first = routed[0];
  const last = routed[routed.length - 1];
  // Every routed line of the number counts, in line order: ends and sequence follow the main (non-branch) runs, DN and specs cover all runs.
  const allRuns = routed.flatMap((r) => r.runs);
  const mains = allRuns.filter((r) => !isBranchRun(r));
  const main = mains.length > 0 ? mains : allRuns;
  const lastPipe = draft.pipes[draft.pipes.length - 1];
  const legacyFrom = text(draft.pipes[0]?.from);
  const legacyTo = text(lastPipe?.to);
  const label = text(draft.pipes[0]?.line) ?? draft.lines[0]?.lineNumber ?? draft.pipes[0]?.mark ?? '';
  return {
    ids: [...draft.pipes.map((p) => p.id), ...routed.flatMap(({ line, runs }) => [line.id, ...runs.map((r) => r.id)])],
    label,
    key: draft.key,
    pipes: draft.pipes,
    dns,
    specs,
    from: legacyFrom ?? routedEnd(piping, building, main[0], 'start', first?.line.from),
    to: legacyTo ?? routedEnd(piping, building, main[main.length - 1], 'end', last?.line.to),
    sequence: main.flatMap((run) => [...(run.inline ?? [])].sort(byRoute).flatMap((c) => inlineOf(run, c) ?? [])),
  };
}

/** Linear in pipes + lines + runs: pipes and routed lines sharing a normalised line number are one 3D line; a pipe without a line number stands alone. */
export function collectRuns(building: BuildingModel, piping: PipingModel, norm: Norm): Run[] {
  const drafts: Draft[] = [];
  const byKey = new Map<string, Draft>();
  const draftFor = (number: string | undefined): Draft => {
    const key = number === undefined ? undefined : norm(number);
    const existing = key === undefined ? undefined : byKey.get(key);
    if (existing !== undefined) return existing;
    const created: Draft = { key, pipes: [], lines: [] };
    if (key !== undefined) byKey.set(key, created);
    drafts.push(created);
    return created;
  };
  for (const pipe of elementsOf(building, 'pipe')) draftFor(text(pipe.line)).pipes.push(pipe);
  for (const id of piping.lineOrder) {
    const line = Object.hasOwn(piping.lines, id) ? piping.lines[id] : undefined;
    if (line !== undefined) draftFor(text(line.lineNumber)).lines.push(line);
  }
  const runsByLine = new Map<string, PipeRun[]>();
  for (const id of piping.runOrder) {
    const run = Object.hasOwn(piping.runs, id) ? piping.runs[id] : undefined;
    if (run === undefined) continue;
    const list = runsByLine.get(run.lineId);
    if (list === undefined) runsByLine.set(run.lineId, [run]);
    else list.push(run);
  }
  return drafts.map((draft) => finalise(draft, piping, building, runsByLine));
}
