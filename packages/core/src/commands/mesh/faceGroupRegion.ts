/**
 * `faceGroups` region selector of the fitting commands (07 MSH FR-MSH-24, TECHNICAL_SPEC 13.24): the triangles of named groups of a mesh, either the groups the mesh entity
 * stores (OBJ groups, 3MF objects: `stored`, by name) or the regions of a segmentation (`segments`, ids `seg-<n>` as `segment_mesh` lists them, computed again here with the
 * same `featureAngleDeg` / `fitTolerance` / `kinds`, which the engines answer deterministically).
 */

import type { CadDocument, MeshData } from '../../model/types';
import { PRIMITIVE_KINDS, type PrimitiveKind } from '../../geometry/mesh/primitiveFit';
import { meshDiagonal } from '../../geometry/mesh/weld';
import { z } from '../schema';
import type { CommandResult, ExecutionContext } from '../types';
import { meshRejection, type SolidMesh } from './meshCommon';
import { runSegmentation } from './segmentMesh';

const DEFAULT_FEATURE_ANGLE_DEG = 30;
const TOLERANCE_FRACTION = 0.001;
/** Group ids listed in a refusal. */
const LISTED = 12;

/** The `faceGroups` parameter of a fitting command. */
export const faceGroupsParam = z
  .object({
    stored: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Names (ids) of the face groups the mesh entity stores (OBJ groups, 3MF objects), e.g. "wing". Their triangles are fitted.',
      ),
    segments: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Ids of segmentation regions as segment_mesh lists them ("seg-3"). The segmentation is computed again with the parameters below.',
      ),
    featureAngleDeg: z
      .number()
      .gt(0)
      .lt(180)
      .optional()
      .describe(
        `segments only: the featureAngleDeg of the segment_mesh call that named the regions. Default ${DEFAULT_FEATURE_ANGLE_DEG}.`,
      ),
    fitTolerance: z
      .number()
      .positive()
      .optional()
      .describe('segments only: the fitTolerance of that segment_mesh call. Default 0.001 x bounding-box diagonal.'),
    kinds: z
      .array(z.enum(['plane', 'cylinder', 'cone', 'sphere']))
      .min(1)
      .optional()
      .describe('segments only: the kinds of that segment_mesh call. Default all four.'),
  })
  .describe(
    'Fit only the triangles of these face groups: `stored` names groups of the mesh entity, `segments` ids of segment_mesh regions (both: the union). With a sphere `region` too, the triangles in both.',
  );

type FaceGroupsSelector = z.infer<typeof faceGroupsParam>;

export interface FaceGroupSelection {
  /** The selected triangles, ascending, each once. */
  readonly faces: number[];
  /** Words for the summary and `data`: how many groups of each source. */
  readonly storedGroups: number;
  readonly segmentGroups: number;
}

const idList = (ids: ReadonlyArray<string>): string =>
  `${ids.slice(0, LISTED).join(', ')}${ids.length > LISTED ? `, ... (${ids.length} in all)` : ''}`;

/**
 * The triangles of the groups `selector` names in the loaded mesh of `id`.
 * @failure neither stored nor segments -> MESH_PARAM_INVALID; an unknown stored name or segment id, a stored range past the triangles (a stale group), a segmentation refusal, no triangle in the groups -> MESH_FIT_GROUP_NOT_FOUND / MESH_FIT_REGION_EMPTY / the engine's code
 */
export function faceGroupSelection(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  command: string,
  id: string,
  loaded: SolidMesh,
  selector: FaceGroupsSelector,
  ids: ReadonlyArray<string> = [id],
): FaceGroupSelection | CommandResult {
  const refuse = (code: string, message: string, path = 'faceGroups'): CommandResult =>
    meshRejection(doc, command, code, message, [...ids], [`params.${path}`]);
  const triangles = loaded.mesh.indices.length / 3;
  const selected = new Set<number>();
  const stored = selector.stored ?? [];
  const segments = selector.segments ?? [];
  if (stored.length === 0 && segments.length === 0)
    return refuse('MESH_PARAM_INVALID', 'faceGroups needs `stored` or `segments` (at least one group id)');
  if (stored.length > 0) {
    const groups = loaded.entity.kind === 'mesh' ? (loaded.entity.faceGroups ?? []) : [];
    const known = groups.map((group) => group.id);
    for (const name of stored) {
      const group = groups.find((candidate) => candidate.id === name);
      if (group === undefined)
        return refuse(
          'MESH_FIT_GROUP_NOT_FOUND',
          `'${id}' stores no face group '${name}'; it stores ${known.length === 0 ? 'none' : idList(known)}`,
          'faceGroups.stored',
        );
      for (const [start, end] of group.faces) {
        if (end > triangles)
          return refuse(
            'MESH_FIT_GROUP_NOT_FOUND',
            `the stored group '${name}' covers triangles ${start} to ${end} but the mesh has ${triangles}: the group is stale (the mesh was changed after the import)`,
            'faceGroups.stored',
          );
        for (let f = start; f < end; f++) selected.add(f);
      }
    }
  }
  if (segments.length > 0) {
    const angle = selector.featureAngleDeg ?? DEFAULT_FEATURE_ANGLE_DEG;
    const tolerance = selector.fitTolerance ?? TOLERANCE_FRACTION * meshDiagonal(loaded.mesh.positions);
    const kinds: PrimitiveKind[] = selector.kinds === undefined ? [...PRIMITIVE_KINDS] : [...new Set(selector.kinds)];
    const segmented = runSegmentation(doc, ctx, command, id, loaded.mesh as MeshData, {
      featureAngleDeg: angle,
      fitTolerance: tolerance,
      kinds,
    });
    if ('document' in segmented) return segmented;
    const available = segmented.segmentation.groups.map((group) => `seg-${group.index}`);
    for (const name of segments) {
      const group = segmented.segmentation.groups.find((candidate) => `seg-${candidate.index}` === name);
      if (group === undefined)
        return refuse(
          'MESH_FIT_GROUP_NOT_FOUND',
          `the segmentation (feature angle ${angle} deg, tolerance ${tolerance.toPrecision(4)}) has no region '${name}'; it has ${idList(available)}: pass the featureAngleDeg / fitTolerance / kinds of the segment_mesh call that listed it`,
          'faceGroups.segments',
        );
      for (const f of group.faces) selected.add(f);
    }
  }
  if (selected.size === 0) return refuse('MESH_FIT_REGION_EMPTY', 'the named face groups hold no triangle');
  return { faces: [...selected].sort((a, b) => a - b), storedGroups: new Set(stored).size, segmentGroups: new Set(segments).size };
}

/** The triangles `faces` of `mesh` as a mesh of their own (the vertices they use, in the order the triangles first use them, renumbered). */
export function meshOfFaces(mesh: MeshData, faces: ReadonlyArray<number>): MeshData {
  const renumber = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  for (const f of faces)
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[3 * f + k] as number;
      let local = renumber.get(v);
      if (local === undefined) {
        local = renumber.size;
        renumber.set(v, local);
        positions.push(mesh.positions[3 * v] as number, mesh.positions[3 * v + 1] as number, mesh.positions[3 * v + 2] as number);
      }
      indices.push(local);
    }
  return { positions, indices };
}
