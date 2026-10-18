/**
 * Exact-shape queries over the kernel's B-rep: topology inspection (the edge indices fillet_edge / chamfer_edge select) and STEP export
 * straight from the kernel shapes.
 */

import { type Vec3, is3D } from '../../model/types';
import type { ShapeHandle, ShapeTopology } from '../../geometry/kernel';
import type { CommandResult } from '../types';
import { confirmExportControlled, defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { operandRecipe } from './kernelShape';
import { labelStep } from './stepLabels';
import { labelStepAssembly } from './stepAssemblyLabels';
import { planStepAssembly } from './stepAssembly';
import { type StepEntry, stepLabels, stepTargets } from './stepTargets';
import { exportRefusal, noop, report } from '../noop';
import { fixedNumber } from '../../lib/compactNumber';

const OCC_HINT = 'the OCC kernel (?kernel=occt in the browser, LLULL_KERNEL=occt on the server)';

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
    `Edges (index for fillet_edge/chamfer_edge edgeIndices): ${edges}${more}.`
  );
}

/**
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

/** The user entity ids behind the exported entries (a loose solid, or the instance whose solids were expanded), each once. */
const exportedIds = (entries: readonly StepEntry[]): string[] => [
  ...new Set(entries.map((entry) => (entry.kind === 'solid' ? entry.entity.id : entry.instance.id))),
];

export interface ExportStepExactData {
  readonly format: 'step';
  readonly step: string;
  readonly solidCount: number;
  readonly entityIds: readonly string[];
  readonly skipped: readonly string[];
  /** Present when the file has assembly structure: STEP products (one per component / loose solid) and placed occurrences. */
  readonly assembly?: { readonly products: number; readonly occurrences: number };
}

/**
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
    'Each solid becomes one STEP product named after its entity (set_entity_name, else the id; the group ' +
    'name goes in the product description) and carries its entity color as a surface style. ' +
    'Returns data: { format, step (the file text), solidCount (the expanded solids written), entityIds (the selected loose-solid / instance ids written, each once; never internal expanded ids), skipped, assembly? }. When the selection holds component instances ' +
    '(assembly parts, fasteners) the file has real assembly structure: one root product, ONE product per component (its solids written once) ' +
    'and one NEXT_ASSEMBLY_USAGE_OCCURRENCE per instance with its placement, named after the instance (instances sharing a name get a numeric ' +
    'suffix (Name 1, Name 2) so every occurrence name is unique); data.assembly = { products, occurrences }. Instances with a uniform scale share one scaled product per scale; ' +
    'only a non-uniform or mirrored scale is written as its own product of world-space solids named <instance>/<part> (inside a component, just that nested instance). ' +
    'Requires a kernel that writes assemblies (OCC); otherwise the flat list of world-space solids is written. Does not modify the document.',
  params: z.object({
    entityIds: z
      .array(z.string())
      .optional()
      .describe('Ids of the 3D solids to export. Omit or pass [] to export every 3D solid of the document.'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { entityIds } = params;
    const refused = exportRefusal(doc, 'export_step_exact', 'step', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('export_step_exact'));
    const { solids, skipped, entries } = stepTargets(doc, entityIds);
    if (solids.length === 0) return noop(doc, 'export_step_exact: no 3D solids to export.');
    if (kernel.exportStepAssembly !== undefined && entries.some((entry) => entry.kind === 'instance')) {
      const plan = planStepAssembly(doc, entries, kernel);
      if ('failed' in plan) return noop(doc, `export_step_exact: the kernel could not build ${plan.failed}; nothing exported.`);
      const assemblyStep = kernel.exportStepAssembly(plan.occurrences);
      if (assemblyStep === null) return noop(doc, `export_step_exact: the kernel could not write the assembly; nothing exported.`);
      const exported = exportedIds(entries);
      const step = labelStepAssembly(assemblyStep, plan.labels);
      const assembly = { products: plan.partCount, occurrences: plan.occurrences.length };
      const data: ExportStepExactData = { format: 'step', step, solidCount: solids.length, entityIds: exported, skipped, assembly };
      return report(
        doc,
        `export_step_exact: ${solids.length} exact solid(s) from ${exported.join(', ')} → STEP AP214 assembly, ${assembly.products} product(s), ` +
          `${assembly.occurrences} occurrence(s), ${step.length} bytes` +
          (skipped.length > 0 ? `; skipped ${skipped.join(', ')}.` : '.'),
        data,
      );
    }
    const shapes: ShapeHandle[] = [];
    for (const entity of solids) {
      const shape = kernel.evaluate(operandRecipe(kernel, entity));
      if (shape === null)
        return noop(doc, `export_step_exact: the kernel could not build '${entity.id}' (kind '${entity.kind}'); nothing exported.`);
      shapes.push(shape);
    }
    const exactStep = kernel.exportStep(shapes);
    const step = exactStep === null ? null : labelStep(exactStep, stepLabels(doc, solids));
    if (step === null) return noop(doc, `export_step_exact: this kernel cannot write exact STEP; use ${OCC_HINT}.`);
    const exported = exportedIds(entries);
    const data: ExportStepExactData = { format: 'step', step, solidCount: solids.length, entityIds: exported, skipped };
    return report(
      doc,
      `export_step_exact: ${solids.length} exact solid(s) from ${exported.join(', ')} → STEP AP214, ${step.length} bytes` +
        (skipped.length > 0 ? `; skipped ${skipped.join(', ')}.` : '.'),
      data,
    );
  },
});
