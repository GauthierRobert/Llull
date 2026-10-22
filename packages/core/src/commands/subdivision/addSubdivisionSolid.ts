/**
 * Freeform solids: Catmull-Clark subdivision surfaces over an editable polygon cage (saddles, shifter hoods, dropouts, grips, fairings).
 * The cage is the definition; the smooth surface is derived (geometry/subdivision).
 */

import { idOrNext } from '../../lib/explicitId';
import type { SubdivisionEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { failer } from '../noop';
import { finiteVec3OrZero } from '../../lib/vec3';
import { newEntity } from '../entity/newEntity';
import {
  DEFAULT_SOLID_COLOR,
  commitSolid,
  rotationField,
  existingLayerOrDefault,
  namedSolidStyleFields,
  explicitIdTaken,
} from '../solids/shared';
import { type Cage, boxCage, cageProblem, cylinderCage } from '../../geometry/subdivision';
import { edgeKey } from '../../geometry/subd/edgeKey';
import { SHARP_MAX, edgeSharpnessMap, partitionSharpness } from '../../geometry/subd/sharpness';
import { initialElementIds } from '../../geometry/subd/elements';
import { dirRejection } from './codes';
import { cageData, cageText, levelsField, sizeProblem } from './shared';

const MAX_SEGMENTS = 32;

const creasesField = z
  .array(z.tuple([z.number().int(), z.number().int()]))
  .describe('Cage edges kept sharp, as [vertexIndex, vertexIndex] pairs (each must be an edge of a face).');

type Preset =
  | { box: { size: Vec3; segments?: [number, number, number] | undefined } }
  | { cylinder: { radius: number; height: number; sides?: number | undefined; segments?: number | undefined } };

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

/** Sharpness entries merged into the entity form: infinite edges in `creases`, finite ones in `edgeSharpness` (a repeated edge keeps its larger value). */
function sharpnessOf(
  creases: ReadonlyArray<readonly [number, number]>,
  semi: ReadonlyArray<{ a: number; b: number; s: number }>,
): ReturnType<typeof partitionSharpness> {
  const merged = edgeSharpnessMap({ creases, edgeSharpness: semi });
  const seen = new Set<string>();
  const entries: Array<[number, number, number]> = [];
  for (const [a, b] of [...creases, ...semi.map(({ a, b }): [number, number] => [a, b])]) {
    const key = edgeKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push([a, b, merged.get(key) as number]);
  }
  return partitionSharpness(entries);
}

const rangeProblem = (entries: ReadonlyArray<{ s: number }>): string | null => {
  const bad = entries.find(({ s }) => !(s > 0 && s <= SHARP_MAX));
  return bad === undefined ? null : `sharpness ${bad.s} is outside (0, ${SHARP_MAX}]`;
};

/**
 * @affects creates 1 subdivision entity at `position`
 * @invariant cage is a closed, consistently wound 2-manifold; creases are cage edges; every vertex and face gets a stable element id minted by this step
 * @failure no / several cage sources, bad sizes, open or mis-wound cage (DIR_CAGE_OPEN), bad levels (DIR_LEVELS_RANGE), too many vertices (DIR_CAGE_TOO_LARGE), sharpness out of range (DIR_SHARPNESS_RANGE), duplicate id -> no-op
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
    'creased edges stay sharp. Semi-sharp creases: `edgeSharpness` / `vertexSharpness` (0..10). Returns data { vertexCount, faceCount, ' +
    'vertices, vertexIds, faceIds } (cage vertices in world coordinates, by index, with their stable element ids) to aim later edits. A closed solid: booleans, blend_union, ' +
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
    edgeSharpness: z
      .array(
        z.object({
          a: z.number().int().describe('Cage vertex index of one end.'),
          b: z.number().int().describe('Cage vertex index of the other end.'),
          s: z
            .number()
            .describe(`Sharpness 0 < s <= ${SHARP_MAX}: the edge stays crisp for about s subdivision levels (${SHARP_MAX} = infinite).`),
        }),
      )
      .describe('Semi-sharp cage edges (OpenSubdiv creases). Use creases for infinitely sharp ones.')
      .optional(),
    vertexSharpness: z
      .array(
        z.object({ v: z.number().int().describe('Cage vertex index.'), s: z.number().describe(`Corner sharpness 0 < s <= ${SHARP_MAX}.`) }),
      )
      .describe('Semi-sharp cage corners: the vertex stays a point for about s levels.')
      .optional(),
    creaseMethod: z
      .enum(['uniform', 'chaikin'])
      .describe('How sharpness decays per level: uniform (default, minus 1) or chaikin (smoothed).')
      .optional(),
    levels: levelsField.optional(),
    position: vec3('World position of the cage origin. Defaults to [0, 0, 0].').optional(),
    rotation: rotationField(),
    ...namedSolidStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_subdivision_solid');
    const { levels = 3, creases = [], edgeSharpness = [], vertexSharpness = [], position = [0, 0, 0], rotation, layerId, name } = params;
    const explicitId = params.id;
    if (explicitIdTaken(doc, explicitId)) return fail(`entity id "${explicitId}" already exists`);
    const base = cageOf(params.box, params.cylinder, params.vertices, params.faces);
    if (typeof base === 'string') return fail(base);
    const range = rangeProblem(edgeSharpness) ?? rangeProblem(vertexSharpness);
    if (range !== null) return dirRejection(doc, 'add_subdivision_solid', 'DIR_SHARPNESS_RANGE', range, [], ['params.edgeSharpness']);
    const sharp = sharpnessOf(creases, edgeSharpness);
    const cage: Cage = {
      ...base,
      creases: sharp.creases,
      ...(sharp.edgeSharpness.length > 0 ? { edgeSharpness: sharp.edgeSharpness } : {}),
      ...(vertexSharpness.length > 0 ? { vertexSharpness } : {}),
      ...(params.creaseMethod !== undefined ? { creaseMethod: params.creaseMethod } : {}),
    };
    const size = sizeProblem(cage, levels);
    if (size !== null) return dirRejection(doc, 'add_subdivision_solid', size.code, size.message);
    const problem = cageProblem(cage);
    if (problem?.includes('must be closed')) return dirRejection(doc, 'add_subdivision_solid', 'DIR_CAGE_OPEN', problem);
    if (problem !== null) return fail(problem);
    const id = idOrNext(explicitId, 'subd');
    const entity: SubdivisionEntity = newEntity(
      'subdivision',
      id,
      {
        vertices: cage.vertices,
        faces: cage.faces,
        creases: cage.creases,
        ...(cage.edgeSharpness !== undefined ? { edgeSharpness: cage.edgeSharpness } : {}),
        ...(cage.vertexSharpness !== undefined ? { vertexSharpness: cage.vertexSharpness } : {}),
        ...(cage.creaseMethod !== undefined ? { creaseMethod: cage.creaseMethod } : {}),
        levels,
        elementIds: initialElementIds(cage.vertices.length, cage.faces.length),
      },
      position,
      params.color ?? DEFAULT_SOLID_COLOR,
      { rotation: finiteVec3OrZero(rotation), name, layerId: existingLayerOrDefault(doc, layerId) },
    ) as SubdivisionEntity;
    return { ...commitSolid(doc, entity, `add_subdivision_solid: created "${id}" (${cageText(cage, levels)})`), data: cageData(entity) };
  },
});
