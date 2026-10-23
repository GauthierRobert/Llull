/** Uniform scaling of the rails, anchors and surface reference of a sweep (`scale_entity`): the fields that hold lengths besides the path and section. */

import type { SweepEntity } from '../../model/types';
import { scaleCurve } from '../nurbsCurve';
import { scaleSurface } from '../nurbsSurface';

/** The scaled `rails`, `anchors` and surface `orientation` of `sweep` by factor `f` (only the fields it has). */
export function scaledSweepDesign(sweep: SweepEntity, f: number): Partial<SweepEntity> {
  const { rails, anchors, orientation } = sweep;
  return {
    ...(rails === undefined ? {} : { rails: rails.map((rail) => ({ ...rail, curve: scaleCurve(rail.curve, f) })) }),
    ...(anchors === undefined ? {} : { anchors: anchors.map(([x, y]) => [x * f, y * f] as const) }),
    ...(orientation?.mode === 'surface'
      ? { orientation: { ...orientation, surface: scaleSurface(orientation.surface, f), tolerance: orientation.tolerance * f } }
      : {}),
  };
}
