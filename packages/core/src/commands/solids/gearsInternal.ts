/** add_internal_gear: ring gear with internal involute teeth as one closed `mesh` solid (no booleans). */

import type { MeshData } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z, nameField } from '../schema';
import { nextId } from '../../lib/id';
import { compactNumber as fmt, vecText } from '../../lib/compactNumber';
import { finiteVec3OrZero } from '../../lib/vec3';
import { DEFAULT_FLANK_SAMPLES, internalCavityPattern, pitchRadiusOf, toothOutline } from '../../lib/gearOutline';
import { circleThrough, ringMesh } from '../../geometry/prismMesh';
import { MAX_GEAR_TEETH } from '../limits';
import { commitSolid, positionField, rotationField } from './shared';
import { moduleProblem, placedMeshEntity, teethCountProblem, toothShapeProblem } from './gearSolid';
import { failedWith } from '../noop';

/** Minimum radial wall (in modules) between the tooth-space roots and the rim. */
const MIN_RIM_WALL_MODULES = 1;

/** Rim radius below which an internal gear has no material left behind its tooth spaces. */
export function minRingOuterRadius(mod: number, teeth: number): number {
  return pitchRadiusOf(mod, teeth) + (1.25 + MIN_RIM_WALL_MODULES) * mod;
}

/** Local-frame ring mesh (axis +Z, z in [0, faceWidth]); `phase` rotates the tooth-space pattern. */
export function internalGearMesh(
  mod: number,
  teeth: number,
  pressureAngle: number,
  faceWidth: number,
  outerRadius: number,
  phase: number,
): MeshData {
  const cavity = toothOutline(internalCavityPattern(mod, teeth, pressureAngle, DEFAULT_FLANK_SAMPLES, phase));
  return ringMesh(circleThrough(cavity, outerRadius), cavity, faceWidth);
}

/**
 * @affects creates 1 mesh entity (ring gear, teeth pointing inward)
 * @invariant module > 0; teeth integer in [12, MAX_GEAR_TEETH]; pressureAngle in (0, π/2); faceWidth > 0;
 *            outerRadius >= pitchRadius + 2.25·module
 * @failure invalid params -> unchanged doc, summary names the violated param, affected:[]
 */
export const addInternalGear = defineCommand({
  name: 'add_internal_gear',
  description:
    'Create an internal (ring) involute gear: a cylindrical rim whose bore carries inward-pointing teeth, ' +
    'as ONE closed mesh solid built without booleans. Same tooth convention as add_spur_gear ' +
    '(addendum 1·module, dedendum 1.25·module), tooth spaces widened by 0.05·module backlash so an ' +
    'external gear of the same module and pressure angle meshes without interference. ' +
    'The ring is centred on its axis (+Z, z from 0 to faceWidth) at `position`; tooth pitch diameter = module * teeth. ' +
    'Pair with add_spur_gear: centre distance = module * (ringTeeth - pinionTeeth) / 2. ' +
    'For a complete sun/planet/ring set use add_planetary_gearset (it phases the teeth for you). ' +
    'The result is a world-space mesh entity (position/rotation are baked in).',
  params: z.object({
    module: z.number().describe('Gear module (metric), > 0. pitchDiameter = module * teeth.'),
    teeth: z.number().describe(`Number of internal teeth, integer >= 12 and <= ${MAX_GEAR_TEETH}. Typical ring gears have 40-120.`),
    pressureAngle: z.number().describe('Pressure angle in RADIANS, in (0, π/2). Default 0.3491 (20°).').optional(),
    faceWidth: z.number().describe('Gear thickness along the axis (+Z), > 0.'),
    outerRadius: z
      .number()
      .describe(
        'Radius of the cylindrical rim (outside of the ring). Must be >= pitchRadius + 2.25 * module so that ' +
          'material remains behind the tooth spaces.',
      ),
    position: positionField('Centre of the ring on its axis (z = bottom face). '),
    rotation: rotationField(),
    color: z.string().describe('Hex color. Default "#8892a0".').optional(),
    name: nameField(),
  }),
  run: (
    doc,
    { module: mod, teeth, pressureAngle = Math.PI / 9, faceWidth, outerRadius, position, rotation, color = '#8892a0', name },
  ): CommandResult => {
    const fail = failedWith(doc, 'add_internal_gear');
    const teethInt = Math.round(teeth);
    const shapeProblem =
      moduleProblem(mod) ?? teethCountProblem('teeth', teethInt, 12, teeth) ?? toothShapeProblem(pressureAngle, faceWidth);
    if (shapeProblem !== null) return fail(shapeProblem);
    const minRim = minRingOuterRadius(mod, teethInt);
    if (!(outerRadius >= minRim && Number.isFinite(outerRadius))) {
      return fail(`outerRadius must be >= ${fmt(minRim)} (pitchRadius + 2.25*module), got ${String(outerRadius)}.`);
    }
    const at = finiteVec3OrZero(position);
    const turn = finiteVec3OrZero(rotation);
    const id = nextId('ring');
    const entity = placedMeshEntity(id, internalGearMesh(mod, teethInt, pressureAngle, faceWidth, outerRadius, 0), at, turn, color, name);
    const pitchRadius = pitchRadiusOf(mod, teethInt);
    return commitSolid(
      doc,
      entity,
      `Created internal_gear ${id}: module=${fmt(mod)} teeth=${teethInt} pitchD=${fmt(2 * pitchRadius)} ` +
        `tipD=${fmt(2 * (pitchRadius - mod))} rootD=${fmt(2 * (pitchRadius + 1.25 * mod))} ` +
        `outerR=${fmt(outerRadius)} face=${fmt(faceWidth)} at ${vecText(at)}`,
    );
  },
});
