/**
 * Valve operators (02 RTE §5.8, V1): the envelope of the handwheel, gear box or actuator of a valve, from the catalogue row and the stem direction. All
 * lengths are mm along the stem axis, which points from the valve centre toward the operator:
 *
 * - `stemHeight`: valve centre to the top of the operator (the handwheel centre of a plain valve);
 * - `handwheelDiameter` (+ `handwheelThickness`, else `WHEEL_THICKNESS_FRACTION` of the diameter): a disc centred at `stemHeight`;
 * - `gearboxDiameter` + `gearboxHeight`, `actuatorDiameter` + `actuatorHeight`: a cylinder whose top is at `stemHeight`.
 * A valve row without `stemHeight` has no envelope (nothing is guessed); the operator kind is the most complex body the row describes.
 * @invariant pure; orientation is the stored stem direction, so rotating a stem rotates the envelope
 */

import type { Vec3 } from '@core/model/vectors';
import type { RoutedPart } from '@aec/plant/types';
import { add3, len3, scale3 } from '@lib/vec3';

/** Named default of a handwheel thickness when the row gives none, as a fraction of its diameter. */
const WHEEL_THICKNESS_FRACTION = 0.06;

export type OperatorKind = 'handwheel' | 'gear' | 'actuator';

/** One cylinder of the envelope: base centre, unit axis, length and radius. */
export interface OperatorBody {
  /** `<valve part id>/wheel`, `/gear` or `/actuator`: also the id of its clash body. */
  readonly id: string;
  readonly kind: OperatorKind;
  readonly from: Vec3;
  readonly axis: Vec3;
  readonly lengthMm: number;
  readonly radiusMm: number;
}

const positive = (value: number | undefined): value is number => value !== undefined && value > 0;

/** The envelope cylinders of a valve part (none without a centre, a stem direction and a `stemHeight`). */
export function operatorBodies(valve: Pick<RoutedPart, 'id' | 'centre' | 'stemDirection' | 'dims'>): OperatorBody[] {
  const { centre, stemDirection: axis, dims } = valve;
  const top = dims['stemHeight'];
  if (centre === undefined || axis === undefined || !(len3(axis) > 0) || !positive(top)) return [];
  const bodies: OperatorBody[] = [];
  const cylinderBelowTop = (kind: OperatorKind, suffix: string, diameter: number | undefined, height: number | undefined): void => {
    if (!positive(diameter) || !positive(height)) return;
    bodies.push({
      id: `${valve.id}/${suffix}`,
      kind,
      from: add3(centre, scale3(axis, top - height)),
      axis,
      lengthMm: height,
      radiusMm: diameter / 2,
    });
  };
  cylinderBelowTop('actuator', 'actuator', dims['actuatorDiameter'], dims['actuatorHeight']);
  cylinderBelowTop('gear', 'gear', dims['gearboxDiameter'], dims['gearboxHeight']);
  const wheel = dims['handwheelDiameter'];
  if (positive(wheel)) {
    const thickness = dims['handwheelThickness'] ?? WHEEL_THICKNESS_FRACTION * wheel;
    bodies.push({
      id: `${valve.id}/wheel`,
      kind: 'handwheel',
      from: add3(centre, scale3(axis, top - thickness / 2)),
      axis,
      lengthMm: thickness,
      radiusMm: wheel / 2,
    });
  }
  return bodies;
}

/** The operator kind of a valve: actuator, else gear box, else handwheel; null when its row describes no envelope. */
export function operatorKind(bodies: readonly OperatorBody[]): OperatorKind | null {
  return (['actuator', 'gear', 'handwheel'] as const).find((kind) => bodies.some((body) => body.kind === kind)) ?? null;
}
