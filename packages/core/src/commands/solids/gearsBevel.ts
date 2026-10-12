/**
 * add_bevel_gear / add_bevel_gear_pair: straight bevel gears with real teeth as closed `mesh` solids.
 *
 * Tooth form: the heel section is the involute spur outline of `teeth` teeth on the pitch circle
 * (module·teeth/2); the toe section is that outline scaled about the pitch-cone apex, so all tooth
 * edges converge on the apex like a true straight bevel. Approximate (no Tredgold back-cone correction).
 *
 * @layer core/commands
 */

import type { MeshData, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import type { Point2 } from '../../lib/polygon';
import { defineCommand, z, nameField } from '../schema';
import { nextId } from '../../lib/id';
import { compactNumber as fmt, vecText } from '../../lib/compactNumber';
import { finiteVec3OrZero } from '../../lib/vec3';
import {
  DEFAULT_FLANK_SAMPLES,
  externalGearPattern,
  pitchRadiusOf,
  toothOutline,
} from '../../lib/gearOutline';
import {
  addCap,
  addLoftWalls,
  addStarAnnulusCap,
  circleThrough,
  createMeshBuilder,
  placeMesh,
} from '../../geometry/prismMesh';
import { MAX_GEAR_TEETH } from '../limits';
import { rotatedEntityBounds } from '../../geometry/rotatedBounds';
import { commitEntity } from '../entity/commitEntity';
import { withEntity } from '../entity/entityOps';
import { boundsText, positionField, rotationField } from './shared';
import { AXIS_ROTATION, meshGearEntity, pressureAngleProblem } from './gearSolid';
import { noop } from '../noop';

const ORIGIN: Vec3 = [0, 0, 0];
const MAX_FACE_FRACTION = 0.7;

export interface BevelGeometry {
  /** Pitch-cone half angle, radians. */
  readonly pitchAngle: number;
  /** Cone distance (apex to heel pitch circle). */
  readonly coneDistance: number;
  /** Axial distance from the heel plane (z = 0) to the apex. */
  readonly apexHeight: number;
}

/** Pitch cone of a bevel gear meshing with `matingTeeth` across `shaftAngle`. */
export function bevelGeometry(
  mod: number,
  teeth: number,
  matingTeeth: number,
  shaftAngle: number,
  pitchAngleOverride?: number,
): BevelGeometry {
  const pitchAngle =
    pitchAngleOverride ??
    Math.atan2(Math.sin(shaftAngle), matingTeeth / teeth + Math.cos(shaftAngle));
  const coneDistance = (mod * teeth) / (2 * Math.sin(pitchAngle));
  return { pitchAngle, coneDistance, apexHeight: coneDistance * Math.cos(pitchAngle) };
}

/** Local-frame mesh: heel face at z = 0, toe face at z = faceWidth·cos(pitchAngle), apex towards +Z. */
export function bevelGearMesh(
  mod: number,
  teeth: number,
  pressureAngle: number,
  geometry: BevelGeometry,
  faceWidth: number,
  bore: number,
  phase: number,
): MeshData {
  const pitchRadius = pitchRadiusOf(mod, teeth);
  // Tooth heights are measured normal to the pitch cone; in the heel plane (perpendicular to the axis)
  // that stretches the radial offsets from the pitch circle by 1 / cos(pitchAngle).
  const stretch = 1 / Math.cos(geometry.pitchAngle);
  const heel: Point2[] = toothOutline(
    externalGearPattern(mod, teeth, pressureAngle, DEFAULT_FLANK_SAMPLES, phase),
  ).map(([x, y]): Point2 => {
    const radius = Math.hypot(x, y);
    const scaled = (pitchRadius + (radius - pitchRadius) * stretch) / radius;
    return [x * scaled, y * scaled];
  });
  const shrink = (geometry.coneDistance - faceWidth) / geometry.coneDistance;
  const toe = heel.map(([x, y]): Point2 => [x * shrink, y * shrink]);
  const toeHeight = geometry.apexHeight * (1 - shrink);
  const hole = bore > 0 ? circleThrough(heel, bore) : null;
  const builder = createMeshBuilder();
  if (hole) {
    addStarAnnulusCap(builder, heel, hole, 0, false);
    addStarAnnulusCap(builder, toe, hole, toeHeight, true);
    addLoftWalls(builder, hole, 0, hole, toeHeight, false);
  } else {
    addCap(builder, heel, [], 0, false);
    addCap(builder, toe, [], toeHeight, true);
  }
  addLoftWalls(builder, heel, 0, toe, toeHeight, true);
  return builder.build();
}

interface BevelInputs {
  readonly mod: number;
  readonly teeth: number;
  readonly matingTeeth: number;
  readonly shaftAngle: number;
  readonly pitchAngle: number | undefined;
  readonly faceWidth: number;
  readonly pressureAngle: number;
  readonly bore: number;
}

/** Rejection reason for bevel parameters, or the pitch cone when valid. */
function checkBevel(input: BevelInputs): string | BevelGeometry {
  const { mod, teeth, matingTeeth, shaftAngle, pitchAngle, faceWidth, pressureAngle, bore } = input;
  if (!(mod > 0 && Number.isFinite(mod)))
    return `module must be finite and > 0, got ${String(mod)}.`;
  if (!(Number.isInteger(teeth) && teeth >= 6 && teeth <= MAX_GEAR_TEETH)) {
    return `teeth must be an integer in [6, ${MAX_GEAR_TEETH}], got ${String(teeth)}.`;
  }
  if (!(Number.isInteger(matingTeeth) && matingTeeth >= 6 && matingTeeth <= MAX_GEAR_TEETH)) {
    return `matingTeeth must be an integer in [6, ${MAX_GEAR_TEETH}], got ${String(matingTeeth)}.`;
  }
  if (!(shaftAngle > 0 && shaftAngle < Math.PI)) {
    return `shaftAngle must be in (0, π) radians, got ${String(shaftAngle)}.`;
  }
  if (pitchAngle !== undefined && !(pitchAngle > 0 && pitchAngle < Math.PI / 2)) {
    return `pitchAngle must be in (0, π/2) radians, got ${String(pitchAngle)}.`;
  }
  const angleProblem = pressureAngleProblem(pressureAngle);
  if (angleProblem !== null) return angleProblem;
  const geometry = bevelGeometry(mod, teeth, matingTeeth, shaftAngle, pitchAngle);
  if (!(faceWidth > 0 && faceWidth <= MAX_FACE_FRACTION * geometry.coneDistance)) {
    return (
      `faceWidth must be in (0, ${fmt(MAX_FACE_FRACTION * geometry.coneDistance)}] ` +
      `(cone distance ${fmt(geometry.coneDistance)}; usual practice is <= cone distance / 3), got ${String(faceWidth)}.`
    );
  }
  const shrink = 1 - faceWidth / geometry.coneDistance;
  const rootRadius = pitchRadiusOf(mod, teeth) - (1.25 * mod) / Math.cos(geometry.pitchAngle);
  if (!(rootRadius > 0.3 * pitchRadiusOf(mod, teeth))) {
    return `pitch angle too steep for ${teeth} teeth (root radius ${fmt(rootRadius)} <= 30% of the pitch radius); use more teeth or a smaller tooth ratio.`;
  }
  const toeRoot = shrink * rootRadius;
  if (!(bore >= 0 && bore < 0.8 * toeRoot)) {
    return `bore must be >= 0 and < ${fmt(0.8 * toeRoot)} (80% of the toe root radius), got ${String(bore)}.`;
  }
  return geometry;
}

const sharedFields = {
  module: z.number().describe('Gear module (metric) at the heel (large end), > 0.'),
  faceWidth: z
    .number()
    .describe(
      'Tooth length along the cone element (heel to toe), > 0 and <= 0.7 * cone distance; usual practice <= cone distance / 3.',
    ),
  pressureAngle: z
    .number()
    .describe('Pressure angle in RADIANS, in (0, π/2). Default 0.3491 (20°).')
    .optional(),
};

/**
 * @command add_bevel_gear
 * @pure
 * @layer core/commands
 * @affects creates 1 mesh entity (straight bevel gear, closed solid)
 * @invariant teeth, matingTeeth integers >= 6; shaftAngle in (0, π); faceWidth <= 0.7 * coneDistance
 * @failure invalid params -> unchanged doc, summary names the violated param, affected:[]
 */
export const addBevelGear = defineCommand({
  name: 'add_bevel_gear',
  description:
    'Create a straight bevel gear with real involute-style teeth as ONE closed mesh solid (no booleans). ' +
    'The pitch cone is derived from teeth, matingTeeth and shaftAngle (90° default): pitchAngle = atan(sin(shaft)/(matingTeeth/teeth + cos(shaft))); ' +
    'or pass pitchAngle explicitly. Heel (large end) face lies at the local z = 0 plane centred on `position`; the tooth profile is the ' +
    'module*teeth/2 pitch-circle spur outline and shrinks linearly towards the cone apex, which lies on the axis at +axis side ' +
    '(apex height = coneDistance*cos(pitchAngle)). `axis` selects the world direction of the gear axis (apex side), `rotation` is then applied about `position`. ' +
    'Tooth form is approximate (no Tredgold back-cone correction). `bore` cuts a cylindrical through hole. ' +
    'For two meshing gears use add_bevel_gear_pair. Result is a world-space mesh entity.',
  params: z.object({
    ...sharedFields,
    teeth: z.number().describe('Tooth count of THIS gear, integer >= 6.'),
    matingTeeth: z
      .number()
      .describe(
        'Tooth count of the mating gear, integer >= 6. Default: same as teeth (miter gear).',
      )
      .optional(),
    shaftAngle: z
      .number()
      .describe('Angle between the two shaft axes in RADIANS, in (0, π). Default π/2 (90°).')
      .optional(),
    pitchAngle: z
      .number()
      .describe(
        'Pitch-cone half angle in RADIANS, in (0, π/2). Overrides the value derived from the tooth counts.',
      )
      .optional(),
    bore: z
      .number()
      .describe('Radius of a central through hole, >= 0. Default 0 (solid).')
      .optional(),
    toothPhase: z
      .number()
      .describe(
        'Rotation of the tooth pattern about the gear axis in RADIANS. Default 0 (tooth 0 centred on +X).',
      )
      .optional(),
    axis: z
      .enum(['x', 'y', 'z'])
      .describe('World direction of the gear axis (towards the apex). Default "z".')
      .optional(),
    position: positionField('Centre of the heel face. '),
    rotation: rotationField('Applied about `position` after `axis`. '),
    color: z.string().describe('Hex color. Default "#b08d57".').optional(),
    name: nameField(),
  }),
  run: (
    doc,
    {
      module: mod,
      teeth,
      matingTeeth = teeth,
      shaftAngle = Math.PI / 2,
      pitchAngle,
      faceWidth,
      pressureAngle = Math.PI / 9,
      bore = 0,
      toothPhase = 0,
      axis = 'z',
      position,
      rotation,
      color = '#b08d57',
      name,
    },
  ): CommandResult => {
    const checked = checkBevel({
      mod,
      teeth,
      matingTeeth,
      shaftAngle,
      pitchAngle,
      faceWidth,
      pressureAngle,
      bore,
    });
    if (typeof checked === 'string') return noop(doc, `add_bevel_gear failed: ${checked}`);
    const at = finiteVec3OrZero(position);
    const turn = finiteVec3OrZero(rotation);
    const local = bevelGearMesh(mod, teeth, pressureAngle, checked, faceWidth, bore, toothPhase);
    const oriented = placeMesh(local, ORIGIN, AXIS_ROTATION[axis]);
    const id = nextId('bevel');
    const pivoted = meshGearEntity(id, placeMesh(oriented, at, turn), color, name);
    return commitEntity(
      doc,
      pivoted,
      `Created bevel_gear ${id}: module=${fmt(mod)} teeth=${teeth} matingTeeth=${matingTeeth} ` +
        `pitchAngle=${fmt((checked.pitchAngle * 180) / Math.PI)}deg coneDistance=${fmt(checked.coneDistance)} ` +
        `face=${fmt(faceWidth)} apexHeight=${fmt(checked.apexHeight)} bore=${fmt(bore)} at ${vecText(at)}. ` +
        `${boundsText(rotatedEntityBounds(pivoted))}.`,
    );
  },
});

/**
 * @command add_bevel_gear_pair
 * @pure
 * @layer core/commands
 * @affects creates 2 mesh entities (pinion on +Z axis, wheel on +X axis, apexes coincident at position)
 * @invariant pinionTeeth, wheelTeeth integers >= 6; shaft angle fixed at 90°
 * @failure invalid params -> unchanged doc, summary names the violated param, affected:[]
 */
export const addBevelGearPair = defineCommand({
  name: 'add_bevel_gear_pair',
  description:
    'Create a meshing pair of straight bevel gears at a 90° shaft angle: a pinion (axis along world Z) and a wheel (axis along world X) ' +
    'whose pitch-cone apexes coincide at `position` (the cone apex, default origin). The pinion heel face lies at z = apex - apexHeight, ' +
    'the wheel heel face at x = apex - apexHeight; teeth are phased so they mesh with backlash. Pitch angles: pinion atan(pinionTeeth/wheelTeeth), ' +
    'wheel 90° minus that. Returns affected = [pinion, wheel] and data {ratio, pinionPitchAngle, wheelPitchAngle, coneDistance}.',
  params: z.object({
    ...sharedFields,
    pinionTeeth: z.number().describe('Pinion tooth count, integer >= 6.'),
    wheelTeeth: z.number().describe('Wheel tooth count, integer >= 6.'),
    pinionBore: z.number().describe('Pinion through-hole radius, >= 0. Default 0.').optional(),
    wheelBore: z.number().describe('Wheel through-hole radius, >= 0. Default 0.').optional(),
    position: positionField('This is the common cone apex. '),
    pinionColor: z.string().describe('Pinion hex color. Default "#b08d57".').optional(),
    wheelColor: z.string().describe('Wheel hex color. Default "#7a9cbb".').optional(),
    namePrefix: z.string().describe('Name prefix: "<prefix>_pinion", "<prefix>_wheel".').optional(),
  }),
  run: (
    doc,
    {
      module: mod,
      faceWidth,
      pressureAngle = Math.PI / 9,
      pinionTeeth,
      wheelTeeth,
      pinionBore = 0,
      wheelBore = 0,
      position,
      pinionColor = '#b08d57',
      wheelColor = '#7a9cbb',
      namePrefix = 'bevel',
    },
  ): CommandResult => {
    const shared = {
      mod,
      shaftAngle: Math.PI / 2,
      pitchAngle: undefined,
      faceWidth,
      pressureAngle,
    };
    const pinion = checkBevel({
      ...shared,
      teeth: pinionTeeth,
      matingTeeth: wheelTeeth,
      bore: pinionBore,
    });
    if (typeof pinion === 'string')
      return noop(doc, `add_bevel_gear_pair failed (pinion): ${pinion}`);
    const wheel = checkBevel({
      ...shared,
      teeth: wheelTeeth,
      matingTeeth: pinionTeeth,
      bore: wheelBore,
    });
    if (typeof wheel === 'string') return noop(doc, `add_bevel_gear_pair failed (wheel): ${wheel}`);

    const apex = finiteVec3OrZero(position);
    const wheelPhase = (Math.PI * (pinionTeeth - 1)) / wheelTeeth;
    const pinionId = nextId('pinion');
    const wheelId = nextId('wheel');
    const pinionEntity = meshGearEntity(
      pinionId,
      placeMesh(
        bevelGearMesh(mod, pinionTeeth, pressureAngle, pinion, faceWidth, pinionBore, 0),
        [apex[0], apex[1], apex[2] - pinion.apexHeight],
        ORIGIN,
      ),
      pinionColor,
      `${namePrefix}_pinion`,
    );
    const wheelEntity = meshGearEntity(
      wheelId,
      placeMesh(
        bevelGearMesh(mod, wheelTeeth, pressureAngle, wheel, faceWidth, wheelBore, wheelPhase),
        [apex[0] - wheel.apexHeight, apex[1], apex[2]],
        AXIS_ROTATION.x,
      ),
      wheelColor,
      `${namePrefix}_wheel`,
    );
    return {
      document: withEntity(withEntity(doc, pinionEntity), wheelEntity),
      summary:
        `Created bevel gear pair: pinion ${pinionId} (${pinionTeeth}T, axis Z) and wheel ${wheelId} (${wheelTeeth}T, axis X), ` +
        `module=${fmt(mod)} ratio=${fmt(wheelTeeth / pinionTeeth)}:1 coneDistance=${fmt(pinion.coneDistance)} ` +
        `apex at ${vecText(apex)}.`,
      affected: [pinionId, wheelId],
      data: {
        ratio: wheelTeeth / pinionTeeth,
        pinionPitchAngle: pinion.pitchAngle,
        wheelPitchAngle: wheel.pitchAngle,
        coneDistance: pinion.coneDistance,
      },
    };
  },
});
