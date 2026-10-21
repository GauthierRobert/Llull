/** import_qif_results (M6, VC-PLM-24): QIF 3.0 MeasurementResults to FAI characteristic results. */

import { nextFreeId } from '@lib/id';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { FaiResult, FaiResultSet } from '@core/model/plm';
import { sha256Hex } from '@lib/sha256';
import { humanAct } from '../gate';
import { atSchema, bySchema, confirmationSchema } from '../params';
import { readQifResults } from '../qif/results';
import { SERIAL, sealResults, own } from '../records';
import { inRevision } from '../register';
import { refusePlm } from '../refusal';
import { withPlm } from '../revisions';
import { NOT_MANAGED } from '../state';

const MAX_UNMATCHED = 200;
const BALLOON = /^[1-9]\d{0,8}$/;

const nextSetId = (ids: readonly string[], revision: string): string =>
  nextFreeId(`FRS-${revision}`, (id) => ids.includes(id), { start: ids.length + 1 });

/**
 * @affects doc.plm.faiResults[id] (adds the measured results of one QIF file for one revision, with the SHA-256 of the exact file)
 * @invariant a human attests the import (signed over the exact params, the file included: an agent cannot enter passing results); the file is read without DOCTYPE / entities and within
 *   size, depth and element limits; a QIF characteristic item maps to a characteristic number by its Name (else its id) when that is a balloon number of this revision's register;
 *   the measuring system's status is stored as written, never recomputed; results that match no characteristic and characteristics without a result are listed, never guessed
 * @failure agent / no trusted signature -> PLM_HUMAN_GATE; not managed -> PLM_NOT_MANAGED; unknown revision -> PLM_REVISION_UNKNOWN; not QIF 3 / malformed / two results for one number /
 *   nothing matches the register -> PLM_QIF_INVALID; over a limit -> PLM_QIF_LIMIT; bad serial or id -> PLM_PARAM_INVALID; duplicate id -> PLM_ID_EXISTS (refusals, unchanged doc)
 */
export const importQifResults = defineCommand({
  name: 'import_qif_results',
  description:
    'Import the measured results of a QIF 3.0 file (MeasurementResults / MeasuredCharacteristics / CharacteristicMeasurements, ANSI/DMSC QIF 3.0) as the FAI ' +
    'results of one revision: each characteristic measurement is matched to a characteristic number of the register (assign_characteristic_ids) through the Name of its ' +
    'CharacteristicItem (the balloon number) or, when the file carries no items, its CharacteristicItemId; its Value, unit and Status (PASS, FAIL, ...) are stored as the ' +
    'measuring system wrote them (llull does not judge them). HUMAN GATE. The file is parsed safely: DOCTYPE and entities are refused, size (8 MB), nesting (48) and element count are ' +
    'limited. The result set keeps the SHA-256 of the exact file. Read it back with fai_report_skeleton { resultsId }. Matches and gaps are in the summary. Needs ' +
    '`confirmation` (plm_act_payload) over exactly these params, the file included: an agent gets PLM_HUMAN_GATE and hands over.',
  annotations: { metaHistory: true },
  params: z.object({
    xml: z.string().describe('The QIF 3.0 file text (UTF-8, at most 8 MB), e.g. the contents of a CMM results .qif / .xml file.'),
    revision: z.string().describe('Revision label of the managed item the results were measured against, e.g. "B".'),
    serial: z
      .string()
      .optional()
      .describe('Serial number of the unit measured (A-Z a-z 0-9 . _ - /), recorded on the result set and Form 1.'),
    id: z.string().optional().describe("Result set id; omitted = 'FRS-<revision>-<n>'."),
    confirmation: confirmationSchema,
    at: atSchema.optional(),
    by: bySchema.optional().describe('Ignored: the import is recorded under the signer of the confirmation.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'import_qif_results', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const gate = humanAct(doc, 'import_qif_results', params, ctx);
    if ('refusal' in gate) return gate.refusal;
    const { revision, serial, xml } = params;
    if (own(plm.item.revisions, revision) === undefined)
      return refusePlm(
        doc,
        'import_qif_results',
        'PLM_REVISION_UNKNOWN',
        `${plm.item.partNumber} has no revision '${revision}'`,
        [revision],
        ['revision'],
      );
    if (serial !== undefined && !SERIAL.test(serial))
      return refusePlm(doc, 'import_qif_results', 'PLM_PARAM_INVALID', `'${serial}' is not a serial number`, [serial], ['serial']);
    const existing = plm.faiResults ?? {};
    const id = params.id ?? nextSetId(Object.keys(existing), revision);
    if (Object.hasOwn(existing, id))
      return refusePlm(doc, 'import_qif_results', 'PLM_ID_EXISTS', `result set '${id}' already exists`, [id]);
    const read = readQifResults(xml);
    if (!read.ok) return refusePlm(doc, 'import_qif_results', read.code, read.message, [], ['xml']);
    const register = new Map(
      Object.values(plm.characteristics ?? {})
        .filter((c) => inRevision(plm, c, revision))
        .map((c) => [c.charNo, c] as const),
    );
    const results: FaiResult[] = [];
    const unmatched: string[] = [];
    for (const measurement of read.measurements) {
      const name = read.itemNames.get(measurement.itemId) ?? measurement.itemId;
      const charNo = BALLOON.test(name) ? Number(name) : undefined;
      if (charNo === undefined || !register.has(charNo)) {
        unmatched.push(
          `${measurement.element} ${measurement.qifId === '' ? '' : `${measurement.qifId} `}(item ${measurement.itemId}, name '${name.slice(0, 40)}')`,
        );
        continue;
      }
      if (results.some((result) => result.charNo === charNo))
        return refusePlm(
          doc,
          'import_qif_results',
          'PLM_QIF_INVALID',
          `two measurements carry characteristic ${charNo}; import one part's results per file`,
          [],
          ['xml'],
        );
      results.push({
        charNo,
        status: measurement.status,
        ...(measurement.value !== undefined ? { value: measurement.value } : {}),
        ...(measurement.maxValue !== undefined ? { maxValue: measurement.maxValue } : {}),
        ...(measurement.unit !== undefined ? { unit: measurement.unit } : {}),
        source: { element: measurement.element, qifId: measurement.qifId },
      });
    }
    if (results.length === 0)
      return refusePlm(
        doc,
        'import_qif_results',
        'PLM_QIF_INVALID',
        `none of the ${read.measurements.length} measurement(s) matches a characteristic of revision ${revision} (assign_characteristic_ids first; the QIF item Name must be the balloon number)`,
        [revision],
        ['xml'],
      );
    results.sort((a, b) => a.charNo - b.charNo);
    const missing = [...register.keys()].filter((charNo) => !results.some((result) => result.charNo === charNo)).sort((a, b) => a - b);
    const set: FaiResultSet = sealResults({
      id,
      revision,
      ...(serial !== undefined ? { serial } : {}),
      source: { format: 'QIF 3.0 MeasurementResults', sha256: sha256Hex(xml), bytes: new TextEncoder().encode(xml).length },
      results,
      unmatched: unmatched.slice(0, MAX_UNMATCHED),
      missing,
      importedBy: gate.signer,
      ...(params.at !== undefined ? { at: params.at } : {}),
    });
    const failed = results.filter((result) => result.status === 'FAIL').length;
    return changed(
      withPlm(doc, { ...plm, faiResults: { ...existing, [id]: set } }),
      `QIF results ${id} imported for ${plm.item.partNumber} rev ${revision}: ${results.length} characteristic(s) matched (${failed} FAIL), ${unmatched.length} unmatched, ${missing.length} without a result; file sha256 ${set.source.sha256.slice(0, 12)}….`,
      [],
    );
  },
});
