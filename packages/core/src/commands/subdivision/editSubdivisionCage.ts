import type { CadDocument, SubdivisionEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { changed } from '../noop';
import { add3, centroid3, map3, scale3, sub3 } from '../../lib/vec3';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { FALLOFF_SHAPES, type FalloffShape } from '../../lib/falloff';
import { applyMat3, matFromAxisAngle, unitAxisOrNull } from '../../lib/axisRotation';
import { replaceEntity } from '../entity/entityOps';
import { edgeKey } from '../../geometry/subd/edgeKey';
import { closeVerticesUnderSymmetry, symmetrize, symmetryDeviation } from '../../geometry/subd/symmetry';
import { dirRejection } from './codes';
import { type SelectionInput, resolveSelection, selectionDistances, selectionWeights, worldVertices } from './cageSelection';
import {
  cageData,
  cageText,
  edgeRefField,
  faceRefField,
  levelsField,
  sizeProblem,
  subdivisionOf,
  isEntity,
  vertexRefField,
} from './shared';

const COMMAND = 'edit_subdivision_cage';

/** Sharpness lists with the edges between `selected` vertices made infinitely sharp (`on`) or smooth; untouched entries keep their order. */
function recreased(
  entity: SubdivisionEntity,
  selected: ReadonlySet<number>,
  on: boolean,
): { creases: Array<readonly [number, number]>; edgeSharpness: SubdivisionEntity['edgeSharpness'] } {
  const between = (a: number, b: number): boolean => selected.has(a) && selected.has(b);
  const creases = entity.creases.filter(([a, b]) => on || !between(a, b));
  const semi = (entity.edgeSharpness ?? []).filter(({ a, b }) => !between(a, b));
  if (on) {
    const keys = new Set(creases.map(([a, b]) => edgeKey(a, b)));
    for (const face of entity.faces)
      face.forEach((a, i) => {
        const b = face[(i + 1) % face.length] as number;
        if (between(a, b) && !keys.has(edgeKey(a, b))) {
          keys.add(edgeKey(a, b));
          creases.push([a, b]);
        }
      });
  }
  return { creases, edgeSharpness: semi.length > 0 ? semi : undefined };
}

const falloffField = z
  .union([
    z.number(),
    z.object({
      radius: z
        .number()
        .describe('Soft-selection radius (>= 0, document units): vertices closer than this to the selection follow it partly.'),
      shape: z
        .enum(FALLOFF_SHAPES)
        .describe(
          'Weight curve: smooth (default, 3t^2-2t^3), linear, sharp (t^2), root, sphere, inverse_square or constant; t = 1 - distance / radius.',
        )
        .optional(),
      metric: z
        .enum(['euclidean', 'topological'])
        .describe('Distance to the selection: euclidean (straight line, default) or topological (along cage edges, "connected only").')
        .optional(),
    }),
  ])
  .describe('Soft selection: a radius (smooth, euclidean) or { radius, shape, metric }. Default: none.');

/** Vertex transform: scale about the pivot, rotate about the rotation pivot, then translate; each blended by the vertex weight. */
function transformer(spec: {
  readonly pivot: Vec3;
  readonly rotationPivot: Vec3;
  readonly move: Vec3;
  readonly factors: Vec3;
  readonly rotation: { readonly axis: Vec3; readonly angle: number } | undefined;
}): (p: Vec3, w: number) => Vec3 {
  return (p, w) => {
    const blended = map3(spec.factors, (s) => 1 + (s - 1) * w);
    const scaled = add3(
      spec.pivot,
      map3(sub3(p, spec.pivot), (value, axis) => value * blended[axis]),
    );
    const turned =
      spec.rotation === undefined
        ? scaled
        : add3(
            spec.rotationPivot,
            applyMat3(matFromAxisAngle(spec.rotation.axis, spec.rotation.angle * w), sub3(scaled, spec.rotationPivot)),
          );
    return add3(turned, scale3(spec.move, w));
  };
}

/**
 * @affects modifies 1 subdivision entity (cage vertices, creases, levels; topology and element ids unchanged)
 * @invariant order scale -> rotate -> translate about the pivot; a symmetric cage stays symmetric (each mirror orbit follows its lowest-index driven vertex; on-plane vertices stay on the plane)
 * @failure missing / non-subdivision id (DIR_ENTITY_NOT_FOUND), unknown element (DIR_REF_LOST), id of the wrong kind (DIR_ELEMENT_KIND), empty selection (DIR_SELECTION_EMPTY), scale <= 0 (DIR_SCALE_NONPOSITIVE), nothing to do, bad levels -> no-op
 */
export const editSubdivisionCage = defineCommand({
  name: COMMAND,
  description:
    'Sculpt a subdivision solid (add_subdivision_solid) by editing its control cage: select cage vertices by `vertexIndices`, ' +
    'by element references `vertices` / `edges` (their end vertices) / `faces` (their corners) — ids such as "v-1.7" are stable across topology ' +
    'edits, indices are resolved and recorded as ids — or by a world-space `region` box (none = all). Add a soft-selection `falloff` ' +
    '(a radius, or { radius, shape, metric }) so neighbours follow smoothly, then `scale` about `pivot` (per axis of the solid), `rotate` ' +
    '({ axis (world), angleDeg, pivot }) and/or `translate` (world vector); order scale, rotate, translate. `crease` true makes cage edges ' +
    'between selected vertices infinitely sharp, false makes them smooth (use set_cage_crease for semi-sharp values). A cage with ' +
    'symmetry (set_cage_symmetry) stays mirror-symmetric unless `symmetry` is "ignore". `levels` changes the refinement. Returns data ' +
    '{ vertexCount, faceCount, vertices, vertexIds, faceIds, selected, selectedIds } (world cage vertices; fully selected vertices). ' +
    'Next: check_subdivision, evaluate_subdivision.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    vertexIndices: z.array(z.number().int()).describe('Cage vertex indices to select (from the data of add_subdivision_solid).').optional(),
    vertices: z.array(vertexRefField).describe('Cage vertices to select, as ids or indices.').optional(),
    edges: z.array(edgeRefField).describe('Cage edges to select (both end vertices), as ids or [a, b] index pairs.').optional(),
    faces: z.array(faceRefField).describe('Cage faces to select (all their vertices), as ids or indices.').optional(),
    region: z
      .object({
        min: vec3('World-space minimum corner [x, y, z] of the selection box.'),
        max: vec3('World-space maximum corner [x, y, z] of the selection box.'),
      })
      .describe('Select the cage vertices inside this world-space box (alternative to element selection).')
      .optional(),
    falloff: falloffField.optional(),
    translate: vec3('World-space move [dx, dy, dz] of the selection.').optional(),
    rotate: z
      .object({
        axis: vec3('World-space rotation axis (any non-zero length).'),
        angleDeg: z.number().describe('Rotation angle in degrees (right-handed about the axis).'),
        pivot: vec3('World-space centre of rotation. Default: the shared pivot.').optional(),
      })
      .describe('Rotate the selection about an axis through the pivot (soft weights scale the angle).')
      .optional(),
    scale: vec3('Scale factors [sx, sy, sz] (> 0) along the solid axes about the pivot (e.g. [0.6, 0.6, 1] narrows).').optional(),
    pivot: vec3('World-space centre of scale and rotation. Default: centre of the fully selected vertices.').optional(),
    symmetry: z
      .enum(['keep', 'ignore'])
      .describe(
        '"keep" (default when the cage has symmetry): mirror the edit onto the mirror images; "ignore": edit only the selection (if that breaks the mirror the cage symmetry is cleared).',
      )
      .optional(),
    crease: z.boolean().describe('true: make edges between selected vertices infinitely sharp; false: make them smooth.').optional(),
    levels: levelsField.optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const { translate, rotate, scale, pivot, crease } = params;
    if (translate === undefined && rotate === undefined && scale === undefined && crease === undefined && params.levels === undefined)
      return reject('DIR_NOTHING_TO_DO', 'give at least one of translate, rotate, scale, crease or levels');
    const falloff = typeof params.falloff === 'number' ? { radius: params.falloff } : (params.falloff ?? { radius: 0 });
    const shape: FalloffShape = ('shape' in falloff ? falloff.shape : undefined) ?? 'smooth';
    const metric = ('metric' in falloff ? falloff.metric : undefined) ?? 'euclidean';
    if (!(falloff.radius >= 0)) return reject('DIR_FALLOFF_INVALID', `falloff must be >= 0 (got ${falloff.radius})`, ['params.falloff']);
    if (scale !== undefined && !scale.every((s) => s > 0))
      return reject('DIR_SCALE_NONPOSITIVE', `scale factors must be > 0 (got [${scale}])`, ['params.scale']);
    const axis = rotate === undefined ? undefined : unitAxisOrNull(rotate.axis);
    if (rotate !== undefined && axis === null)
      return reject('DIR_NOTHING_TO_DO', 'rotate.axis must be a non-zero vector', ['params.rotate.axis']);
    const levels = params.levels ?? entity.levels;
    const size = sizeProblem(entity, levels);
    if (size !== null) return reject(size.code, size.message);
    const input: SelectionInput = params;
    const selection = resolveSelection(entity, input);
    if ('code' in selection) return reject(selection.code, selection.message, [selection.path]);
    const distances = selectionDistances(entity, selection, params.region, metric);
    const weights = selectionWeights(distances, falloff.radius, shape);
    const selected = distances.flatMap((d, v) => (d <= 1e-9 ? [v] : []));
    const moving = translate !== undefined || rotate !== undefined || scale !== undefined || crease !== undefined;
    if (moving && selected.length === 0) return reject('DIR_SELECTION_EMPTY', 'the selection is empty', ['params.region']);
    const world = worldVertices(entity);
    const centre = centroid3(selected.map((v) => world[v] as Vec3));
    const localOf = (p: Vec3): Vec3 => inverseEulerXYZ(sub3(p, entity.position), entity.rotation);
    const localPivot = localOf(pivot ?? centre);
    const mirrored = entity.symmetry !== undefined && params.symmetry !== 'ignore' ? entity.symmetry : undefined;
    const creaseSet = new Set(mirrored === undefined ? selected : closeVerticesUnderSymmetry(selected, mirrored));
    const sharp =
      crease === undefined ? { creases: entity.creases, edgeSharpness: entity.edgeSharpness } : recreased(entity, creaseSet, crease);
    const recorded = selection.record === null ? undefined : { recordExtras: selection.record };
    const result = (updated: SubdivisionEntity, moved: number, note = ''): CommandResult => ({
      ...changed(
        replaceEntity(doc, updated),
        `${COMMAND}: '${entity.id}' — ${selected.length} vertex(es) selected` +
          (moved > selected.length ? ` (+${moved - selected.length} by falloff)` : '') +
          `; now ${cageText(updated, updated.levels)}${note}.`,
        [entity.id],
      ),
      data: { ...cageData(updated), selected, selectedIds: selected.map((v) => updated.elementIds.vertices[v]) },
      ...recorded,
    });
    const base: SubdivisionEntity = { ...entity, levels, creases: sharp.creases };
    if (sharp.edgeSharpness === undefined) delete base.edgeSharpness;
    else base.edgeSharpness = sharp.edgeSharpness;
    if (translate === undefined && rotate === undefined && scale === undefined) return result(base, selected.length);
    const place = transformer({
      pivot: localPivot,
      rotationPivot: rotate?.pivot === undefined ? localPivot : localOf(rotate.pivot),
      move: inverseEulerXYZ(translate ?? [0, 0, 0], entity.rotation),
      factors: scale ?? [1, 1, 1],
      rotation:
        rotate === undefined || !axis
          ? undefined
          : { axis: inverseEulerXYZ(axis, entity.rotation), angle: (rotate.angleDeg * Math.PI) / 180 },
    });
    const edited = entity.vertices.map((p, v): Vec3 => ((weights[v] as number) === 0 ? p : place(p, weights[v] as number)));
    const vertices = mirrored === undefined ? edited : symmetrize(entity.vertices, edited, weights, mirrored);
    const movedCount = weights.filter((w) => w > 0).length;
    const broken =
      entity.symmetry !== undefined && mirrored === undefined && symmetryDeviation(vertices, entity.symmetry) > entity.symmetry.tolerance;
    if (!broken) return result({ ...base, vertices }, movedCount);
    const cleared: SubdivisionEntity = { ...base, vertices };
    delete cleared.symmetry;
    return result(
      cleared,
      movedCount,
      '; the symmetry was cleared because an ignored-symmetry edit broke it (set_cage_symmetry restores it)',
    );
  },
});
