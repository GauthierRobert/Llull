/**
 * Preview of a cage command for the viewport (04 DIR §2.2, §5.9): the same pure command the commit will dispatch, run on the current
 * document without keeping the result. The ghost may be refined less than the committed entity (display only).
 */

import type { CadDocument, SubdivisionEntity } from '../../model/types';
import type { Triangle } from '../../geometry/triangles';
import { entityLocalToWorld } from '../../geometry/entityFrame';
import { subdivisionTriangles } from '../../geometry/subdivision';
import type { CommandError } from '../types';
import { execute } from '../execute';

/** Cage commands a preview may run. */
const PREVIEWABLE = new Set([
  'edit_subdivision_cage',
  'set_cage_crease',
  'set_cage_symmetry',
  'extrude_cage_faces',
  'inset_cage_faces',
  'loop_cut_cage',
]);

/** Cages above this many vertices are previewed at no more than `maxLevels`. */
const FULL_QUALITY_VERTICES = 100;

export interface CagePreview {
  readonly ok: boolean;
  readonly summary: string;
  readonly error?: CommandError;
  /** The edited entity as committed would store it (full `levels`), or null when the command refused. */
  readonly entity: SubdivisionEntity | null;
  /** Levels the ghost triangles were built at. */
  readonly displayLevels: number;
  /** World-space ghost triangles of the edited entity (full placement: rotation, then position) at `displayLevels` (empty when refused). */
  readonly triangles: Triangle[];
}

/**
 * Run cage command `name` with `params` on `doc` and return the ghost; `doc` is never changed and nothing is recorded.
 * @invariant ids minted by the preview equal those the real commit mints (same document, same step number)
 * @failure unknown / non-cage command or a refusal -> ok false with the command's summary and error
 */
export function previewCageCommand(doc: CadDocument, name: string, params: object, maxLevels = 2): CagePreview {
  const refused = (summary: string, error?: CommandError): CagePreview => ({
    ok: false,
    summary,
    ...(error === undefined ? {} : { error }),
    entity: null,
    displayLevels: 0,
    triangles: [],
  });
  if (!PREVIEWABLE.has(name)) return refused(`${name} is not a previewable cage command`);
  const result = execute(doc, name, params);
  const id = (params as { id?: unknown }).id;
  const edited = typeof id === 'string' ? result.document.entities[id] : undefined;
  if (result.affected.length === 0 || edited?.kind !== 'subdivision') return refused(result.summary, result.error);
  const displayLevels = edited.vertices.length > FULL_QUALITY_VERTICES ? Math.min(edited.levels, maxLevels) : edited.levels;
  return {
    ok: true,
    summary: result.summary,
    entity: edited,
    displayLevels,
    triangles: subdivisionTriangles({ ...edited, levels: displayLevels }, [0, 0, 0], (p) => entityLocalToWorld(edited, p)),
  };
}
