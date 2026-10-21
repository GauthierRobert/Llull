/** Evaluates drainage structures and pipes into mesh, plan and label entities. */

import type { Entity, MeshData, Vec3 } from '@core/model/types';
import type { ManholeObject, PipeObject } from '@aec/civil/types';
import { circlePolygon } from '@lib/arc';
import { cross3, normalize3OrZero } from '@lib/vec3';
import { toMm } from '@core/model/units';
import { civilLine, civilMesh, civilPolyline, civilText } from '../entities';
import { labelHeight, type CivilContext } from '../context';
import { civilObject } from '../model';

const MANHOLE_SIDES = 16;
const PIPE_SIDES = 12;

/** Closed prism of `sides` facets and `radius` about the axis `bottom` -> `top` (outward normals). */
function axisPrismMesh(bottom: Vec3, top: Vec3, radius: number, sides: number): MeshData {
  const axis = normalize3OrZero([top[0] - bottom[0], top[1] - bottom[1], top[2] - bottom[2]]);
  const reference: Vec3 = Math.abs(axis[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = normalize3OrZero(cross3(axis, reference));
  const v = cross3(axis, u);
  const positions: number[] = [];
  for (const centre of [bottom, top]) {
    for (let i = 0; i < sides; i += 1) {
      const angle = (2 * Math.PI * i) / sides;
      const c = Math.cos(angle) * radius;
      const s = Math.sin(angle) * radius;
      positions.push(centre[0] + u[0] * c + v[0] * s, centre[1] + u[1] * c + v[1] * s, centre[2] + u[2] * c + v[2] * s);
    }
  }
  positions.push(...bottom, ...top);
  const bottomCentre = 2 * sides;
  const topCentre = 2 * sides + 1;
  const indices: number[] = [];
  for (let i = 0; i < sides; i += 1) {
    const j = (i + 1) % sides;
    indices.push(i, j, sides + j, i, sides + j, sides + i);
    indices.push(topCentre, sides + i, sides + j);
    indices.push(bottomCentre, j, i);
  }
  return { positions, indices };
}

export function evaluateManhole(context: CivilContext, manhole: ManholeObject): Entity[] {
  const [x, y] = manhole.position;
  const radius = manhole.diameter / 2;
  const bottom: Vec3 = [x, y, manhole.invertElevation];
  const top: Vec3 = [x, y, manhole.rimElevation];
  return [
    civilMesh(manhole, 'body', manhole.name, 'structures', axisPrismMesh(bottom, top, radius, MANHOLE_SIDES)),
    civilPolyline(
      manhole,
      'plan',
      `${manhole.name} plan`,
      'structures',
      circlePolygon(manhole.position, radius, MANHOLE_SIDES),
      true,
      manhole.rimElevation,
    ),
    civilText(manhole, 'label', manhole.name, 'annotation', top, labelHeight(context.doc)),
  ];
}

/** Pipe label, e.g. "Ø300 PVC 1.25 %" (diameter in mm, slope in percent). */
export function pipeLabel(context: CivilContext, pipe: PipeObject, planLength: number): string {
  const slope = planLength > 0 ? ((pipe.invertFrom - pipe.invertTo) / planLength) * 100 : 0;
  return `Ø${Math.round(toMm(context.doc, pipe.diameter))} ${pipe.material} ${slope.toFixed(2)} %`;
}

/** Text angle (rad) of a pipe running along (dx, dy), flipped by 180 degrees when it would read upside down: result in (-pi/2, pi/2]. @pure */
export function readableAngle(dx: number, dy: number): number {
  const angle = Math.atan2(dy, dx);
  if (angle > Math.PI / 2 + 1e-9) return angle - Math.PI;
  if (angle <= -Math.PI / 2 + 1e-9) return angle + Math.PI;
  return angle;
}

export function evaluatePipe(context: CivilContext, pipe: PipeObject): Entity[] {
  const from = civilObject(context.civil, pipe.fromId, 'manhole');
  const to = civilObject(context.civil, pipe.toId, 'manhole');
  if (!from || !to) return [];
  const radius = pipe.diameter / 2;
  const dx = to.position[0] - from.position[0];
  const dy = to.position[1] - from.position[1];
  const start: Vec3 = [from.position[0], from.position[1], pipe.invertFrom + radius];
  const end: Vec3 = [to.position[0], to.position[1], pipe.invertTo + radius];
  const middle: Vec3 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2];
  return [
    civilMesh(pipe, 'body', pipe.name, 'pipes', axisPrismMesh(start, end, radius, PIPE_SIDES)),
    civilLine(pipe, 'plan', `${pipe.name} plan`, 'pipes', from.position, to.position, middle[2]),
    civilText(
      pipe,
      'label',
      pipeLabel(context, pipe, Math.hypot(dx, dy)),
      'annotation',
      middle,
      labelHeight(context.doc),
      readableAngle(dx, dy),
    ),
  ];
}
