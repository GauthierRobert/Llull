/** add_helix_spring: compression spring as one `sweep` entity (round wire along a smooth helix spline). */

import type { Vec3 } from '../../model/types';
import { catmullRomBeziers, mapSegment } from '../../geometry/curveSegments';
import type { CommandResult } from '../types';
import { defineCommand, z, looseVec3 as vec3, colorField } from '../schema';
import { nextId } from '../../lib/id';
import { ORIGIN, add3, sub3 } from '../../lib/vec3';
import { applyMat3, eulerFromMat, matFromAxis, unitAxisOrNull } from '../../lib/axisRotation';
import { compactNumber as fmt, vecText } from '../../lib/compactNumber';
import { commitSolid, positionField } from './shared';
import { newEntity } from '../entity/newEntity';
import { noop } from '../noop';

const SAMPLES_PER_TURN = 16;
const MAX_SPRING_TURNS = 200;

interface SpringShape {
  readonly wireRadius: number;
  readonly coilRadius: number;
  readonly turns: number;
  /** Centerline height between the first and last centerline point. */
  readonly rise: number;
  readonly closedEnds: boolean;
}

/** Centerline height z at `t` turns (0..turns): closed ends use one flat (pitch = wire diameter) turn each end. */
function centerlineZ(shape: SpringShape, t: number): number {
  const flat = shape.wireRadius * 2;
  if (!shape.closedEnds) return (shape.rise * t) / shape.turns;
  const middlePitch = (shape.rise - 2 * flat) / (shape.turns - 2);
  const startFlat = Math.min(t, 1);
  const middle = Math.max(0, Math.min(t, shape.turns - 1) - 1);
  const endFlat = Math.max(0, t - (shape.turns - 1));
  return flat * (startFlat + endFlat) + middlePitch * middle;
}

/** Centerline samples (local frame: axis +Z, base plane at z = 0, wire resting on it) at `SAMPLES_PER_TURN` per turn. */
function helixPoints(shape: SpringShape): Vec3[] {
  const count = Math.max(8, Math.ceil(shape.turns * SAMPLES_PER_TURN));
  return Array.from({ length: count + 1 }, (_, i): Vec3 => {
    const t = (shape.turns * i) / count;
    const phi = 2 * Math.PI * t;
    return [shape.coilRadius * Math.cos(phi), shape.coilRadius * Math.sin(phi), centerlineZ(shape, t) + shape.wireRadius];
  });
}

/** Resolve wire radius (from radius or diameter) or an error string. */
function wireRadiusOf(radius: number | undefined, diameter: number | undefined): number | string {
  const value = radius ?? (diameter === undefined ? undefined : diameter / 2);
  if (value === undefined) return 'give wireRadius or wireDiameter';
  return Number.isFinite(value) && value > 0 ? value : `wire size must be finite and > 0, got ${value}`;
}

/** `{ turns, rise }` from any two of pitch / turns / length (free length incl. wire: rise = length - d); pitch + turns win. */
function resolveRise(
  d: number,
  pitch: number | undefined,
  turns: number | undefined,
  length: number | undefined,
): { turns: number; rise: number } | string {
  const positive = (v: number | undefined): boolean => v === undefined || (Number.isFinite(v) && v > 0);
  if (!positive(pitch) || !positive(turns) || !positive(length)) return 'pitch, turns and length must be finite and > 0';
  if (pitch !== undefined && turns !== undefined) return { turns, rise: pitch * turns };
  if (turns !== undefined && length !== undefined) return { turns, rise: length - d };
  if (pitch !== undefined && length !== undefined) return { turns: (length - d) / pitch, rise: length - d };
  return 'give at least two of pitch, turns, length';
}

/**
 * @affects creates 1 sweep entity (circular wire along a helix spline); position = world start of the wire centerline
 * @invariant coilRadius > wireRadius; pitch >= wire diameter; 0 < turns <= MAX_SPRING_TURNS
 * @failure bad dimensions / fewer than two of pitch,turns,length / zero axis -> no-op, affected:[]
 */
export const addHelixSpring = defineCommand({
  name: 'add_helix_spring',
  description:
    'Create a helical compression spring as one sweep solid (round wire swept along a smooth helix spline). ' +
    'The spring axis runs from position along axis (default +Z); the base plane center is at position and the ' +
    'spring extends to position + axis * free length, wire thickness included. ' +
    'Wire size: give wireRadius or wireDiameter. coilRadius is the MEAN coil radius (axis to wire centerline) and must exceed wireRadius. ' +
    'Give at least two of pitch (centerline advance per turn, >= wire diameter), turns (number of coils, may be fractional, <= 200) ' +
    'and length (free length = overall extent along the axis incl. wire). Pitch and turns win if all three are given. ' +
    'closedEnds=true flattens the first and last turn (pitch = wire diameter) like ground/closed spring ends; the middle ' +
    'turns get the pitch needed to keep the overall length (requires turns > 2). The result is a sweep entity, so booleans, measuring, rendering and STEP/STL export work like any solid. Returns the entity id and data {freeLength, turns, pitch, wireDiameter, outerDiameter}.',
  params: z.object({
    wireRadius: z.number().describe('Wire radius in document units (> 0). Alternative: wireDiameter.').optional(),
    wireDiameter: z.number().describe('Wire diameter in document units (> 0). Used when wireRadius is absent.').optional(),
    coilRadius: z.number().describe('Mean coil radius (axis to wire centerline) in document units; must be > wire radius.'),
    pitch: z.number().describe('Centerline advance along the axis per full turn, document units; >= wire diameter.').optional(),
    turns: z.number().describe('Number of coils (may be fractional), 0 < turns <= 200.').optional(),
    length: z.number().describe('Free length along the axis incl. wire thickness, document units.').optional(),
    closedEnds: z.boolean().describe('Flatten the first and last turn to wire-diameter pitch. Default false. Needs turns > 2.').optional(),
    position: positionField('Center of the spring base plane (start of the spring). '),
    axis: vec3('Direction [dx, dy, dz] (non-zero, normalized) the spring extends along from position. Defaults to [0, 0, 1].').optional(),
    color: colorField('#8a8f98'),
    name: z.string().describe('Optional entity name, e.g. "Return spring".').optional(),
  }),
  run: (
    doc,
    { wireRadius, wireDiameter, coilRadius, pitch, turns, length, closedEnds = false, position = ORIGIN, axis, color = '#8a8f98', name },
  ): CommandResult => {
    const fail = (reason: string): CommandResult => noop(doc, `add_helix_spring failed: ${reason}; no-op.`);
    const r = wireRadiusOf(wireRadius, wireDiameter);
    if (typeof r === 'string') return fail(r);
    if (!Number.isFinite(coilRadius) || coilRadius <= r)
      return fail(`coilRadius (${coilRadius}) must be finite and > wireRadius (${fmt(r)})`);
    const resolved = resolveRise(2 * r, pitch, turns, length);
    if (typeof resolved === 'string') return fail(resolved);
    if (resolved.turns > MAX_SPRING_TURNS || resolved.turns <= 0)
      return fail(`turns must be in (0, ${MAX_SPRING_TURNS}], got ${fmt(resolved.turns)}`);
    const unitAxis = axis === undefined ? ([0, 0, 1] as Vec3) : unitAxisOrNull(axis);
    if (!unitAxis) return fail('axis must be 3 finite numbers with non-zero length');
    if (position.length !== 3 || !position.every(Number.isFinite)) return fail('position must be 3 finite numbers');
    const shape: SpringShape = { wireRadius: r, coilRadius, closedEnds, ...resolved };
    const pitchOut = resolved.rise / resolved.turns;
    const middlePitch = closedEnds ? (resolved.rise - 4 * r) / (resolved.turns - 2) : pitchOut;
    if (closedEnds && resolved.turns <= 2) return fail('closedEnds needs turns > 2');
    if (resolved.rise <= 0 || middlePitch < 2 * r * 0.999)
      return fail(`pitch ${fmt(middlePitch)} is below the wire diameter ${fmt(2 * r)} (coils would overlap) or length is too short`);
    const matrix = matFromAxis(unitAxis);
    const points = helixPoints(shape);
    const startLocal = points[0] as Vec3;
    const path = catmullRomBeziers(points, false).map((segment) => mapSegment(segment, (p: Vec3): Vec3 => sub3(p, startLocal)));
    const id = nextId('spring');
    const entity = newEntity(
      'sweep',
      id,
      { path, section: { shape: 'circle', radius: r } },
      add3(position, applyMat3(matrix, startLocal)),
      color,
      { rotation: eulerFromMat(matrix), name },
    );
    const freeLength = resolved.rise + 2 * r;
    const data = { freeLength, turns: resolved.turns, pitch: middlePitch, wireDiameter: 2 * r, outerDiameter: 2 * (coilRadius + r) };
    return {
      ...commitSolid(
        doc,
        entity,
        `Added helix spring ${id}: ${fmt(resolved.turns)} turns, pitch ${fmt(middlePitch)}, wire Ø${fmt(2 * r)}, ` +
          `mean coil radius ${fmt(coilRadius)}, free length ${fmt(freeLength)} along ${vecText(unitAxis)}`,
      ),
      data,
    };
  },
});
