/**
 * Exact-shape queries over the kernel's B-rep: topology inspection (the edge indices fillet_edge / chamfer_edge select) and STEP export
 * straight from the kernel shapes.
 */

import { type CadDocument, type Entity, type Vec3, is3D } from '../../model/types';
import type { GeometryKernel, ShapeHandle, ShapeTopology } from '../../geometry/kernel';
import type { CommandResult } from '../types';
import { confirmExportControlled, defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { exactOrMesh, operandRecipe } from './kernelShape';
import { labelStep } from './stepLabels';
import { labelStepAssembly } from './stepAssemblyLabels';
import { planStepAssembly } from './stepAssembly';
import { exportedIds, stepLabels, stepTargets } from './stepTargets';
import { buildStepExport } from '../exchange/exportStepAp242';
import { exportRefusal, noop, report } from '../noop';
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

/** AP214 export through the kernel's XDE writer (aerospace 04 TR-XCH-19): the data of the legacy path, with names, colours and structure written by the writer. */
function exportThroughXde(doc: CadDocument, kernel: GeometryKernel, entityIds: readonly string[] | undefined): CommandResult {
  const outcome = buildStepExport(doc, kernel, entityIds, {
    schema: 'ap214',
    validation: false,
    structured: true,
    fileName: 'llull.stp',
    timestamp: '1970-01-01T00:00:00',
  });
  if (!outcome.ok) return noop(doc, `export_step_exact: ${outcome.message}; nothing exported.`);
  const { data } = outcome;
  const exact: ExportStepExactData = {
    format: 'step',
    step: data.step,
    solidCount: data.solidCount,
    sheetCount: data.sheetCount,
    entityIds: data.entityIds,
    skipped: data.skipped,
    ...(data.assembly === undefined ? {} : { assembly: data.assembly }),
  };
  const sheets = data.sheetCount > 0 ? ` and ${data.sheetCount} surface sheet(s)` : '';
  const structure = data.assembly === undefined ? '' : `, ${data.assembly.products} product(s), ${data.assembly.occurrences} occurrence(s)`;
  const left = data.skipped.length > 0 ? `; skipped ${data.skipped.join(', ')}.` : '.';
  return report(
    doc,
    `export_step_exact: ${data.solidCount} exact solid(s)${sheets} from ${data.entityIds.join(', ')} → STEP AP214${data.assembly === undefined ? '' : ' assembly'}${structure}, ${data.step.length} bytes${left}`,
    exact,
  );
}

export interface ExportStepExactData {
  readonly format: 'step';
  readonly step: string;
  readonly solidCount: number;
  /** Surface sheets (`nurbs_surface`) written as B-spline faces; they are also in `entityIds`. */
  readonly sheetCount: number;
  readonly entityIds: readonly string[];
  readonly skipped: readonly string[];
  /** Present when the file has assembly structure: STEP products (one per component / loose solid) and placed occurrences. */
  readonly assembly?: { readonly products: number; readonly occurrences: number };
}

/**
 * @affects nothing — read-only
 * @invariant data = { format:'step', step (ISO 10303-21 text), solidCount, sheetCount, entityIds, skipped }; every solid is
 *   written from the kernel's exact B-rep (true planes, cylinders, fillet surfaces — never triangles,
 *   except for imported meshes that have no exact form); a surface sheet is one product holding its (trimmed) B-spline face
 * @failure no solids or sheets, no kernel, mesh-only kernel, or a solid the kernel cannot build -> no-op, no data; a sheet the kernel
 *   cannot build is skipped (named in `skipped`), it never fails the export
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
    'Surface sheets (nurbs_surface entities, trimmed ones included) are written as exact B-spline faces, one product each, after the solids, ' +
    'when the kernel builds them (the native OCC kernel does); a sheet it cannot build is listed in skipped. Sheets are not placed into an assembly file. ' +
    'Returns data: { format, step (the file text), solidCount (the expanded solids written), sheetCount (sheets written), entityIds (the selected loose-solid / instance / sheet ids written, each once; never internal expanded ids), skipped, assembly? }. When the selection holds component instances ' +
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
    if (kernel.writeExchange !== undefined) return exportThroughXde(doc, kernel, entityIds);
    const { solids, sheets, skipped, entries } = stepTargets(doc, entityIds);
    if (solids.length === 0 && sheets.length === 0) return noop(doc, 'export_step_exact: no 3D solids to export.');
    if (kernel.exportStepAssembly !== undefined && entries.some((entry) => entry.kind === 'instance')) {
      const plan = planStepAssembly(doc, entries, kernel);
      if ('failed' in plan) return noop(doc, `export_step_exact: the kernel could not build ${plan.failed}; nothing exported.`);
      const assemblyStep = kernel.exportStepAssembly(plan.occurrences);
      if (assemblyStep === null) return noop(doc, `export_step_exact: the kernel could not write the assembly; nothing exported.`);
      const exported = exportedIds(entries);
      const step = labelStepAssembly(assemblyStep, plan.labels);
      const assembly = { products: plan.partCount, occurrences: plan.occurrences.length };
      const left = sheets.map((sheet) => `${sheet.id} (surface sheet: not written into an assembly file)`);
      const data: ExportStepExactData = {
        format: 'step',
        step,
        solidCount: solids.length,
        sheetCount: 0,
        entityIds: exported,
        skipped: [...skipped, ...left],
        assembly,
      };
      return report(
        doc,
        `export_step_exact: ${solids.length} exact solid(s) from ${exported.join(', ')} → STEP AP214 assembly, ${assembly.products} product(s), ` +
          `${assembly.occurrences} occurrence(s), ${step.length} bytes` +
          (data.skipped.length > 0 ? `; skipped ${data.skipped.join(', ')}.` : '.'),
        data,
      );
    }
    const shapes: ShapeHandle[] = [];
    for (const entity of solids) {
      const shape = exactOrMesh(kernel, entity);
      if (shape === null)
        return noop(doc, `export_step_exact: the kernel could not build '${entity.id}' (kind '${entity.kind}'); nothing exported.`);
      shapes.push(shape);
    }
    const faces: Entity[] = [];
    const notBuilt: string[] = [];
    for (const sheet of sheets) {
      const shape = kernel.evaluate(operandRecipe(kernel, sheet));
      if (shape === null) notBuilt.push(`${sheet.id} (surface sheet: this kernel cannot build B-spline faces; use ${OCC_HINT})`);
      else {
        shapes.push(shape);
        faces.push(sheet);
      }
    }
    if (shapes.length === 0)
      return noop(doc, `export_step_exact: nothing the kernel can write; skipped ${[...skipped, ...notBuilt].join(', ')}.`);
    const exactStep = kernel.exportStep(shapes);
    const step = exactStep === null ? null : labelStep(exactStep, stepLabels(doc, [...solids, ...faces]));
    if (step === null) return noop(doc, `export_step_exact: this kernel cannot write exact STEP; use ${OCC_HINT}.`);
    const exported = [...exportedIds(entries), ...faces.map((sheet) => sheet.id)];
    const left = [...skipped, ...notBuilt];
    const data: ExportStepExactData = {
      format: 'step',
      step,
      solidCount: solids.length,
      sheetCount: faces.length,
      entityIds: exported,
      skipped: left,
    };
    return report(
      doc,
      `export_step_exact: ${solids.length} exact solid(s)${faces.length > 0 ? ` and ${faces.length} surface sheet(s)` : ''} from ${exported.join(', ')} → STEP AP214, ${step.length} bytes` +
        (left.length > 0 ? `; skipped ${left.join(', ')}.` : '.'),
      data,
    );
  },
});
