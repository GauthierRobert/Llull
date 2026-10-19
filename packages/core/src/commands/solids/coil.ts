/** add_coil (SC-F2): a round or rectangular section swept along a (optionally conical) helix. */

import type { MeshData, Vec3 } from '../../model/types';
import { catmullRomBeziers, mapSegment } from '../../geometry/curveSegments';
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
  /** Half the section extent along the axis: the coil rests on the base plane. */
  readonly halfHeight: number;
}

/** Centre-line radius at `t` in 0..1 along the coil. */
const radiusAt = (shape: CoilShape, t: number): number => shape.radius + (shape.endRadius - shape.radius) * t;

/** Centre-line samples in the local frame (axis +Z, base plane z = 0), `SAMPLES_PER_TURN` per turn. */
function helixPoints(shape: CoilShape): Vec3[] {
  const count = Math.max(8, Math.ceil(shape.turns * SAMPLES_PER_TURN));
  return Array.from({ length: count + 1 }, (_, i): Vec3 => {
    const t = i / count;
    const phi = 2 * Math.PI * shape.turns * t * (shape.left ? -1 : 1);
    const r = radiusAt(shape, t);
    return [r * Math.cos(phi), r * Math.sin(phi), shape.pitch * shape.turns * t + shape.halfHeight];
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

/**
 * @affects creates 1 entity: a sweep (round wire) or a mesh (rectangular wire); position = world start of the wire centre line
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
    '(sectionWidth radial x sectionHeight along the axis, kept radial/axial all along: flat wire, a mesh solid, volume = width x height x ' +
    '2 pi x mean radius x turns). The coil is refused when the section is as large as the pitch (sectionDiameter or sectionHeight >= pitch: ' +
    'neighbouring turns would overlap) or wider than the coil radius. handedness "right" (default) or "left". Returns the entity id and data ' +
    '{ height, turns, pitch, centreLineLength, sectionArea, analyticVolume } in document units.',
  params: z.object({
    radius: z.number().describe('Centre-line radius of the helix at its start, document units (> 0).'),
    endRadius: z.number().describe('Centre-line radius at the end for a conical coil (> 0). Omit for a cylindrical coil.').optional(),
    pitch: z.number().describe('Axial advance per turn, document units (> 0, larger than the section extent along the axis).'),
    turns: z.number().describe('Number of turns (may be fractional), 0.1 <= turns <= 200.'),
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
    color: colorField('#b87333'),
    name: z.string().describe('Optional entity name, e.g. "Heating coil".').optional(),
  }),
  run: (
    doc,
    {
      radius,
      endRadius = radius,
      pitch,
      turns,
      sectionShape = 'circle',
      sectionRadius,
      sectionDiameter,
      sectionWidth,
      sectionHeight,
      handedness = 'right',
      position = ORIGIN,
      axis,
      color = '#b87333',
      name,
    },
  ): CommandResult => {
    const fail = failedWith(doc, 'add_coil');
    const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
    if (![radius, endRadius, pitch, turns].every(positive)) return fail('radius, endRadius, pitch and turns must be finite and > 0');
    if (turns < MIN_COIL_TURNS || turns > MAX_COIL_TURNS)
      return fail(`turns must be in [${MIN_COIL_TURNS}, ${MAX_COIL_TURNS}], got ${fmt(turns)}`);
    const round = sectionShape === 'circle';
    const wire = sectionRadius ?? (sectionDiameter === undefined ? undefined : sectionDiameter / 2);
    if (round && (wire === undefined || !positive(wire))) return fail('a circle section needs sectionRadius or sectionDiameter > 0');
    if (!round && (sectionWidth === undefined || sectionHeight === undefined || !positive(sectionWidth) || !positive(sectionHeight)))
      return fail('a rectangle section needs sectionWidth and sectionHeight > 0');
    const halfWidth = round ? (wire as number) : (sectionWidth as number) / 2;
    const halfHeight = round ? (wire as number) : (sectionHeight as number) / 2;
    if (2 * halfHeight >= pitch)
      return fail(
        `the section extent along the axis (${fmt(2 * halfHeight)}) must be below the pitch (${fmt(pitch)}), or neighbouring turns overlap (self-intersecting coil)`,
      );
    const smallest = Math.min(radius, endRadius);
    if (halfWidth >= smallest)
      return fail(`the section half width (${fmt(halfWidth)}) must be below the smallest coil radius (${fmt(smallest)})`);
    const frame = axisFrame(axis, position);
    if (typeof frame === 'string') return fail(frame);
    const shape: CoilShape = { radius, endRadius, pitch, turns, left: handedness === 'left', halfHeight };
    const id = nextId('coil');
    const sectionArea = round ? Math.PI * halfWidth * halfWidth : 4 * halfWidth * halfHeight;
    const centreLineLength = helixLength(shape);
    const analyticVolume = round ? sectionArea * centreLineLength : sectionArea * 2 * Math.PI * ((radius + endRadius) / 2) * turns;
    let entity;
    if (round) {
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
    const height = pitch * turns + 2 * halfHeight;
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
