/**
 * add_planetary_gearset: sun + N planets + ring with the tooth phasing that lets them mesh.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { nextId } from '../../lib/id';
import { compactNumber as fmt, vecText } from '../../lib/compactNumber';
import { applyEulerXYZ } from '../../lib/eulerRotation';
import { finiteVec3OrZero } from '../../lib/vec3';
import { DEFAULT_FLANK_SAMPLES, externalGearPattern, toothOutline } from '../../lib/gearOutline';
import { MAX_GEAR_TEETH } from '../limits';
import { withEntity } from '../entity/entityOps';
import { newEntity } from '../entity/newEntity';
import { positionField } from './shared';
import {
  AXIS_ROTATION,
  faceWidthProblem,
  placedMeshEntity,
  pressureAngleProblem,
} from './gearSolid';
import { internalGearMesh, minRingOuterRadius } from './gearsInternal';
import { failedWith } from '../noop';

const MAX_PLANETS = 12;

/**
 * Tooth-pattern phases (angle of tooth 0 / space 0, radians) that let every planet mesh with sun
 * (tooth 0 at angle 0) and ring. Planet i sits at carrier angle `2π·i/planetCount`.
 * @invariant requires (sunTeeth + ringTeeth) % planetCount === 0
 */
export function planetaryPhases(
  sunTeeth: number,
  planetTeeth: number,
  planetCount: number,
): { planets: number[]; ring: number } {
  const ringTeeth = sunTeeth + 2 * planetTeeth;
  const planets = Array.from({ length: planetCount }, (_, i) => {
    const carrier = (2 * Math.PI * i) / planetCount;
    return carrier + (carrier * sunTeeth - Math.PI + Math.PI * planetTeeth) / planetTeeth;
  });
  return { planets, ring: (Math.PI * (planetTeeth - 1)) / ringTeeth };
}

/**
 * @command add_planetary_gearset
 * @pure
 * @layer core/commands
 * @affects creates 1 sun (extrusion) + planetCount planets (extrusion) + 1 ring (mesh)
 * @invariant ringTeeth = sunTeeth + 2*planetTeeth; (sunTeeth + ringTeeth) % planetCount === 0; neighbouring planets do not touch
 * @failure assembly condition violated / invalid params -> unchanged doc, summary explains, affected:[]
 */
export const addPlanetaryGearset = defineCommand({
  name: 'add_planetary_gearset',
  description:
    'Create a complete planetary (epicyclic) gear stage: one sun gear, planetCount planet gears and an internal ring gear, ' +
    'all sharing one module and pressure angle, with tooth phasing computed so that every planet meshes with the sun and the ring ' +
    'without interference. ringTeeth = sunTeeth + 2*planetTeeth. Assembly condition: (sunTeeth + ringTeeth) must be divisible by ' +
    'planetCount (e.g. sun 12, planet 18 -> ring 48, sum 60: planetCount 1-6, 10 or 12 work); otherwise the command is rejected ' +
    'and the summary lists the valid planetCounts. Centre distance (sun-planet) = module*(sunTeeth+planetTeeth)/2. ' +
    'Planets below ~12 teeth can show tip interference with the ring (undercut) - prefer planetTeeth >= 12. Gear ratio (sun in, ring fixed, carrier out) = 1 + ringTeeth/sunTeeth. All gears share the axis direction (default +Z); the sun ' +
    'and ring are centred on `position`, planets orbit it. Returns affected = [sun, ...planets, ring] and data ' +
    '{ringTeeth, ratio, centerDistance, ringPitchRadius, ids:{sun, planets, ring}}. The sun and planets are extrusion entities, the ring a mesh entity.',
  params: z.object({
    module: z.number().describe('Gear module (metric), > 0, shared by sun, planets and ring.'),
    sunTeeth: z.number().describe('Sun gear tooth count, integer >= 6.'),
    planetTeeth: z.number().describe('Planet gear tooth count, integer >= 6.'),
    planetCount: z
      .number()
      .describe(
        `Number of planets, integer in [1, ${MAX_PLANETS}]. (sunTeeth + ringTeeth) must be divisible by it.`,
      ),
    faceWidth: z.number().describe('Thickness of every gear along the axis, > 0.'),
    ringOuterRadius: z
      .number()
      .describe(
        'Outer radius of the ring gear rim, >= ring pitch radius + 2.25*module (the command reports the minimum).',
      ),
    pressureAngle: z
      .number()
      .describe('Pressure angle in RADIANS, in (0, π/2). Default 0.3491 (20°).')
      .optional(),
    position: positionField('Centre of the sun/ring on the axis (z = bottom face). '),
    axis: z
      .enum(['x', 'y', 'z'])
      .describe(
        'Direction of the gear axis in world space. Default "z" (gears lie in the XY plane).',
      )
      .optional(),
    sunColor: z.string().describe('Sun hex color. Default "#d9a441".').optional(),
    planetColor: z.string().describe('Planet hex color. Default "#7a9cbb".').optional(),
    ringColor: z.string().describe('Ring hex color. Default "#8892a0".').optional(),
    namePrefix: z
      .string()
      .describe('Prefix for entity names: "<prefix>_sun", "<prefix>_planet_1".., "<prefix>_ring".')
      .optional(),
  }),
  run: (
    doc,
    {
      module: mod,
      sunTeeth,
      planetTeeth,
      planetCount,
      faceWidth,
      ringOuterRadius,
      pressureAngle = Math.PI / 9,
      position,
      axis = 'z',
      sunColor = '#d9a441',
      planetColor = '#7a9cbb',
      ringColor = '#8892a0',
      namePrefix = 'planetary',
    },
  ): CommandResult => {
    const fail = failedWith(doc, 'add_planetary_gearset');
    if (!(mod > 0 && Number.isFinite(mod)))
      return fail(`module must be finite and > 0, got ${String(mod)}.`);
    const [sun, planet, count] = [sunTeeth, planetTeeth, planetCount].map(Math.round) as [
      number,
      number,
      number,
    ];
    const ring = sun + 2 * planet;
    if (!(sun >= 6 && planet >= 6 && ring <= MAX_GEAR_TEETH)) {
      return fail(
        `sunTeeth and planetTeeth must be integers >= 6 with ringTeeth <= ${MAX_GEAR_TEETH}, got sun=${String(sunTeeth)} planet=${String(planetTeeth)}.`,
      );
    }
    if (!(count >= 1 && count <= MAX_PLANETS)) {
      return fail(
        `planetCount must be an integer in [1, ${MAX_PLANETS}], got ${String(planetCount)}.`,
      );
    }
    const shapeProblem = pressureAngleProblem(pressureAngle) ?? faceWidthProblem(faceWidth);
    if (shapeProblem !== null) return fail(shapeProblem);
    if ((sun + ring) % count !== 0) {
      const valid = Array.from({ length: MAX_PLANETS }, (_, i) => i + 1).filter(
        (n) => (sun + ring) % n === 0,
      );
      return fail(
        `assembly condition violated: (sunTeeth + ringTeeth) = ${sun + ring} (ringTeeth = ${ring}) is not divisible by planetCount ${count}. ` +
          `Valid planetCounts for this tooth combination: ${valid.join(', ')}.`,
      );
    }
    const minRim = minRingOuterRadius(mod, ring);
    if (!(ringOuterRadius >= minRim && Number.isFinite(ringOuterRadius))) {
      return fail(
        `ringOuterRadius must be >= ${fmt(minRim)} (ring pitch radius + 2.25*module), got ${String(ringOuterRadius)}.`,
      );
    }
    const centerDistance = (mod * (sun + planet)) / 2;
    if (count > 1 && 2 * centerDistance * Math.sin(Math.PI / count) <= mod * (planet + 2.2)) {
      return fail(
        `neighbouring planets would collide: ${count} planets of ${planet} teeth do not fit on centre distance ${fmt(centerDistance)}. Use fewer planets or fewer planet teeth.`,
      );
    }

    const centre = finiteVec3OrZero(position);
    const turn = AXIS_ROTATION[axis];
    const phases = planetaryPhases(sun, planet, count);
    const outline = (teeth: number, phase: number): ReadonlyArray<readonly [number, number]> =>
      toothOutline(externalGearPattern(mod, teeth, pressureAngle, DEFAULT_FLANK_SAMPLES, phase));
    const toothed = (
      id: string,
      teeth: number,
      phase: number,
      at: Vec3,
      color: string,
      name: string,
    ): Entity =>
      newEntity('extrusion', id, { profile: outline(teeth, phase), depth: faceWidth }, at, color, {
        rotation: turn,
        name,
      });

    const sunId = nextId('sun');
    const entities: Entity[] = [toothed(sunId, sun, 0, centre, sunColor, `${namePrefix}_sun`)];
    const planetIds: string[] = [];
    phases.planets.forEach((phase, i) => {
      const carrier = (2 * Math.PI * i) / count;
      const local: Vec3 = [
        centerDistance * Math.cos(carrier),
        centerDistance * Math.sin(carrier),
        0,
      ];
      const offset = applyEulerXYZ(local, [0, 0, 0], turn);
      const at: Vec3 = [centre[0] + offset[0], centre[1] + offset[1], centre[2] + offset[2]];
      const id = nextId('planet');
      planetIds.push(id);
      entities.push(toothed(id, planet, phase, at, planetColor, `${namePrefix}_planet_${i + 1}`));
    });
    const ringId = nextId('ring');
    entities.push(
      placedMeshEntity(
        ringId,
        internalGearMesh(mod, ring, pressureAngle, faceWidth, ringOuterRadius, phases.ring),
        centre,
        turn,
        ringColor,
        `${namePrefix}_ring`,
      ),
    );

    const next: CadDocument = entities.reduce(withEntity, doc);
    const ratio = 1 + ring / sun;
    return {
      document: next,
      summary:
        `Created planetary gearset: sun ${sunId} (${sun}T), ${count} planets [${planetIds.join(', ')}] (${planet}T), ` +
        `ring ${ringId} (${ring}T). module=${fmt(mod)} centerDistance=${fmt(centerDistance)} ` +
        `ratio=${fmt(ratio)}:1 (sun in, ring fixed, carrier out) axis=${axis} at ${vecText(centre)}.`,
      affected: [sunId, ...planetIds, ringId],
      data: {
        ringTeeth: ring,
        ratio,
        centerDistance,
        ringPitchRadius: (mod * ring) / 2,
        ids: { sun: sunId, planets: planetIds, ring: ringId },
      },
    };
  },
});
