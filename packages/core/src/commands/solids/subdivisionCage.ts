import type { CadDocument, SubdivisionEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { changed, noop } from '../noop';
import { add3, distance3, scale3, sub3 } from '../../lib/vec3';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { replaceEntity } from '../entity/entityOps';
import { edgeKey } from '../../geometry/subdivision';
import { cageData, cageText, levelsField, sizeProblem, worldOf } from './subdivision';

/** Selection weight of each cage vertex in [0, 1] (1 = fully selected). */
function selectionWeights(
  world: readonly Vec3[],
  vertexIndices: readonly number[] | undefined,
  region: { min: Vec3; max: Vec3 } | undefined,
  falloff: number,
): number[] {
  const inRegion = (p: Vec3): number => {
    if (region === undefined) return 0;
    const outside = p.map((value, axis) =>
      Math.max((region.min[axis] as number) - value, 0, value - (region.max[axis] as number)),
    );
    return Math.hypot(...outside);
  };
  const picked = new Set(vertexIndices ?? []);
  const seeds = world.filter((_, v) => picked.has(v));
  const distance = (p: Vec3, v: number): number => {
    if (vertexIndices === undefined && region === undefined) return 0;
    if (region !== undefined) return inRegion(p);
    if (picked.has(v)) return 0;
    return seeds.reduce((best, seed) => Math.min(best, distance3(p, seed)), Infinity);
  };
  return world.map((p, v) => {
    const d = distance(p, v);
    if (d <= 1e-9) return 1;
    if (falloff <= 0 || d >= falloff) return 0;
    const t = 1 - d / falloff;
    return t * t * (3 - 2 * t);
  });
}

/** Crease list with edges between fully selected vertices added (`on`) or removed. */
function recreased(
  entity: SubdivisionEntity,
  selected: ReadonlySet<number>,
  on: boolean,
): Array<readonly [number, number]> {
  const kept = entity.creases.filter(([a, b]) => on || !(selected.has(a) && selected.has(b)));
  if (!on) return kept;
  const keys = new Set(kept.map(([a, b]) => edgeKey(a, b)));
  for (const face of entity.faces) {
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length] as number;
      if (selected.has(a) && selected.has(b) && !keys.has(edgeKey(a, b))) {
        keys.add(edgeKey(a, b));
        kept.push([a, b]);
      }
    });
  }
  return kept;
}

/** The edited document, summary and cage data of an edit. */
function reported(
  doc: CadDocument,
  id: string,
  updated: SubdivisionEntity,
  selected: number[],
  moved: number,
): CommandResult {
  return {
    ...changed(
      replaceEntity(doc, updated),
      `edit_subdivision_cage: '${id}' — ${selected.length} vertex(es) selected` +
        (moved > selected.length ? ` (+${moved - selected.length} by falloff)` : '') +
        `; now ${cageText(updated, updated.levels)}.`,
      [id],
    ),
    data: { ...cageData(updated), selected },
  };
}

function subdivisionTarget(doc: CadDocument, id: string): SubdivisionEntity | string {
  const entity = doc.entities[id];
  if (entity === undefined) return `no entity '${id}'`;
  if (entity.kind !== 'subdivision')
    return `'${id}' is a ${entity.kind}, not a subdivision solid (add_subdivision_solid)`;
  return entity;
}

/**
 * @command edit_subdivision_cage
 * @pure
 * @layer core/commands
 * @affects modifies 1 subdivision entity (cage vertices, creases, levels; topology unchanged)
 * @failure missing / non-subdivision id, bad indices, empty selection, nothing to do, bad levels -> no-op
 */
export const editSubdivisionCage = defineCommand({
  name: 'edit_subdivision_cage',
  description:
    'Sculpt a subdivision solid (add_subdivision_solid) by editing its control cage: select cage ' +
    'vertices by `vertexIndices` or by a world-space `region` box (none = all), optionally with a soft ' +
    '`falloff` distance so neighbours follow smoothly, then `translate` them (world vector), `scale` ' +
    'them about `pivot` (per axis of the solid; pivot defaults to the selection centre), and/or set ' +
    '`crease` (true: cage edges between selected vertices turn sharp; false: smooth again). `levels` ' +
    'changes the refinement. Order: scale, then translate. Returns data { vertexCount, faceCount, ' +
    'vertices, selected } (world cage vertices; indices of fully selected vertices).',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    vertexIndices: z
      .array(z.number().int())
      .describe('Cage vertex indices to select (from the data of add_subdivision_solid).')
      .optional(),
    region: z
      .object({
        min: vec3('World-space minimum corner [x, y, z] of the selection box.'),
        max: vec3('World-space maximum corner [x, y, z] of the selection box.'),
      })
      .describe('Select the cage vertices inside this world-space box (alternative to indices).')
      .optional(),
    falloff: z
      .number()
      .describe(
        'Soft-selection distance (>= 0, default 0): vertices this close to the selection move partly (smoothstep).',
      )
      .optional(),
    translate: vec3('World-space move [dx, dy, dz] of the selection.').optional(),
    scale: vec3(
      'Scale factors [sx, sy, sz] (> 0) along the solid axes about the pivot (e.g. [0.6, 0.6, 1] narrows).',
    ).optional(),
    pivot: vec3(
      'World-space scale centre. Default: centre of the fully selected vertices.',
    ).optional(),
    crease: z
      .boolean()
      .describe('true: make edges between selected vertices sharp; false: make them smooth.')
      .optional(),
    levels: levelsField.optional(),
  }),
  run: (doc, params): CommandResult => {
    const fail = (why: string): CommandResult => noop(doc, `edit_subdivision_cage: ${why}; no-op.`);
    const entity = subdivisionTarget(doc, params.id);
    if (typeof entity === 'string') return fail(entity);
    const { vertexIndices, region, falloff = 0, translate, scale, pivot, crease } = params;
    if (
      translate === undefined &&
      scale === undefined &&
      crease === undefined &&
      params.levels === undefined
    )
      return fail('give at least one of translate, scale, crease or levels');
    if (vertexIndices !== undefined && region !== undefined)
      return fail('give vertexIndices or region, not both');
    const outOfRange = (vertexIndices ?? []).find((v) => v < 0 || v >= entity.vertices.length);
    if (outOfRange !== undefined)
      return fail(`vertex ${outOfRange} is outside 0..${entity.vertices.length - 1}`);
    if (!(falloff >= 0)) return fail(`falloff must be >= 0 (got ${falloff})`);
    if (scale !== undefined && !scale.every((s) => s > 0))
      return fail(`scale factors must be > 0 (got [${scale}])`);
    const levels = params.levels ?? entity.levels;
    const levelProblem = sizeProblem(entity, levels);
    if (levelProblem !== null) return fail(levelProblem);
    const world = entity.vertices.map((p) => worldOf(p, entity));
    const weights = selectionWeights(world, vertexIndices, region, falloff);
    const selected = weights.flatMap((w, v) => (w === 1 ? [v] : []));
    const moving = translate !== undefined || scale !== undefined || crease !== undefined;
    if (moving && selected.length === 0) return fail('the selection is empty');
    const centre = scale3(
      selected.reduce<Vec3>((sum, v) => add3(sum, world[v] as Vec3), [0, 0, 0]),
      1 / Math.max(1, selected.length),
    );
    const localPivot = inverseEulerXYZ(sub3(pivot ?? centre, entity.position), entity.rotation);
    const localMove = inverseEulerXYZ(translate ?? [0, 0, 0], entity.rotation);
    const factors = scale ?? [1, 1, 1];
    if (translate === undefined && scale === undefined) {
      const updated: SubdivisionEntity = {
        ...entity,
        creases:
          crease === undefined ? entity.creases : recreased(entity, new Set(selected), crease),
        levels,
      };
      return reported(doc, entity.id, updated, selected, selected.length);
    }
    const vertices = entity.vertices.map((p, v): Vec3 => {
      const w = weights[v] as number;
      if (w === 0) return p;
      const blended = factors.map((s) => 1 + (s - 1) * w) as unknown as Vec3;
      return add3(
        add3(
          localPivot,
          sub3(p, localPivot).map(
            (value, axis) => value * (blended[axis] as number),
          ) as unknown as Vec3,
        ),
        scale3(localMove, w),
      );
    });
    const creases =
      crease === undefined ? entity.creases : recreased(entity, new Set(selected), crease);
    const moved = weights.filter((w) => w > 0).length;
    return reported(doc, entity.id, { ...entity, vertices, creases, levels }, selected, moved);
  },
});
