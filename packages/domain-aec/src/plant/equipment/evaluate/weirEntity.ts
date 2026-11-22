/** Derived mesh of the kettle weir plate: an extrusion of the circular segment, standing across the enlarged shell. */

import type { ExtrusionEntity } from '@core/model/types';
import type { CurveSegment } from '@core/model/curve';
import type { Vec2 } from '@core/model/vectors';
import { eulerFromMat, mulMat3, type Mat3 } from '@lib/axisRotation';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import { base } from '../../../building/evaluate/entities';
import type { KettleWeir } from '../geometry/kettleWeir';
import { toWorld } from '../geometry/ports';
import { SUPPORT_COLOR } from './revolutionPart';

const ARC_POINTS = 48;

/** Local frame of the extrusion: profile x -> equipment +Y, profile y -> equipment +Z, depth -> equipment +X (the shell axis). */
const PROFILE_TO_EQUIPMENT: Mat3 = [0, 0, 1, 1, 0, 0, 0, 1, 0];

/**
 * @param axisZ elevation of the shell axis in the equipment frame
 * @invariant profile = segment of the enlarged inside circle below the chord at weirHeight above its lowest point; exact curves = one arc + one line
 */
export function weirEntity(element: EquipmentElement, level: BuildingLevel, weir: KettleWeir, axisZ: number): ExtrusionEntity {
  const { radius, height } = weir;
  const chordY = height - radius;
  const half = Math.sqrt(Math.max(0, radius * radius - chordY * chordY));
  const start: Vec2 = [-half, chordY];
  const end: Vec2 = [half, chordY];
  const sweep = Math.atan2(chordY, half);
  const from = Math.PI - sweep;
  const arc: Vec2[] = Array.from({ length: ARC_POINTS + 1 }, (_unused, step): Vec2 => {
    const angle = from + ((Math.PI + 2 * sweep) * step) / ARC_POINTS;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });
  const curves: CurveSegment<Vec2>[] = [
    { type: 'arc', points: [start, [0, -radius], end] },
    { type: 'line', points: [end, start] },
  ];
  const turn: Mat3 = [Math.cos(element.angle), -Math.sin(element.angle), 0, Math.sin(element.angle), Math.cos(element.angle), 0, 0, 0, 1];
  return {
    ...base(
      element,
      { part: 'weir', label: `Kettle weir ${element.mark}` },
      toWorld(element, level, [weir.xFront, 0, axisZ]),
      eulerFromMat(mulMat3(turn, PROFILE_TO_EQUIPMENT)),
      SUPPORT_COLOR,
    ),
    kind: 'extrusion',
    profile: arc,
    depth: weir.thickness,
    curves,
  };
}
