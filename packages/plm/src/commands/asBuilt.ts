/** As-built records per serial (FR-PLM-28, VC-PLM-14): what was installed where it differs from the as-designed baseline, and the comparison. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { AsBuiltDeviation, AsBuiltRecord } from '@core/model/plm';
import { PART_NUMBER } from '../document';
import { humanAct } from '../gate';
import { atSchema, bySchema, confirmationSchema } from '../params';
import { refusePlm } from '../refusal';
import { SERIAL, isSealed, sealAsBuilt } from '../records';
import { withPlm } from '../revisions';
import { REVISION_LABEL } from '../schemes';
import { NOT_MANAGED } from '../state';
import { membersHash } from '../structure';

const MAX_AUTHORITY = 200;
const MAX_DEVIATIONS = 500;

/**
 * @affects doc.plm.asBuilt[serial] (adds one sealed record: the baseline the serial was designed to, the part revisions installed where they differ, and the authority for each)
 * @invariant a human attests what is installed (signed over exactly these params, so an agent cannot declare a unit conforming or waive a deviation); a record is never edited or removed
 *   (a hand edit breaks its seal on load); every deviation names a baseline member, a revision different from the baselined one and a non-empty authority
 * @failure agent / no trusted signature -> PLM_HUMAN_GATE; not managed -> PLM_NOT_MANAGED; unknown baseline -> PLM_BASELINE_UNKNOWN; baseline hash broken -> PLM_INTEGRITY_MISMATCH;
 *   serial already recorded -> PLM_ID_EXISTS; bad serial / part number / revision / authority, a deviation on a part outside the baseline, one that equals the baselined revision or
 *   a duplicate, an unknown mbom -> PLM_PARAM_INVALID (refusals, unchanged doc)
 */
export const recordAsBuilt = defineCommand({
  name: 'record_as_built',
  description:
    'HUMAN GATE. Record what was built for one serial number: the product baseline it was designed to (create_baseline) and the deviations from it, each ' +
    '{ partNumber (a member of the baseline), installedRevision (a revision label different from the baselined one), authority (the request for variance / waiver ' +
    'that allowed it, non-empty) }. An empty deviations list records a unit built exactly to the baseline. Optionally names the manufacturing BOM it was built ' +
    'from (create_mbom, same baseline). The record is sealed with a SHA-256 and never edited. Needs `confirmation` (plm_act_payload) over exactly these params: ' +
    'an agent prepares the data and hands over (PLM_HUMAN_GATE). Compare with as_built_vs_as_designed.',
  annotations: { metaHistory: true },
  params: z.object({
    serial: z.string().describe('Serial number of the unit (A-Z a-z 0-9 . _ - /, at most 64 characters), e.g. "SN-0007".'),
    partNumber: z.string().describe("Part number of the unit's end item: this document's managed item."),
    asDesignedBaseline: z.string().describe('Id of the product baseline (create_baseline) the unit was designed to, e.g. "BL-PBL-0003".'),
    mbom: z
      .string()
      .optional()
      .describe('Id of the manufacturing BOM (create_mbom) the unit was built from; its baseline must be asDesignedBaseline.'),
    deviations: z
      .array(
        z.object({
          partNumber: z.string().describe('Part number of a member of the baseline that was installed differently.'),
          installedRevision: z
            .string()
            .describe('Revision label actually installed (1-16 of A-Z, 0-9, -); must differ from the baselined revision.'),
          authority: z.string().describe('The authority that allowed the deviation, e.g. "RFV-0012 (request for variance, use-as-is)".'),
        }),
      )
      .describe('Deviations from the baseline; [] = built to the baseline.'),
    confirmation: confirmationSchema,
    at: atSchema.optional(),
    by: bySchema.optional().describe('Ignored: the record is kept under the signer of the confirmation.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'record_as_built', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const gate = humanAct(doc, 'record_as_built', params, ctx);
    if ('refusal' in gate) return gate.refusal;
    const { serial, partNumber, asDesignedBaseline, deviations } = params;
    const invalid = (message: string, path: string, ids: readonly string[] = [serial]): CommandResult =>
      refusePlm(doc, 'record_as_built', 'PLM_PARAM_INVALID', message, ids, [path]);
    if (!SERIAL.test(serial)) return invalid(`'${serial}' is not a serial number (A-Z a-z 0-9 . _ - /, 1-64 characters)`, 'serial');
    if (partNumber !== plm.item.partNumber)
      return invalid(`this document manages ${plm.item.partNumber}, not ${partNumber}`, 'partNumber', [partNumber]);
    const baseline = plm.baselines?.[asDesignedBaseline];
    if (baseline === undefined)
      return refusePlm(
        doc,
        'record_as_built',
        'PLM_BASELINE_UNKNOWN',
        `unknown baseline '${asDesignedBaseline}'`,
        [asDesignedBaseline],
        ['asDesignedBaseline'],
      );
    if (baseline.hash !== membersHash(baseline.members))
      return refusePlm(
        doc,
        'record_as_built',
        'PLM_INTEGRITY_MISMATCH',
        `baseline ${asDesignedBaseline} no longer hashes to its recorded hash`,
        [asDesignedBaseline],
      );
    if (plm.asBuilt?.[serial] !== undefined)
      return refusePlm(
        doc,
        'record_as_built',
        'PLM_ID_EXISTS',
        `serial ${serial} already has an as-built record (records are never edited)`,
        [serial],
      );
    if (params.mbom !== undefined && plm.mbom?.[params.mbom]?.baseline !== asDesignedBaseline)
      return invalid(`mbom '${params.mbom}' does not exist or was not made from ${asDesignedBaseline}`, 'mbom', [serial, params.mbom]);
    if (deviations.length > MAX_DEVIATIONS) return invalid(`at most ${MAX_DEVIATIONS} deviations per record`, 'deviations');
    const seen = new Set<string>();
    for (const [index, deviation] of deviations.entries()) {
      const at = `deviations[${index}]`;
      const member = baseline.members.find((candidate) => candidate.partNumber === deviation.partNumber);
      if (!PART_NUMBER.test(deviation.partNumber) || member === undefined)
        return invalid(`${at}: '${deviation.partNumber}' is not a member of baseline ${asDesignedBaseline}`, `${at}.partNumber`, [
          serial,
          deviation.partNumber,
        ]);
      if (!REVISION_LABEL.test(deviation.installedRevision))
        return invalid(`${at}: '${deviation.installedRevision}' is not a revision label`, `${at}.installedRevision`);
      if (deviation.installedRevision === member.revision)
        return invalid(
          `${at}: ${deviation.partNumber} rev ${member.revision} is the baselined revision, not a deviation`,
          `${at}.installedRevision`,
        );
      if (deviation.authority.trim() === '' || deviation.authority.length > MAX_AUTHORITY)
        return invalid(`${at}: authority must be 1-${MAX_AUTHORITY} characters`, `${at}.authority`);
      if (seen.has(deviation.partNumber)) return invalid(`${at}: ${deviation.partNumber} is listed twice`, `${at}.partNumber`);
      seen.add(deviation.partNumber);
    }
    const record = sealAsBuilt({
      serial,
      partNumber,
      asDesignedBaseline,
      ...(params.mbom !== undefined ? { mbom: params.mbom } : {}),
      deviations: deviations.map(
        (d): AsBuiltDeviation => ({ partNumber: d.partNumber, installedRevision: d.installedRevision, authority: d.authority }),
      ),
      ...(params.at !== undefined ? { at: params.at } : {}),
      by: gate.signer,
    });
    return changed(
      withPlm(doc, { ...plm, asBuilt: { ...plm.asBuilt, [serial]: record } }),
      `As-built ${serial} (${partNumber}) recorded against ${asDesignedBaseline}: ${deviations.length} deviation(s), by ${gate.signer}.`,
      [],
    );
  },
});

/**
 * @affects nothing (read-only)
 * @invariant differences are exactly the deviations whose installed revision differs from the baselined revision, by part number, with the recorded authority; a record that no longer hashes to its seal is reported, not trusted
 * @failure not managed -> PLM_NOT_MANAGED; unknown serial -> PLM_SERIAL_UNKNOWN; unknown baseline -> PLM_BASELINE_UNKNOWN (refusals)
 */
export const asBuiltVsAsDesigned = defineCommand({
  name: 'as_built_vs_as_designed',
  description:
    'Compare the as-built record of one serial with the product baseline it was designed to. Returns data { serial, baseline, conforming, differences: [{ partNumber, asDesigned, ' +
    'asBuilt, authority }], sealOk, mbom }: conforming is true when no installed revision differs from the baselined one; sealOk is false when the record was edited by hand ' +
    '(do not rely on it then). Read-only.',
  annotations: { readOnly: true },
  params: z.object({ serial: z.string().describe('Serial number with an as-built record (record_as_built).') }),
  run: (doc, { serial }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'as_built_vs_as_designed', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const record: AsBuiltRecord | undefined = plm.asBuilt?.[serial];
    if (record === undefined)
      return refusePlm(
        doc,
        'as_built_vs_as_designed',
        'PLM_SERIAL_UNKNOWN',
        `no as-built record for serial '${serial}'`,
        [serial],
        ['serial'],
      );
    const baseline = plm.baselines?.[record.asDesignedBaseline];
    if (baseline === undefined)
      return refusePlm(doc, 'as_built_vs_as_designed', 'PLM_BASELINE_UNKNOWN', `unknown baseline '${record.asDesignedBaseline}'`, [
        record.asDesignedBaseline,
      ]);
    const differences = record.deviations.flatMap((deviation) => {
      const member = baseline.members.find((candidate) => candidate.partNumber === deviation.partNumber);
      if (member === undefined || member.revision === deviation.installedRevision) return [];
      return [
        {
          partNumber: deviation.partNumber,
          asDesigned: member.revision,
          asBuilt: deviation.installedRevision,
          authority: deviation.authority,
        },
      ];
    });
    const sealOk = isSealed(record);
    return report(
      doc,
      `${serial} vs ${record.asDesignedBaseline}: ${differences.length === 0 ? 'conforming' : `${differences.length} difference(s)`}${sealOk ? '' : '; the record does not hash to its seal (edited by hand)'}.`,
      { serial, baseline: record.asDesignedBaseline, conforming: differences.length === 0, differences, sealOk, mbom: record.mbom ?? null },
    );
  },
});
