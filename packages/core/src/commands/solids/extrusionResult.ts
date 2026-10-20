import type { CadDocument, Vec2, Vec3 } from '../../model/types';
import type { CurveSegment } from '../../model/curve';
import type { CommandResult } from '../types';
import { noop } from '../noop';
import { newEntity } from '../entity/newEntity';
import { nextId } from '../../lib/id';
import { commitSolid, resolveRotation } from './shared';

/** `{ curves }` when the loop has an arc or Bézier (a pure polygon needs no exact copy). */
export function exactCurves(curves: ReadonlyArray<CurveSegment<Vec2>>): { curves?: ReadonlyArray<CurveSegment<Vec2>> } {
  return curves.some((segment) => segment.type !== 'line') ? { curves } : {};
}

/** The extrusion entity of an already validated profile, committed to `doc`. */
export function extrusionResult(
  doc: CadDocument,
  extrusion: {
    readonly profile: ReadonlyArray<readonly [number, number]>;
    readonly depth: number;
    readonly position: Vec3;
    readonly rotation: unknown;
    readonly axis: unknown;
    readonly color: string;
    readonly curves?: ReadonlyArray<CurveSegment<Vec2>>;
    readonly describe: (id: string) => string;
  },
): CommandResult {
  const resolved = resolveRotation(extrusion.axis, extrusion.rotation);
  if (resolved.error !== undefined) return noop(doc, `extrude_profile: ${resolved.error}; no-op.`);
  const id = nextId('ext');
  const entity = newEntity(
    'extrusion',
    id,
    { profile: extrusion.profile, depth: extrusion.depth, ...exactCurves(extrusion.curves ?? []) },
    extrusion.position,
    extrusion.color,
    { rotation: resolved.rotation },
  );
  return commitSolid(doc, entity, extrusion.describe(id));
}
