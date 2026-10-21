/** Manufacturing BOM (M6, FR-PLM-28): the engineering BOM of a product baseline made buildable, frozen with a hash, and its difference from the EBOM. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { MbomLine, MbomOmission, MbomRecord } from '@core/model/plm';
import { PART_NUMBER } from '../document';
import { atSchema, bySchema } from '../params';
import { refusePlm } from '../refusal';
import { byPartNumber, frozenQuantity, isSealed, sealMbom, own } from '../records';
import { withPlm } from '../revisions';
import { NOT_MANAGED } from '../state';
import { membersHash } from '../structure';

const nextMbomId = (ids: readonly string[]): string => {
  let n = ids.length + 1;
  while (ids.includes(`MBOM-${String(n).padStart(4, '0')}`)) n += 1;
  return `MBOM-${String(n).padStart(4, '0')}`;
};

const reasonSchema = z.string().describe('Why, non-empty: it is kept in the MBOM (e.g. "supplied as a kit", "design-only item").');

/**
 * @affects doc.plm.mbom[id] (adds a sealed manufacturing BOM derived from a baseline: its members with the quantities frozen at release, then the omissions, quantity changes and manufacturing-only lines)
 * @invariant every ebom line is a member of the baseline at the baselined revision with the quantity of the frozen structure unless changed with a reason; an MBOM is never edited
 *   (a hand edit breaks its seal on load); an agent may create one: it adds no authority, only a manufacturing view of what humans released
 * @failure not managed -> PLM_NOT_MANAGED; unknown baseline -> PLM_BASELINE_UNKNOWN; broken baseline hash -> PLM_INTEGRITY_MISMATCH; duplicate id -> PLM_ID_EXISTS; a part
 *   outside the baseline, a member the frozen structure has no quantity for, an empty reason or name, an overlap between the lists -> PLM_PARAM_INVALID (refusals, unchanged doc)
 */
export const createMbom = defineCommand({
  name: 'create_mbom',
  description:
    'Derive and freeze the manufacturing BOM of a product baseline. Starts from the engineering BOM of the baseline (every member except the end item, at the baselined ' +
    'revision, with the quantity frozen at release) and applies: omit (design-only EBOM items, with a reason), quantities (a different build quantity, e.g. a kit, with a ' +
    'reason) and add (manufacturing-only lines: consumable, tooling, process-material or phantom, with a name, quantity and reason). Lines are sorted by part number and the ' +
    'record is sealed with a SHA-256. An agent may create one. Use it as the mbom of record_as_built; read it with manufacturing_bom.',
  annotations: { metaHistory: true },
  params: z.object({
    id: z.string().optional().describe("MBOM id; omitted = the next 'MBOM-nnnn'."),
    name: z.string().describe('MBOM name (non-empty), e.g. "Hinge plant 2 build".'),
    baseline: z.string().describe('Id of the product baseline (create_baseline) whose engineering BOM this derives from.'),
    omit: z
      .array(z.object({ partNumber: z.string().describe('EBOM part number left out.'), reason: reasonSchema }))
      .optional()
      .describe('EBOM items not built or not bought separately.'),
    quantities: z
      .array(
        z.object({
          partNumber: z.string().describe('EBOM part number whose build quantity differs.'),
          quantity: z.number().positive().describe('Build quantity (> 0).'),
          reason: reasonSchema,
        }),
      )
      .optional()
      .describe('Quantity overrides.'),
    add: z
      .array(
        z.object({
          partNumber: z.string().describe('Part number of the manufacturing-only item (A-Z 0-9 . _ - /), not already a line.'),
          name: z.string().describe('What it is, non-empty.'),
          revision: z.string().optional().describe('Revision label when it has one; default "-".'),
          quantity: z.number().positive().describe('Quantity per end item (> 0).'),
          kind: z.enum(['consumable', 'tooling', 'process-material', 'phantom']).describe('What the line is.'),
          reason: reasonSchema,
        }),
      )
      .optional()
      .describe('Manufacturing-only lines.'),
    at: atSchema.optional(),
    by: bySchema.optional(),
  }),
  run: (doc, params): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'create_mbom', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const invalid = (message: string, path: string, ids: readonly string[] = []): CommandResult =>
      refusePlm(doc, 'create_mbom', 'PLM_PARAM_INVALID', message, ids, [path]);
    if (params.name.trim() === '') return invalid('an MBOM needs a name', 'name');
    const baseline = own(plm.baselines, params.baseline);
    if (baseline === undefined)
      return refusePlm(
        doc,
        'create_mbom',
        'PLM_BASELINE_UNKNOWN',
        `unknown baseline '${params.baseline}'`,
        [params.baseline],
        ['baseline'],
      );
    if (baseline.hash !== membersHash(baseline.members))
      return refusePlm(doc, 'create_mbom', 'PLM_INTEGRITY_MISMATCH', `baseline ${params.baseline} no longer hashes to its recorded hash`, [
        params.baseline,
      ]);
    const existing = plm.mbom ?? {};
    const id = params.id ?? nextMbomId(Object.keys(existing));
    if (Object.hasOwn(existing, id)) return refusePlm(doc, 'create_mbom', 'PLM_ID_EXISTS', `MBOM '${id}' already exists`, [id]);
    const rootRevision = baseline.members.find((member) => member.partNumber === plm.item.partNumber)?.revision;
    const omissions = params.omit ?? [];
    const overrides = params.quantities ?? [];
    const additions = params.add ?? [];
    const lines: MbomLine[] = [];
    for (const member of baseline.members) {
      if (member.partNumber === plm.item.partNumber) continue;
      const quantity = rootRevision === undefined ? undefined : frozenQuantity(plm, rootRevision, member.partNumber);
      if (quantity === undefined)
        return invalid(`${member.partNumber} is a baseline member but rev ${rootRevision ?? '?'} froze no quantity for it`, 'baseline', [
          member.partNumber,
        ]);
      lines.push({ partNumber: member.partNumber, revision: member.revision, quantity, origin: 'ebom' });
    }
    const touched = new Set<string>();
    const touch = (partNumber: string, path: string): CommandResult | null => {
      if (touched.has(partNumber))
        return invalid(`${partNumber} is named twice (omit / quantities / add each name a part once)`, path, [partNumber]);
      touched.add(partNumber);
      return null;
    };
    const omitted: MbomOmission[] = [];
    for (const [index, entry] of omissions.entries()) {
      const path = `omit[${index}]`;
      if (!lines.some((line) => line.partNumber === entry.partNumber))
        return invalid(`${path}: '${entry.partNumber}' is not an EBOM line of ${params.baseline}`, `${path}.partNumber`, [
          entry.partNumber,
        ]);
      if (entry.reason.trim() === '') return invalid(`${path}: a reason is required`, `${path}.reason`);
      const clash = touch(entry.partNumber, path);
      if (clash !== null) return clash;
      omitted.push({ partNumber: entry.partNumber, reason: entry.reason });
    }
    const kept = lines.filter((line) => !omitted.some((entry) => entry.partNumber === line.partNumber));
    const result: MbomLine[] = [...kept];
    for (const [index, entry] of overrides.entries()) {
      const path = `quantities[${index}]`;
      const at = result.findIndex((line) => line.partNumber === entry.partNumber);
      if (at < 0) return invalid(`${path}: '${entry.partNumber}' is not a kept EBOM line`, `${path}.partNumber`, [entry.partNumber]);
      if (entry.reason.trim() === '') return invalid(`${path}: a reason is required`, `${path}.reason`);
      const clash = touch(entry.partNumber, path);
      if (clash !== null) return clash;
      const line = result[at] as MbomLine;
      result[at] = { ...line, quantity: entry.quantity, origin: 'ebom-quantity', reason: entry.reason };
    }
    for (const [index, entry] of additions.entries()) {
      const path = `add[${index}]`;
      if (!PART_NUMBER.test(entry.partNumber))
        return invalid(`${path}: '${entry.partNumber}' is not a valid part number`, `${path}.partNumber`);
      if (entry.name.trim() === '' || entry.reason.trim() === '') return invalid(`${path}: name and reason are required`, path);
      if (lines.some((line) => line.partNumber === entry.partNumber) || entry.partNumber === plm.item.partNumber)
        return invalid(`${path}: ${entry.partNumber} is already an EBOM line or the end item`, `${path}.partNumber`, [entry.partNumber]);
      const clash = touch(entry.partNumber, path);
      if (clash !== null) return clash;
      result.push({
        partNumber: entry.partNumber,
        revision: entry.revision ?? '-',
        quantity: entry.quantity,
        origin: 'manufacturing',
        kind: entry.kind,
        name: entry.name,
        reason: entry.reason,
      });
    }
    const record: MbomRecord = sealMbom({
      id,
      name: params.name,
      baseline: params.baseline,
      lines: byPartNumber(result),
      omitted: byPartNumber(omitted),
      ...(params.at !== undefined ? { at: params.at } : {}),
      ...(params.by !== undefined ? { by: params.by } : {}),
    });
    return changed(
      withPlm(doc, { ...plm, mbom: { ...existing, [id]: record } }),
      `MBOM ${id} frozen from ${params.baseline}: ${record.lines.length} line(s) (${additions.length} manufacturing-only), ${omitted.length} omitted, seal ${record.sha256.slice(0, 12)}….`,
      [],
    );
  },
});

/**
 * @affects nothing (read-only)
 * @invariant differences against the engineering BOM are exactly the omissions, quantity changes and manufacturing-only lines recorded; the seal is re-checked on every read
 * @failure not managed -> PLM_NOT_MANAGED; unknown id -> PLM_MBOM_UNKNOWN (refusals)
 */
export const manufacturingBom = defineCommand({
  name: 'manufacturing_bom',
  description:
    'Read a manufacturing BOM made by create_mbom (the as-built, sealed variant of the engineering_bom; not the building quantity_takeoff): data { id, name, baseline, lines, omitted, differences: { omitted, quantityChanged: [{ partNumber, ebom, mbom }], manufacturingOnly }, ' +
    'totalQuantity, sealOk }. Without id: the list of MBOM ids with their baseline and line count. Read-only.',
  annotations: { readOnly: true },
  params: z.object({ id: z.string().optional().describe('MBOM id; omitted = list every MBOM.') }),
  run: (doc, { id }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'manufacturing_bom', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const all = plm.mbom ?? {};
    if (id === undefined) {
      const list = Object.values(all).map((mbom) => ({ id: mbom.id, name: mbom.name, baseline: mbom.baseline, lines: mbom.lines.length }));
      return report(doc, `${list.length} manufacturing BOM(s).`, { mboms: list });
    }
    const mbom = own(all, id);
    if (mbom === undefined) return refusePlm(doc, 'manufacturing_bom', 'PLM_MBOM_UNKNOWN', `unknown MBOM '${id}'`, [id], ['id']);
    const sealOk = isSealed(mbom);
    const ebom = own(plm.baselines, mbom.baseline);
    const root = ebom?.members.find((member) => member.partNumber === plm.item.partNumber)?.revision;
    const quantityChanged = mbom.lines
      .filter((line) => line.origin === 'ebom-quantity')
      .map((line) => ({
        partNumber: line.partNumber,
        ebom: root === undefined ? null : (frozenQuantity(plm, root, line.partNumber) ?? null),
        mbom: line.quantity,
      }));
    const manufacturingOnly = mbom.lines.filter((line) => line.origin === 'manufacturing');
    const totalQuantity = mbom.lines.reduce((sum, line) => sum + line.quantity, 0);
    return report(
      doc,
      `MBOM ${id} from ${mbom.baseline}: ${mbom.lines.length} line(s), total quantity ${totalQuantity}, ${mbom.omitted.length} omitted${sealOk ? '' : '; the record does not hash to its seal (edited by hand)'}.`,
      {
        id: mbom.id,
        name: mbom.name,
        baseline: mbom.baseline,
        lines: mbom.lines,
        omitted: mbom.omitted,
        differences: { omitted: mbom.omitted, quantityChanged, manufacturingOnly },
        totalQuantity,
        sealOk,
      },
    );
  },
});
