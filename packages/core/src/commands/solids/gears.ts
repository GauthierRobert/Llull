/**
 * add_spur_gear: parametric involute spur gear as one `extrusion` entity (pure math, no kernel).
 *
 * @layer core/commands
 */

import type { CommandResult } from '../types';
import { defineCommand, z, colorField, nameField, looseVec3 } from '../schema';
import { nextId } from '../../lib/id';
import { compactNumber as fmt, vecText } from '../../lib/compactNumber';
import {
  DEFAULT_FLANK_SAMPLES,
  externalGearPattern,
  pitchRadiusOf,
  toothOutline,
  toothProfile,
} from '../../lib/gearOutline';
import { circleThrough, ringMesh } from '../../geometry/prismMesh';
import {
  faceWidthProblem,
  moduleProblem,
  placedMeshEntity,
  pressureAngleProblem,
} from './gearSolid';
import { finiteVec3OrZero } from '../../lib/vec3';
import { MAX_GEAR_TEETH } from '../limits';
import { newEntity } from '../entity/newEntity';
import { ROTATION_CONVENTION, commitSolid } from './shared';
import { failedWith } from '../noop';
import type { Vec2 as Point } from '../../model/vectors';

const DEFAULT_GEAR_COLOR = '#7a9cbb';

/**
 * Closed CCW involute spur gear outline centred at the origin (first point NOT repeated).
 * @param pressureAngle radians (typical 20° = π/9)
 * @invariant baseRadius >= rootRadius (teeth < ~42) undercuts: each flank starts with a radial lead-in to the root circle
 */
export function buildSpurGearProfile(
  module: number,
  teeth: number,
  pressureAngle: number,
  flankSamples = DEFAULT_FLANK_SAMPLES,
): ReadonlyArray<Point> {
  return toothOutline(externalGearPattern(module, teeth, pressureAngle, flankSamples));
}

/**
 * @command add_spur_gear
 * @pure
 * @layer core/commands
 * @affects creates 1 extrusion entity (spur gear solid)
 * @invariant module > 0; teeth >= 3; pressureAngle in (0, π/2); faceWidth > 0; bore >= 0 and bore < pitchRadius
 * @failure invalid params -> unchanged doc, summary explains which param violated, affected:[]
 * @affects bore > 0 -> creates 1 mesh entity instead (ExtrusionEntity has no holes)
 * @invariant when baseRadius >= rootRadius (typically teeth < 17), undercut occurs;
 *            the involute start is clamped to rootRadius (approximate — not geometrically exact undercut)
 */

export const addSpurGear = defineCommand({
  name: 'add_spur_gear',
  description:
    'Create a parametric involute spur gear solid (extrusion with exact Bézier/arc tooth curves; mesh when bore > 0). ' +
    'Computes the full closed 2D tooth profile from module, tooth count, and pressure angle, ' +
    'then extrudes it by faceWidth along +Z. ' +
    'module (metric) sets the tooth scale: pitchDiameter = module * teeth. ' +
    'pressureAngle is in RADIANS; standard value is 0.3491 rad (20 degrees = Math.PI/9). ' +
    'faceWidth is the gear thickness along Z. ' +
    'bore is a central hole radius; if > 0 the gear is emitted as a closed mesh solid with a through hole (no boolean needed). ' +
    'position is [x, y, z] of the gear center; rotation is three.js intrinsic XYZ Euler angles in radians (about world Z, then Y, then X). ' +
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
      .int()
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
        'Central bore hole radius in document units. >= 0 and < pitch radius. Default 0 (solid hub, extrusion entity). ' +
          'When > 0 the result is a mesh solid with a through hole.',
      )
      .optional(),
    position: looseVec3(
      'World-space center of the gear [x, y, z] in document units. ' +
        'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
    ).optional(),
    rotation: z
      .array(z.number())
      .describe(
        `${ROTATION_CONVENTION}. Defaults to [0, 0, 0]. ` +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
      )
      .optional(),
    color: colorField(DEFAULT_GEAR_COLOR),
    name: nameField(),
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
      color = DEFAULT_GEAR_COLOR,
      name,
    },
  ): CommandResult => {
    const fail = failedWith(doc, 'add_spur_gear');
    const moduleIssue = moduleProblem(mod);
    if (moduleIssue !== null) return fail(moduleIssue);

    const teethInt = teeth;
    if (teethInt < 3 || teethInt > MAX_GEAR_TEETH) {
      return fail(
        `teeth must be a finite integer in [3, ${MAX_GEAR_TEETH}], got ${String(teeth)}.`,
      );
    }

    const shapeProblem = pressureAngleProblem(pressureAngle) ?? faceWidthProblem(faceWidth);
    if (shapeProblem !== null) return fail(shapeProblem);

    const pitchRadius = pitchRadiusOf(mod, teethInt);
    if (bore < 0) return fail(`bore must be finite and >= 0, got ${String(bore)}.`);
    if (bore >= pitchRadius) {
      return fail(`bore (${bore}) must be < pitchRadius (${pitchRadius}).`);
    }

    const resolvedPosition = finiteVec3OrZero(position);
    const resolvedRotation = finiteVec3OrZero(rotation);

    const { points: profile, curves } = toothProfile(
      externalGearPattern(mod, teethInt, pressureAngle, DEFAULT_FLANK_SAMPLES),
    );

    const pitchDiameter = mod * teethInt;
    const outerDiameter = pitchDiameter + 2 * mod;

    const id = nextId('gear');
    const entity =
      bore > 0
        ? placedMeshEntity(
            id,
            ringMesh(profile, circleThrough(profile, bore), faceWidth),
            resolvedPosition,
            resolvedRotation,
            color,
            name,
          )
        : newEntity(
            'extrusion',
            id,
            { profile, depth: faceWidth, curves },
            resolvedPosition,
            color,
            {
              rotation: resolvedRotation,
              name,
            },
          );

    return commitSolid(
      doc,
      entity,
      `Created spur_gear ${id}: module=${fmt(mod)} teeth=${teethInt} ` +
        `pitchD=${fmt(pitchDiameter)} outerD=${fmt(outerDiameter)} ` +
        `bore=${bore} face=${fmt(faceWidth)} ` +
        `at ${vecText(resolvedPosition)}` +
        `${bore > 0 ? '; bored: mesh solid' : ''}`,
    );
  },
});
