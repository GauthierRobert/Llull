/**
 * add_spur_gear: parametric involute spur gear as one `extrusion` entity (pure math, no kernel).
 *
 * @layer core/commands
 */

import type { Entity } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3 as vec3 } from './schema';
import { nextId } from '../lib/id';
import { compactNumber as fmt } from '../lib/compactNumber';
import { rotatePoint2 } from '../lib/polygon';
import { finiteVec3OrZero } from '../lib/vec3';
import { MAX_GEAR_TEETH } from './limits';
import { rotatedEntityBounds } from './sceneRotatedBounds';
import { withEntity } from './entityOps';
import { boundsText } from './geometryShared';
import { noop } from './noop';

type Point = readonly [number, number];

/**
 * `samples` points of the involute of a circle of radius `rb` (x = rb(cos t + t sin t),
 * y = rb(sin t - t cos t)), t linear from `tStart` to `tEnd`. Shared by `draw_involute`.
 */
export function sampleInvolute(
  rb: number,
  tStart: number,
  tEnd: number,
  samples: number,
): ReadonlyArray<Point> {
  const n = Math.max(samples - 1, 1);
  return Array.from({ length: n + 1 }, (_, i): Point => {
    const t = tStart + ((tEnd - tStart) * i) / n;
    return [rb * (Math.cos(t) + t * Math.sin(t)), rb * (Math.sin(t) - t * Math.cos(t))];
  });
}

/** Involute parameter t at which the curve reaches radius `r` (0 when r <= rb). */
function involuteT(rb: number, r: number): number {
  return r <= rb ? 0 : Math.sqrt((r / rb) ** 2 - 1);
}

/** `segments` points on the circle of radius `r`, from just after `startAngle` through `endAngle` (CCW). */
function sampleArc(r: number, startAngle: number, endAngle: number, segments: number): Point[] {
  const n = Math.max(segments, 1);
  return Array.from({ length: n }, (_, i): Point => {
    const a = startAngle + ((endAngle - startAngle) * (i + 1)) / n;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
}

const angleOf = (p: Point): number => Math.atan2(p[1], p[0]);

/**
 * Closed CCW involute spur gear outline centred at the origin (first point repeated last).
 * @param pressureAngle radians (typical 20° = π/9)
 * @invariant baseRadius >= rootRadius (teeth < ~17) undercuts: the flank starts on the root circle (approximation)
 */
export function buildSpurGearProfile(
  module: number,
  teeth: number,
  pressureAngle: number,
  flankSamples = 14,
): ReadonlyArray<Point> {
  const pitchRadius = (module * teeth) / 2;
  const baseRadius = pitchRadius * Math.cos(pressureAngle);
  const outerRadius = pitchRadius + module;
  const rootRadius = pitchRadius - 1.25 * module;
  const toothAngle = (2 * Math.PI) / teeth;
  const halfToothPitchAngle = Math.PI / (2 * teeth);

  const tMax = involuteT(baseRadius, outerRadius);
  const tPitch = involuteT(baseRadius, pitchRadius);
  const involuteAngleAtPitch =
    baseRadius > 0
      ? Math.atan2(
          baseRadius * (Math.sin(tPitch) - tPitch * Math.cos(tPitch)),
          baseRadius * (Math.cos(tPitch) + tPitch * Math.sin(tPitch)),
        )
      : 0;
  // The pitch-circle point of the right flank lands at +halfToothPitchAngle (tooth symmetric about its centre line).
  const rightFlankRotation = halfToothPitchAngle - involuteAngleAtPitch;
  const leftFlankRotation = -halfToothPitchAngle + involuteAngleAtPitch;
  const tStart = baseRadius >= rootRadius ? involuteT(baseRadius, rootRadius) : 0;
  const rawFlank = sampleInvolute(baseRadius, tStart, tMax, flankSamples);
  const rootArcSegments = teeth >= 10 ? 3 : 2;

  const profile: Point[] = [];
  for (let t = 0; t < teeth; t++) {
    const toothCenter = t * toothAngle;
    const rightFlank = rawFlank.map((pt) => rotatePoint2(pt, rightFlankRotation + toothCenter));
    const leftFlank = rawFlank.map((pt) =>
      rotatePoint2([pt[0], -pt[1]], leftFlankRotation + toothCenter),
    );
    const rightTipAngle = angleOf(rightFlank[rightFlank.length - 1]!);
    let tipArcEnd = angleOf(leftFlank[leftFlank.length - 1]!);
    if (tipArcEnd < rightTipAngle) tipArcEnd += 2 * Math.PI;

    const leftRootAngle = angleOf(leftFlank[0]!);
    const nextToothCenter = ((t + 1) % teeth) * toothAngle;
    let rootArcEnd = angleOf(rotatePoint2(rawFlank[0]!, rightFlankRotation + nextToothCenter));
    if (rootArcEnd <= leftRootAngle) rootArcEnd += 2 * Math.PI;

    profile.push(
      ...rightFlank,
      ...sampleArc(outerRadius, rightTipAngle, tipArcEnd, 2),
      ...[...leftFlank].reverse(),
      ...sampleArc(rootRadius, leftRootAngle, rootArcEnd, rootArcSegments),
    );
  }
  if (profile.length > 0) profile.push(profile[0]!);
  return profile;
}

/**
 * @command add_spur_gear
 * @pure
 * @layer core/commands
 * @affects creates 1 extrusion entity (spur gear solid)
 * @invariant module > 0; teeth >= 3; pressureAngle in (0, π/2); faceWidth > 0; bore >= 0 and bore < pitchRadius
 * @failure invalid params -> unchanged doc, summary explains which param violated, affected:[]
 * @failure bore > 0 when ExtrusionEntity does not support holes natively -> bore is ignored, noted in summary
 * @invariant when baseRadius >= rootRadius (typically teeth < 17), undercut occurs;
 *            the involute start is clamped to rootRadius (approximate — not geometrically exact undercut)
 */

export const addSpurGear = defineCommand({
  name: 'add_spur_gear',
  description:
    'Create a parametric involute spur gear solid (extrusion). ' +
    'Computes the full closed 2D tooth profile from module, tooth count, and pressure angle, ' +
    'then extrudes it by faceWidth along +Z. ' +
    'module (metric) sets the tooth scale: pitchDiameter = module * teeth. ' +
    'pressureAngle is in RADIANS; standard value is 0.3491 rad (20 degrees = Math.PI/9). ' +
    'faceWidth is the gear thickness along Z. ' +
    'bore is a central hole radius; if > 0 it is currently ignored (kernel hole not yet wired) and noted in the summary. ' +
    'position is [x, y, z] of the gear center; rotation is extrinsic XYZ Euler angles in radians. ' +
    'Right-handed frame, +Z up.',
  params: z.object({
    module: z
      .number()
      .describe(
        'Gear module (metric). Controls tooth scale: pitchDiameter = module * teeth. Must be > 0. ' +
          'Common values: 1 (small), 2 (medium), 4 (large).',
      ),
    teeth: z
      .number()
      .describe(
        'Number of teeth. Must be an integer >= 3. ' +
          'Below ~17 teeth undercut occurs; the profile is approximated by clamping the involute to the root circle.',
      ),
    pressureAngle: z
      .number()
      .describe(
        'Pressure angle in RADIANS. Must be in (0, π/2). ' +
          'Standard value: 0.3491 rad (20°). Omit to use the 20° default.',
      )
      .optional(),
    faceWidth: z
      .number()
      .describe(
        'Gear face width (thickness along Z) in document units. Must be > 0. ' +
          'Typical: 8–12× module for spur gears.',
      ),
    bore: z
      .number()
      .describe(
        'Central bore hole radius in document units. >= 0. Default 0 (solid hub). ' +
          'Currently ignored if > 0 (kernel hole not yet wired); a note appears in the summary.',
      )
      .optional(),
    position: vec3(
      'World-space center of the gear [x, y, z] in document units. ' +
        'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
    ).optional(),
    rotation: z
      .array(z.number())
      .describe(
        'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
      )
      .optional(),
    color: z
      .string()
      .describe('Hex color string, e.g. "#7a9cbb". Defaults to "#7a9cbb".')
      .optional(),
    name: z
      .string()
      .describe('Optional display name for the entity (shown in the scene tree).')
      .optional(),
  }),
  run: (
    doc,
    {
      module: mod,
      teeth,
      pressureAngle = Math.PI / 9,
      faceWidth,
      bore = 0,
      position = [0, 0, 0] as const,
      rotation,
      color = '#7a9cbb',
      name,
    },
  ): CommandResult => {
    if (!Number.isFinite(mod) || mod <= 0) {
      return noop(doc, `add_spur_gear failed: module must be finite and > 0, got ${String(mod)}.`);
    }

    const teethInt = Math.round(teeth);
    if (!Number.isFinite(teeth) || teethInt < 3 || teethInt > MAX_GEAR_TEETH) {
      return noop(
        doc,
        `add_spur_gear failed: teeth must be a finite integer in [3, ${MAX_GEAR_TEETH}], got ${String(teeth)}.`,
      );
    }

    if (!Number.isFinite(pressureAngle) || pressureAngle <= 0 || pressureAngle >= Math.PI / 2) {
      return noop(
        doc,
        `add_spur_gear failed: pressureAngle must be in (0, π/2), got ${String(pressureAngle)}.`,
      );
    }

    if (!Number.isFinite(faceWidth) || faceWidth <= 0) {
      return noop(
        doc,
        `add_spur_gear failed: faceWidth must be finite and > 0, got ${String(faceWidth)}.`,
      );
    }

    const pitchRadius = (mod * teethInt) / 2;
    if (!Number.isFinite(bore) || bore < 0) {
      return noop(doc, `add_spur_gear failed: bore must be finite and >= 0, got ${String(bore)}.`);
    }
    if (bore >= pitchRadius) {
      return noop(
        doc,
        `add_spur_gear failed: bore (${bore}) must be < pitchRadius (${pitchRadius}).`,
      );
    }

    const resolvedPosition = finiteVec3OrZero(position);
    const resolvedRotation = finiteVec3OrZero(rotation);

    const profile = buildSpurGearProfile(mod, teethInt, pressureAngle);

    const pitchDiameter = mod * teethInt;
    const outerDiameter = pitchDiameter + 2 * mod;

    const boreNote = bore > 0 ? ` bore=${bore} ignored — kernel hole not yet wired.` : '';

    const id = nextId('gear');
    const entity: Entity = {
      id,
      kind: 'extrusion',
      profile,
      depth: faceWidth,
      position: resolvedPosition,
      rotation: resolvedRotation,
      layerId: DEFAULT_LAYER_ID,
      color,
      ...(name !== undefined && name !== '' ? { name } : {}),
    };

    const newDoc = withEntity(doc, entity);
    const b = rotatedEntityBounds(newDoc.entities[id] as Entity);

    return {
      document: newDoc,
      summary:
        `Created spur_gear ${id}: module=${fmt(mod)} teeth=${teethInt} ` +
        `pitchD=${fmt(pitchDiameter)} outerD=${fmt(outerDiameter)} ` +
        `bore=${bore} face=${fmt(faceWidth)} ` +
        `at [${resolvedPosition.map(fmt).join(', ')}].` +
        `${boreNote} ${boundsText(b)}.`,
      affected: [id],
    };
  },
});
