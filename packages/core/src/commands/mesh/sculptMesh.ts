/** sculpt_mesh — brush strokes on a triangle mesh: draw, inflate, grab, smooth, flatten, pinch, crease, layer (07 MSH FR-MSH-18). */

import { samplesByArcLength } from '../../geometry/deform/rbf';
import { SCULPT_BRUSHES, type SculptParams } from '../../geometry/mesh/sculpt';
import { MAX_STROKE_STAMPS, stampsAlong } from '../../geometry/mesh/strokePath';
import type { Vec3 } from '../../model/vectors';
import { worldCurves } from '../surface/curveInputs';
import { meshRejection } from './meshCommon';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { keepSourceParam } from './levelSetCommands';
import { runMeshOp } from './runMeshOp';

/** Chords of the polyline a curve path is sampled into (equal arc length). */
const STROKE_CHORDS = 2000;

/**
 * @affects rewrites the mesh `id` with moved (and, with refineEdge, split) vertices, or adds one mesh with keepSource
 * @invariant `along` stamps are placed every `spacing` of arc length from the start of the path (a polyline or a nurbs_curve sampled in 2,000 chords), then behave as explicit stamps (same engines, same bytes); stamps apply in order; a stamp and its mirror are computed from the same positions and added, so a mirrored stroke is symmetric; only vertices closer than `radius` to a stamp (and inside maskRegion) move
 * @failure unknown id / non-solid -> MESH_*; a stamp farther than radius from the surface -> MESH_SCULPT_STAMP_OFF_SURFACE; refineEdge so small that the mesh passes 4,000,000 triangles -> MESH_SCULPT_RESULT_TOO_LARGE; grab without a direction vector, neither or both of stamps / along, a path of no length or more than 10,000 stamps -> MESH_PARAM_INVALID; `along.curveId` not a nurbs_curve -> SRF_*
 */
export const sculptMesh = defineCommand({
  name: 'sculpt_mesh',
  description:
    'Sculpt a triangle mesh (or the triangles of any 3D solid) with a brush stroke: give EITHER `stamps` (centres) OR `along` (a path and a spacing: ' +
    'a stamp every `spacing` of arc length from the start of a nurbs_curve `curveId` or a polyline `points`, at most 10000); each stamp centre is projected onto the surface, then every ' +
    'vertex closer than `radius` (euclidean distance, t = distance / radius < 1) moves by strength x falloff(t). Brushes: "draw" along the ' +
    'area-weighted normal of the brush region (direction "area_normal", default) or each vertex normal ("normal") or a fixed vector; "inflate" ' +
    'along vertex normals; "grab" by the `direction` vector times falloff (strength ignored); "smooth" toward the neighbour mean (strength <= 1, ' +
    '`taubin` adds the inflating step); "flatten" onto the plane through the brush region centroid (or `planePoint`) with the region normal; ' +
    '"pinch" tangentially toward the stamp centre; "crease" = draw with -strength plus pinch with strength / 2; "layer" raises to ' +
    'min(strength x falloff, maxHeight) above the surface at stroke start without accumulating. Falloffs: constant 1, linear 1 - t, smooth ' +
    '(1 - t^2)^2 (default), sphere sqrt(1 - t^2). `symmetry` {plane yz|xz|xy through the origin} stamps the mirror image in the same pass. ' +
    '`refineEdge` first splits edges longer than that inside the brush so detail is possible. Reports movedVertices, maxDisplacement (document ' +
    'units), displacedVolume (closed mesh: volume after - before; open height field: sum of triangle area x mean vertex displacement along the face ' +
    'normal) and symmetryError (largest distance between mirror vertex pairs). Connectivity is unchanged without refineEdge. ' +
    'Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID, MESH_SCULPT_STAMP_OFF_SURFACE, MESH_SCULPT_RESULT_TOO_LARGE (refineEdge splits past 4,000,000 triangles: use a longer edge).',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to sculpt.'),
    brush: z.enum(SCULPT_BRUSHES).describe('Brush: draw, inflate, grab, smooth, flatten, pinch, crease or layer.'),
    stamps: z
      .array(z.object({ center: vec3('Stamp centre [x, y, z] (world, document units); projected onto the surface.') }))
      .min(1)
      .optional()
      .describe('Stamps applied in order (the stroke). Not with `along`.'),
    along: z
      .object({
        curveId: z.string().optional().describe('Id of a nurbs_curve (world placement): the path. Not with `points`.'),
        points: z
          .array(vec3('Path point [x, y, z] (world, document units).'))
          .min(2)
          .optional()
          .describe('A polyline path. Not with `curveId`.'),
        spacing: z
          .number()
          .positive()
          .describe('Arc length between two stamps (document units); the first stamp is at the start of the path.'),
      })
      .optional()
      .describe(
        'A stroke along a path: stamps every `spacing`, each projected onto the surface like an explicit stamp (a stamp farther than `radius` from the surface is MESH_SCULPT_STAMP_OFF_SURFACE). Not with `stamps`.',
      ),
    radius: z.number().positive().describe('Brush radius (document units).'),
    strength: z
      .number()
      .describe('Strength: displacement per stamp at the centre (document units); a fraction 0..1 for smooth / flatten / pinch.'),
    falloff: z
      .enum(['constant', 'linear', 'smooth', 'sphere'])
      .optional()
      .describe('Falloff curve of t = distance / radius. Default "smooth".'),
    direction: z
      .union([z.enum(['normal', 'area_normal']), vec3('Vector [x, y, z]: the displacement of grab, the direction of draw / layer.')])
      .optional()
      .describe('"area_normal" (default) region normal, "normal" per-vertex normals, or a vector (required by grab).'),
    symmetry: z
      .object({ plane: z.enum(['yz', 'xz', 'xy']).describe('Mirror plane through the origin: yz mirrors x, xz mirrors y, xy mirrors z.') })
      .optional()
      .describe('Also stamp the mirror image of every stamp (a stamp on the plane is applied once).'),
    maskRegion: z
      .object({
        center: vec3('Centre [x, y, z] of the sphere (document units, world).'),
        radius: z.number().positive().describe('Radius of the sphere (document units).'),
      })
      .optional()
      .describe('Only vertices inside this sphere may move.'),
    refineEdge: z
      .number()
      .positive()
      .optional()
      .describe('Split edges longer than this (document units) inside the brush before sculpting.'),
    taubin: z.boolean().optional().describe('smooth only: add the inflating Taubin step to avoid shrinkage. Default false.'),
    maxHeight: z.number().positive().optional().describe('layer only: largest layer height (document units). Default unlimited.'),
    planePoint: vec3('A point [x, y, z] of the flatten plane (document units). Default the brush region centroid.').optional(),
    keepSource: keepSourceParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const {
      id,
      brush,
      stamps,
      along,
      radius,
      strength,
      falloff,
      direction,
      symmetry,
      maskRegion,
      refineEdge,
      taubin,
      maxHeight,
      planePoint,
      keepSource,
    } = params;
    const chosen = falloff ?? 'smooth';
    const refuse = (message: string, path: string): CommandResult =>
      meshRejection(doc, 'sculpt_mesh', 'MESH_PARAM_INVALID', message, [id], [path]);
    if ((stamps === undefined) === (along === undefined)) return refuse('give exactly one of stamps or along', 'stamps');
    let centres: Vec3[] = stamps?.map((stamp) => stamp.center) ?? [];
    if (along !== undefined) {
      if ((along.curveId === undefined) === (along.points === undefined))
        return refuse('along needs exactly one of curveId or points', 'along');
      let path: Vec3[];
      if (along.points !== undefined) path = along.points;
      else {
        const curves = worldCurves(doc, 'sculpt_mesh', [along.curveId as string], 'along.curveId');
        if (!Array.isArray(curves)) return curves;
        path = samplesByArcLength(curves[0] as (typeof curves)[number], STROKE_CHORDS + 1);
      }
      const along_ = stampsAlong(path, along.spacing);
      if (along_ === null)
        return refuse(
          `the path has no length, or ${along.spacing} gives more than ${MAX_STROKE_STAMPS} stamps; raise the spacing`,
          'along.spacing',
        );
      centres = along_;
    }
    return runMeshOp(doc, ctx, {
      command: 'sculpt_mesh',
      id,
      keepSource: keepSource ?? false,
      requireClosed: false,
      precheck: () =>
        brush === 'grab' && !Array.isArray(direction)
          ? { code: 'MESH_PARAM_INVALID', message: 'grab needs `direction` as a vector [x, y, z]', path: 'direction' }
          : null,
      op: () => {
        const sculpt: SculptParams = {
          brush,
          stamps: centres,
          radius,
          strength,
          falloff: chosen,
          direction: direction ?? 'area_normal',
          taubin: taubin ?? false,
          ...(symmetry !== undefined ? { symmetry: symmetry.plane } : {}),
          ...(maxHeight !== undefined ? { maxHeight } : {}),
          ...(refineEdge !== undefined ? { refineEdge } : {}),
          ...(maskRegion !== undefined ? { mask: { center: maskRegion.center, radius: maskRegion.radius } } : {}),
          ...(planePoint !== undefined ? { planePoint } : {}),
        };
        return { op: 'sculpt', ...sculpt };
      },
      fields: (_before, _after, result) => ({ brush, falloff: chosen, stamps: centres.length, radius, strength, ...result.report }),
      summary: (from, to, _before, _after, unit, result) =>
        `sculpt_mesh '${from}' ${brush} x${centres.length} -> '${to}': ${String(result.report['movedVertices'])} vertices moved, max displacement ` +
        `${(result.report['maxDisplacement'] as number).toPrecision(5)} ${unit}, displaced volume ${(result.report['displacedVolume'] as number).toPrecision(10)} ${unit}^3.`,
    });
  },
});
