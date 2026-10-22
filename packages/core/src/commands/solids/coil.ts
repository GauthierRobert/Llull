/** add_coil (SC-F2): a round or rectangular section swept along a (optionally conical) helix; also the compression spring (closed ends, free length). */

import type { MeshData, SweepEntity, Vec3 } from '../../model/types';
import { catmullRomBeziers, mapSegment } from '../../geometry/curveSegments';
import { curveChain } from '../../geometry/nurbsChain';
import { helixCurve } from '../../lib/helix/helix';
import type { HelixDefinition } from '../../lib/helix/types';
import { screwMesh } from '../../geometry/threadTool';
import type { CommandResult } from '../types';
import { defineCommand, z, looseVec3 as vec3, colorField } from '../schema';
import { nextId } from '../../lib/id';
import { ORIGIN, sub3 } from '../../lib/vec3';
import { compactNumber as fmt, vecText } from '../../lib/compactNumber';
import { axisFrame, commitSolid, positionField } from './shared';
import { newEntity } from '../entity/newEntity';
import { failedWith } from '../noop';

const SAMPLES_PER_TURN = 16;
const MAX_COIL_TURNS = 200;
const MIN_COIL_TURNS = 0.1;

interface CoilShape {
  readonly radius: number;
  readonly endRadius: number;
  readonly pitch: number;
  readonly turns: number;
  readonly left: boolean;
  /** Round wire only: the first and last turn lie flat (pitch = wire diameter); the middle turns take the pitch that keeps the rise. */
  readonly closedEnds: boolean;
  /** Half the section extent along the axis: the coil rests on the base plane. */
  readonly halfHeight: number;
}

/** Centre-line radius at `t` in 0..1 along the coil. */
const radiusAt = (shape: CoilShape, t: number): number => shape.radius + (shape.endRadius - shape.radius) * t;

/** Centre-line height (above the base plane, before the wire half height) at `t` in 0..1; closed ends use one flat turn at each end. */
function centerlineZ(shape: CoilShape, t: number): number {
  const rise = shape.pitch * shape.turns;
  if (!shape.closedEnds) return rise * t;
  const flat = shape.halfHeight * 2;
  const turn = shape.turns * t;
  const middlePitch = (rise - 2 * flat) / (shape.turns - 2);
  return (
    flat * (Math.min(turn, 1) + Math.max(0, turn - (shape.turns - 1))) + middlePitch * Math.max(0, Math.min(turn, shape.turns - 1) - 1)
  );
}

/** Centre-line samples in the local frame (axis +Z, base plane z = 0), `SAMPLES_PER_TURN` per turn. */
function helixPoints(shape: CoilShape): Vec3[] {
  const count = Math.max(8, Math.ceil(shape.turns * SAMPLES_PER_TURN));
  return Array.from({ length: count + 1 }, (_, i): Vec3 => {
    const t = i / count;
    const phi = 2 * Math.PI * shape.turns * t * (shape.left ? -1 : 1);
    const r = radiusAt(shape, t);
    return [r * Math.cos(phi), r * Math.sin(phi), centerlineZ(shape, t) + shape.halfHeight];
  });
}

/** Centre-line length: integral of sqrt(r^2 + (dr/dphi)^2 + (pitch / 2 pi)^2) over the angle (composite Simpson). */
function helixLength(shape: CoilShape): number {
  const steps = 2000;
  const total = 2 * Math.PI * shape.turns;
  const slope = (shape.endRadius - shape.radius) / total;
  const lead = shape.pitch / (2 * Math.PI);
  const speed = (i: number): number => Math.hypot(radiusAt(shape, i / steps), slope, lead);
  let sum = speed(0) + speed(steps);
  for (let i = 1; i < steps; i++) sum += speed(i) * (i % 2 === 0 ? 2 : 4);
  return (sum * total) / (3 * steps);
}

/** Rectangular section [radial width x axial height] screwed along the coil, as a closed triangle mesh in the local frame. */
function flatWire(shape: CoilShape, width: number, height: number): MeshData {
  const corners = [
    [shape.radius - width / 2, -height / 2],
    [shape.radius + width / 2, -height / 2],
    [shape.radius + width / 2, height / 2],
    [shape.radius - width / 2, height / 2],
  ] as const;
  const mesh = screwMesh(corners, shape.pitch, shape.turns, shape.left, (t) => (shape.endRadius - shape.radius) * t);
  return { positions: mesh.positions.map((value, index) => (index % 3 === 2 ? value + shape.halfHeight : value)), indices: mesh.indices };
}

/** `{ turns, rise }` from any two of pitch / turns / length (free length incl. the section extent `extent`: rise = length - extent); pitch + turns win. */
function resolveRise(
  extent: number,
  pitch: number | undefined,
  turns: number | undefined,
  length: number | undefined,
): { turns: number; rise: number } | string {
  const positive = (v: number | undefined): boolean => v === undefined || (Number.isFinite(v) && v > 0);
  if (!positive(pitch) || !positive(turns) || !positive(length)) return 'pitch, turns and length must be finite and > 0';
  if (pitch !== undefined && turns !== undefined) return { turns, rise: pitch * turns };
  if (turns !== undefined && length !== undefined) return { turns, rise: length - extent };
  if (pitch !== undefined && length !== undefined) return { turns: (length - extent) / pitch, rise: length - extent };
  return 'give at least two of pitch, turns, length';
}

/** The coil as a sweep along the exact helix: a round wire normal to it, or a flat wire in the plane through the axis (an exact screw sweep). */
function exactCoil(
  shape: CoilShape,
  wire: { round: number } | { width: number; height: number },
  id: string,
  frame: Exclude<ReturnType<typeof axisFrame>, string>,
  color: string,
  name: string | undefined,
): SweepEntity | string {
  const start: Vec3 = [shape.radius, 0, shape.halfHeight];
  const definition: HelixDefinition = {
    type: 'helix',
    origin: [-shape.radius, 0, 0],
    axis: [0, 0, 1],
    radius: shape.radius,
    endRadius: shape.endRadius,
    turns: shape.turns,
    pitch: shape.pitch,
    handedness: shape.left ? 'left' : 'right',
    startAngle: 0,
  };
  const fitted = helixCurve(definition, 1e-6 * Math.max(shape.radius, shape.endRadius));
  const path = curveChain(fitted.curve);
  if (typeof path === 'string') return `the helix path cannot be built: ${path}`;
  const geometry = {
    path,
    helix: definition,
    ...('round' in wire
      ? { section: { shape: 'circle' as const, radius: wire.round } }
      : {
          section: {
            shape: 'profile' as const,
            profile: [
              [-wire.width / 2, -wire.height / 2],
              [wire.width / 2, -wire.height / 2],
              [wire.width / 2, wire.height / 2],
              [-wire.width / 2, wire.height / 2],
            ] as Array<[number, number]>,
          },
          orientation: {
            mode: 'axis_plane' as const,
            axisPoint: definition.origin,
            direction: definition.axis,
            sectionFrame: 'path' as const,
          },
        }),
  };
  return newEntity('sweep', id, geometry, frame.worldAt(start), color, { rotation: frame.rotation, name }) as SweepEntity;
}

/**
 * @affects creates 1 entity: a sweep (round wire, or a rectangular wire as an axis_plane screw sweep); with exactHelix false or closedEnds the old path and a mesh for a rectangular wire; position = world start of the wire centre line
 * @invariant section extent along the axis < pitch (turns never touch); section half width < the smallest coil radius; MIN_COIL_TURNS <= turns <= MAX_COIL_TURNS
 * @failure missing / non-positive dimensions, section as large as the pitch (self-intersecting coil), section wider than the coil radius, taper to a
 *   non-positive radius, zero axis -> no-op, affected:[]
 */
export const addCoil = defineCommand({
  name: 'add_coil',
  description:
    'Create a helical coil: a round or rectangular wire section swept along a helix (springs, inductors, cooling coils, flat-wire coils). ' +
    'The coil axis runs from position along axis (default +Z); the base plane is at position and the wire rests on it. radius is the centre-line ' +
    'radius of the helix at the start; endRadius (optional) makes a conical coil whose centre-line radius changes linearly to endRadius over ' +
    'the coil. pitch is the axial advance per turn, turns the number of coils (fractions allowed, 0.1 to 200). Section: sectionShape "circle" ' +
    '(default; sectionRadius or sectionDiameter) swept as a round tube (a sweep entity: volume = pi r^2 x centre-line length), or "rectangle" ' +
    '(sectionWidth radial x sectionHeight along the axis, kept radial/axial all along: flat wire, a sweep in the plane through the axis (a mesh with exactHelix false), volume = width x height x ' +
    '2 pi x mean radius x turns). The coil is refused when the section is as large as the pitch (sectionDiameter or sectionHeight >= pitch: ' +
    'neighbouring turns would overlap) or wider than the coil radius. Give at least two of pitch, turns and length (length = free length along the axis including the wire; pitch and turns win if all three are given). closedEnds=true (round wire, turns > 2) makes a compression spring: the first and last turn lie flat (pitch = wire diameter) and the middle turns take the pitch that keeps the length. handedness "right" (default) or "left". Returns the entity id and data ' +
    '{ height (= free length), turns, pitch (the middle-turn pitch with closedEnds), centreLineLength, sectionArea, analyticVolume } in document units.',
  params: z.object({
    radius: z.number().describe('Centre-line radius of the helix at its start, document units (> 0).'),
    endRadius: z.number().describe('Centre-line radius at the end for a conical coil (> 0). Omit for a cylindrical coil.').optional(),
    pitch: z
      .number()
      .describe(
        'Axial advance per turn, document units (> 0, larger than the section extent along the axis). Give two of pitch, turns, length.',
      )
      .optional(),
    turns: z.number().describe('Number of turns (may be fractional), 0.1 <= turns <= 200. Give two of pitch, turns, length.').optional(),
    length: z
      .number()
      .describe('Free length along the axis including the section extent, document units. Give two of pitch, turns, length.')
      .optional(),
    closedEnds: z
      .boolean()
      .describe('Round wire: flatten the first and last turn to wire-diameter pitch (spring end coils). Default false. Needs turns > 2.')
      .optional(),
    sectionShape: z.enum(['circle', 'rectangle']).describe('Wire section: "circle" (default) or "rectangle".').optional(),
    sectionRadius: z.number().describe('Circle section: wire radius (> 0). Alternative: sectionDiameter.').optional(),
    sectionDiameter: z.number().describe('Circle section: wire diameter (> 0). Used when sectionRadius is absent.').optional(),
    sectionWidth: z
      .number()
      .describe('Rectangle section: radial width of the wire (> 0, less than twice the smallest coil radius).')
      .optional(),
    sectionHeight: z.number().describe('Rectangle section: extent of the wire along the axis (> 0, less than the pitch).').optional(),
    handedness: z.enum(['right', 'left']).describe('"right" (default) or "left" helix.').optional(),
    position: positionField('Center of the coil base plane (start of the coil). '),
    axis: vec3('Direction [dx, dy, dz] (non-zero, normalized) the coil extends along from position. Defaults to [0, 0, 1].').optional(),
    exactHelix: z
      .boolean()
      .describe(
        'Default true: the wire is swept along the exact helix (add_helix geometry, within 1e-6 of the radius) and a rectangular wire is an exact screw sweep (orientation axis_plane) instead of a mesh. false (or closedEnds) keeps the older 16-points-per-turn Catmull-Rom approximation (up to 1.2 % of the radius off at the end turns) and the mesh flat wire.',
      )
      .optional(),
    color: colorField('#b87333'),
    name: z.string().describe('Optional entity name, e.g. "Heating coil".').optional(),
  }),
  run: (
    doc,
    {
      radius,
      endRadius = radius,
      pitch: pitchIn,
      turns: turnsIn,
      length,
      closedEnds = false,
      sectionShape = 'circle',
      sectionRadius,
      sectionDiameter,
      sectionWidth,
      sectionHeight,
      handedness = 'right',
      exactHelix = true,
      position = ORIGIN,
      axis,
      color = '#b87333',
      name,
    },
  ): CommandResult => {
    const fail = failedWith(doc, 'add_coil');
    const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
    if (![radius, endRadius].every(positive)) return fail('radius and endRadius must be finite and > 0');
    const round = sectionShape === 'circle';
    const wire = sectionRadius ?? (sectionDiameter === undefined ? undefined : sectionDiameter / 2);
    if (round && (wire === undefined || !positive(wire))) return fail('a circle section needs sectionRadius or sectionDiameter > 0');
    if (!round && (sectionWidth === undefined || sectionHeight === undefined || !positive(sectionWidth) || !positive(sectionHeight)))
      return fail('a rectangle section needs sectionWidth and sectionHeight > 0');
    const halfWidth = round ? (wire as number) : (sectionWidth as number) / 2;
    const halfHeight = round ? (wire as number) : (sectionHeight as number) / 2;
    const resolved = resolveRise(2 * halfHeight, pitchIn, turnsIn, length);
    if (typeof resolved === 'string') return fail(resolved);
    const { turns } = resolved;
    if (turns < MIN_COIL_TURNS || turns > MAX_COIL_TURNS)
      return fail(`turns must be in [${MIN_COIL_TURNS}, ${MAX_COIL_TURNS}], got ${fmt(turns)}`);
    if (closedEnds && (!round || turns <= 2)) return fail('closedEnds needs a circle section and turns > 2');
    const meanPitch = pitchIn !== undefined && turnsIn !== undefined ? pitchIn : resolved.rise / turns;
    const pitch = closedEnds ? (resolved.rise - 4 * halfHeight) / (turns - 2) : meanPitch;
    if (!(resolved.rise > 0) || !positive(pitch)) return fail('pitch must be > 0 (length is too short for this wire)');
    if (2 * halfHeight >= pitch)
      return fail(
        `the section extent along the axis (${fmt(2 * halfHeight)}) must be below the pitch (${fmt(pitch)}), or neighbouring turns overlap (self-intersecting coil)`,
      );
    const smallest = Math.min(radius, endRadius);
    if (halfWidth >= smallest)
      return fail(`the section half width (${fmt(halfWidth)}) must be below the smallest coil radius (${fmt(smallest)})`);
    const frame = axisFrame(axis, position);
    if (typeof frame === 'string') return fail(frame);
    const shape: CoilShape = { radius, endRadius, pitch: meanPitch, turns, left: handedness === 'left', closedEnds, halfHeight };
    const id = nextId('coil');
    const sectionArea = round ? Math.PI * halfWidth * halfWidth : 4 * halfWidth * halfHeight;
    const centreLineLength = helixLength(shape);
    const analyticVolume = round ? sectionArea * centreLineLength : sectionArea * 2 * Math.PI * ((radius + endRadius) / 2) * turns;
    let entity;
    if (exactHelix && !closedEnds) {
      const exact = exactCoil(
        shape,
        round ? { round: halfWidth } : { width: 2 * halfWidth, height: 2 * halfHeight },
        id,
        frame,
        color,
        name,
      );
      if (typeof exact === 'string') return fail(exact);
      entity = exact;
    } else if (round) {
      const points = helixPoints(shape);
      const startLocal = points[0] as Vec3;
      const path = catmullRomBeziers(points, false).map((segment) => mapSegment(segment, (p: Vec3): Vec3 => sub3(p, startLocal)));
      entity = newEntity('sweep', id, { path, section: { shape: 'circle', radius: halfWidth } }, frame.worldAt(startLocal), color, {
        rotation: frame.rotation,
        name,
      });
    } else {
      const local = flatWire(shape, 2 * halfWidth, 2 * halfHeight);
      const positions = Array.from(
        { length: local.positions.length / 3 },
        (_, i): Vec3 =>
          frame.worldAt([local.positions[3 * i] as number, local.positions[3 * i + 1] as number, local.positions[3 * i + 2] as number]),
      ).flat();
      entity = newEntity('mesh', id, { mesh: { positions, indices: local.indices } }, ORIGIN, color, { name });
    }
    const height = resolved.rise + 2 * halfHeight;
    return {
      ...commitSolid(
        doc,
        entity,
        `Added ${round ? 'round' : 'flat'}-wire ${handedness}-hand coil ${id}: ${fmt(turns)} turns, pitch ${fmt(pitch)}, radius ${fmt(radius)}` +
          `${endRadius === radius ? '' : ` to ${fmt(endRadius)}`}, ${round ? `wire Ø${fmt(2 * halfWidth)}` : `wire ${fmt(2 * halfWidth)} x ${fmt(2 * halfHeight)}`}, ` +
          `height ${fmt(height)} along ${vecText(frame.unitAxis)}`,
      ),
      data: { height, turns, pitch, centreLineLength, sectionArea, analyticVolume },
    };
  },
});
