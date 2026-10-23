/** mesh_to_brep — turn a closed triangle mesh into an exact B-rep solid: one planar face per triangle, or one exact face per fitted region (07 MSH FR-MSH-21). */

import type { Entity, ShapeRecipe } from '../../model/types';
import type { MeshToBrepGroup, MeshToBrepRequest } from '../../geometry/kernelMeshBrep';
import { PRIMITIVE_KINDS } from '../../geometry/mesh/primitiveFit';
import { recipeOf } from '../../geometry/shapeRecipe';
import { meshDiagonal } from '../../geometry/mesh/weld';
import { makeBlob, withBlob } from '../../model/blobs';
import { newEntity } from '../entity/newEntity';
import { defineCommand, z } from '../schema';
import { evaluateRecipe } from '../kernelShape';
import type { CommandResult } from '../types';
import { keepSourceParam } from './levelSetCommands';
import {
  commitMesh,
  contextOf,
  isLoadFailure,
  isStoreFailure,
  loadSolidMesh,
  measureMesh,
  meshRejection,
  namedDefault,
  outwardMesh,
  storeMesh,
  withConventions,
} from './meshCommon';
import { runSegmentation } from './segmentMesh';

const DEFAULT_MAX_FACES = 50_000;
const MAX_FACES_LIMIT = 200_000;
const TOLERANCE_FRACTION = 0.001;
const DEFAULT_FEATURE_ANGLE_DEG = 30;

/**
 * @affects rewrites the mesh `id` as a mesh entity with an exact `brep` (same id), or adds one with keepSource; prismatic also stores the B-rep text as a document blob
 * @invariant faceted: every triangle is a planar face of the sewn solid; prismatic: every region fitted by a plane / cylinder / cone / sphere is ONE face on that exact surface bounded by exact intersection curves, the other regions keep their triangles (data.facetedGroups, warning MESH_BREP_GROUP_FACETED)
 * @failure open mesh -> MESH_NOT_CLOSED; over maxFaces -> MESH_PARAM_INVALID; sewing leaves free edges / invalid solid -> MESH_BREP_SEW_FAILED; a kernel without the builder -> MESH_KERNEL_UNSUPPORTED
 */
export const meshToBrep = defineCommand({
  name: 'mesh_to_brep',
  annotations: { requiresKernel: true },
  description:
    "Convert a closed triangle mesh (or any 3D solid's triangles) into an exact B-rep solid on the native OCC kernel, so mass_properties is exact (method " +
    'exact) and export_step writes real faces. mode "faceted": one planar face per triangle (the polyhedron the mesh is), up to `maxFaces`. mode ' +
    '"prismatic": segment_mesh first (same featureAngleDeg / fitTolerance), then each region fitted by a plane, cylinder, cone or sphere becomes ONE ' +
    'face on that exact surface, bounded by the exact intersection curves with its neighbours, and the faces are sewn into a solid (a plate with a ' +
    'tessellated hole gives 6 planes and a cylinder of the fitted radius; volume = the analytic value). Freeform regions, and regions whose ' +
    'boundary cannot be followed within fitTolerance, stay triangles (listed in data.facetedGroups with the warning MESH_BREP_GROUP_FACETED). ' +
    'Reports data.faces {plane, cylinder, ..., faceted}, volumeExact against volumeMesh, the largest fit residual (document units) and the kernel ' +
    'sewing report. The mesh must be closed, manifold and consistently wound. Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_NOT_CLOSED, ' +
    'MESH_PARAM_INVALID, MESH_NON_MANIFOLD, MESH_ORIENTATION_INCONSISTENT, MESH_DEGENERATE, MESH_BREP_SEW_FAILED, MESH_KERNEL_UNSUPPORTED, MESH_ASSET_MISSING.',
  params: z.object({
    id: z.string().describe('Id of the closed mesh (or other 3D solid) to convert.'),
    mode: z
      .enum(['faceted', 'prismatic'])
      .describe('"faceted": one planar face per triangle. "prismatic": one exact face per fitted plane / cylinder / cone / sphere region.'),
    fitTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'prismatic: largest distance (document units) of a region vertex to its primitive, and the sewing tolerance. Default 0.001 x bounding-box diagonal (named default).',
      ),
    featureAngleDeg: z
      .number()
      .gt(0)
      .lt(180)
      .optional()
      .describe(
        `prismatic: edges whose faces meet at more than this angle (degrees) separate regions. Default ${DEFAULT_FEATURE_ANGLE_DEG}.`,
      ),
    maxFaces: z
      .number()
      .int()
      .positive()
      .max(MAX_FACES_LIMIT)
      .optional()
      .describe(`Refuse meshes with more triangles than this. Default ${DEFAULT_MAX_FACES}, at most ${MAX_FACES_LIMIT}.`),
    keepSource: keepSourceParam,
  }),
  run: (doc, { id, mode, fitTolerance, featureAngleDeg, maxFaces, keepSource }, ctx): CommandResult => {
    const context = contextOf(ctx);
    const kernel = context.kernel;
    const reject = (code: string, message: string, path?: string): CommandResult =>
      meshRejection(doc, 'mesh_to_brep', code, message, [id], path === undefined ? [] : [path]);
    if (kernel === null) return reject('MESH_KERNEL_UNSUPPORTED', 'no geometry kernel is installed');
    const loaded = loadSolidMesh(doc, id, undefined, context.meshAssets);
    if (isLoadFailure(loaded)) return meshRejection(doc, 'mesh_to_brep', loaded.code, loaded.message, loaded.ids);
    const before = measureMesh(loaded.mesh);
    if (!before.closed)
      return reject('MESH_NOT_CLOSED', `entity '${id}' has open or non-manifold edges: repair_mesh / fill_mesh_holes first`);
    const limit = maxFaces ?? DEFAULT_MAX_FACES;
    if (before.faces > limit)
      return reject(
        'MESH_PARAM_INVALID',
        `${before.faces} triangles exceed maxFaces ${limit}: decimate_mesh first, or raise maxFaces`,
        'maxFaces',
      );
    if (kernel.meshToBrep === undefined)
      return reject(
        'MESH_KERNEL_UNSUPPORTED',
        'this kernel has no exact B-rep builder (run on the native llull-kernel; Manifold only has meshes)',
        'mode',
      );
    const outward = outwardMesh(loaded.mesh);
    const source = loaded.entity as Entity;
    const tolerance = fitTolerance ?? TOLERANCE_FRACTION * meshDiagonal(outward.positions);
    let working = doc;
    let recipe: ShapeRecipe;
    let facesBuilt: Record<string, number> = { faceted: before.faces };
    let kernelReport: Record<string, unknown> = {};
    let maxResidual = 0;
    let facetedGroups: Array<{ group: string; fit: string }> = [];
    let groupsSummary: Array<{ id: string; faces: number; fit: string }> = [];
    let provenance: Parameters<typeof withConventions>[2]['provenance'];
    if (mode === 'faceted') {
      const leaf = newEntity('mesh', id, { mesh: outward }, [0, 0, 0], source.color, { layerId: source.layerId });
      recipe = recipeOf(leaf);
    } else {
      const segmented = runSegmentation(doc, ctx, 'mesh_to_brep', id, outward, {
        featureAngleDeg: featureAngleDeg ?? DEFAULT_FEATURE_ANGLE_DEG,
        fitTolerance: tolerance,
        kinds: [...PRIMITIVE_KINDS],
      });
      if ('document' in segmented) return segmented;
      provenance = segmented.provenance;
      const { groups, faceGroup } = segmented.segmentation;
      if (segmented.segmentation.unassignedFaces > 0)
        return reject('MESH_DEGENERATE', 'the mesh has faces without area: repair_mesh mode=clean first');
      const request: MeshToBrepRequest = {
        positions: outward.positions,
        indices: outward.indices,
        faceGroup: Array.from(faceGroup),
        tolerance,
        groups: groups.map((group): MeshToBrepGroup => {
          const fit = group.fit;
          switch (fit.type) {
            case 'plane':
              return { kind: 'plane', point: fit.point, normal: fit.normal };
            case 'cylinder':
              return { kind: 'cylinder', axisPoint: fit.axisPoint, axis: fit.axis, radius: fit.radius };
            case 'cone':
              return { kind: 'cone', apex: fit.apex, axis: fit.axis, halfAngleRad: fit.halfAngleRad };
            case 'sphere':
              return { kind: 'sphere', center: fit.center, radius: fit.radius };
            case 'freeform':
              return { kind: 'faceted' };
          }
        }),
      };
      const built = kernel.meshToBrep?.(request) ?? null;
      if (built === null || !built.ok || built.brep === undefined || built.report === undefined)
        return reject('MESH_BREP_SEW_FAILED', `the kernel could not build the solid: ${built?.error ?? 'no answer'}`);
      if (!built.report.valid || built.report.freeEdges > 0)
        return reject(
          'MESH_BREP_SEW_FAILED',
          `the sewn solid is not valid (${built.report.freeEdges} free edge(s)): try mode=faceted, or a larger fitTolerance`,
        );
      const blob = makeBlob('model/x-occt-brep', built.brep);
      kernel.loadBlob?.(blob.sha256, built.brep);
      working = withBlob(doc, blob);
      recipe = { op: 'brep', blob: blob.sha256, format: 'occt-brep-v1' };
      facesBuilt = { ...built.report.built, faceted: built.report.facetedFaces };
      kernelReport = { ...built.report };
      const names = new Map<number, string>(groups.map((group) => [group.index, group.fit.type]));
      facetedGroups = built.report.facetedGroups.map((group) => ({ group: `seg-${group}`, fit: names.get(group) ?? 'freeform' }));
      groupsSummary = groups.map((group) => ({ id: `seg-${group.index}`, faces: group.faces.length, fit: group.fit.type }));
      maxResidual = groups.reduce((max, group) => (group.fit.type === 'freeform' ? max : Math.max(max, group.fit.max)), 0);
    }
    const result = evaluateRecipe(kernel, recipe);
    if (typeof result === 'string')
      return reject('MESH_BREP_SEW_FAILED', `the kernel ${result === 'refused' ? 'refused' : 'built an empty'} solid from the mesh`);
    const stored = storeMesh(result.mesh, context.meshAssets);
    if (isStoreFailure(stored)) return reject(stored.code, stored.message);
    const committed = commitMesh(
      working,
      source,
      { ...stored, brep: result.recipe },
      { keepSource: keepSource ?? false, unverified: loaded.unverified },
    );
    const exact = kernel.massProperties?.(result.shape) ?? null;
    const topology = kernel.topology(result.shape);
    const volumeMesh = before.volume;
    const data = withConventions(
      working,
      {
        id: committed.id,
        sourceId: id,
        mode,
        faces: facesBuilt,
        exactFaces: Object.entries(facesBuilt).reduce((sum, [kind, count]) => sum + (kind === 'faceted' ? 0 : count), 0),
        brepFaces: topology?.faces.length ?? null,
        brepEdges: topology?.edges.length ?? null,
        volumeExact: exact?.volume ?? null,
        areaExact: exact?.area ?? null,
        volumeMesh,
        volumeRelativeDifference:
          exact !== null && volumeMesh !== null && volumeMesh !== 0 ? (exact.volume - volumeMesh) / volumeMesh : null,
        maxResidual,
        fitTolerance: tolerance,
        groups: groupsSummary.slice(0, 50),
        facetedGroups,
        warnings: facetedGroups.map((entry) => ({
          code: 'MESH_BREP_GROUP_FACETED',
          message: `region ${entry.group} (${entry.fit}) stays triangles`,
        })),
        kernel: kernelReport,
      },
      {
        unverified: loaded.unverified,
        ...(provenance !== undefined ? { provenance } : {}),
        defaults:
          mode === 'prismatic' && fitTolerance === undefined
            ? [namedDefault('fitTolerance', tolerance, doc.units, 'llull default 0.001 x bbox diagonal')]
            : [],
      },
    );
    const faceText = Object.entries(facesBuilt)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ');
    return {
      document: committed.document,
      summary:
        `mesh_to_brep '${id}' ${mode} -> '${committed.id}': exact solid, faces ${faceText}` +
        `${exact !== null ? `, volume ${exact.volume.toPrecision(10)} ${doc.units}^3 (mesh ${volumeMesh?.toPrecision(10)})` : ''}` +
        `${facetedGroups.length > 0 ? `; ${facetedGroups.length} region(s) stay triangles` : ''}.`,
      affected: [committed.id],
      data,
    };
  },
});
