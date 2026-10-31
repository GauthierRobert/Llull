import { defineCommand, z } from '@core/commands/schema';
import { execute } from '@core/commands/registry';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { getPlantData } from '../model';
import { diffImport, type ImportChange } from '../importTable/importDiff';
import { plantDataHash } from '../importTable/meta';
import { loadSource } from '../importTable/sheetSource';
import { sourceFields } from '../importTable/sourceFields';
import { refuse } from './params';

const MAX_LISTED = 2000;

/**
 * @affects mode apply: property values (provenance import) of existing plant objects in plant.data, as ONE set_plant_properties step; mode preview: none
 * @invariant atomic: a rejected cell refuses the whole apply unless onRejected is skip; read-only columns never change; the file is data (formulas are never evaluated); equal values are no change
 * @failure unreadable / oversized file, no key column, rejected cells (apply), unknown accept id, a refused set_plant_properties batch -> DAT_IMPORT_* / DAT_* refusal, document unchanged
 */
export const importPlantData = defineCommand({
  name: 'import_plant_data',
  description:
    'Import the property values of plant objects from a spreadsheet exported by export_plant_data and edited outside llull (Excel round trip). Reads an .xlsx or .csv; ' +
    'nothing in it is executed (a formula cell is read through its cached value, a text starting with = + - @ is just text). Rows are keyed by the ObjectId column ' +
    '(the plant object id, or the id of the model object it stands for) or by Tag; columns are mapped by header ("DisplayName (unit)", "DisplayName" or the property name; a unit ' +
    'other than the property unit is converted); empty cells clear a value. Tag, Class, Hierarchy and read-only properties may stay in the sheet but must not differ. ' +
    'mode preview (default) changes nothing and returns data = { changes [{ changeId, objectId, tag, property, from, to, cell }], rejected [{ row, column, cell, code, message, tag }], ' +
    'rejectedCount, unchanged, rowsRead, rowsMatched, warnings, documentChanged false }. mode apply writes the changes as ONE undoable set_plant_properties step with provenance ' +
    'import (file sha256 in ref): by default every changed value, or only accept [changeId]. If any cell is rejected the apply is refused whole (the document stays unchanged and ' +
    'paths lists the cells); onRejected skip applies the valid changes and reports the rejected cells. A sheet exported earlier than the last edit of the plant objects gives the ' +
    'warning DAT_IMPORT_STALE (the values are still diffed against the current document). keyColumn auto (default) uses ObjectId then Tag; Tag forces the tag. ' +
    'Codes: DAT_IMPORT_FORMAT, DAT_IMPORT_KEY_MISSING, DAT_IMPORT_UNKNOWN_OBJECT, DAT_IMPORT_UNKNOWN_COLUMN, DAT_IMPORT_READONLY_COLUMN, DAT_IMPORT_TYPE, DAT_IMPORT_FORMULA, ' +
    'DAT_IMPORT_DUPLICATE_ROW, DAT_IMPORT_STALE. Next: plant_report, check_plant_data.',
  params: z.object({
    ...sourceFields,
    mode: z
      .enum(['preview', 'apply'])
      .optional()
      .describe('preview (default): diff only, document unchanged. apply: write the accepted changes.'),
    accept: z
      .array(z.string())
      .max(10000)
      .optional()
      .describe('apply only: changeIds (from the preview) to apply; default all changes. An unknown id is refused.'),
    onRejected: z
      .enum(['refuse', 'skip'])
      .optional()
      .describe(
        'apply only. refuse (default): any rejected cell refuses the whole import. skip: apply the valid changes and report the rejected cells.',
      ),
    keyColumn: z
      .enum(['auto', 'ObjectId', 'Tag'])
      .optional()
      .describe(
        'Which column identifies the object: auto (default; ObjectId, falling back to Tag when the row has no ObjectId or it is unknown), ObjectId or Tag.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const source = loadSource(params);
    if (!source.ok) return refuse(doc, 'import_plant_data', source);
    const { table } = source;
    const outcome = diffImport(doc, table, params.keyColumn ?? 'auto');
    if (!outcome.ok) return refuse(doc, 'import_plant_data', outcome);
    const { diff } = outcome;
    const mode = params.mode ?? 'preview';
    const warnings =
      table.metaHash !== null && table.metaHash !== plantDataHash(getPlantData(doc))
        ? [
            {
              code: 'DAT_IMPORT_STALE',
              message: 'the plant objects changed after this sheet was exported; the values are diffed against the current document',
            },
          ]
        : [];
    const listed = {
      format: table.format,
      sheet: table.sheet,
      sha256: table.sha256,
      rowsRead: diff.rowsRead,
      rowsMatched: diff.rowsMatched,
      unchanged: diff.unchanged,
      rejected: diff.rejected.slice(0, MAX_LISTED),
      rejectedCount: diff.rejectedCount,
      warnings,
    };
    const describeRejected = `${diff.rejectedCount} rejected cell(s)`;
    const summaryHead = `import_plant_data ${table.sheet}: ${diff.rowsMatched} of ${diff.rowsRead} row(s) matched, ${diff.changes.length} change(s), ${describeRejected}`;
    if (mode === 'preview')
      return report(doc, `${summaryHead}; preview, document unchanged.`, {
        ...listed,
        mode,
        changes: diff.changes.slice(0, MAX_LISTED),
        changeCount: diff.changes.length,
        applied: 0,
        documentChanged: false,
      });
    let selected: readonly ImportChange[] = diff.changes;
    if (params.accept !== undefined) {
      const known = new Set(diff.changes.map((change) => change.changeId));
      const unknown = params.accept.filter((id) => !known.has(id));
      if (unknown.length > 0)
        return refuse(doc, 'import_plant_data', {
          code: 'DAT_PARAM_INVALID',
          message: `accept names ${unknown.length} change id(s) the sheet does not produce: ${unknown.slice(0, 5).join(', ')}`,
          paths: ['accept'],
        });
      const wanted = new Set(params.accept);
      selected = diff.changes.filter((change) => wanted.has(change.changeId));
    }
    if (diff.rejectedCount > 0 && (params.onRejected ?? 'refuse') === 'refuse')
      return refuse(doc, 'import_plant_data', {
        code: diff.rejected[0]?.code ?? 'DAT_IMPORT_TYPE',
        message: `${describeRejected}, nothing applied (onRejected skip applies the valid changes); first: ${diff.rejected[0]?.cell ?? ''} ${diff.rejected[0]?.message ?? ''}`,
        paths: diff.rejected.slice(0, 50).map((entry) => `${table.sheet}!${entry.cell}`),
        ids: [...new Set(diff.rejected.flatMap((entry) => entry.objectId ?? []))].slice(0, 50),
        detail: { rejected: listed.rejected.slice(0, 50), rejectedCount: diff.rejectedCount },
      });
    if (selected.length === 0)
      return report(doc, `${summaryHead}; nothing to apply, document unchanged.`, {
        ...listed,
        mode,
        changes: [],
        changeCount: 0,
        applied: 0,
        documentChanged: false,
      });
    const provenance = { source: 'import' as const, ref: `${table.sheet} sha256:${table.sha256.slice(0, 16)}` };
    const applied = execute(
      doc,
      'set_plant_properties',
      { edits: selected.map((change) => ({ object: change.objectId, property: change.property, value: change.to, provenance })) },
      ctx,
    );
    if (applied.rejected === true)
      return refuse(doc, 'import_plant_data', {
        code: applied.error?.code ?? 'DAT_PROPERTY_TYPE',
        message: `set_plant_properties refused the import: ${applied.summary}`,
        paths: applied.error?.paths ?? [],
      });
    return {
      ...applied,
      summary: `${summaryHead}; applied ${selected.length} change(s) as one step.`,
      data: {
        ...listed,
        mode,
        changes: selected.slice(0, MAX_LISTED),
        changeCount: selected.length,
        applied: selected.length,
        documentChanged: applied.document !== doc,
      },
    };
  },
});
