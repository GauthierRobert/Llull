/**
 * Pipe supports follow their run (02 RTE V1 part 2), the same idea as `reconcilePipeSupports` for building pipes: after a command changed a run (stretch
 * when equipment moved, `edit_route`, an eccentric reducer, a size or spec change) each support of that run is re-snapped to the nearest point of the new
 * centreline and re-attached to the steel in reach, or left unattached; a run that is broken (the stretch failed) keeps its supports where they are. Nothing
 * is dropped silently: moved, re-attached, detached and orphaned supports are all named in the notes of the editing command. `followCarrier` is the one
 * snap-and-attach step, shared with `convert_pipe_run` (V1c: the supports of a replaced legacy pipe move onto its run).
 * @invariant pure; a support is never deleted here (a run delete removes its supports in delete_pipe_run); supports of unchanged runs are not touched
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { BuildingModel, PipeSupportElement } from '@aec/building/types';
import { regenerateBuilding } from '../../building/evaluate/evaluateElements';
import { carrierOfSupport, orphanSupports } from '../../industrial/piping/pipeCarrier';
import { reconcilePipeSupports, reconciliationNote, type SupportReconciliation } from '../../industrial/piping/pipeSupportAttach';
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

interface Moved {
  readonly support: PipeSupportElement;
  /** Distance from the old position to the nearest point of the carrier centreline, mm. */
  readonly by: number;
}

const NONE = (document: CadDocument): Result => ({ document, notes: [], affected: [] });

const geometryOf = (doc: CadDocument, support: PipeSupportElement): string => {
  const pipe = doc.building === undefined ? undefined : carrierOfSupport(doc, doc.building, support);
  return JSON.stringify(pipe === undefined ? null : [pipe.points, pipe.diameter]);
};

/** Distance (mm) of each support to its carrier centreline and the snapped position (document units, relative to the support's level); carrier-less supports are skipped. */
function snapOf(doc: CadDocument, building: BuildingModel, supports: ReadonlyArray<PipeSupportElement>): Array<Moved & { position: Vec3 }> {
  const units = modelUnits(doc);
  return supports.flatMap((support) => {
    const pipe = carrierOfSupport(doc, building, support);
    if (pipe === undefined) return [];
    const route = pipe.points.map((point): Vec3 => absolutePointMm(units, support.levelId, point));
    const snap = nearestOnRoute(route, absolutePointMm(units, support.levelId, support.position));
    if (snap === null) return [];
    const level = units.elevationMm(support.levelId);
    return [{ support, by: snap.distance, position: [snap.point[0], snap.point[1], snap.point[2] - level] }];
  });
}

/** How far each support (which names its carrier in `doc.building`) is from that carrier's centreline, mm. */
export const supportOffsets = (doc: CadDocument, supports: ReadonlyArray<PipeSupportElement>): Moved[] =>
  snapOf(doc, doc.building as BuildingModel, supports).map(({ support, by }) => ({ support, by }));

export interface SupportFollow extends Result {
  readonly moved: Moved[];
  readonly reconciliation: SupportReconciliation;
}

/**
 * Snaps `supports` of `next` (each names its carrier) onto the nearest point of the carrier centreline, re-attaches them to steel and rebuilds their entities.
 * @invariant pure; a support already on the centreline does not move
 */
export function followCarrier(next: CadDocument, supports: ReadonlyArray<PipeSupportElement>): SupportFollow {
  const building = next.building as BuildingModel;
  const moved: Moved[] = [];
  const elements = { ...building.elements };
  for (const { support, by, position } of snapOf(next, building, supports)) {
    if (by < 1e-6) continue;
    elements[support.id] = { ...support, position };
    moved.push({ support, by });
  }
  const reconciliation = reconcilePipeSupports(
    next,
    { ...building, elements },
    supports.map((support) => support.id),
  );
  const document = regenerateBuilding(next, reconciliation.building);
  const movedNote =
    moved.length === 0
      ? ''
      : `moved to stay on the run: ${moved.map(({ support, by }) => `${support.mark} ${+by.toFixed(3)} mm`).join(', ')}.`;
  const attachNote = reconciliationNote(reconciliation).trim();
  const notes = [
    `pipe supports of ${[...new Set(supports.map((support) => support.pipeId))].join(', ')}: ${supports.length} re-checked${movedNote === '' ? '.' : `; ${movedNote}`}`,
    ...(attachNote === '' ? [] : [attachNote]),
  ];
  const affected = supports.flatMap((support) => [support.id, ...(document.building?.elements[support.id]?.entityIds ?? [])]);
  return { document, notes, affected, moved, reconciliation };
}

/**
 * Re-snaps and re-attaches the supports of the runs whose centreline or size changed between `previous` and `next`.
 * @failure a support whose run no longer exists is kept as it is and named in the notes (RTE_SUPPORT_ORPHAN in check_pipe_supports)
 */
export function reconcileRunSupports(previous: CadDocument, next: CadDocument): Result {
  if (next.plant === previous.plant || next.building === undefined) return NONE(next);
  const orphanNotes = orphanSupports(next, next.building).flatMap((support) =>
    getPiping(previous).runs[support.pipeId] === undefined
      ? []
      : [
          `${support.mark} left in place: its run ${support.pipeId} no longer exists (RTE_SUPPORT_ORPHAN: delete the support or route the run again)`,
        ],
  );
  const orphaned = orphanNotes.length === 0 ? [] : [`pipe supports: ${orphanNotes.join('; ')}.`];
  const changed = Object.values(supportsByRun(next))
    .flat()
    .filter((support) => geometryOf(previous, support) !== geometryOf(next, support));
  if (changed.length === 0) {
    // Orphaned supports lose their geometry exactly as on load (no carrier, no entities): live and loaded documents are the same document.
    if (orphanNotes.length === 0) return { document: next, notes: orphaned, affected: [] };
    const document = regenerateBuilding(next, next.building);
    return { document, notes: orphaned, affected: [...new Set(orphanSupports(next, next.building).map((support) => support.id))] };
  }
  const followed = followCarrier(next, changed);
  return { document: followed.document, notes: [...followed.notes, ...orphaned], affected: followed.affected };
}
