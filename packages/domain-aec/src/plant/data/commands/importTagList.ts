import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { resolveClass } from '../classes';
import { cellToInput, matchHeader } from '../importTable/columns';
import type { ImportRejection } from '../importTable/importDiff';
import { MAX_REJECTIONS } from '../importTable/importDiff';
import { cellReference, loadSource } from '../importTable/sheetSource';
import { sourceFields } from '../importTable/sourceFields';
import { getPlantData, withPlantData, type ValueProvenance } from '../model';
import { coerceValue, type PlantValueInput } from '../properties';
import { assignObject } from './assignObject';
import { refuse } from './params';

const MAX_ROWS = 10_000;
const MAX_LISTED = 2000;

/**
 * @affects mode apply: creates one reserved plant object per accepted row (plant.data, no model object) as ONE step; mode preview: none
 * @invariant atomic: a rejected row refuses the whole apply unless onRejected is skip; each row follows assign_plant_object (format, uniqueness in the scope, typed values); linear in the rows
 * @failure unreadable file, no Tag column, unknown / abstract class or hierarchy, rejected rows (apply) -> DAT_* refusal, document unchanged
 */
export const importTagList = defineCommand({
  name: 'import_tag_list',
  description:
    'Reserve the tags of a client or P&ID tag list before their objects exist (an .xlsx or .csv: row 1 headers, one tag per row). The Tag column is required; every other column ' +
    'whose header names a property of className ("DisplayName (unit)", "DisplayName" or the name) sets that property of the reserved object with provenance import. Each row ' +
    'is an assign_plant_object with target "reserved": the tag must fit the class tag format, be unique in its scope (a tag that exists already is rejected with ' +
    'DAT_TAG_DUPLICATE, also a second occurrence in the file) and its values must be typed. className (concrete) and hierarchy (node code, path or id) place every row. ' +
    'Nothing in the file is executed (formulas are cached values, text starting with = + - @ is text). mode preview (default) changes nothing; apply creates the objects as ' +
    'ONE step. If any row is rejected the apply is refused whole (paths lists the cells); onRejected skip reserves the valid rows and reports the rejected ones. Returns data = ' +
    '{ reserved, created [{ objectId, tag }], rejected [{ tag, code, message, row, cell }], rejectedCount, documentChanged }. Next: renumber_tags, assign_plant_object (a reserved tag is ' +
    're-used when its object is modelled), check_plant_data.',
  params: z.object({
    ...sourceFields,
    className: z.string().min(1).describe('Concrete class every row gets, e.g. "CentrifugalPump" (plant_data_table lists the classes).'),
    hierarchy: z.string().min(1).describe('Hierarchy node of every row: code, path S1/P1/U10 or id.'),
    mode: z.enum(['preview', 'apply']).optional().describe('preview (default): report only. apply: create the reserved objects.'),
    onRejected: z
      .enum(['refuse', 'skip'])
      .optional()
      .describe(
        'apply only. refuse (default): any rejected row refuses the whole import. skip: reserve the valid rows and report the rejected ones.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const source = loadSource(params);
    if (!source.ok) return refuse(doc, 'import_tag_list', source);
    const { table } = source;
    const data = getPlantData(doc);
    const resolution = resolveClass(data, params.className);
    if (!resolution.ok) return refuse(doc, 'import_tag_list', { code: resolution.code, message: resolution.message, paths: ['className'] });
    const resolved = resolution.resolved;
    const tagIndex = table.header.findIndex((header) => header.toLowerCase() === 'tag');
    if (tagIndex < 0)
      return refuse(doc, 'import_tag_list', {
        code: 'DAT_IMPORT_KEY_MISSING',
        message: `the list has no Tag column in row 1 (headers: ${table.header.join(', ')})`,
        paths: ['header'],
      });
    if (table.rows.length > MAX_ROWS)
      return refuse(doc, 'import_tag_list', {
        code: 'DAT_IMPORT_FORMAT',
        message: `${table.rows.length} rows: import at most ${MAX_ROWS} tags at a time`,
        paths: ['rows'],
      });
    const rejected: ImportRejection[] = [];
    let rejectedCount = 0;
    const reject = (entry: ImportRejection): void => {
      rejectedCount++;
      if (rejected.length < MAX_REJECTIONS) rejected.push(entry);
    };
    const mapped = table.header.flatMap((header, index) => {
      if (index === tagIndex || header === '') return [];
      for (const definition of resolved.properties) {
        const match = matchHeader(header, definition);
        if (match !== null) return [{ index, header, definition, unit: match.unit }];
      }
      reject({
        code: 'DAT_IMPORT_UNKNOWN_COLUMN',
        message: `${resolved.name} has no property headed "${header}": the whole column is ignored`,
        row: 1,
        column: header,
        cell: cellReference(index, 1),
      });
      return [];
    });
    const provenance: ValueProvenance = { source: 'import', ref: `${table.sheet} sha256:${table.sha256.slice(0, 16)}` };
    let current = withPlantData(doc, { ...data, objects: { ...data.objects }, objectOrder: [...data.objectOrder] });
    const created: Array<{ objectId: string; tag: string }> = [];
    const affected: string[] = [];
    for (const row of table.rows) {
      if (row.cells.every((cell) => cell === null || (typeof cell === 'string' && cell.trim() === ''))) continue;
      const raw = row.cells[tagIndex] ?? null;
      const here = { row: row.row, column: table.header[tagIndex] ?? 'Tag', cell: cellReference(tagIndex, row.row) };
      const tag = raw === null || typeof raw === 'object' ? '' : String(raw).normalize('NFC').trim();
      if (tag === '') {
        reject({ ...here, code: 'DAT_IMPORT_KEY_MISSING', message: 'the row has no tag' });
        continue;
      }
      const properties: Record<string, PlantValueInput> = {};
      const provenances: Record<string, ValueProvenance> = {};
      let bad: ImportRejection | null = null;
      for (const column of mapped) {
        const cell = row.cells[column.index] ?? null;
        const input = cellToInput(column.definition, cell, column.unit);
        const cellHere = { ...here, column: column.header, cell: cellReference(column.index, row.row), tag };
        if (!input.ok) {
          bad = {
            ...cellHere,
            code: typeof cell === 'object' && cell?.unreadable === 'formula' ? 'DAT_IMPORT_FORMULA' : 'DAT_IMPORT_TYPE',
            message: input.message,
          };
          break;
        }
        if (input.input === null) continue;
        const coerced = coerceValue(column.definition, input.input);
        if (!coerced.ok) {
          bad = { ...cellHere, code: 'DAT_IMPORT_TYPE', message: `${tag}: ${coerced.message}` };
          break;
        }
        properties[column.definition.name] = coerced.value;
        provenances[column.definition.name] = provenance;
      }
      if (bad !== null) {
        reject(bad);
        continue;
      }
      const outcome = assignObject(
        current,
        {
          target: 'reserved',
          className: params.className,
          hierarchy: params.hierarchy,
          tag,
          properties: properties as Record<string, PlantValueInput>,
          provenance: provenances,
        },
        ctx,
        true,
      );
      if (!outcome.ok) {
        if (outcome.code === 'DAT_HIERARCHY_UNKNOWN' || outcome.code === 'DAT_CLASS_ABSTRACT' || outcome.code === 'DAT_CLASS_UNKNOWN')
          return refuse(doc, 'import_tag_list', outcome);
        reject({
          ...here,
          code: outcome.code,
          message: outcome.message,
          tag,
          ...(outcome.ids?.[0] === undefined ? {} : { objectId: outcome.ids[0] }),
        });
        continue;
      }
      current = outcome.assigned.document;
      created.push({ objectId: outcome.assigned.object.id, tag: outcome.assigned.object.tag });
      affected.push(outcome.assigned.object.id);
    }
    const mode = params.mode ?? 'preview';
    const head = `import_tag_list ${table.sheet}: ${created.length} tag(s) to reserve as ${params.className}, ${rejectedCount} rejected`;
    const listed = {
      mode,
      sheet: table.sheet,
      sha256: table.sha256,
      reserved: created.length,
      created: created.slice(0, MAX_LISTED),
      rejected: rejected.slice(0, MAX_LISTED),
      rejectedCount,
    };
    if (mode === 'preview') return report(doc, `${head}; preview, document unchanged.`, { ...listed, documentChanged: false });
    if (rejectedCount > 0 && (params.onRejected ?? 'refuse') === 'refuse')
      return refuse(doc, 'import_tag_list', {
        code: rejected[0]?.code ?? 'DAT_IMPORT_TYPE',
        message: `${rejectedCount} rejected row(s) or column(s), nothing applied (onRejected skip reserves the valid rows); first: ${rejected[0]?.cell ?? ''} ${rejected[0]?.message ?? ''}`,
        paths: rejected.slice(0, 50).map((entry) => `${table.sheet}!${entry.cell}`),
        ids: [...new Set(rejected.flatMap((entry) => entry.objectId ?? []))].slice(0, 50),
        detail: { rejected: rejected.slice(0, 50), rejectedCount },
      });
    if (created.length === 0) return report(doc, `${head}; nothing to reserve, document unchanged.`, { ...listed, documentChanged: false });
    return {
      ...changed(current, `${head}; reserved ${created.length} tag(s) as one step.`, affected),
      data: { ...listed, documentChanged: true },
    };
  },
});
