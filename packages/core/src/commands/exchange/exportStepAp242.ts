/**
 * export_step_ap242 (aerospace 04 XCH M2): STEP AP242 / AP214 / AP203 through the kernel's XDE writer, with the product structure of the model,
 * names, colours, layers, materials and the CAx-IF geometric validation properties, then a self-check that re-reads the written text with the
 * independent Part 21 reader and compares the embedded properties with the model. `buildStepExport` is shared with `export_step_exact`.
 */

import type { CadDocument } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import type { ExchangeWriteRequest, StepSchema } from '../../geometry/kernelExchange';
import type { CommandResult, ExecutionContext } from '../types';
import { confirmExportControlled, defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { exportDocumentHash } from '../../model/exportGate';
import { humanGate } from '../../model/humanGate';
import { canonicalizeStep21 } from '../../lib/step21/canonical';
import { summarizeStep21 } from '../../lib/step21/summary';
import { commandError, exportRefusal, noop, rejection, report } from '../noop';
import { kernelStampOf } from '../persistence/kernelStamp';
import { type ExpectedGvp, groupFileGvp, selfCheckGvp } from './fileGvp';
import { type ExchangePlan, planExchange } from './stepPlan';
import { MM_PER_UNIT } from '../../model/units';

/** Timestamp of the header when the host passes none: a fixed instant, so the same document always yields the same bytes (TR-XCH-05). */
const EPOCH_TIMESTAMP = '1970-01-01T00:00:00';

export interface StepExportOptions {
  readonly schema: StepSchema;
  readonly validation: boolean;
  readonly structured: boolean;
  readonly fileName: string;
  readonly timestamp: string;
}

export interface StepExportData {
  readonly format: 'step';
  readonly step: string;
  readonly schema: StepSchema;
  readonly schemaName: string | null;
  readonly unit: string;
  readonly solidCount: number;
  readonly sheetCount: number;
  readonly entityIds: readonly string[];
  readonly skipped: readonly string[];
  /** Ply solids written from triangles because the kernel refused their exact slab. */
  readonly faceted: readonly string[];
  readonly assembly?: { readonly products: number; readonly occurrences: number };
  readonly gvp: readonly {
    readonly product: string;
    readonly volume: number;
    readonly area: number;
    readonly centroid: readonly number[];
  }[];
  readonly selfCheck?: ReturnType<typeof selfCheckGvp>;
  readonly policy: { readonly schema: NamedDefault<StepSchema>; readonly selfCheck: string };
  readonly provenance: {
    readonly originatingSystem: string;
    readonly kernel: string;
    readonly schemaName: string | null;
    readonly timestamp: string;
  };
  readonly reviewRequired: { readonly value: boolean; readonly reasons: readonly string[] };
}

interface NamedDefault<T> {
  readonly value: T;
  readonly source: string;
  readonly defaulted: boolean;
}

export type StepExportOutcome =
  | { readonly ok: true; readonly data: StepExportData; readonly plan: ExchangePlan }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly remediation: string; readonly ids?: readonly string[] };

const SCHEMA_NAMES: Readonly<Record<StepSchema, string>> = { ap242: 'AP242', ap214: 'AP214', ap203: 'AP203' };

const fail = (code: string, message: string, remediation: string, ids?: readonly string[]): StepExportOutcome => ({
  ok: false,
  code,
  message,
  remediation,
  ...(ids === undefined ? {} : { ids }),
});

/** Ids among `ids` whose import left them unverified (a sender GVP that disagrees with the geometry, or none to compare). */
function unverifiedIds(doc: CadDocument, ids: readonly string[]): string[] {
  const provenance = doc.exchange?.provenance ?? {};
  return ids.filter((id) => provenance[id]?.unverified.value === true);
}

/**
 * Plans, writes and self-checks one STEP file. Pure; never throws.
 * @failure no writer / nothing exportable / kernel cannot build or write / self-check red -> `{ ok: false, code, … }`
 */
export function buildStepExport(
  doc: CadDocument,
  kernel: GeometryKernel,
  entityIds: readonly string[] | undefined,
  options: StepExportOptions,
): StepExportOutcome {
  if (kernel.writeExchange === undefined)
    return fail(
      'XCH_WRITER_UNAVAILABLE',
      'this kernel has no STEP writer (the mesh kernel cannot write exact STEP)',
      'run on the desktop backend or with --kernel occt-native',
    );
  const plan = planExchange(doc, kernel, entityIds, { structured: options.structured, validation: options.validation });
  if ('empty' in plan)
    return fail(
      'XCH_NO_SOLIDS',
      `nothing exportable${plan.skipped.length > 0 ? ` (skipped ${plan.skipped.join(', ')})` : ''}`,
      'pass 3D solid ids (find_entities) or build solids first',
    );
  if ('failed' in plan)
    return fail(
      'XCH_NO_SOLIDS',
      `the kernel could not build ${plan.failed}`,
      'check the entity with inspect_topology; nothing was exported',
    );
  const originatingSystem = 'llull';
  const request: ExchangeWriteRequest = {
    format: 'step',
    schema: options.schema,
    unit: doc.units,
    products: plan.products,
    occurrences: plan.occurrences,
    rootName: 'Assembly',
    ...(plan.rootValidation === undefined ? {} : { rootValidation: plan.rootValidation }),
    header: { fileName: options.fileName, originatingSystem, timestamp: options.timestamp },
  };
  const written = kernel.writeExchange(request);
  if (written === null || written === '')
    return fail(
      'XCH_WRITER_UNAVAILABLE',
      'the kernel could not write the product tree',
      'retry; if it repeats, export a smaller selection and report the entity ids',
    );
  const step = canonicalizeStep21(written);
  const summary = summarizeStep21(step);
  let selfCheck: ReturnType<typeof selfCheckGvp> | undefined;
  if (options.validation) {
    const expected: ExpectedGvp[] = [
      ...plan.products.flatMap((product) =>
        product.validation === undefined ? [] : [{ name: product.name, assembly: false, ...product.validation }],
      ),
      ...(plan.rootValidation === undefined ? [] : [{ name: 'Assembly', assembly: true, ...plan.rootValidation }]),
    ];
    const scale = new Map(expected.map((item) => [item.name, Math.cbrt(item.volume ?? 1)] as const));
    selfCheck = selfCheckGvp(expected, groupFileGvp(summary, MM_PER_UNIT[doc.units]), (name) => scale.get(name) ?? 1);
    if (selfCheck.band === 'red')
      return fail(
        'XCH_SELFCHECK_RED',
        `the written file disagrees with the model${selfCheck.missing.length > 0 ? ` (no validation property for ${selfCheck.missing.join(', ')})` : ''}`,
        'report a defect; do not deliver the file',
      );
  }
  const gvp = plan.products.flatMap((product) =>
    product.validation === undefined
      ? []
      : [
          {
            product: product.name,
            volume: product.validation.volume,
            area: product.validation.area,
            centroid: product.validation.centroid,
          },
        ],
  );
  const info = kernelStampOf(kernel);
  const topLevel = plan.occurrences.filter((occurrence) => occurrence.parent === null).length;
  const data: StepExportData = {
    format: 'step',
    step,
    schema: options.schema,
    schemaName: summary.fileSchema,
    unit: doc.units,
    solidCount: plan.solidCount,
    sheetCount: plan.sheetCount,
    entityIds: plan.entityIds,
    skipped: plan.skipped,
    faceted: plan.faceted,
    ...(plan.hasRoot ? { assembly: { products: plan.products.length - plan.sheetCount, occurrences: topLevel } } : {}),
    gvp,
    ...(selfCheck === undefined ? {} : { selfCheck }),
    policy: {
      schema: {
        value: options.schema,
        source: 'export_step_ap242 default AP242 (ISO 10303-242); AP214 / AP203 on request',
        defaulted: true,
      },
      selfCheck: `same-kernel round trip: ${JSON.stringify(selfCheck?.policy ?? {})}`,
    },
    provenance: {
      originatingSystem,
      kernel: info?.build ?? kernel.name ?? 'unknown',
      schemaName: summary.fileSchema,
      timestamp: options.timestamp,
    },
    reviewRequired: { value: false, reasons: [] },
  };
  return { ok: true, data, plan };
}

const refusal = (doc: CadDocument, outcome: Extract<StepExportOutcome, { ok: false }>, command: string): CommandResult =>
  rejection(
    doc,
    `${command}: ${outcome.code} — ${outcome.message}; nothing was exported; no-op.`,
    commandError(outcome.code, outcome.remediation, outcome.ids ?? []),
  );

/** Refusal for unverified bodies unless a human cleared `acceptUnverified` (TR-XCH-26); null when the export may proceed. */
function unverifiedRefusal(
  doc: CadDocument,
  ids: readonly string[],
  confirmation: unknown,
  ctx: ExecutionContext | undefined,
  command: string,
): CommandResult | null {
  if (ids.length === 0) return null;
  const why = `${ids.join(', ')} ${ids.length === 1 ? 'was' : 'were'} imported with a validation property that disagrees with the geometry or could not be checked`;
  if (confirmation === undefined || confirmation === false)
    return rejection(
      doc,
      `${command}: XCH_UNVERIFIED_BODIES — ${why}; nothing was exported; no-op.`,
      commandError(
        'XCH_UNVERIFIED_BODIES',
        'a qualified reviewer verifies the bodies, then passes acceptUnverified with a human signature',
        ids,
        ['acceptUnverified'],
      ),
    );
  const outcome = humanGate(ctx?.humanSignature ?? null, 'export of unverified bodies', ids, confirmation, {
    command,
    documentHash: exportDocumentHash(doc),
  });
  return outcome.cleared
    ? null
    : rejection(
        doc,
        `${command}: XCH_HUMAN_GATE — ${outcome.reason}; nothing was exported; no-op.`,
        commandError('XCH_HUMAN_GATE', 'hand the prepared request to a qualified reviewer in the desktop app', ids, ['acceptUnverified']),
      );
}

/**
 * @affects nothing — read-only
 * @invariant data.step is ISO 10303-21 text whose FILE_SCHEMA is the requested schema; one PRODUCT per component / free solid, one
 *   NEXT_ASSEMBLY_USAGE_OCCURRENCE per instance (structured), a geometric validation property set (volume, surface area, centre point) per
 *   product and per root assembly when includeValidationProperties; data.selfCheck re-reads data.step and compares them with the model
 * @failure no solids, no kernel, kernel without writeExchange, a solid the kernel cannot build, self-check red, unverified imported bodies
 *   without a human acceptUnverified -> no-op, no data, error.code XCH_*
 */
export const exportStepAp242 = defineCommand({
  name: 'export_step_ap242',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'Export 3D solids to STEP (ISO 10303-21) from the kernel exact B-rep through the XDE writer: AP242 by default (AP214 or AP203 on request), the document unit ' +
    'as the file length unit (numbers are not converted), real assembly structure (one PRODUCT per component, one placed NEXT_ASSEMBLY_USAGE_OCCURRENCE per ' +
    'instance, shared parts written once), entity names, colours, layers, materials, and the CAx-IF geometric validation properties (volume, surface area, ' +
    'centre of volume) of every product and of the root assembly. The written text is read back with an independent Part 21 reader and its validation ' +
    'properties are compared with the model (data.selfCheck, tolerance 1e-9 relative); a disagreement refuses the export with XCH_SELFCHECK_RED. Surface sheets ' +
    '(nurbs_surface) are written as B-spline face products. Returns data: { format, step, schema, schemaName, unit, solidCount, sheetCount, entityIds, skipped, ' +
    'assembly?, gvp[{ product, volume, area, centroid }], selfCheck, policy, provenance, reviewRequired }. Same document and same timestamp give identical bytes. ' +
    'Imported bodies whose sender validation properties were red or not checkable need acceptUnverified (a human signature). Requires the OCC kernel; the ' +
    'Manifold kernel refuses with XCH_WRITER_UNAVAILABLE. Does not modify the document.',
  params: z.object({
    entityIds: z
      .array(z.string())
      .optional()
      .describe('Ids of the solids, instances or sheets to export. Omit or pass [] for every 3D solid of the document.'),
    schema: z
      .enum(['ap242', 'ap214', 'ap203'])
      .optional()
      .describe("STEP application protocol written in FILE_SCHEMA: 'ap242' (default, ISO 10303-242), 'ap214' or 'ap203'."),
    includeValidationProperties: z
      .boolean()
      .optional()
      .describe(
        'Write the geometric validation properties (volume, surface area, centre point) of every product and of the root assembly, and self-check them. Default true.',
      ),
    assembly: z
      .enum(['structured', 'flat'])
      .optional()
      .describe(
        "'structured' (default): products per component with placed occurrences. 'flat': every solid in world space as its own product, no assembly.",
      ),
    fileName: z.string().optional().describe('File name recorded in the Part 21 header (FILE_NAME). Default llull.stp.'),
    timestamp: z
      .string()
      .optional()
      .describe(
        'ISO 8601 time recorded in the header (e.g. 2026-10-15T12:00:00); hosts pass the current time. Default 1970-01-01T00:00:00 so the output is reproducible.',
      ),
    acceptUnverified: confirmExportControlled.describe(
      'Human confirmation to export imported bodies whose validation properties were red or not checkable: a signature object with a nonce produced in the ' +
        'desktop app. An agent cannot give it (XCH_HUMAN_GATE).',
    ),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_step_ap242', 'step', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('export_step_ap242'));
    const outcome = buildStepExport(doc, kernel, params.entityIds, {
      schema: params.schema ?? 'ap242',
      validation: params.includeValidationProperties !== false,
      structured: params.assembly !== 'flat',
      fileName: params.fileName ?? 'llull.stp',
      timestamp: params.timestamp ?? EPOCH_TIMESTAMP,
    });
    if (!outcome.ok) return refusal(doc, outcome, 'export_step_ap242');
    const blocked = unverifiedRefusal(doc, unverifiedIds(doc, outcome.data.entityIds), params.acceptUnverified, ctx, 'export_step_ap242');
    if (blocked !== null) return blocked;
    const { data } = outcome;
    const unverified = unverifiedIds(doc, data.entityIds);
    const reviewRequired = unverified.length > 0 ? { value: true, reasons: ['unverified_bodies_accepted'] } : data.reviewRequired;
    const checked =
      data.selfCheck === undefined
        ? 'validation properties not written'
        : `self-check ${data.selfCheck.band} (${data.selfCheck.comparisons.length} comparisons)`;
    return report(
      doc,
      `export_step_ap242: ${data.solidCount} exact solid(s)${data.sheetCount > 0 ? ` and ${data.sheetCount} sheet(s)` : ''} from ${data.entityIds.join(', ')} → STEP ${SCHEMA_NAMES[data.schema]}` +
        `${data.assembly === undefined ? '' : `, ${data.assembly.products} product(s), ${data.assembly.occurrences} occurrence(s)`}, unit ${data.unit}, ${data.step.length} bytes; ${checked}` +
        `${data.skipped.length > 0 ? `; skipped ${data.skipped.join(', ')}` : ''}.${reviewRequired.value ? ' Review required: unverified bodies accepted.' : ''}`,
      { ...data, reviewRequired },
    );
  },
});
