/** project_to_face — project sketch curves onto the faces of a solid along a direction (or to the closest points): curves lying on the faces (03 WRP M2, native). */

import type { BaseEntity, CadDocument, Entity, NurbsCurveEntity, Vec3 } from '../../model/types';
import { is3D } from '../../model/types';
import { nextId } from '../../lib/id';
import { dot3, normalize3, sub3 } from '../../lib/vec3';
import { applyEulerXYZ } from '../../lib/eulerRotation';
import { bezier2 } from '../../lib/nurbs/curve2d';
import { curveDomain } from '../../lib/nurbs/evaluate';
import { integrateCurve } from '../../lib/nurbs/integrate';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { CurveProjectionRequest } from '../../geometry/kernelPorts';
import { meshCorners, meshDiagonal } from '../../geometry/meshExtent';
import { operandRecipe } from '../../geometry/operandRecipe';
import type { PlaneSegment } from '../../geometry/planeSegments';
import { pickFaces } from '../brep/faceReferences';
import { withEntity } from '../entity/entityOps';
import { newEntity } from '../entity/newEntity';
import { defineCommand, looseVec3, z } from '../schema';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { namedDefault, wrapData } from './conventions';
import { defaultFitTolerance, exactKernel } from './faceSession';
import { faceRefField } from './schemas';
import { isSketchFailure, sketchOutline, type SketchOutline } from './sketchProfiles';

const MAX_ENTITIES = 200;

const lengthOf = (curve: NurbsCurveData, from?: number, to?: number): number => {
  const [first, last] = curveDomain(curve);
  return integrateCurve(curve, from ?? first, to ?? last, (_point, derivative) => Math.hypot(derivative[0], derivative[1], derivative[2]));
};

const worldCurve = (piece: PlaneSegment, toWorld: SketchOutline['toWorld']): NurbsCurveData => {
  const curve = piece.kind === 'line' ? bezier2([piece.from, piece.to]) : piece.curve;
  return {
    degree: curve.degree,
    poles: curve.poles.map(toWorld),
    ...(curve.weights === undefined ? {} : { weights: curve.weights }),
    knots: curve.knots,
    multiplicities: curve.multiplicities,
  };
};

/**
 * @affects creates one nurbs_curve (with onFace and its native pcurve) per run of a sketch piece on a face
 * @invariant each piece is sampled and carried to the nearest face ahead of it (direction) or to its closest point; the returned curves are fits of those points within
 *   fitTolerance; data.missed lists the sketch entities that only partly land
 * @failure unknown ids / not a solid / no exact face queries / nothing lands on the faces (WRP_PROJECTION_MISSES_FACE) -> coded no-op
 */
export const projectToFace = defineCommand({
  name: 'project_to_face',
  description:
    'Project 2D sketch entities (or font text) onto the faces of a solid: along `direction` (default: the sketch normal, turned to point at the solid) each point lands on the ' +
    'nearest face ahead of it; with `closest: true` each point goes to its closest point on the faces within `maxDistance`. The result is one nurbs_curve per run of a sketch ' +
    'piece on a face (data.curves[i]: id, faceIndex, faceName, length3d and chartLength in document units, lengthStrain = length3d / chartLength - 1). Projection stretches ' +
    '(a 30 mm chord projected onto a radius 20 cylinder is a 33.92 mm arc); wrap_to_face keeps lengths. `faces` limits the target faces (default: all). Parts of the sketch that ' +
    'miss every face are reported in data.missed [{ entityId, fraction }]; nothing landing at all refuses with WRP_PROJECTION_MISSES_FACE. Needs the exact (native) kernel. ' +
    'Next: check_wrap, wrap_to_face, emboss_on_face.',
  params: z.object({
    id: z.string().describe('Id of the solid receiving the curves.'),
    entityIds: z.array(z.string()).min(1).max(MAX_ENTITIES).describe('Ids of the 2D sketch entities (or font texts) to project.'),
    faces: z
      .array(faceRefField)
      .max(1000)
      .optional()
      .describe('Faces to project onto, each picked like `face` of wrap_to_face. Default: every face of the solid.'),
    direction: looseVec3('Projection direction [x, y, z] (world). Default: the sketch plane normal, turned toward the solid.').optional(),
    closest: z
      .boolean()
      .optional()
      .describe('Project every point to its closest point on the faces instead of along a direction. Default false.'),
    maxDistance: z
      .number()
      .positive()
      .optional()
      .describe('Closest mode only: farthest distance a point may travel to land, document units. Default: the solid diagonal.'),
    requireAll: z
      .boolean()
      .optional()
      .describe(
        'Refuse with WRP_PROJECTION_MISSES_FACE when any part of the sketch misses every face (default false: partial results are returned and listed in data.missed).',
      ),
    fitTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest deviation of a projected curve from its sampled points, document units. Default: 1e-6 x the solid diagonal (named default).',
      ),
  }),
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: string[] = [], paths: string[] = []): CommandResult =>
      wrapRejection(doc, 'project_to_face', code, message, ids, paths);
    const solid = doc.entities[params.id];
    if (solid === undefined) return fail('WRP_ENTITY_NOT_FOUND', `entity '${params.id}' not found`, [params.id], ['id']);
    if (!is3D(solid) || solid.kind === 'instance')
      return fail('WRP_NOT_A_SOLID', `entity '${params.id}' (${solid.kind}) is not a 3D solid`, [params.id], ['id']);
    const exact = exactKernel(doc, 'project_to_face', ctx);
    if ('summary' in exact) return exact;
    const { kernel, query } = exact;
    const shape = kernel.evaluate(operandRecipe(kernel, solid));
    if (shape === null) return fail('WRP_KERNEL_BUILD_FAILED', `the kernel could not build '${params.id}'`, [params.id], ['id']);
    const topology = kernel.topology(shape);
    const mesh = kernel.tessellate(shape);
    const diagonal = mesh === null ? 1 : meshDiagonal(mesh);
    const [low, high] = mesh === null ? [[0, 0, 0] as Vec3, [0, 0, 0] as Vec3] : meshCorners(mesh);
    const center: Vec3 = [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2];
    let faces: number[] = Array.from({ length: topology?.faces.length ?? 0 }, (_, k) => k);
    if (params.faces !== undefined) {
      faces = [];
      for (const [index, ref] of params.faces.entries()) {
        const pick = pickFaces(kernel, shape, topology, {
          indices: ref.faceIndex === undefined ? [] : [ref.faceIndex],
          near: ref.faceNear === undefined ? [] : [ref.faceNear],
          names: ref.faceName === undefined ? undefined : [ref.faceName],
        });
        if ('problem' in pick) return fail('WRP_FACE_NOT_FOUND', `${pick.problem} on '${params.id}'`, [params.id], [`faces.${index}`]);
        faces.push(...pick.faces);
      }
    }
    if (faces.length === 0) return fail('WRP_FACE_NOT_FOUND', `'${params.id}' has no faces to project onto`, [params.id], ['faces']);
    const outlines: SketchOutline[] = [];
    for (const [index, entityId] of params.entityIds.entries()) {
      const outline = sketchOutline(doc, entityId);
      if (isSketchFailure(outline)) return fail(outline.code, outline.message, [entityId], [`entityIds.${index}`]);
      outlines.push(outline);
    }
    const sources: Array<{ outline: SketchOutline; curve: NurbsCurveData; length: number }> = [];
    for (const outline of outlines) {
      const chains = [...outline.regions.flatMap((region) => [region.outer, ...region.holes]), ...outline.open];
      for (const piece of chains.flat()) {
        const curve = worldCurve(piece, outline.toWorld);
        sources.push({ outline, curve, length: lengthOf(curve) });
      }
    }
    const tolerance = params.fitTolerance ?? defaultFitTolerance(diagonal);
    const first = doc.entities[params.entityIds[0] as string] as Entity;
    let direction: Vec3;
    if (params.direction !== undefined) {
      if (!params.direction.every(Number.isFinite) || Math.hypot(...params.direction) === 0)
        return fail('WRP_PARAM_INVALID', 'direction must be a non-zero [x, y, z]', [], ['direction']);
      direction = normalize3(params.direction);
    } else {
      const normal = applyEulerXYZ([0, 0, 1], [0, 0, 0], first.rotation);
      direction = dot3(normal, sub3(center, first.position)) >= 0 ? normal : normalize3(sub3([0, 0, 0], normal));
    }
    const request: CurveProjectionRequest = {
      faces,
      curves: sources.map((source) => source.curve),
      ...(params.closest === true ? { closest: { maxDistance: params.maxDistance ?? diagonal } } : { direction }),
      sampleStep: diagonal / 400,
      tolerance,
    };
    const projection = query.projectCurves(shape, request);
    if (projection === null)
      return fail(
        'WRP_KERNEL_BUILD_FAILED',
        'the kernel could not project the curves (needs the native kernel with projectCurves)',
        [params.id],
        ['entityIds'],
      );
    if (projection.curves.length === 0)
      return fail(
        'WRP_PROJECTION_MISSES_FACE',
        `none of the ${sources.length} sketch piece(s) lands on the faces (direction [${direction.map((v) => v.toPrecision(4)).join(', ')}])`,
        params.entityIds,
        ['entityIds'],
      );
    const fraction = new Map<string, { sum: number; weight: number }>();
    for (const [index, source] of sources.entries()) {
      const entry = fraction.get(source.outline.id) ?? { sum: 0, weight: 0 };
      entry.sum += (projection.coverage[index] ?? 0) * source.length;
      entry.weight += source.length;
      fraction.set(source.outline.id, entry);
    }
    const missed = [...fraction.entries()]
      .filter(([, v]) => v.sum < v.weight * (1 - 1e-6))
      .map(([entityId, v]) => ({ entityId, fraction: v.weight > 0 ? v.sum / v.weight : 0 }));
    if (params.requireAll === true && missed.length > 0) {
      const refused = fail(
        'WRP_PROJECTION_MISSES_FACE',
        `requireAll: ${missed.map((m) => `${m.entityId} lands only ${(m.fraction * 100).toFixed(1)}%`).join(', ')}`,
        missed.map((m) => m.entityId),
        ['entityIds'],
      );
      return { ...refused, data: { missed, unit: doc.units } };
    }
    let next: CadDocument = doc;
    const created: string[] = [];
    const records: Array<Record<string, unknown>> = [];
    for (const run of projection.curves) {
      const source = sources[run.source] as (typeof sources)[number];
      const origin = doc.entities[source.outline.id] as Entity;
      const id = nextId('curve');
      const faceName = topology?.faces[run.face]?.name;
      const length3d = lengthOf(run.curve);
      const chartLength = lengthOf(source.curve, run.t0, run.t1);
      const geometry = {
        curve: run.curve,
        onFace: {
          entityId: params.id,
          faceIndex: run.face,
          ...(faceName !== undefined ? { faceName } : {}),
          pcurve: run.pcurve,
          frame: 'native' as const,
          fitTolerance: tolerance,
          chartLength,
        },
      } satisfies Omit<NurbsCurveEntity, keyof BaseEntity>;
      next = withEntity(next, newEntity('nurbs_curve', id, geometry, [0, 0, 0], origin.color, { layerId: origin.layerId }));
      created.push(id);
      records.push({
        id,
        sourceId: source.outline.id,
        faceIndex: run.face,
        ...(faceName !== undefined ? { faceName } : {}),
        length3d,
        chartLength,
        lengthStrain: chartLength > 0 ? length3d / chartLength - 1 : 0,
        fitTolerance: tolerance,
      });
    }
    const unverified = outlines.some((outline) => outline.unverified);
    const data = wrapData(
      doc,
      {
        curves: records,
        missed,
        faces,
        direction: params.closest === true ? null : direction,
        mode: params.closest === true ? 'closest' : 'direction',
      },
      {
        unverified,
        provenance: {
          method: params.closest === true ? 'closest-point projection, sampled and fitted' : 'directional projection, sampled and fitted',
          inputs: { id: params.id, entityIds: params.entityIds },
        },
        defaults:
          params.fitTolerance === undefined
            ? [namedDefault('fitTolerance', tolerance, doc.units, 'llull WRP default (D-WRP-4): 1e-6 x the solid diagonal')]
            : [],
      },
    );
    const lengths = records.map((record) => (record['length3d'] as number).toPrecision(8)).join(', ');
    const partly =
      missed.length > 0 ? `; partly missing: ${missed.map((m) => `${m.entityId} ${(m.fraction * 100).toFixed(1)}%`).join(', ')}` : '';
    return {
      document: next,
      affected: created,
      summary: `project_to_face: projected ${params.entityIds.length} entit${params.entityIds.length === 1 ? 'y' : 'ies'} onto ${faces.length} face(s) of '${params.id}': ${created.length} curve(s) ${created.join(', ')}, 3D lengths ${lengths} ${doc.units}${partly}.`,
      data,
    };
  },
});
