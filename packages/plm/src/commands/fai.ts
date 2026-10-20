/** fai_report_skeleton (FR-PLM-27): AS9102 Forms 1-3 data prefilled from PLM, the EBOM, materials and characteristics; measured results stay null unless an imported result set (import_qif_results) is named. */

import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { pmiText } from '@core/geometry/pmiText';
import type { PmiItem } from '@core/model/pmi';
import type { Characteristic, FaiResult, PlmModel } from '@core/model/plm';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { inRevision } from '../register';
import { refusePlm } from '../refusal';
import { snapshotText, unreadableSnapshot } from '../snapshot';
import { NOT_MANAGED, revisionText } from '../state';
import { liveStructure } from '../structure';

type Cell = string | number | null;

/** The PMI items of revision `label`: the live document for the current revision, else its frozen snapshot (a reason string when unreadable). */
function itemsOf(doc: CadDocument, plm: PlmModel, label: string, ctx: ExecutionContext | undefined): Record<string, PmiItem> | string {
  const revision = plm.item.revisions[label];
  if (revision === undefined) return `${plm.item.partNumber} has no revision '${label}'`;
  if (label === plm.item.currentRevision && revision.snapshot === undefined) return doc.pmi?.items ?? {};
  const text = snapshotText(revision, ctx);
  if (text === null) return `${revisionText(plm, label)}: ${unreadableSnapshot(revision)}`;
  const pmi = (JSON.parse(text) as { document?: { pmi?: { items?: unknown } } }).document?.pmi?.items;
  return isRecord(pmi) ? (pmi as Record<string, PmiItem>) : {};
}

/** RFC 4180 field. */
const field = (cell: Cell): string => {
  const text = cell === null ? '' : String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** One flat table `form,row,field,value` (every form, every row): the same data as the JSON, for spreadsheets. */
function toCsv(forms: { form1: Record<string, Cell>; form2: Record<string, Cell>[]; form3: Record<string, Cell>[] }): string {
  const lines = ['form,row,field,value'];
  for (const [key, value] of Object.entries(forms.form1)) lines.push(['1', '', key, value].map(field).join(','));
  forms.form2.forEach((row, index) =>
    Object.entries(row).forEach(([key, value]) => lines.push(['2', index + 1, key, value].map(field).join(','))),
  );
  for (const row of forms.form3)
    Object.entries(row).forEach(([key, value]) => lines.push(['3', row['charNo'] ?? '', key, value].map(field).join(',')));
  return `${lines.join('\n')}\n`;
}

/** Form 2 rows: each distinct material (with its specs) and each distinct special process named by a surface texture. */
function form2Rows(doc: CadDocument, items: Readonly<Record<string, PmiItem>>): Record<string, Cell>[] {
  const used = [
    ...new Set(Object.values(doc.entities).flatMap((entity) => (entity.materialId === undefined ? [] : [entity.materialId]))),
  ].sort();
  const materials = used.flatMap((id) => {
    const material = doc.materials[id];
    if (material === undefined) return [];
    const specs = material.record?.specs.map((spec) => `${spec.body} ${spec.id}`).join('; ');
    return [row2(material.name, specs === undefined || specs === '' ? null : specs)];
  });
  const processes = [
    ...new Set(
      Object.values(items).flatMap((item) => (item.kind === 'surface_texture' && item.process !== undefined ? [item.process] : [])),
    ),
  ]
    .sort()
    .map((process) => row2(process, null));
  return [...materials, ...processes];
}

/** The Form 3 results cell of an imported result: value with its unit, else the verdict alone; null when the file had no result for the characteristic. */
function resultCell(result: FaiResult | undefined): string | null {
  if (result === undefined) return null;
  return result.value === undefined ? result.status : `${result.value}${result.unit === undefined ? '' : ` ${result.unit}`}`;
}

const row2 = (name: string, spec: string | null): Record<string, Cell> => ({
  materialOrProcessName: name,
  specificationNumber: spec,
  code: null,
  supplierCode: null,
  customerApprovalVerification: null,
  certificateOfConformanceNumber: null,
});

/**
 * @affects nothing (read-only)
 * @invariant results are null unless `resultsId` names an imported result set (the measuring system's value and verdict, copied as imported); tooling, nonconformance and signatures are always null: llull prepares the form, people measure and sign; a partial FAI lists only
 *   the characteristics that are new or whose rendered requirement differs from the baseline revision
 * @failure not managed / unknown part number or revision -> PLM_NOT_MANAGED / PLM_PARAM_INVALID / PLM_REVISION_UNKNOWN; partial without reason or
 *   baselineRevision -> PLM_PARAM_INVALID; a needed snapshot unreadable -> PLM_VAULT_OBJECT_MISSING; unknown resultsId or one imported for another revision -> PLM_RESULTS_UNKNOWN (refusals, unchanged doc)
 */
export const faiReportSkeleton = defineCommand({
  name: 'fai_report_skeleton',
  description:
    'AS9102 First Article Inspection skeleton for one revision of the managed item as data (JSON, or also a flat CSV): Form 1 (part number and name, drawing ' +
    'revision, full / partial with reason and baseline revision, deterministic report id, open and implemented change orders, the sub-items of an assembly), ' +
    'Form 2 (materials with their specifications and special processes from surface-texture PMI) and Form 3 rows { charNo, referenceLocation, ' +
    'characteristicDesignator, requirement, results: null } from the characteristic register (assign_characteristic_ids first). A partial FAI needs ' +
    'baselineRevision and reason and lists only characteristics new or changed since that revision, plus the numbers retired. Measured results, tooling, ' +
    'nonconformance numbers and the approval signatures are always null: people fill them. With resultsId (a set made by import_qif_results for this revision) Form 3 rows also carry the imported measured value and the verdict of the measuring system (resultStatus) and Form 1 the serial number; llull does not judge them. Field mapping: validation/as9102_field_mapping.csv. Read-only.',
  annotations: { readOnly: true },
  params: z.object({
    partNumber: z.string().optional().describe("Part number; default and only valid value: this document's managed item."),
    revision: z.string().describe('Revision label the first article is inspected against, e.g. "B".'),
    faiType: z.enum(['full', 'partial']).describe('full = every characteristic; partial = only those changed since baselineRevision.'),
    baselineRevision: z.string().optional().describe('Partial only: the revision the previous first article was accepted against.'),
    reason: z.string().optional().describe('Partial only: why a partial FAI (e.g. "ECO-0002 design change").'),
    resultsId: z
      .string()
      .optional()
      .describe('Id of an imported result set (import_qif_results) for this revision: its measured values fill Form 3 results.'),
    format: z.enum(['json', 'csv']).describe('json = structured forms; csv = the same data also as one flat table in data.csv.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'fai_report_skeleton', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const { revision: label, faiType, baselineRevision, reason, format } = params;
    if (params.partNumber !== undefined && params.partNumber !== plm.item.partNumber)
      return refusePlm(
        doc,
        'fai_report_skeleton',
        'PLM_PARAM_INVALID',
        `this document manages ${plm.item.partNumber}, not ${params.partNumber}`,
        [params.partNumber],
        ['partNumber'],
      );
    const revision = plm.item.revisions[label];
    if (revision === undefined)
      return refusePlm(doc, 'fai_report_skeleton', 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no revision '${label}'`, [label]);
    if (faiType === 'partial' && (baselineRevision === undefined || reason === undefined || reason.trim() === ''))
      return refusePlm(
        doc,
        'fai_report_skeleton',
        'PLM_PARAM_INVALID',
        'a partial FAI needs baselineRevision and a reason',
        [],
        ['baselineRevision', 'reason'],
      );
    const resultSet = params.resultsId === undefined ? undefined : plm.faiResults?.[params.resultsId];
    if (params.resultsId !== undefined && (resultSet === undefined || resultSet.revision !== label))
      return refusePlm(
        doc,
        'fai_report_skeleton',
        'PLM_RESULTS_UNKNOWN',
        `no result set '${params.resultsId}' for revision ${label}`,
        [params.resultsId],
        ['resultsId'],
      );
    const resultOf = new Map((resultSet?.results ?? []).map((result) => [result.charNo, result]));
    const items = itemsOf(doc, plm, label, ctx);
    const baseItems = faiType === 'partial' && baselineRevision !== undefined ? itemsOf(doc, plm, baselineRevision, ctx) : {};
    for (const side of [items, baseItems])
      if (typeof side === 'string') return refusePlm(doc, 'fai_report_skeleton', 'PLM_VAULT_OBJECT_MISSING', side, [label]);
    const found = items as Record<string, PmiItem>;
    const base = baseItems as Record<string, PmiItem>;
    const register = Object.entries(plm.characteristics ?? {}).filter(([, c]) => inRevision(plm, c, label));
    const requirement = (id: string, c: Characteristic): string => {
      const item = found[id];
      return item === undefined ? c.requirementText : pmiText(item);
    };
    const changedSince = (id: string, c: Characteristic): boolean => {
      if (faiType === 'full') return true;
      if (baselineRevision === undefined || !inRevision(plm, c, baselineRevision)) return true;
      const before = base[id];
      return before === undefined ? c.requirementText !== requirement(id, c) : pmiText(before) !== requirement(id, c);
    };
    const rows = register
      .filter(([id, c]) => changedSince(id, c))
      .sort(([, a], [, b]) => a.charNo - b.charNo)
      .map(([id, c]) => ({
        charNo: c.charNo,
        referenceLocation: c.sheetId ?? null,
        characteristicDesignator: c.designator ?? null,
        requirement: requirement(id, c),
        results: resultCell(resultOf.get(c.charNo)),
        ...(resultSet === undefined ? {} : { resultStatus: resultOf.get(c.charNo)?.status ?? null }),
        tooling: null,
        nonconformanceNumber: null,
      }));
    const removed =
      faiType === 'partial' && baselineRevision !== undefined
        ? Object.values(plm.characteristics ?? {})
            .filter((c) => inRevision(plm, c, baselineRevision) && !inRevision(plm, c, label))
            .map((c) => c.charNo)
            .sort((a, b) => a - b)
        : [];
    const changes = Object.values(plm.changes).filter(
      (change) =>
        change.kind === 'eco' &&
        change.affectedItems.includes(plm.item.partNumber) &&
        (change.state === 'open' || (change.state === 'implemented' && revision.changeOrder === change.id)),
    );
    const form1: Record<string, Cell> = {
      partNumber: plm.item.partNumber,
      partName: plm.item.name,
      drawingNumber: plm.item.partNumber,
      drawingRevision: label,
      serialNumber: resultSet?.serial ?? null,
      reportId: `FAI-${plm.item.partNumber}-${label}-1`,
      additionalChanges: changes.length === 0 ? null : changes.map((change) => `${change.id} (${change.state})`).join('; '),
      detailOrAssembly: plm.item.itemType === 'assembly' ? 'assembly' : 'detail',
      fullOrPartial: faiType,
      reasonForPartial: faiType === 'partial' ? (reason ?? null) : null,
      baselineRevision: faiType === 'partial' ? (baselineRevision ?? null) : null,
      partsIndex:
        liveStructure(doc, plm)
          .map((sub) => `${sub.partNumber} rev ${sub.revision}`)
          .join('; ') || null,
      faiComplete: null,
      preparedBy: null,
      approvedBy: null,
    };
    const form2 = form2Rows(doc, found);
    const forms = { form1, form2, form3: rows.map((row) => ({ ...row }) as Record<string, Cell>) };
    return report(
      doc,
      `FAI skeleton ${form1['reportId']} (${faiType}): Form 3 lists ${rows.length} characteristic(s)${removed.length > 0 ? `, ${removed.length} retired since ${baselineRevision}` : ''}; every result is null.`,
      {
        form1,
        form2: { rows: form2 },
        form3: { rows, ...(faiType === 'partial' ? { retiredSinceBaseline: removed } : {}) },
        mappingTable: 'docs/aerospace/09-plm-configuration-traceability/validation/as9102_field_mapping.csv',
        ...(format === 'csv' ? { csv: toCsv(forms) } : {}),
      },
    );
  },
});
