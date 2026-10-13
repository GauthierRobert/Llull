/**
 * Freeform solids: Catmull-Clark subdivision surfaces over an editable polygon cage (saddles,
 * shifter hoods, dropouts, grips, fairings). The cage is the definition; the smooth surface is
 * derived (geometry/subdivision).
 */

import type { SubdivisionEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { failer } from '../noop';
import { finiteVec3OrZero, map3 } from '../../lib/vec3';
import { entityLocalToWorld } from '../../geometry/entityFrame';
import { newEntity } from '../entity/newEntity';
import {
  DEFAULT_SOLID_COLOR,
  commitSolid,
  rotationField,
  existingLayerOrDefault,
  namedSolidStyleFields,
  explicitIdOrNext,
  explicitIdTaken,
} from './shared';
import { type Cage, edgeKey, MAX_SUBDIVISION_LEVELS, boxCage, cageProblem, cylinderCage } from '../../geometry/subdivision';
import { roundTo } from '../../lib/compactNumber';

/** Largest cage accepted (vertices); the surface grows ×4 per level. */
const MAX_CAGE_VERTICES = 2000;
const MAX_SEGMENTS = 32;

export const levelsField = z
  .number()
  .int()
  .describe(
    `Subdivision levels 0..${MAX_SUBDIVISION_LEVELS} (0 = the faceted cage itself; 2-3 is smooth; ` +
      'each level quadruples the face count).',
  );

const creasesField = z
  .array(z.tuple([z.number().int(), z.number().int()]))
  .describe('Cage edges kept sharp, as [vertexIndex, vertexIndex] pairs (each must be an edge of a face).');

type Preset =
  | { box: { size: Vec3; segments?: [number, number, number] | undefined } }
  | {
      cylinder: {
        radius: number;
        height: number;
        sides?: number | undefined;
        segments?: number | undefined;
      };
    };

function presetCage(preset: Preset): Cage | string {
  const intIn = (value: number, min: number, max: number): boolean => Number.isInteger(value) && value >= min && value <= max;
  if ('box' in preset) {
    const { size, segments = [1, 1, 1] } = preset.box;
    if (!size.every((s) => s > 0)) return `box size must be > 0 on every axis (got [${size}])`;
    if (!segments.every((n) => intIn(n, 1, MAX_SEGMENTS))) return `box segments must be integers 1..${MAX_SEGMENTS}`;
    return boxCage(size, segments);
  }
  const { radius, height, sides = 8, segments = 1 } = preset.cylinder;
  if (!(radius > 0) || !(height > 0)) return 'cylinder radius and height must be > 0';
  if (!intIn(sides, 3, 64) || !intIn(segments, 1, MAX_SEGMENTS)) return `cylinder sides must be 3..64 and segments 1..${MAX_SEGMENTS}`;
  return cylinderCage(radius, height, sides, segments);
}

function cageOf(
  box: Extract<Preset, { box: unknown }>['box'] | undefined,
  cylinder: Extract<Preset, { cylinder: unknown }>['cylinder'] | undefined,
  vertices: Vec3[] | undefined,
  faces: number[][] | undefined,
): Cage | string {
  const given = [box, cylinder, vertices ?? faces].filter((x) => x !== undefined).length;
  if (given !== 1) return 'give exactly one of box, cylinder or vertices + faces';
  if (box !== undefined) return presetCage({ box });
  if (cylinder !== undefined) return presetCage({ cylinder });
  if (vertices === undefined || faces === undefined) return 'a custom cage needs both vertices and faces';
  return { vertices, faces, creases: [] };
}

/** `edges` without repeats (a-b and b-a are the same edge). */
function uniqueEdges(edges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const seen = new Map<string, [number, number]>();
  for (const [a, b] of edges) if (!seen.has(edgeKey(a, b))) seen.set(edgeKey(a, b), [a, b]);
  return [...seen.values()];
}

/** Summary line of a cage. */
export const cageText = (cage: Cage, levels: number): string =>
  `${cage.vertices.length}-vertex / ${cage.faces.length}-face cage, ${levels} level(s)` +
  (cage.creases.length > 0 ? `, ${cage.creases.length} crease(s)` : '');

/** Why `levels` / the cage size are out of range (null when fine). */
export function sizeProblem(cage: Cage, levels: number): string | null {
  if (!Number.isInteger(levels) || levels < 0 || levels > MAX_SUBDIVISION_LEVELS)
    return `levels must be an integer 0..${MAX_SUBDIVISION_LEVELS} (got ${levels})`;
  if (cage.vertices.length > MAX_CAGE_VERTICES) return `the cage has ${cage.vertices.length} vertices (max ${MAX_CAGE_VERTICES})`;
  return null;
}

/**
 * @command add_subdivision_solid
 * @pure
 * @layer core/commands
 * @affects creates 1 subdivision entity at `position`
 * @invariant cage is a closed, consistently wound 2-manifold; creases are cage edges
 * @failure no / several cage sources, bad sizes, open or mis-wound cage, bad levels, duplicate id -> no-op
 */
export const addSubdivisionSolid = defineCommand({
  name: 'add_subdivision_solid',
  description:
    'Create a freeform solid as a Catmull-Clark subdivision surface over a coarse polygon control ' +
    'cage — for organic shapes no primitive gives (saddles, shifter hoods, grips, dropouts, ' +
    'fairings, handles). Start from a `box` cage (size + segments per axis) or a `cylinder` cage ' +
    '(radius, height, sides, segments along Z), both centred on `position`, or give a custom closed ' +
    'cage (`vertices` local to `position` + `faces` as vertex-index loops wound counter-clockwise seen ' +
    'from outside). Then shape it with edit_subdivision_cage (move / scale regions of cage vertices, ' +
    'with soft falloff; crease edges). The surface stays inside the cage and is smooth (2-3 levels); ' +
    'creased edges stay sharp. Returns data { vertexCount, faceCount, vertices } (cage vertices in ' +
    'world coordinates, by index) to aim later edits. A closed solid: booleans, blend_union, ' +
    'measurement and export all work. With the OCC kernel a smooth solid (levels >= 1) is an exact ' +
    'B-spline solid — one bicubic face per refined cage quad, exactly the limit surface away from ' +
    'extraordinary vertices and creases (close to it there) — so STEP export and booleans are exact; levels 0 stays faceted.',
  params: z.object({
    box: z
      .object({
        size: vec3('Cage size [x, y, z] (> 0); the smooth surface sits inside it.'),
        segments: z
          .tuple([z.number().int(), z.number().int(), z.number().int()])
          .describe(`Cage faces along x, y, z (1..${MAX_SEGMENTS}; default [1, 1, 1]).`)
          .optional(),
      })
      .describe('Box cage centred on position.')
      .optional(),
    cylinder: z
      .object({
        radius: z.number().describe('Cage circumradius (> 0).'),
        height: z.number().describe('Cage height along Z (> 0).'),
        sides: z.number().int().describe('Sides of the cage polygon (3..64; default 8).').optional(),
        segments: z.number().int().describe(`Side-face rings along Z (1..${MAX_SEGMENTS}; default 1).`).optional(),
      })
      .describe('Cylinder (n-gon prism) cage along Z centred on position.')
      .optional(),
    vertices: z.array(vec3('Cage vertex [x, y, z], local to position.')).describe('Custom cage vertices (use with faces).').optional(),
    faces: z
      .array(z.array(z.number().int()).describe('Vertex indices of one face, counter-clockwise from outside.'))
      .describe('Custom cage faces (use with vertices); the cage must be closed.')
      .optional(),
    creases: creasesField.optional(),
    levels: levelsField.optional(),
    position: vec3('World position of the cage origin. Defaults to [0, 0, 0].').optional(),
    rotation: rotationField(),
    ...namedSolidStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_subdivision_solid');
    const { levels = 3, creases = [], position = [0, 0, 0], rotation, layerId, name } = params;
    const explicitId = params.id;
    if (explicitIdTaken(doc, explicitId)) return fail(`entity id "${explicitId}" already exists`);
    const base = cageOf(params.box, params.cylinder, params.vertices, params.faces);
    if (typeof base === 'string') return fail(base);
    const cage: Cage = { ...base, creases: uniqueEdges(creases) };
    const problem = sizeProblem(cage, levels) ?? cageProblem(cage);
    if (problem !== null) return fail(problem);
    const id = explicitIdOrNext(explicitId, 'subd');
    const entity: SubdivisionEntity = newEntity(
      'subdivision',
      id,
      { vertices: cage.vertices, faces: cage.faces, creases: cage.creases, levels },
      position,
      params.color ?? DEFAULT_SOLID_COLOR,
      {
        rotation: finiteVec3OrZero(rotation),
        name,
        layerId: existingLayerOrDefault(doc, layerId),
      },
    ) as SubdivisionEntity;
    const result = commitSolid(doc, entity, `add_subdivision_solid: created "${id}" (${cageText(cage, levels)})`);
    return { ...result, data: cageData(entity) };
  },
});

/** `data` of the cage commands: counts plus the cage vertices in world coordinates. */
export function cageData(entity: { vertices: readonly Vec3[]; faces: readonly unknown[]; position: Vec3; rotation: Vec3 }): {
  vertexCount: number;
  faceCount: number;
  vertices: Vec3[];
} {
  return {
    vertexCount: entity.vertices.length,
    faceCount: entity.faces.length,
    vertices: entity.vertices.map((p) => worldOf(p, entity)),
  };
}

/** World coordinates of a cage point. */
export function worldOf(p: Vec3, entity: { position: Vec3; rotation: Vec3 }): Vec3 {
  return map3(entityLocalToWorld(entity, p), (value) => roundTo(value, 6));
}
