// Dry run of a cage gesture for the drag preview. Pure wrapper over `previewCageCommand`: the same command the commit dispatches, run
// on the current document, with the ghost triangles (world space) brought back into entity-local coordinates.

import type { CadDocument } from '@core/model/types';
import { previewCageCommand } from '@core/commands/subdivision/preview';
import { inverseEulerXYZ } from '@lib/eulerRotation';
import type { Vec3 } from '@core/model/types';
import type { CagePreviewState } from '@ui/store/directEditStore';
import type { CageCommand } from './gestureCommands';

/** Cages above ~100 vertices are previewed at no more than this many levels. */
const PREVIEW_MAX_LEVELS = 2;

export function runCagePreview(doc: CadDocument, command: CageCommand): CagePreviewState {
  const result = previewCageCommand(doc, command.name, command.params, PREVIEW_MAX_LEVELS);
  if (!result.ok || result.entity === null) return { ok: false, summary: result.summary, entity: null, triangles: [] };
  const { position, rotation } = result.entity;
  const local = (p: Vec3): Vec3 => inverseEulerXYZ([p[0] - position[0], p[1] - position[1], p[2] - position[2]], rotation);
  return {
    ok: true,
    summary: result.summary,
    entity: result.entity,
    triangles: result.triangles.map(([a, b, c]) => [local(a), local(b), local(c)] as const),
  };
}
