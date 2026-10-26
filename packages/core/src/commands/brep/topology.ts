/**
 * Exact-shape query over the kernel's B-rep: topology inspection (the edge indices fillet_edge / chamfer_edge select).
 */

import { type Vec3, is3D } from '../../model/types';
import type { ShapeTopology } from '../../geometry/kernel';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { operandRecipe } from '../../geometry/operandRecipe';
import { noop, report } from '../noop';
import { fixedNumber } from '../../lib/compactNumber';

const OCC_HINT = 'the OCC kernel (the desktop default; LLULL_KERNEL=occt-native or occt for the CLI and server)';

/** Edges listed in the summary itself; the full list is always in `data.edges`. */
const SUMMARY_EDGE_LIMIT = 24;

const fmtVec = (v: Vec3, precision: number): string => `[${v.map((c) => fixedNumber(c, precision)).join(', ')}]`;

function topologySummary(id: string, topology: ShapeTopology, precision: number): string {
  const surfaces = new Map<string, number>();
  for (const face of topology.faces) surfaces.set(face.surface, (surfaces.get(face.surface) ?? 0) + 1);
  const faceKinds = [...surfaces].map(([surface, count]) => `${count} ${surface}`).join(', ');
  const edges = topology.edges
    .slice(0, SUMMARY_EDGE_LIMIT)
    .map((edge) => `#${edge.index} ${edge.curve} len ${fixedNumber(edge.length, precision)} mid ${fmtVec(edge.mid, precision)}`)
    .join('; ');
  const more = topology.edges.length > SUMMARY_EDGE_LIMIT ? `; … ${topology.edges.length - SUMMARY_EDGE_LIMIT} more in data.edges` : '';
  return (
    `inspect_topology: '${id}' is ${topology.solids} exact solid(s), volume ${fixedNumber(topology.volume, precision)}, ` +
    `${topology.faces.length} faces (${faceKinds}), ${topology.edges.length} edges, ${topology.vertices} vertices. ` +
    `Edges (index for fillet_edge/chamfer_edge edgeIndices): ${edges}${more}.` +
    (topology.note === undefined ? '' : ` Note: ${topology.note}.`)
  );
}

/**
 * @affects nothing — read-only
 * @invariant data = { entityId, solids, volume, faces[{index,surface,area}], edges[{index,curve,length,start,end,mid}], vertices, note? };
 *   edge indices are exactly the ones fillet_edge / chamfer_edge accept for the same entity
 * @failure missing id, 2D / instance entity, no kernel, mesh-only kernel, kernel refusal -> no-op, no data
 */
export const inspectTopology = defineCommand({
  name: 'inspect_topology',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'List the exact B-rep topology of a 3D solid as the geometry kernel holds it: its faces (surface type, area) and ' +
    'its unique edges (curve type, length, start/end/mid points). The edge indices are the ones fillet_edge and ' +
    'chamfer_edge take in edgeIndices — inspect first, then pick edges by position (e.g. the edge whose mid point ' +
    'is at the top front). Works on primitives and on boolean / fillet / chamfer / shell results (they keep their ' +
    `exact construction). Needs the exact kernel (check kernel_info): ${OCC_HINT}; with the mesh kernel it no-ops. ` +
    'For located face geometry (normals, centroids, radii, sample points, adjacency graph) use inspect_faces. ' +
    'Returns data.note (set when the adaptive integration guard tripped and the fixed rule was used) when an area or the volume may be off. Does not modify the document.',
  params: z.object({ id: z.string().describe('Id of the 3D solid entity to inspect.') }),
  run: (doc, { id }, ctx): CommandResult => {
    const entity = doc.entities[id];
    if (!entity) return noop(doc, `inspect_topology: entity '${id}' not found.`);
    if (!is3D(entity) || entity.kind === 'instance')
      return noop(doc, `inspect_topology: entity '${id}' (kind '${entity.kind}') is not a 3D solid; explode instances first.`);
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('inspect_topology'));
    const shape = kernel.evaluate(operandRecipe(kernel, entity));
    if (shape === null) return noop(doc, `inspect_topology: the kernel could not build entity '${id}' (kind '${entity.kind}').`);
    const topology = kernel.topology(shape);
    if (topology === null) return noop(doc, `inspect_topology: this kernel has no exact B-rep topology; use ${OCC_HINT}.`);
    return report(doc, topologySummary(id, topology, doc.displayPrecision), { entityId: id, ...topology });
  },
});
