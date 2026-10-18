/**
 * Exact-shape queries over the kernel's B-rep: topology inspection (the edge indices fillet_edge / chamfer_edge select) and STEP export
 * straight from the kernel shapes.
 */

import { type CadDocument, type Entity, type InstanceEntity, type Vec3, is3D } from '../../model/types';
import { expandInstance } from '../../geometry/instanceExpansion';
import type { ShapeHandle, ShapeTopology } from '../../geometry/kernel';
import type { CommandResult } from '../types';
import { confirmExportControlled, defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { operandRecipe } from './kernelShape';
import { labelStep, type StepLabel } from './stepLabels';
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

export interface ExportStepExactData {
  readonly format: 'step';
  readonly step: string;
  readonly solidCount: number;
  readonly entityIds: readonly string[];
  readonly skipped: readonly string[];
}

/** Product name (entity name, else id), group name as description, and color of each solid. */
function stepLabels(doc: CadDocument, solids: readonly Entity[]): StepLabel[] {
  const groups = Object.values(doc.groups);
  return solids.map((entity) => {
    const group = groups.find((candidate) => candidate.memberIds.includes(entity.id));
    return { name: entity.name ?? entity.id, color: entity.color, ...(group !== undefined ? { description: group.name } : {}) };
  });
}

/** Component instances nested deeper than this are not exported (guards against reference cycles). */
const MAX_INSTANCE_DEPTH = 4;

/** The 3D solids of a component instance in world space (nested instances expanded), named `<instance>/<part>`. */
function instanceSolids(doc: CadDocument, instance: InstanceEntity, label: string, depth: number): Entity[] {
  const component = doc.components[instance.componentId];
  if (component === undefined || depth >= MAX_INSTANCE_DEPTH) return [];
  const children = expandInstance(instance, component);
  return children.flatMap((child, index): Entity[] => {
    const nestedComponent = child.kind === 'instance' ? doc.components[child.componentId] : undefined;
    const fallback = nestedComponent?.name ?? (children.length === 1 ? component.name : `${component.name} ${index + 1}`);
    const name = `${label}/${child.name ?? fallback}`;
    if (child.kind === 'instance') return instanceSolids(doc, child, name, depth + 1);
    return is3D(child) ? [{ ...child, name }] : [];
  });
}

/** Ids of the exportable solids in `entityIds` (or the whole document), plus the ids skipped and why. */
function stepTargets(doc: CadDocument, entityIds: readonly string[] | undefined): { solids: Entity[]; skipped: string[] } {
  const ids = entityIds !== undefined && entityIds.length > 0 ? entityIds : doc.order;
  const solids: Entity[] = [];
  const skipped: string[] = [];
  const baseOf = (instance: InstanceEntity): string => instance.name ?? doc.components[instance.componentId]?.name ?? 'instance';
  const bases = ids.flatMap((id) => {
    const entity = doc.entities[id];
    return entity?.kind === 'instance' ? [baseOf(entity)] : [];
  });
  const seen = new Map<string, number>();
  for (const id of ids) {
    const entity = doc.entities[id];
    if (entity === undefined) skipped.push(`${id} (not found)`);
    else if (entity.kind === 'instance') {
      const base = baseOf(entity);
      const ordinal = (seen.get(base) ?? 0) + 1;
      seen.set(base, ordinal);
      const label = bases.filter((candidate) => candidate === base).length > 1 ? `${base} ${ordinal}` : base;
      const parts = instanceSolids(doc, entity, label, 0);
      if (parts.length === 0) skipped.push(`${id} (instance without solids)`);
      solids.push(...parts);
    } else if (is3D(entity)) solids.push(entity);
    else if (entityIds !== undefined && entityIds.length > 0) skipped.push(`${id} (2D)`);
  }
  return { solids, skipped };
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
    'Returns data: { format, step (the file text), solidCount, entityIds, skipped }. Component instances (assembly parts, ' +
    'fasteners) are exported as their solids in world space, named <instance>/<part> (instances sharing a name get a numeric suffix (Name 1, Name 2) so every product name is unique). Does not modify the document.',
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
    const { solids, skipped } = stepTargets(doc, entityIds);
    if (solids.length === 0) return noop(doc, 'export_step_exact: no 3D solids to export.');
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
    const exported = solids.map((entity) => entity.id);
    const data: ExportStepExactData = { format: 'step', step, solidCount: solids.length, entityIds: exported, skipped };
    return report(
      doc,
      `export_step_exact: ${solids.length} exact solid(s) (${exported.join(', ')}) → STEP AP214, ${step.length} bytes` +
        (skipped.length > 0 ? `; skipped ${skipped.join(', ')}.` : '.'),
      data,
    );
  },
});
