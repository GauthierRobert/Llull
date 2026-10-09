/**
 * Evaluates drainage structures and pipes into mesh, plan and label entities.
 * @layer domain-aec/civil
 * @pure
 */

import type { Entity, MeshData, Vec2, Vec3 } from '@core/model/types';
import type { ManholeObject, PipeObject } from '@core/model/civil';
import { toMm } from '../model';
import { civilLine, civilMesh, civilPolyline, civilText } from './entities';
import { labelHeight, type CivilContext } from './context';
import { civilObject } from './model';

const MANHOLE_SIDES = 16;
const PIPE_SIDES = 12;

type Triple = [number, number, number];

function normalized(v: Triple): Triple {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Triple, b: Triple): Triple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Closed prism of `sides` facets and `radius` about the axis `bottom` -> `top` (outward normals). */
export function prismMesh(bottom: Vec3, top: Vec3, radius: number, sides: number): MeshData {
  const axis = normalized([top[0] - bottom[0], top[1] - bottom[1], top[2] - bottom[2]]);
  const reference: Triple = Math.abs(axis[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = normalized(cross(axis, reference));
  const v = cross(axis, u);
  const positions: number[] = [];
  for (const centre of [bottom, top]) {
    for (let i = 0; i < sides; i += 1) {
      const angle = (2 * Math.PI * i) / sides;
      const c = Math.cos(angle) * radius;
      const s = Math.sin(angle) * radius;
      positions.push(
        centre[0] + u[0] * c + v[0] * s,
        centre[1] + u[1] * c + v[1] * s,
        centre[2] + u[2] * c + v[2] * s,
      );
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

function circlePoints(centre: Vec2, radius: number, sides: number): Vec2[] {
  return Array.from({ length: sides }, (_, i): Vec2 => {
    const angle = (2 * Math.PI * i) / sides;
    return [centre[0] + Math.cos(angle) * radius, centre[1] + Math.sin(angle) * radius];
  });
}

export function evaluateManhole(context: CivilContext, manhole: ManholeObject): Entity[] {
  const [x, y] = manhole.position;
  const radius = manhole.diameter / 2;
  const bottom: Vec3 = [x, y, manhole.invertElevation];
  const top: Vec3 = [x, y, manhole.rimElevation];
  return [
    civilMesh(
      manhole,
      'body',
      manhole.name,
      'structures',
      prismMesh(bottom, top, radius, MANHOLE_SIDES),
    ),
    civilPolyline(
      manhole,
      'plan',
      `${manhole.name} plan`,
      'structures',
      circlePoints(manhole.position, radius, MANHOLE_SIDES),
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
    civilMesh(pipe, 'body', pipe.name, 'pipes', prismMesh(start, end, radius, PIPE_SIDES)),
    civilLine(pipe, 'plan', `${pipe.name} plan`, 'pipes', from.position, to.position, middle[2]),
    civilText(
      pipe,
      'label',
      pipeLabel(context, pipe, Math.hypot(dx, dy)),
      'annotation',
      middle,
      labelHeight(context.doc),
      Math.atan2(dy, dx),
    ),
  ];
}
