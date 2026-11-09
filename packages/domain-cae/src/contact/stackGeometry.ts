/** Where the plates of a fastener stack lie along its axis (document length units): the plate extents, interfaces and the grip mid-plane. */

import { boundsCorners, entityBoundsInDoc } from '@core/geometry/bounds';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { add3, cross3, dot3, scale3, sub3 } from '@lib/vec3';
import type { StackView } from './stackRead';

export interface PlateExtent {
  readonly entityId: string;
  /** Extent of the plate bounds along the axis, as s in `origin + s * direction`. */
  readonly low: number;
  readonly high: number;
}

export interface StackGeometry {
  readonly direction: Vec3;
  readonly plates: readonly PlateExtent[];
  /** Axis point at `s`. */
  readonly pointAt: (s: number) => Vec3;
  /** Unit vector perpendicular to the axis. */
  readonly lateral: Vec3;
}

/**
 * Plate extents along the axis, sorted by their low end.
 * @invariant bounds are the axis-aligned bounds of each plate projected on the axis (exact for plates normal to the axis, an upper bound otherwise)
 * @failure a plate that is not a document entity, a zero axis -> { message }
 */
export function stackGeometry(doc: CadDocument, stack: StackView): StackGeometry | { readonly message: string } {
  const length = Math.hypot(...stack.axis.direction);
  if (!(length > 0)) return { message: `stack '${stack.id}' has a zero axis direction` };
  const direction = scale3(stack.axis.direction, 1 / length);
  const plates: PlateExtent[] = [];
  for (const layer of stack.layers) {
    const entity = Object.hasOwn(doc.entities, layer.entityId) ? doc.entities[layer.entityId] : undefined;
    if (entity === undefined) return { message: `layer '${layer.entityId}' of stack '${stack.id}' is not an entity of the document` };
    const along = boundsCorners(entityBoundsInDoc(doc, entity)).map((corner) => dot3(sub3(corner, stack.axis.origin), direction));
    plates.push({ entityId: layer.entityId, low: Math.min(...along), high: Math.max(...along) });
  }
  plates.sort((a, b) => a.low - b.low);
  const trial: Vec3 = Math.abs(direction[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const across = cross3(direction, trial);
  return {
    direction,
    plates,
    pointAt: (s) => add3(stack.axis.origin, scale3(direction, s)),
    lateral: scale3(across, 1 / Math.hypot(...across)),
  };
}
