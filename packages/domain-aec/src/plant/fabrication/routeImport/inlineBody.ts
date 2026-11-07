/**
 * The inline body of a valve or an instrument read from a PCF record (plant 05 ISO M6c): its centre, the spindle direction of a valve, the face-to-face length and end type
 * of an instrument. The centre is the midpoint of the two END-POINTs; `shift` is the offset of the actual axis from the stored one (an eccentric reducer upstream).
 */

import type { Vec3 } from '@core/model/vectors';
import { distance3, sub3 } from '@lib/vec3';
import type { NetworkComponent } from '../model';
import type { PlannedFlat } from './eccentric';

export interface PlannedInline {
  readonly type: 'valve' | 'reducer' | 'flangedJoint' | 'instrument';
  readonly componentId: string;
  readonly centre: Vec3;
  /** Reducers: the size the run continues at. */
  readonly dn2?: number;
  /** Valves: direction from the centre toward the handwheel, when the file gives a spindle direction. */
  readonly stem?: Vec3;
  /** Eccentric reducers (`type` reducer): the flat side; absent = concentric. */
  readonly flat?: PlannedFlat;
  /** Instruments: face-to-face length (distance between the END-POINTs) and ends: flanged (between flange sets) or butt welded. */
  readonly lengthMm?: number;
  readonly endType?: 'FL' | 'BW';
}

const SPINDLE: Readonly<Record<string, Vec3>> = {
  UP: [0, 0, 1],
  DOWN: [0, 0, -1],
  NORTH: [0, 1, 0],
  SOUTH: [0, -1, 0],
  EAST: [1, 0, 0],
  WEST: [-1, 0, 0],
};

const midpoint = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

const stemOf = (component: NetworkComponent): { stem?: Vec3 } => {
  const stem = SPINDLE[component.extra?.['SPINDLE-DIRECTION'] ?? ''];
  return stem === undefined ? {} : { stem };
};

/** The planned inline valve or instrument of `component` between its END-POINTs `a` and `b`; `flanged` = it sits between flange sets (an instrument then gets flanged ends). */
export function bodyOf(component: NetworkComponent, a: Vec3, b: Vec3, shift: Vec3, flanged: boolean): PlannedInline {
  const centre = sub3(midpoint(a, b), shift);
  if (component.type === 'INSTRUMENT')
    return { type: 'instrument', componentId: component.id, centre, lengthMm: distance3(a, b), endType: flanged ? 'FL' : 'BW' };
  return { type: 'valve', componentId: component.id, centre, ...stemOf(component) };
}
