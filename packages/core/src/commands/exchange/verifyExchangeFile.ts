/**
 * verify_exchange_file (aerospace 04 XCH M3, TR-XCH-21): what an AP203 / AP214 / AP242 or IGES file says about itself, and (with an exact kernel) whether
 * its embedded geometric validation properties agree with the geometry. Read-only; the document is not touched.
 */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { commandError, rejection, report } from '../noop';
import { base64ToText } from '../../lib/base64';
import { summarizeStep21 } from '../../lib/step21/summary';
import { summarizeIges } from '../../lib/iges/summary';
import { makeBlob } from '../../model/blobs';
import { modelingToleranceOf } from '../../model/kernelSettings';
import type { GvpBand } from '../../model/exchange';
import type { GeometryKernel } from '../../geometry/kernel';
import type { ImportedExchange } from '../../geometry/kernelExchange';
import type { ExactMassProperties } from '../../geometry/kernelPorts';
import { type FileGvpGroup, groupFileGvp } from './fileGvp';
import { gvpPolicy } from './gvpBands';
import { simplifyTree } from './importSimplify';
import { type ProductVerification, overallBand, verifyImportedProducts } from './importVerify';

const MAX_TEXT = 64 * 1024 * 1024;

interface Issue {
  readonly code: string;
  readonly severity: 'fail' | 'warn' | 'info';
  readonly productKey?: string;
  readonly property?: string;
  readonly remediation: string;
  readonly message: string;
}

const KNOWN_SCHEMA = /(CONFIG_CONTROL_DESIGN|AUTOMOTIVE_DESIGN|AP203|AP214|AP242|MANAGED_MODEL_BASED|10303\s+(203|214|442))/i;

const looksLikeIges = (text: string): boolean => /^.{72}S\s*\d+\s*$/m.test(text) && !text.trimStart().startsWith('ISO-10303-21');

type Recomputed =
  | { readonly tree: ImportedExchange; readonly masses: readonly (ExactMassProperties | null)[] }
  | { readonly error: string; readonly detail: string }
  | null;

function recompute(kernel: GeometryKernel, text: string, tolerance: { linear: number; maxImportTolerance: number }): Recomputed {
  const tree = kernel.importExchange?.('step', text, {
    precision: tolerance.linear,
    maxTolerance: Math.max(0.1, tolerance.maxImportTolerance),
    heal: true,
    sew: true,
  });
  if (tree === undefined || tree === null) return null;
  if ('error' in tree) return tree;
  if (!('products' in tree)) return null;
  const masses = tree.solids.map((solid) => {
    const blob = makeBlob('model/x-occt-brep', solid.brep);
    kernel.loadBlob?.(blob.sha256, solid.brep);
    const shape = kernel.evaluate({ op: 'brep', blob: blob.sha256, format: 'occt-brep-v1' });
    return shape === null ? null : (kernel.massProperties?.(shape) ?? null);
  });
  return { tree, masses };
}

const issueOf = (verification: ProductVerification): Issue | null => {
  const band = verification.check.band;
  const worst = verification.check.comparisons.filter((entry) => entry.band === band);
  const detail = worst.map((entry) => `${entry.property} delta ${entry.delta.toPrecision(3)}`).join(', ');
  if (band === 'yellow')
    return {
      code: 'XCH_GVP_YELLOW',
      severity: 'warn',
      productKey: verification.name,
      message: `validation properties deviate from the sender's (${detail})`,
      remediation: 'report the numbers to the owner; continue only if the owner accepts the deviation',
    };
  if (band === 'red')
    return {
      code: 'XCH_GVP_RED',
      severity: 'fail',
      productKey: verification.name,
      message: `validation properties disagree with the sender's beyond the yellow limit (${detail})`,
      remediation: 'do not deliver; a qualified reviewer decides',
    };
  return null;
};

/**
 * @affects nothing — read-only
 * @invariant data = { format, schemaName, fileUnit, unitFactor, census, embeddedGvp[], products[], band, issues[], unverified, reviewRequired, policy };
 *   without a kernel only the file's own claims are reported (band 'not-checkable'); lengths of recomputed values are millimetres
 * @failure empty or non-STEP / non-IGES text -> no-op, error.code KRN_STEP_UNREADABLE; unreadable by the kernel -> issue, no band
 */
export const verifyExchangeFile = defineCommand({
  name: 'verify_exchange_file',
  annotations: { readOnly: true },
  description:
    'Verify a STEP (AP203 / AP214 / AP242) or IGES file before using it: file schema, length unit with its exact factor to millimetres (25.4 for inch), entity census ' +
    '(PMI, tessellation, B-rep and assembly types for STEP; entity types and untranslated types for IGES) and the geometric validation properties the sender embedded ' +
    '(volume, surface area, centre point per product, converted to millimetres). With the exact OCC kernel the file is also imported (nothing is stored) and the ' +
    'embedded properties are compared with the recomputed ones per product: band green (<= 1e-3 relative) / yellow (<= 1e-2 and 1 mm) / red / not-checkable (sender ' +
    'gave none or all zero). Without a kernel only the file claims are reported. Returns data.issues[] with XCH_* codes and a remediation each. Give the file as text or ' +
    'stepBase64 (IGES too). Does not modify the document.',
  params: z.object({
    text: z.string().max(MAX_TEXT).optional().describe('The file content (Part 21 or IGES text). Give exactly one of text or stepBase64.'),
    stepBase64: z
      .string()
      .max(Math.ceil((MAX_TEXT * 4) / 3) + 4)
      .optional()
      .describe('The file bytes, base64 encoded (ASCII text). Give exactly one of text or stepBase64.'),
    format: z.enum(['step', 'iges']).optional().describe('File format. Default: detected from the content.'),
    fileName: z.string().optional().describe('Original file name, echoed in the report.'),
    gvpPolicy: z
      .object({
        greenRel: z.number().optional().describe('Largest relative volume / area difference still green. Default 1e-3.'),
        yellowRel: z.number().optional().describe('Largest relative difference still yellow. Default 1e-2.'),
        greenCentroidPerDiag: z
          .number()
          .optional()
          .describe('Green centroid distance as a fraction of the bounding-box diagonal. Default 1e-3.'),
        yellowCentroidMm: z.number().optional().describe('Largest centroid distance still yellow, in millimetres. Default 1.'),
      })
      .optional()
      .describe('Band limits; each omitted limit keeps its default.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    if ((params.text === undefined) === (params.stepBase64 === undefined))
      return rejection(
        doc,
        'verify_exchange_file: give exactly one of text or stepBase64; no-op.',
        commandError('CMD_INVALID_PARAMS', 'pass the file as text or stepBase64, not both', [], ['text', 'stepBase64']),
      );
    const text = params.text ?? base64ToText(params.stepBase64 ?? '');
    if (text === null || text.trim() === '')
      return rejection(
        doc,
        'verify_exchange_file: KRN_STEP_UNREADABLE — empty or undecodable content; no-op.',
        commandError('KRN_STEP_UNREADABLE', 'check the file (size, truncated?) and pass its text or base64 bytes', [], ['text']),
      );
    const format = params.format ?? (looksLikeIges(text) ? 'iges' : 'step');
    const issues: Issue[] = [];
    if (format === 'iges') {
      const iges = summarizeIges(text);
      if (!iges.valid)
        return rejection(
          doc,
          'verify_exchange_file: KRN_STEP_UNREADABLE — not a complete IGES file (no Terminate section or no entities); no-op.',
          commandError('KRN_STEP_UNREADABLE', 'check the file (truncated? 80-column fixed format)', [], ['text']),
        );
      if (iges.global.mmPerUnit === null)
        issues.push({
          code: 'XCH_UNIT_UNKNOWN',
          severity: 'warn',
          message: 'the Global section names no recognised length unit',
          remediation: 'ask the sender for the unit',
        });
      const untranslated = Object.entries(iges.untranslated);
      if (untranslated.length > 0)
        issues.push({
          code: 'XCH_IGES_UNTRANSLATED',
          severity: 'warn',
          message: `entity types a translator ignores: ${untranslated.map(([name, count]) => `${name} x${count}`).join(', ')}`,
          remediation: 'expected for annotation and property types; review the list',
        });
      const data = {
        format: 'iges' as const,
        fileName: params.fileName,
        fileUnit: iges.global.unitName === null ? null : { name: iges.global.unitName, mmPerUnit: iges.global.mmPerUnit },
        unitFactor: iges.global.mmPerUnit,
        global: iges.global,
        entities: iges.entities,
        geometricEntities: iges.geometricEntities,
        census: iges.census,
        untranslated: iges.untranslated,
        band: 'not-checkable' as GvpBand,
        issues,
        unverified: { value: true, reasons: ['verify_skipped'] },
        reviewRequired: { value: untranslated.length > 0, reasons: untranslated.length > 0 ? ['untranslated_entities'] : [] },
      };
      return report(
        doc,
        `verify_exchange_file: IGES, ${iges.entities} entities (${iges.geometricEntities} geometric), unit ${data.fileUnit?.name ?? 'unknown'}${data.unitFactor === null ? '' : ` (${data.unitFactor} mm)`}, ` +
          `${untranslated.length} untranslated type${untranslated.length === 1 ? '' : 's'}.`,
        data,
      );
    }
    if (!text.includes('ISO-10303-21') && !text.includes('DATA;'))
      return rejection(
        doc,
        'verify_exchange_file: KRN_STEP_UNREADABLE — not an ISO 10303-21 file; no-op.',
        commandError('KRN_STEP_UNREADABLE', 'check the file is STEP Part 21 text (or pass format: iges)', [], ['text']),
      );
    const summary = summarizeStep21(text);
    const policy = gvpPolicy(params.gvpPolicy);
    if (summary.fileSchema === null || !KNOWN_SCHEMA.test(summary.fileSchema))
      issues.push({
        code: 'XCH_SCHEMA_UNKNOWN',
        severity: 'warn',
        message: `FILE_SCHEMA '${summary.fileSchema ?? 'absent'}' is not AP203 / AP214 / AP242`,
        remediation: 'import is attempted; check the result with this command',
      });
    if (summary.lengthUnit === null || !Number.isFinite(summary.lengthUnit.mmPerUnit))
      issues.push({
        code: 'XCH_UNIT_UNKNOWN',
        severity: 'warn',
        message: 'the file names no recognisable length unit',
        remediation: 'validation properties are not compared; ask the sender for the unit',
      });
    const groups: FileGvpGroup[] = groupFileGvp(summary, 1);
    for (const group of groups)
      if (group.placeholder && group.product !== null)
        issues.push({
          code: 'XCH_GVP_NOT_CHECKABLE',
          severity: 'warn',
          productKey: group.product,
          message: 'the sender embedded an all-zero placeholder validation property',
          remediation: 'ask the sender for real validation properties or proceed with review',
        });
    const kernel = (ctx ?? currentContext()).kernel;
    let verifications: ProductVerification[] | null = null;
    let kernelNote: string | null = null;
    if (kernel?.importExchange !== undefined) {
      const recomputed = recompute(kernel, text, modelingToleranceOf(doc));
      if (recomputed === null) kernelNote = 'the kernel could not read the file';
      else if ('error' in recomputed) kernelNote = `the kernel refused the file: ${recomputed.error} — ${recomputed.detail}`;
      else {
        verifications = verifyImportedProducts(simplifyTree(recomputed.tree), recomputed.masses, summary, policy);
        for (const verification of verifications) {
          const issue = issueOf(verification);
          if (issue !== null) issues.push(issue);
        }
      }
      if (kernelNote !== null)
        issues.push({
          code: 'KRN_STEP_UNREADABLE',
          severity: 'fail',
          message: kernelNote,
          remediation: 'check the file and the kernel (kernel_info)',
        });
    }
    const band: GvpBand =
      verifications === null ? 'not-checkable' : overallBand(verifications.filter((entry) => !(entry.check.band === 'not-checkable')));
    const unverified = band === 'red' || band === 'not-checkable';
    const data = {
      format: 'step' as const,
      fileName: params.fileName,
      schemaName: summary.fileSchema,
      fileUnit: summary.lengthUnit,
      unitFactor: summary.lengthUnit !== null && Number.isFinite(summary.lengthUnit.mmPerUnit) ? summary.lengthUnit.mmPerUnit : null,
      census: summary.entityCensus,
      products: summary.products,
      embeddedGvp: groups.map((group) => ({
        product: group.product,
        target: group.target,
        volumeMm3: group.volume,
        areaMm2: group.area,
        centroidMm: group.centroid,
        placeholder: group.placeholder,
      })),
      validationPropertyCounts: summary.validationPropertyCounts,
      recomputed:
        verifications === null
          ? null
          : verifications.map((entry) => ({
              product: entry.name,
              band: entry.check.band,
              recomputed: entry.recomputed,
              comparisons: entry.check.comparisons,
            })),
      band,
      issues,
      unverified: {
        value: unverified,
        reasons:
          verifications === null
            ? ['verify_skipped']
            : band === 'red'
              ? ['import_gvp_red']
              : band === 'not-checkable'
                ? ['import_gvp_not_checkable']
                : [],
      },
      reviewRequired: { value: band !== 'green', reasons: band === 'green' ? [] : [`gvp_${band.replace('-', '_')}`] },
      policy,
    };
    return report(
      doc,
      `verify_exchange_file: ${summary.fileSchema ?? 'unknown schema'}, ${summary.products.length} product(s), unit ${summary.lengthUnit?.name ?? 'unknown'}${data.unitFactor === null ? '' : ` (${data.unitFactor} mm)`}, ` +
        `${summary.geometricValidationProperties.length} embedded geometric validation propert${summary.geometricValidationProperties.length === 1 ? 'y' : 'ies'}; ` +
        `${verifications === null ? `not compared (${kernelNote ?? 'no exact kernel'})` : `band ${band}`}; ${issues.length} issue(s).`,
      data,
    );
  },
});
