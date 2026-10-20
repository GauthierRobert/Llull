/**
 * import_iges / export_iges (aerospace 04 XCH M4, TR-XCH-12/13): IGES 5.3 through the kernel's translator. Import sews the faces at
 * max(the file's own resolution, 1e-6 x diagonal) into closed shells, heals them into exact solids and counts what no translator reads; export
 * writes B-rep solids (type 186/514/510/508/504/502) or trimmed faces and reads the text back to check volume and area.
 */

import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { confirmExportControlled, defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { changed, commandError, exportRefusal, noop, rejection, report } from '../noop';
import { base64ToText } from '../../lib/base64';
import { sha256Hex } from '../../lib/sha256';
import { summarizeIges } from '../../lib/iges/summary';
import { makeBlob, withBlob } from '../../model/blobs';
import { MM_PER_UNIT } from '../../model/units';
import { modelingToleranceOf, withKernelStamp } from '../../model/kernelSettings';
import type { ImportProvenance } from '../../model/exchange';
import { kernelStampOf } from '../persistence/kernelStamp';
import { MAX_IMPORT_BODIES } from '../limits';
import { buildBodies } from './importBodies';
import { stepImportReport } from './stepImportReport';
import { planExchange } from './stepPlan';
import { ACCEPT_UNVERIFIED, acceptedReasons, gateResult, unverifiedGate } from './unverifiedGate';

const MAX_IGES_CHARS = 64 * 1024 * 1024;

const ERRORS = {
  unreadable: ['KRN_STEP_UNREADABLE', 'check the file (size, truncated?) and that it is IGES text in the 80-column format'],
  no_solid: ['KRN_STEP_NO_SOLID', 'retry with sew: true; open shells stay surfaces and are not imported as solids'],
  unavailable: [
    'XCH_WRITER_UNAVAILABLE',
    'this kernel build has no IGES translator (TKDEIGES): rebuild OCCT with build-occt.mjs, or run on the desktop backend',
  ],
  tessellated_only: ['KRN_STEP_UNREADABLE', 'the file holds no B-rep geometry'],
} as const;

/**
 * @affects adds document blobs (healed B-rep per solid) and one `mesh` entity per solid (brep = blob leaf); sets exchange.provenance
 * @invariant faces are sewn at max(file resolution, 1e-6 x diagonal, document linear tolerance); only closed shells become solids (open ones are
 *   counted in data.report.census.openShells and listed as skipped); the bodies are flagged unverified (an IGES file carries no validation properties)
 * @failure no exact IGES kernel, empty or truncated IGES, no closed shell -> no-op, affected:[], error.code
 */
export const importIges = defineCommand({
  name: 'import_iges',
  annotations: { requiresKernel: true },
  description:
    'Import an IGES file (<= 5.3, ANS US PRO/IPO-100) as exact B-rep solids: the 3D geometry (trimmed / bounded surfaces, solids, shells) is read, loose faces are ' +
    "sewn into closed shells at max(the file's resolution, 1e-6 x diagonal) and healed into solids, stored like import_step_exact (one mesh entity per solid, " +
    'content-addressed blob). Lengths are converted from the file unit (Global section; exact factor in data.iges.unitFactor) to the document unit. data.iges lists the ' +
    'entity census, the types no translator reads (annotation, properties: untranslated), open shells that did not close and the sewing tolerance used. IGES has no ' +
    'validation properties, so the bodies are flagged unverified and the report asks for review. Needs the exact OCC kernel with the IGES translator. ' +
    'Give the file as text or igesBase64. Refusals carry error.code KRN_STEP_UNREADABLE, KRN_STEP_NO_SOLID, XCH_WRITER_UNAVAILABLE, KRN_NO_EXACT_KERNEL.',
  params: z.object({
    text: z.string().max(MAX_IGES_CHARS).optional().describe('The IGES file as text. Give exactly one of text or igesBase64.'),
    igesBase64: z
      .string()
      .max(Math.ceil((MAX_IGES_CHARS * 4) / 3) + 4)
      .optional()
      .describe('The IGES file bytes, base64 encoded (ASCII). Give exactly one of text or igesBase64.'),
    fileName: z.string().optional().describe('Original file name, kept in the report and provenance only.'),
    sha256: z
      .string()
      .optional()
      .describe('sha256 (hex) of the file bytes computed by the host; kept in the provenance. Default: sha256 of the text.'),
    sew: z.boolean().optional().describe('Sew faces into closed shells. Default true; false keeps only solids the file already holds.'),
    heal: z.boolean().optional().describe('Run shape healing on every solid. Default true.'),
    name: z.string().optional().describe('Entity name; several solids get a numeric suffix. Default: none.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const refuse = (code: string, remediation: string, why: string, path = 'text'): CommandResult =>
      rejection(doc, `import_iges: ${code} — ${why}; no-op.`, commandError(code, remediation, [], [path]));
    if ((params.text === undefined) === (params.igesBase64 === undefined))
      return refuse('CMD_INVALID_PARAMS', 'pass the file as text or igesBase64, not both', 'give exactly one of text or igesBase64');
    const text = params.text ?? base64ToText(params.igesBase64 ?? '');
    const kernel = (ctx ?? currentContext()).kernel;
    if (kernel?.importExchange === undefined || kernel.loadBlob === undefined)
      return refuse(
        'KRN_NO_EXACT_KERNEL',
        'run on the desktop backend or with --kernel occt-native',
        'the active kernel has no exact import (kernel_info shows it)',
      );
    if (text === null || text.trim() === '') return refuse(...ERRORS.unreadable, 'the IGES content is empty or not valid base64 text');
    const summary = summarizeIges(text);
    if (!summary.valid)
      return refuse(...ERRORS.unreadable, 'not a complete IGES file (no Terminate section, no entities or no Global section)');
    const tolerance = modelingToleranceOf(doc);
    const resolutionMm =
      summary.global.resolution !== null && summary.global.mmPerUnit !== null ? summary.global.resolution * summary.global.mmPerUnit : 0;
    const options = {
      precision: tolerance.linear,
      maxTolerance: Math.max(0.1, tolerance.maxImportTolerance),
      heal: params.heal !== false,
      sew: params.sew !== false,
      fileResolutionMm: resolutionMm,
    };
    const read = kernel.importExchange('iges', text, options);
    if (read === null) return refuse(...ERRORS.unreadable, 'the kernel could not read the file');
    if ('error' in read) {
      const [code, remediation] = ERRORS[read.error];
      return refuse(code, remediation, read.detail);
    }
    if ('products' in read) return refuse(...ERRORS.unreadable, 'the kernel answered a STEP product tree for an IGES file');
    if (read.solids.length > MAX_IMPORT_BODIES)
      return refuse(...ERRORS.unreadable, `${read.solids.length} solids exceed MAX_IMPORT_BODIES (${MAX_IMPORT_BODIES})`);
    const invalid = read.solids.flatMap((solid, index) => (solid.validAfterHeal ? [] : [index + 1]));
    if (invalid.length > 0)
      return refuse(
        'KRN_HEAL_FAILED',
        'retry with sew: false / heal: true, or another linear tolerance',
        `solid${invalid.length > 1 ? 's' : ''} ${invalid.join(', ')} still fail BRepCheck after sewing`,
      );
    const bodies = buildBodies(doc, kernel, read, params.name);
    if (typeof bodies === 'number')
      return refuse('KRN_HEAL_FAILED', 'retry the import', `the kernel cannot rebuild healed solid ${bodies + 1} from its stored B-rep`);
    const stamp = kernelStampOf(kernel);
    const staged = bodies.reduce((next, body) => withBlob(next, body.blob), doc);
    const ids = bodies.map((body) => body.entity.id);
    const sha256 = params.sha256 ?? sha256Hex(text);
    const unit = summary.global.unitName;
    const record: ImportProvenance = {
      format: 'iges',
      schemaName: summary.global.system === '' ? null : summary.global.system,
      fileName: params.fileName ?? summary.global.fileName,
      sha256,
      productName: summary.global.productId,
      sourceUnit: unit === 'mm' || unit === 'cm' || unit === 'm' ? unit : unit === 'inch' ? 'in' : unit === 'foot' ? 'ft' : 'unknown',
      unverified: { value: true, reasons: ['import_gvp_not_checkable'] },
    };
    const document: CadDocument = {
      ...(doc.kernelSettings === undefined && stamp !== null ? withKernelStamp(staged, stamp) : staged),
      entities: { ...staged.entities, ...Object.fromEntries(bodies.map((body) => [body.entity.id, body.entity])) },
      order: [...doc.order, ...ids],
      exchange: { provenance: { ...doc.exchange?.provenance, ...Object.fromEntries(ids.map((id) => [id, record])) } },
    };
    const base = stepImportReport({
      ids,
      solids: bodies.map((body) => body.solid),
      imported: read,
      tolerance,
      options,
      doc,
      fileName: params.fileName,
      original: undefined,
      blobs: bodies.map((body) => body.blob.sha256),
    });
    const untranslated = Object.entries(summary.untranslated);
    const warnings = [
      ...base.warnings,
      ...(read.census.openShells > 0
        ? [
            {
              code: 'XCH_IGES_OPEN_SHELL' as const,
              severity: 'warn' as const,
              message: `${read.census.openShells} shell(s) did not close after sewing at ${read.sewingToleranceMm} mm`,
              entityIds: [],
              remediation: 'retry with a larger linear tolerance within limits (set_modeling_tolerance); open shells stay surfaces',
            },
          ]
        : []),
      ...(untranslated.length > 0
        ? [
            {
              code: 'XCH_IGES_UNTRANSLATED' as const,
              severity: 'warn' as const,
              message: `entity types no translator reads: ${untranslated.map(([name, count]) => `${name} x${count}`).join(', ')}`,
              entityIds: [],
              remediation: 'expected for annotation and property types; review the list',
            },
          ]
        : []),
    ];
    const reasons = ['iges_no_validation_properties', ...base.reviewRequired.reasons];
    const data = {
      report: { ...base, warnings, reviewRequired: { value: true, reasons } },
      iges: {
        global: summary.global,
        unitFactor: summary.global.mmPerUnit,
        entities: summary.entities,
        geometricEntities: summary.geometricEntities,
        census: summary.census,
        untranslated: summary.untranslated,
        openShells: read.census.openShells,
        sewingToleranceMm: read.sewingToleranceMm,
        diagonalMm: read.diagonalMm,
        policy: {
          sewingTolerance: {
            value: read.sewingToleranceMm,
            unit: 'mm',
            source: 'max(file resolution, 1e-6 x diagonal, document linear tolerance) — TECHNICAL_SPEC §5.5',
            defaulted: true,
          },
        },
      },
    };
    return {
      ...changed(
        document,
        `import_iges: ${bodies.length} exact solid${bodies.length === 1 ? '' : 's'} (${ids.join(', ')}) from ${summary.entities} IGES entities (${summary.geometricEntities} geometric), unit ${unit ?? 'unknown'}; ` +
          `sewn at ${Number(read.sewingToleranceMm.toPrecision(3))} mm, ${read.census.openShells} open shell(s), ${untranslated.length} untranslated type(s). Review required: IGES carries no validation properties.` +
          warnings.map((warning) => ` ${warning.code}: ${warning.message}.`).join(''),
        ids,
      ),
      data,
    };
  },
});

/**
 * @affects nothing — read-only
 * @invariant data.iges is IGES text; data.selfCheck re-reads it and compares total volume and area (provisional tolerance 1e-6 relative)
 * @failure no solids, no kernel, no IGES writer, a solid the kernel cannot build, self-check red -> no-op, no data
 */
export const exportIges = defineCommand({
  name: 'export_iges',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'Export 3D solids to IGES 5.3 from the exact kernel B-rep: mode brep (default) writes manifold solid B-rep objects (types 186 / 514 / 510 / 508 / 504 / 502), ' +
    'mode faces writes trimmed surfaces (144 + 128) for legacy CAM. Solids are written in world space (instances expanded) in the document unit (Global section ' +
    'carries the unit; numbers are not converted). The text is read back and its total volume and area are compared with the model (data.selfCheck, 1e-6 relative); a ' +
    'disagreement refuses the export (XCH_SELFCHECK_RED). Returns data: { format: "iges", iges (the file text), solidCount, entityIds, skipped, mode, unit, selfCheck }. ' +
    'Requires the OCC kernel with the IGES translator. Does not modify the document.',
  params: z.object({
    entityIds: z
      .array(z.string())
      .optional()
      .describe('Ids of the solids or instances to export. Omit or pass [] for every 3D solid of the document.'),
    mode: z
      .enum(['brep', 'faces'])
      .optional()
      .describe("'brep' (default): solid B-rep entities. 'faces': trimmed parametric surfaces for legacy CAM."),
    acceptUnverified: confirmExportControlled.describe(ACCEPT_UNVERIFIED),
    confirmExportControlled,
  }),
  run: (doc, { entityIds, mode, acceptUnverified, confirmExportControlled: confirmation }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_iges', 'step', confirmation, ctx);
    if (refused !== null) return refused;
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('export_iges'));
    const fail = (code: string, why: string, remediation: string): CommandResult =>
      rejection(doc, `export_iges: ${code} — ${why}; nothing was exported; no-op.`, commandError(code, remediation));
    if (kernel.writeExchange === undefined)
      return fail('XCH_WRITER_UNAVAILABLE', 'this kernel has no IGES writer', 'run on the desktop backend or with --kernel occt-native');
    const plan = planExchange(doc, kernel, entityIds, { structured: false, validation: true });
    if ('empty' in plan) return fail('XCH_NO_SOLIDS', 'nothing exportable', 'pass 3D solid ids (find_entities) or build solids first');
    if ('failed' in plan)
      return fail('XCH_NO_SOLIDS', `the kernel could not build ${plan.failed}`, 'check the entity with inspect_topology');
    const blocked = unverifiedGate(doc, plan, acceptUnverified, ctx, 'export_iges');
    if (blocked !== null) return gateResult(doc, blocked, 'export_iges');
    const written = plan.products.filter((product) => product.validation !== undefined);
    const text = kernel.writeExchange({
      format: 'iges',
      unit: doc.units,
      products: plan.products,
      occurrences: [],
      igesMode: mode ?? 'brep',
      header: { fileName: 'llull.igs', originatingSystem: 'llull', timestamp: '' },
    });
    if (text === null || text === '')
      return fail(
        'XCH_WRITER_UNAVAILABLE',
        'the kernel could not write IGES',
        'this build may lack the IGES translator; rebuild OCCT with build-occt.mjs',
      );
    const summary = summarizeIges(text);
    let selfCheck: {
      band: 'green' | 'red';
      volume?: { model: number; file: number };
      area?: { model: number; file: number };
      solids?: { model: number; file: number };
    } = { band: 'green' };
    if ((mode ?? 'brep') === 'brep' && kernel.importExchange !== undefined && written.length === plan.products.length) {
      const modelVolume = written.reduce((sum, product) => sum + (product.validation?.volume ?? 0), 0);
      const modelArea = written.reduce((sum, product) => sum + (product.validation?.area ?? 0), 0);
      const tolerance = modelingToleranceOf(doc);
      const back = kernel.importExchange('iges', text, {
        precision: tolerance.linear,
        maxTolerance: Math.max(0.1, tolerance.maxImportTolerance),
        heal: true,
        sew: true,
        fileResolutionMm: (summary.global.resolution ?? 0) * (summary.global.mmPerUnit ?? 1),
      });
      if (back === null || 'error' in back) selfCheck = { band: 'red' };
      else {
        const scale = MM_PER_UNIT[doc.units];
        let volume = 0;
        let area = 0;
        for (const solid of back.solids) {
          const blob = makeBlob('model/x-occt-brep', solid.brep);
          kernel.loadBlob?.(blob.sha256, solid.brep);
          const shape = kernel.evaluate({ op: 'brep', blob: blob.sha256, format: 'occt-brep-v1' });
          const mass = shape === null ? null : (kernel.massProperties?.(shape) ?? null);
          volume += (mass?.volume ?? 0) / scale ** 3;
          area += (mass?.area ?? 0) / scale ** 2;
        }
        const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), 1e-12);
        selfCheck = {
          band: close(modelVolume, volume) && close(modelArea, area) && back.solids.length >= 1 ? 'green' : 'red',
          volume: { model: modelVolume, file: volume },
          area: { model: modelArea, file: area },
          solids: { model: plan.products.length, file: back.solids.length },
        };
      }
      if (selfCheck.band === 'red')
        return fail(
          'XCH_SELFCHECK_RED',
          `the written IGES disagrees with the model after re-reading (${JSON.stringify(selfCheck)})`,
          'report a defect; do not deliver the file',
        );
    }
    const accepted = acceptedReasons(doc, plan);
    return report(
      doc,
      `export_iges: ${plan.solidCount} exact solid(s) from ${plan.entityIds.join(', ')} → IGES 5.3 ${mode ?? 'brep'}, unit ${doc.units}, ${summary.entities} entities, ${text.length} bytes; ` +
        `self-check ${selfCheck.band}${plan.skipped.length > 0 ? `; skipped ${plan.skipped.join(', ')}` : ''}.${accepted.length > 0 ? ` Review required: ${accepted.join(', ')}.` : ''}`,
      {
        format: 'iges',
        iges: text,
        mode: mode ?? 'brep',
        unit: doc.units,
        solidCount: plan.solidCount,
        entityIds: plan.entityIds,
        skipped: plan.skipped,
        entities: summary.entities,
        selfCheck,
        reviewRequired: { value: accepted.length > 0, reasons: accepted },
      },
    );
  },
});
