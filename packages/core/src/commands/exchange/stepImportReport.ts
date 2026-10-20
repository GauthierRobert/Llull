/** The `data.report` of import_step_exact (aerospace 01 TR-KRN-22/24/102/104). Pure shaping of the kernel's import result. */

import type { CadDocument } from '../../model/types';
import type { ImportedShapes, ImportedSolid, ImportShapesOptions } from '../../geometry/kernelPorts';
import type { ModelingTolerance } from '../../model/kernelSettings';
import { MM_PER_UNIT } from '../../model/units';

interface ImportWarning {
  readonly code: 'KRN_IMPORT_TOLERANCE_HIGH' | 'XCH_GVP_YELLOW' | 'XCH_GVP_RED' | 'XCH_GVP_NOT_CHECKABLE';
  readonly severity: 'warn' | 'fail';
  readonly message: string;
  readonly entityIds: readonly string[];
  readonly remediation: string;
}

interface ReportInput {
  readonly ids: readonly string[];
  readonly solids: readonly ImportedSolid[];
  readonly imported: ImportedShapes;
  readonly tolerance: ModelingTolerance;
  readonly options: ImportShapesOptions;
  readonly doc: Pick<CadDocument, 'units'>;
  readonly fileName: string | undefined;
  readonly original: string | undefined;
  readonly blobs: readonly string[];
}

interface ReportBody {
  readonly id: string;
  readonly blob: string;
  readonly validAsRead: boolean;
  readonly validAfterHeal: boolean;
  readonly actions: readonly string[];
  readonly maxToleranceMm: number;
  readonly freeEdges: number;
  readonly faces: number;
  readonly faceted: boolean;
}

interface StepImportReport {
  readonly source: { readonly fileName?: string; readonly originalBlob?: string };
  readonly options: { readonly heal: boolean; readonly sew: boolean; readonly precisionMm: number; readonly maxToleranceMm: number };
  readonly unit: { readonly document: string; readonly scaleFromMm: number };
  readonly census: ImportedShapes['census'];
  readonly solids: readonly ReportBody[];
  readonly maxToleranceMm: number;
  readonly skipped: readonly string[];
  readonly warnings: readonly ImportWarning[];
  readonly reviewRequired: { readonly value: boolean; readonly reasons: readonly string[] };
}

export function stepImportReport(input: ReportInput): StepImportReport {
  const { ids, solids, imported, tolerance, options } = input;
  const bodies = solids.map((solid, index) => ({
    id: ids[index] ?? '',
    blob: input.blobs[index] ?? '',
    validAsRead: solid.validAsRead,
    validAfterHeal: solid.validAfterHeal,
    actions: solid.actions,
    maxToleranceMm: solid.maxToleranceMm,
    freeEdges: solid.freeEdges,
    faces: solid.faces,
    faceted: solid.faceted,
  }));
  const high = bodies.filter((body) => body.maxToleranceMm > tolerance.maxImportTolerance);
  const warnings: ImportWarning[] =
    high.length === 0
      ? []
      : [
          {
            code: 'KRN_IMPORT_TOLERANCE_HIGH',
            severity: 'warn',
            message: `sub-shape tolerance up to ${Math.max(...high.map((body) => body.maxToleranceMm))} mm exceeds maxImportTolerance ${tolerance.maxImportTolerance} mm`,
            entityIds: high.map((body) => body.id),
            remediation: 'check the result with a measurement against the source; a reviewer decides if the tolerance is acceptable',
          },
        ];
  const reasons = [
    ...(bodies.some((body) => body.actions.includes('tolerance_grown')) ? ['tolerance_growth'] : []),
    ...(high.length > 0 ? ['import_tolerance_high'] : []),
  ];
  return {
    source: {
      ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
      ...(input.original === undefined ? {} : { originalBlob: input.original }),
    },
    options: { heal: options.heal, sew: options.sew, precisionMm: options.precision, maxToleranceMm: options.maxTolerance },
    unit: { document: input.doc.units, scaleFromMm: 1 / MM_PER_UNIT[input.doc.units] },
    census: imported.census,
    solids: bodies,
    maxToleranceMm: Math.max(0, ...bodies.map((body) => body.maxToleranceMm)),
    skipped: imported.skipped,
    warnings,
    reviewRequired: { value: reasons.length > 0, reasons },
  };
}
