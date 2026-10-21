/**
 * Fallback writer of `export_step_ap242` for kernels that have no XDE writer (`writeExchange`) but write STEP shapes directly
 * (`exportStep` / `exportStepAssembly`): AP214 or AP242 header, flat or shared-part assembly, ply solids and surface sheets.
 */

import type { CadDocument, Entity } from '../../model/types';
import type { GeometryKernel, ShapeHandle } from '../../geometry/kernel';
import type { CommandResult, ExecutionContext } from '../types';
import { exactOrMesh } from '../kernelShape';
import { operandRecipe } from '../../geometry/operandRecipe';
import { labelStep } from './stepLabels';
import { retargetStepSchema, type StepSchema } from './stepSchema';
import { labelStepAssembly } from './stepAssemblyLabels';
import { planStepAssembly } from './stepAssembly';
import { exportedIds, stepLabels, stepTargets } from './stepTargets';
import { gateResult, unverifiedGate } from '../exchange/unverifiedGate';
import { commandError, noop, rejection, report } from '../noop';

const OCC_HINT = 'the OCC kernel (the desktop default; LLULL_KERNEL=occt-native or occt for the CLI and server)';

interface ExportStepExactData {
  readonly format: 'step';
  readonly step: string;
  readonly solidCount: number;
  /** Surface sheets (`nurbs_surface`) written as B-spline faces; they are also in `entityIds`. */
  readonly sheetCount: number;
  readonly entityIds: readonly string[];
  readonly skipped: readonly string[];
  /** Ply solids written from their triangles because the kernel could not build their exact slab. */
  readonly faceted: readonly string[];
  /** Present when the file has assembly structure: STEP products (one per component / loose solid) and placed occurrences. */
  readonly assembly?: { readonly products: number; readonly occurrences: number };
}

/** @failure no solids or sheets, a solid or assembly the kernel cannot build or write, unverified bodies without a human signature -> no-op */
export function exportLegacyStep(
  doc: CadDocument,
  kernel: GeometryKernel,
  entityIds: readonly string[] | undefined,
  schema: StepSchema,
  acceptUnverified: unknown,
  ctx: ExecutionContext | undefined,
): CommandResult {
  const params = { acceptUnverified };
  const protocol = schema === 'ap242' ? 'AP242' : 'AP214';
  const { solids, sheets, skipped, entries } = stepTargets(doc, entityIds);
  if (solids.length === 0 && sheets.length === 0) return noop(doc, 'export_step_ap242: no 3D solids to export.');
  if (kernel.exportStepAssembly !== undefined && entries.some((entry) => entry.kind === 'instance')) {
    const plan = planStepAssembly(doc, entries, kernel);
    if ('failed' in plan) return noop(doc, `export_step_ap242: the kernel could not build ${plan.failed}; nothing exported.`);
    const assemblyStep = kernel.exportStepAssembly(plan.occurrences);
    if (assemblyStep === null) return noop(doc, `export_step_ap242: the kernel could not write the assembly; nothing exported.`);
    const exported = exportedIds(entries);
    const blocked = unverifiedGate(doc, { entityIds: exported, faceted: plan.faceted }, params.acceptUnverified, ctx, 'export_step_ap242');
    if (blocked !== null) return gateResult(doc, blocked, 'export_step_ap242');
    const step = retargetStepSchema(labelStepAssembly(assemblyStep, plan.labels), schema);
    const assembly = { products: plan.partCount, occurrences: plan.occurrences.length };
    const left = sheets.map((sheet) => `${sheet.id} (surface sheet: not written into an assembly file)`);
    const data: ExportStepExactData = {
      format: 'step',
      step,
      solidCount: solids.length,
      sheetCount: 0,
      entityIds: exported,
      skipped: [...skipped, ...left],
      faceted: plan.faceted,
      assembly,
    };
    return report(
      doc,
      `export_step_ap242: ${solids.length} exact solid(s) from ${exported.join(', ')} → STEP ${protocol} assembly, ${assembly.products} product(s), ` +
        `${assembly.occurrences} occurrence(s), ${step.length} bytes` +
        (plan.faceted.length > 0
          ? `; ${plan.faceted.length} ply solid(s) written from triangles (exact slab refused): ${plan.faceted.join(', ')}`
          : '') +
        (data.skipped.length > 0 ? `; skipped ${data.skipped.join(', ')}.` : '.'),
      data,
    );
  }
  const shapes: ShapeHandle[] = [];
  const faceted: string[] = [];
  for (const entity of solids) {
    const built = exactOrMesh(kernel, entity);
    const shape = built.shape;
    if (built.faceted) faceted.push(entity.id);
    if (shape === null)
      return noop(doc, `export_step_ap242: the kernel could not build '${entity.id}' (kind '${entity.kind}'); nothing exported.`);
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
    return noop(doc, `export_step_ap242: nothing the kernel can write; skipped ${[...skipped, ...notBuilt].join(', ')}.`);
  const exported = [...exportedIds(entries), ...faces.map((sheet) => sheet.id)];
  const blocked = unverifiedGate(doc, { entityIds: exported, faceted }, params.acceptUnverified, ctx, 'export_step_ap242');
  if (blocked !== null) return gateResult(doc, blocked, 'export_step_ap242');
  const exactStep = kernel.exportStep(shapes);
  const step = exactStep === null ? null : retargetStepSchema(labelStep(exactStep, stepLabels(doc, [...solids, ...faces])), schema);
  if (step === null)
    return rejection(
      doc,
      `export_step_ap242: XCH_WRITER_UNAVAILABLE — this kernel cannot write exact STEP; use ${OCC_HINT}; no-op.`,
      commandError('XCH_WRITER_UNAVAILABLE', `Run on the desktop backend or with --kernel occt-native.`, []),
    );
  const left = [...skipped, ...notBuilt];
  const data: ExportStepExactData = {
    format: 'step',
    step,
    solidCount: solids.length,
    sheetCount: faces.length,
    entityIds: exported,
    skipped: left,
    faceted,
  };
  return report(
    doc,
    `export_step_ap242: ${solids.length} exact solid(s)${faces.length > 0 ? ` and ${faces.length} surface sheet(s)` : ''} from ${exported.join(', ')} → STEP ${protocol}, ${step.length} bytes` +
      (faceted.length > 0 ? `; ${faceted.length} ply solid(s) written from triangles (exact slab refused): ${faceted.join(', ')}` : '') +
      (left.length > 0 ? `; skipped ${left.join(', ')}.` : '.'),
    data,
  );
}
