/**
 * Pipe supports follow their run (02 RTE V1 part 2), the same idea as `reconcilePipeSupports` for building pipes: after a command changed a run (stretch
 * when equipment moved, `edit_route`, an eccentric reducer, a size or spec change) each support of that run is re-snapped to the nearest point of the new
 * centreline and re-attached to the steel in reach, or left unattached; a run that is broken (the stretch failed) keeps its supports where they are. Nothing
 * is dropped silently: moved, re-attached, detached and orphaned supports are all named in the notes of the editing command.
 * @invariant pure; a support is never deleted here (a run delete removes its supports in delete_pipe_run); supports of unchanged runs are not touched
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { PipeSupportElement } from '@aec/building/types';
import { regenerateBuilding } from '../../building/evaluate/evaluateElements';
import { carrierOfSupport } from '../../industrial/piping/pipeCarrier';
import { reconcilePipeSupports, reconciliationNote } from '../../industrial/piping/pipeSupportAttach';
import { absolutePointMm } from '../../industrial/piping/pipeSupportLayout';
import { nearestOnRoute } from '../../industrial/piping/routeSupport';
import { modelUnits } from '../../industrial/steelDesign/steelMemberBars';
import { getPiping } from './model';
import { supportsByRun } from './runSupports';

interface Result {
  readonly document: CadDocument;
  readonly notes: string[];
  readonly affected: string[];
}

const NONE = (document: CadDocument): Result => ({ document, notes: [], affected: [] });

const geometryOf = (doc: CadDocument, support: PipeSupportElement): string => {
  const pipe = doc.building === undefined ? undefined : carrierOfSupport(doc, doc.building, support);
  return JSON.stringify(pipe === undefined ? null : [pipe.points, pipe.diameter]);
};

/**
 * Re-snaps and re-attaches the supports of the runs whose centreline or size changed between `previous` and `next`.
 * @failure a support whose run no longer exists is kept as it is and named in the notes
 */
export function reconcileRunSupports(previous: CadDocument, next: CadDocument): Result {
  if (next.plant === previous.plant || next.building === undefined) return NONE(next);
  const building = next.building;
  const carried = supportsByRun(next);
  const orphans = Object.values(building.elements).filter(
    (element): element is PipeSupportElement =>
      element.category === 'pipeSupport' &&
      building.elements[element.pipeId] === undefined &&
      getPiping(next).runs[element.pipeId] === undefined,
  );
  const orphanNotes = orphans.flatMap((support) =>
    getPiping(previous).runs[support.pipeId] === undefined
      ? []
      : [`${support.mark} left in place: its run ${support.pipeId} no longer exists (delete the support or route the run again)`],
  );
  const changed = Object.values(carried)
    .flat()
    .filter((support) => geometryOf(previous, support) !== geometryOf(next, support));
  if (changed.length === 0)
    return { document: next, notes: orphanNotes.length === 0 ? [] : [`pipe supports: ${orphanNotes.join('; ')}.`], affected: [] };
  const units = modelUnits(next);
  const moved: Array<{ support: PipeSupportElement; by: number }> = [];
  const elements = { ...building.elements };
  for (const support of changed) {
    const pipe = carrierOfSupport(next, building, support);
    if (pipe === undefined) continue;
    const route = pipe.points.map((point): Vec3 => absolutePointMm(units, support.levelId, point));
    const here = absolutePointMm(units, support.levelId, support.position);
    const snap = nearestOnRoute(route, here);
    if (snap === null || snap.distance < 1e-6) continue;
    const level = units.elevationMm(support.levelId);
    elements[support.id] = { ...support, position: [snap.point[0], snap.point[1], snap.point[2] - level] };
    moved.push({ support, by: snap.distance });
  }
  const edited = { ...building, elements };
  const reconciled = reconcilePipeSupports(
    next,
    edited,
    changed.map((support) => support.id),
  );
  const document = regenerateBuilding(next, reconciled.building);
  const movedNote =
    moved.length === 0
      ? ''
      : `moved to stay on the run: ${moved.map(({ support, by }) => `${support.mark} ${+by.toFixed(3)} mm`).join(', ')}.`;
  const attachNote = reconciliationNote(reconciled).trim();
  const notes = [
    `pipe supports of ${[...new Set(changed.map((support) => support.pipeId))].join(', ')}: ${changed.length} re-checked${movedNote === '' ? '.' : `; ${movedNote}`}`,
    ...(attachNote === '' ? [] : [attachNote]),
    ...(orphanNotes.length === 0 ? [] : [`pipe supports: ${orphanNotes.join('; ')}.`]),
  ];
  const ids = changed.flatMap((support) => [support.id, ...(document.building?.elements[support.id]?.entityIds ?? [])]);
  return { document, notes, affected: ids };
}
