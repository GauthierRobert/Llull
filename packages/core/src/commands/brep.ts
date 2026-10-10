/**
 * Exact-shape queries over the kernel's B-rep: topology inspection (the edge indices fillet_edge /
 * chamfer_edge select) and STEP export straight from the kernel shapes.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, Vec3 } from '../model/types';
import { is3D } from '../model/types';
import type { ShapeHandle, ShapeTopology } from '../geometry/kernel';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { currentContext } from './context';
import { kernelUnavailable } from './kernelRefusal';
import { operandRecipe } from './kernelShape';
import { noop, report } from './noop';

const OCC_HINT = 'the OCC kernel (?kernel=occt in the browser, LLULL_KERNEL=occt on the server)';

/** Edges listed in the summary itself; the full list is always in `data.edges`. */
const SUMMARY_EDGE_LIMIT = 24;

const fmt = (value: number, precision: number): string =>
  Number(value.toFixed(precision)).toString();
const fmtVec = (v: Vec3, precision: number): string =>
  `[${v.map((c) => fmt(c, precision)).join(', ')}]`;

function topologySummary(id: string, topology: ShapeTopology, precision: number): string {
  const surfaces = new Map<string, number>();
  for (const face of topology.faces)
    surfaces.set(face.surface, (surfaces.get(face.surface) ?? 0) + 1);
  const faceKinds = [...surfaces].map(([surface, count]) => `${count} ${surface}`).join(', ');
  const edges = topology.edges
    .slice(0, SUMMARY_EDGE_LIMIT)
    .map(
      (edge) =>
        `#${edge.index} ${edge.curve} len ${fmt(edge.length, precision)} mid ${fmtVec(edge.mid, precision)}`,
    )
    .join('; ');
  const more =
    topology.edges.length > SUMMARY_EDGE_LIMIT
      ? `; … ${topology.edges.length - SUMMARY_EDGE_LIMIT} more in data.edges`
      : '';
  return (
    `inspect_topology: '${id}' is ${topology.solids} exact solid(s), volume ${fmt(topology.volume, precision)}, ` +
    `${topology.faces.length} faces (${faceKinds}), ${topology.edges.length} edges, ${topology.vertices} vertices. ` +
    `Edges (index for fillet_edge/chamfer_edge edgeIndices): ${edges}${more}.`
  );
}

/**
 * @command inspect_topology
 * @pure
 * @layer core/commands
 * @affects nothing — read-only
 * @invariant data = { entityId, solids, volume, faces[{index,surface,area}], edges[{index,curve,length,start,end,mid}], vertices };
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
    `exact construction). Requires ${OCC_HINT}; the default Manifold kernel has no B-rep and gracefully no-ops. ` +
    'Does not modify the document.',
  params: z.object({
    id: z.string().describe('Id of the 3D solid entity to inspect.'),
  }),
  run: (doc, { id }, ctx): CommandResult => {
    const entity = doc.entities[id];
    if (!entity) return noop(doc, `inspect_topology: entity '${id}' not found.`);
    if (!is3D(entity) || entity.kind === 'instance') {
      return noop(
        doc,
        `inspect_topology: entity '${id}' (kind '${entity.kind}') is not a 3D solid; explode instances first.`,
      );
    }
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('inspect_topology'));
    const shape = kernel.evaluate(operandRecipe(kernel, entity));
    if (shape === null) {
      return noop(
        doc,
        `inspect_topology: the kernel could not build entity '${id}' (kind '${entity.kind}').`,
      );
    }
    const topology = kernel.topology(shape);
    if (topology === null) {
      return noop(
        doc,
        `inspect_topology: this kernel has no exact B-rep topology; use ${OCC_HINT}.`,
      );
    }
    return report(doc, topologySummary(id, topology, doc.displayPrecision), {
      entityId: id,
      ...topology,
    });
  },
});

export interface ExportStepExactData {
  readonly format: 'step';
  readonly step: string;
  readonly solidCount: number;
  readonly entityIds: readonly string[];
  readonly skipped: readonly string[];
}

/** Ids of the exportable solids in `entityIds` (or the whole document), plus the ids skipped and why. */
function stepTargets(
  doc: CadDocument,
  entityIds: readonly string[] | undefined,
): { solids: Entity[]; skipped: string[] } {
  const ids = entityIds !== undefined && entityIds.length > 0 ? entityIds : doc.order;
  const solids: Entity[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const entity = doc.entities[id];
    if (entity === undefined) skipped.push(`${id} (not found)`);
    else if (entity.kind === 'instance') skipped.push(`${id} (instance)`);
    else if (is3D(entity)) solids.push(entity);
    else if (entityIds !== undefined && entityIds.length > 0) skipped.push(`${id} (2D)`);
  }
  return { solids, skipped };
}

/**
 * @command export_step_exact
 * @pure
 * @layer core/commands
 * @affects nothing — read-only
 * @invariant data = { format:'step', step (ISO 10303-21 text), solidCount, entityIds, skipped }; every solid is
 *   written from the kernel's exact B-rep (true planes, cylinders, fillet surfaces — never triangles,
 *   except for imported meshes that have no exact form)
 * @failure no solids, no kernel, mesh-only kernel, or a solid the kernel cannot build -> no-op, no data
 */
export const exportStepExact = defineCommand({
  name: 'export_step_exact',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    "Export 3D solids to STEP (AP214, ISO 10303-21) directly from the geometry kernel's exact B-rep: primitives, " +
    'booleans, fillets, chamfers and shells are written as true analytic/NURBS faces, not triangles. ' +
    `No Python needed. Requires ${OCC_HINT}; the default Manifold kernel gracefully no-ops ` +
    '(use export_step via the Python bridge, or export_stl, instead). ' +
    'Returns data: { format, step (the file text), solidCount, entityIds, skipped }. Instances are skipped ' +
    '(explode_instance first). Does not modify the document.',
  params: z.object({
    entityIds: z
      .array(z.string())
      .optional()
      .describe(
        'Ids of the 3D solids to export. Omit or pass [] to export every 3D solid of the document.',
      ),
  }),
  run: (doc, { entityIds }, ctx): CommandResult => {
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('export_step_exact'));
    const { solids, skipped } = stepTargets(doc, entityIds);
    if (solids.length === 0) return noop(doc, 'export_step_exact: no 3D solids to export.');
    const shapes: ShapeHandle[] = [];
    for (const entity of solids) {
      const shape = kernel.evaluate(operandRecipe(kernel, entity));
      if (shape === null) {
        return noop(
          doc,
          `export_step_exact: the kernel could not build '${entity.id}' (kind '${entity.kind}'); nothing exported.`,
        );
      }
      shapes.push(shape);
    }
    const step = kernel.exportStep(shapes);
    if (step === null) {
      return noop(doc, `export_step_exact: this kernel cannot write exact STEP; use ${OCC_HINT}.`);
    }
    const exported = solids.map((entity) => entity.id);
    const data: ExportStepExactData = {
      format: 'step',
      step,
      solidCount: solids.length,
      entityIds: exported,
      skipped,
    };
    return report(
      doc,
      `export_step_exact: ${solids.length} exact solid(s) (${exported.join(', ')}) → STEP AP214, ${step.length} bytes` +
        (skipped.length > 0 ? `; skipped ${skipped.join(', ')}.` : '.'),
      data,
    );
  },
});
