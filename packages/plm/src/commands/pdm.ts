/** export_step_pdm (M6, VC-PLM-24): the configuration data of a revision as AP242 PDM entities in an ISO 10303-21 file, read back and compared. */

import type { CommandResult } from '@core/commands/types';
import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import { exportRefusal, report } from '@core/commands/noop';
import { jcsJson } from '@lib/jcs';
import { refusePlm } from '../refusal';
import { NOT_MANAGED } from '../state';
import { pdmModelOf } from '../pdm/model';
import { readPdm } from '../pdm/read';
import { PDM_SCHEMA, writePdm } from '../pdm/write';
import { unmanagedComponents } from '../structure';
import { own } from '../records';

/** Timestamp of the header when the host passes none: a fixed instant, so the same document always yields the same bytes. */
const EPOCH_TIMESTAMP = '1970-01-01T00:00:00';
const DEFAULT_ORGANIZATION = { id: 'llull', name: 'llull local installation' };

/** The top-level members of two models that differ (for the self-check finding). */
function differences(written: Record<string, unknown>, read: Record<string, unknown>): string[] {
  return Object.keys(written).filter((key) => jcsJson(written[key]) !== jcsJson(read[key]));
}

/**
 * @affects nothing (read-only)
 * @invariant data.step holds the product, its version history, the design view, the structure with quantities, approvals, release approval, export-control classification, date effectivity
 *   and the llull properties (signatures, serial / msn / lot ranges, lifecycle state, hashes) of one revision; the text is read back by an independent reader and compared member by member
 *   (data.selfCheck), and a red check exports nothing; deterministic for equal input (default header time is the epoch)
 * @failure not managed -> PLM_NOT_MANAGED; unknown revision or mbom -> PLM_REVISION_UNKNOWN / PLM_MBOM_UNKNOWN; controlled materials without the human confirmation -> MAT_EXPORT_CONTROLLED / MAT_HUMAN_GATE;
 *   read-back differs from the model -> PLM_PDM_SELFCHECK_RED (refusals, nothing exported)
 */
export const exportStepPdm = defineCommand({
  name: 'export_step_pdm',
  annotations: { readOnly: true },
  description:
    'Export the configuration data (PDM) of one revision of the managed item to STEP AP242 (ISO 10303-21), following the CAx-IF / PDM-IF "Usage Guide for the STEP PDM Schema": ' +
    'PRODUCT (part number, name, id owner organization, category part / assembly or detail), one PRODUCT_DEFINITION_FORMATION per revision up to the exported one linked by a sequence ' +
    'relationship, the design view, the structure of a frozen revision as NEXT_ASSEMBLY_USAGE_OCCURRENCE (quantified when more than one), the recorded approvals and the release as ' +
    'APPROVAL with person / organization and date and time, the export-control marking as SECURITY_CLASSIFICATION, date effectivity as a general validity period, and optionally a manufacturing ' +
    'view (mbom). What the PDM schema has no place for is written as named llull properties: the Ed25519 release signatures, serial / msn / lot effectivity ranges, the lifecycle state and the ' +
    'content / package hashes. No geometry is written (use export_step_ap242 for the shape). The text is read back with an independent reader and compared with the model (data.selfCheck); ' +
    'a red check exports nothing. Returns data { format, step, schema, schemaName, partNumber, revision, state, counts, warnings, selfCheck }. The file is data, not authority: the signature ' +
    'bytes are in it, verify them with llull release verify. Read-only.',
  params: z.object({
    revision: z
      .string()
      .optional()
      .describe('Revision label to export; default = the current revision. A revision that is not released is exported with a warning.'),
    mbom: z.string().optional().describe('Id of a manufacturing BOM (create_mbom) to add as a manufacturing view of the same version.'),
    organization: z
      .object({
        id: z.string().min(1).describe('Organization id (the id owner of the part number), e.g. a CAGE code.'),
        name: z.string().min(1).describe('Organization name.'),
      })
      .optional()
      .describe(
        'The organization that owns the part number. Default { id "llull", name "llull local installation" } with a warning: set your own.',
      ),
    fileName: z.string().optional().describe('File name recorded in the Part 21 header; default llull-pdm.stp.'),
    timestamp: z
      .string()
      .optional()
      .describe('ISO 8601 time recorded in the header; default 1970-01-01T00:00:00 so the output is reproducible.'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_step_pdm', 'step', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'export_step_pdm', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const label = params.revision ?? plm.item.currentRevision;
    if (own(plm.item.revisions, label) === undefined)
      return refusePlm(
        doc,
        'export_step_pdm',
        'PLM_REVISION_UNKNOWN',
        `${plm.item.partNumber} has no revision '${label}'`,
        [label],
        ['revision'],
      );
    if (params.mbom !== undefined && own(plm.mbom, params.mbom) === undefined)
      return refusePlm(doc, 'export_step_pdm', 'PLM_MBOM_UNKNOWN', `unknown MBOM '${params.mbom}'`, [params.mbom], ['mbom']);
    const mbomRecord = params.mbom === undefined ? undefined : own(plm.mbom, params.mbom);
    const baselineRoot =
      mbomRecord === undefined
        ? undefined
        : own(plm.baselines, mbomRecord.baseline)?.members.find((member) => member.partNumber === plm.item.partNumber)?.revision;
    if (mbomRecord !== undefined && baselineRoot !== label)
      return refusePlm(
        doc,
        'export_step_pdm',
        'PLM_PARAM_INVALID',
        `MBOM '${mbomRecord.id}' was made from baseline ${mbomRecord.baseline} (rev ${baselineRoot ?? '?'} of ${plm.item.partNumber}), not rev ${label}`,
        [mbomRecord.id, label],
        ['mbom'],
      );
    const organization = params.organization ?? DEFAULT_ORGANIZATION;
    const model = pdmModelOf(doc, plm, label, { organization, ...(params.mbom !== undefined ? { mbom: params.mbom } : {}) });
    if (typeof model === 'string') return refusePlm(doc, 'export_step_pdm', 'PLM_REVISION_UNKNOWN', model, [label]);
    const step = writePdm(model, { fileName: params.fileName ?? 'llull-pdm.stp', timestamp: params.timestamp ?? EPOCH_TIMESTAMP });
    const read = readPdm(step);
    const differing =
      typeof read === 'string'
        ? ['(file)']
        : differences(model as unknown as Record<string, unknown>, read as unknown as Record<string, unknown>);
    if (differing.length > 0)
      return refusePlm(
        doc,
        'export_step_pdm',
        'PLM_PDM_SELFCHECK_RED',
        `the written file does not read back as the model: ${typeof read === 'string' ? read : differing.join(', ')}`,
        [label],
      );
    const warnings: string[] = [];
    if (params.organization === undefined)
      warnings.push('organization_not_set: the id owner is the default "llull" organization; pass organization { id, name }');
    if (model.state !== 'released' && model.state !== 'superseded')
      warnings.push(`revision_not_released: ${plm.item.partNumber} rev ${label} is ${model.state}`);
    const unplaced = Object.values(plm.subItems ?? {}).filter((sub) => !model.structure.some((row) => row.partNumber === sub.partNumber));
    if (unplaced.length > 0)
      warnings.push(
        `sub_items_not_written: ${unplaced.map((sub) => sub.partNumber).join(', ')} (no instance in the structure of rev ${label})`,
      );
    const unmanaged = unmanagedComponents(doc, plm);
    if (label === plm.item.currentRevision && unmanaged.length > 0)
      warnings.push(`components_without_part_number: ${unmanaged.map((c) => c.componentId).join(', ')}`);
    if (model.unitEffectivity.length > 0)
      warnings.push(
        'unit_effectivity_as_property: serial / msn / lot ranges are written as an llull property (the practice has no general-validity place for them)',
      );
    const lines = step.split('\n').length;
    return report(
      doc,
      `${plm.item.partNumber} rev ${label} exported as AP242 PDM: ${model.revisions.length} version(s), ${model.structure.length} structure row(s), ${model.approvals.length} approval(s), ${model.signatures.length} signature(s), ${lines} lines; read-back identical.`,
      {
        format: 'step',
        step,
        schema: 'ap242',
        schemaName: PDM_SCHEMA.split(' ')[0],
        partNumber: plm.item.partNumber,
        revision: label,
        state: model.state,
        counts: {
          versions: model.revisions.length,
          structureRows: model.structure.length,
          mbomLines: model.mbom?.lines.length ?? 0,
          approvals: model.approvals.length,
          signatures: model.signatures.length,
          dateEffectivity: model.dateEffectivity.length,
          unitEffectivity: model.unitEffectivity.length,
        },
        warnings,
        selfCheck: { ok: true, compared: Object.keys(model).length, differences: [] },
      },
    );
  },
});
