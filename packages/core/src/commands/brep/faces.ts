/**
 * Face-level B-rep queries for agents (01 KRN §5.9, AF-01): located face records and the face adjacency graph of an exact solid.
 */

import { type CadDocument, type Vec3, is3D } from '../../model/types';
import type { FaceDetail, FaceGraph } from '../../geometry/kernelPorts';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { operandRecipe } from '../../geometry/operandRecipe';
import { commandError, rejection, report } from '../noop';
import { fixedNumber } from '../../lib/compactNumber';

const MAX_SAMPLES = 256;
const OCC_HINT = 'the OCC kernel (the desktop default; LLULL_KERNEL=occt-native or occt for the CLI and server)';
/** Faces listed in the summary itself; the full records are always in `data.faces`. */
const SUMMARY_FACE_LIMIT = 12;

const refuse = (doc: CadDocument, id: string, code: string, why: string, remediation: string): CommandResult =>
  rejection(doc, `inspect_faces: ${why}; no-op.`, commandError(code, remediation, [id]));

const fmtVec = (v: Vec3, precision: number): string => `[${v.map((c) => fixedNumber(c, precision)).join(', ')}]`;

function faceLine(face: FaceDetail, precision: number): string {
  const extras = [
    face.normal === undefined ? '' : ` normal ${fmtVec(face.normal, precision)}`,
    face.radius === undefined ? '' : ` radius ${fixedNumber(face.radius, precision)}`,
  ].join('');
  return `#${face.index} ${face.surface} area ${fixedNumber(face.area, precision)} centroid ${fmtVec(face.centroid, precision)}${extras}`;
}

function summaryOf(
  id: string,
  total: number,
  faces: readonly FaceDetail[],
  graph: FaceGraph | undefined,
  precision: number,
  note?: string,
): string {
  const listed = faces.slice(0, SUMMARY_FACE_LIMIT).map((face) => faceLine(face, precision));
  const more = faces.length > SUMMARY_FACE_LIMIT ? `; … ${faces.length - SUMMARY_FACE_LIMIT} more in data.faces` : '';
  const kinds =
    graph === undefined
      ? ''
      : ` Edge convexity: ${(['convex', 'concave', 'smooth', 'unknown'] as const).map((kind) => `${graph.edgeConvexity.filter((k) => k === kind).length} ${kind}`).join(', ')}.`;
  return `inspect_faces: '${id}' has ${total} faces; ${faces.length} reported: ${listed.join('; ')}${more}.${kinds}${note === undefined ? '' : ` Note: ${note}.`}`;
}

/**
 * @affects nothing — read-only
 * @invariant data = { entityId, faceCount, faces[FaceDetail] (only `faces` when given, ascending index), graph?, note? }; face indices are those of
 *   inspect_topology on the same entity; lengths and areas in document units
 * @failure missing id, 2D / instance entity, no kernel or a kernel without a face-query port (error.code KRN_NO_EXACT_KERNEL), unbuildable
 *   solid (KRN_SHAPE_UNAVAILABLE), face index out of range (KRN_FACE_INDEX), kernel unable to answer (KRN_FACE_QUERY_FAILED) -> rejected no-op, no data
 */
export const inspectFaces = defineCommand({
  name: 'inspect_faces',
  annotations: { readsMeshTriangles: true, readOnly: true, requiresKernel: true },
  description:
    'List the faces of an exact 3D solid with located geometry: per face its index (the same index inspect_topology uses), surface type ' +
    '(plane, cylinder, cone, sphere, torus, bspline, …), area, centroid, outward unit normal (planes), axis and radius (cylinder, cone, ' +
    'sphere, torus: the torus minor radius; a cone reports its radius at the face centroid) and, on request, sample points inside the ' +
    'trimmed face. With graph=true it also returns the face adjacency graph: per face its surface parameters, whether it is stored ' +
    'reversed, its loops (edge indices, outer loop first) and uv box; per edge the faces it joins and whether the edge is convex, ' +
    'concave, smooth (tangent faces) or unknown. Use it to pick faces for holes, datums, tolerances or meshing: sample points and ' +
    'centroids are positions in the document frame. All lengths are document units and areas their square. ' +
    `Needs the exact kernel (check kernel_info): ${OCC_HINT}; the mesh kernel has no B-rep and the command is refused with error.code KRN_NO_EXACT_KERNEL. ` +
    'For edges, edge indices and vertex counts (the fillet_edge / chamfer_edge selectors) use inspect_topology. ' +
    'data.note is set (and on the face concerned) when the adaptive integration guard tripped and an area comes from the fixed rule. Does not modify the document.',
  params: z.object({
    entityId: z.string().describe('Id of the 3D solid entity to inspect (a primitive, or a boolean / fillet / chamfer / shell result).'),
    faces: z
      .array(z.number().int().min(0))
      .optional()
      .describe(
        '0-based face indices to report (as listed by inspect_topology). Omit to report every face. An index out of range is refused.',
      ),
    samples: z
      .number()
      .int()
      .min(0)
      .max(MAX_SAMPLES)
      .optional()
      .describe(
        `Number of sample points per face, placed inside the trimmed face on a regular uv grid (0-${MAX_SAMPLES}). Default 0 (none).`,
      ),
    graph: z
      .boolean()
      .optional()
      .describe('When true, also return the face adjacency graph (all faces, regardless of the faces filter). Default false.'),
  }),
  run: (doc, { entityId, faces, samples = 0, graph = false }, ctx): CommandResult => {
    const entity = doc.entities[entityId];
    if (!entity)
      return refuse(
        doc,
        entityId,
        'ENTITY_NOT_FOUND',
        `entity '${entityId}' not found`,
        'List entities, then pass an existing 3D solid id.',
      );
    if (!is3D(entity) || entity.kind === 'instance')
      return refuse(
        doc,
        entityId,
        'ENTITY_NOT_SOLID',
        `entity '${entityId}' (kind '${entity.kind}') is not a 3D solid`,
        'Pass a 3D solid; explode instances first.',
      );
    const kernel = (ctx ?? currentContext()).kernel;
    const port = kernel?.faceQuery;
    if (!kernel || !port)
      return refuse(
        doc,
        entityId,
        'KRN_NO_EXACT_KERNEL',
        `no exact kernel with face queries is available; use ${OCC_HINT}`,
        `Start with ${OCC_HINT}.`,
      );
    const shape = kernel.evaluate(operandRecipe(kernel, entity));
    if (shape === null)
      return refuse(
        doc,
        entityId,
        'KRN_SHAPE_UNAVAILABLE',
        `the kernel could not build entity '${entityId}' (kind '${entity.kind}')`,
        'Check the solid with inspect_topology.',
      );
    const details = port.faceDetails(shape, { samples });
    if (details === null)
      return refuse(
        doc,
        entityId,
        'KRN_FACE_QUERY_FAILED',
        'the kernel could not compute the faces of this shape',
        'Retry; check the solid is valid.',
      );
    const missing = (faces ?? []).filter((index) => index >= details.length);
    if (missing.length > 0)
      return refuse(
        doc,
        entityId,
        'KRN_FACE_INDEX',
        `face index ${missing.join(', ')} out of range (0-${details.length - 1})`,
        'Use indices from inspect_topology.',
      );
    const wanted = faces === undefined ? undefined : new Set(faces);
    const selected = details.filter((face) => wanted === undefined || wanted.has(face.index));
    const adjacency = graph ? port.faceGraph(shape) : null;
    if (graph && adjacency === null)
      return refuse(
        doc,
        entityId,
        'KRN_FACE_QUERY_FAILED',
        'the kernel could not build the face graph of this shape',
        'Retry without graph=true.',
      );
    const note = details.find((face) => face.note !== undefined)?.note ?? adjacency?.note;
    const data = {
      entityId,
      faceCount: details.length,
      faces: selected,
      ...(adjacency === null ? {} : { graph: adjacency }),
      ...(note === undefined ? {} : { note }),
    };
    return report(doc, summaryOf(entityId, details.length, selected, adjacency ?? undefined, doc.displayPrecision, note), data);
  },
});
