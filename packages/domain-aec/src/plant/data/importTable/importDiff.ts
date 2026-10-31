/**
 * The import diff (plant 08 DAT §5.11): a sheet against the plant objects of the document. Pure: it reads the document and returns the accepted changes and the
 * rejected cells with a code each; nothing is applied here. Columns are mapped by header, rows are keyed by ObjectId (plant object id, or the id of the model
 * object it stands for) or by Tag; read-only columns may be present but must not differ.
 */

import { sha256Hex } from '@lib/sha256';
import { resolvedOrNull, type ResolvedClass } from '../classes';
import { pathOf } from '../hierarchy';
import { getPlantData, type PlantDataModel, type PlantObject, type PlantValue, type PropertyDefinition } from '../model';
import { coerceValue } from '../properties';
import { objectByRef } from '../registry';
import { cellToInput, matchHeader, type HeaderMatch } from './columns';
import { cellReference, type SheetRow, type SourceTable } from './sheetSource';
import type { CadDocument } from '@core/model/types';

export interface ImportChange {
  readonly changeId: string;
  readonly objectId: string;
  readonly tag: string;
  readonly property: string;
  readonly from: PlantValue;
  readonly to: PlantValue;
  readonly cell: string;
  readonly row: number;
}

export interface ImportRejection {
  readonly code: string;
  readonly message: string;
  readonly row: number;
  readonly column: string;
  readonly cell: string;
  readonly tag?: string;
  readonly objectId?: string;
}

export interface ImportDiff {
  readonly changes: readonly ImportChange[];
  readonly rejected: readonly ImportRejection[];
  /** Rejections beyond MAX_REJECTIONS are counted, not listed. */
  readonly rejectedCount: number;
  readonly unchanged: number;
  readonly rowsRead: number;
  readonly rowsMatched: number;
}

export type KeyColumn = 'auto' | 'ObjectId' | 'Tag';

export const MAX_REJECTIONS = 5000;
const MAX_CHANGES = 10_000;

type Role = 'objectId' | 'tag' | 'class' | 'hierarchy' | 'ignored' | 'property' | 'blank';

const BASE_ROLES: Readonly<Record<string, Role>> = {
  objectid: 'objectId',
  tag: 'tag',
  class: 'class',
  hierarchy: 'hierarchy',
  'model object': 'ignored',
  'unverified values': 'ignored',
};

interface Column {
  readonly index: number;
  readonly header: string;
  readonly role: Role;
}

/** The first definition of `data`'s classes a header names: is the column known anywhere? */
function knownProperty(data: PlantDataModel, header: string): boolean {
  return data.classOrder.some((name) =>
    resolvedOrNull(data, name)?.properties.some((definition) => matchHeader(header, definition) !== null),
  );
}

class ClassColumns {
  private readonly cache = new Map<string, Map<string, { definition: PropertyDefinition; match: HeaderMatch } | null>>();
  constructor(private readonly headers: readonly Column[]) {}

  of(resolved: ResolvedClass, header: string): { definition: PropertyDefinition; match: HeaderMatch } | null {
    let perClass = this.cache.get(resolved.name);
    if (perClass === undefined) {
      perClass = new Map();
      for (const column of this.headers)
        if (column.role === 'property') {
          let found: { definition: PropertyDefinition; match: HeaderMatch } | null = null;
          for (const definition of resolved.properties) {
            const match = matchHeader(column.header, definition);
            if (match !== null) {
              found = { definition, match };
              break;
            }
          }
          perClass.set(column.header, found);
        }
      this.cache.set(resolved.name, perClass);
    }
    return perClass.get(header) ?? null;
  }
}

const isBlank = (cell: unknown): boolean => cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');
const sameValue = (a: PlantValue | undefined, b: PlantValue): boolean => (a ?? null) === b;

function modelIndex(data: PlantDataModel): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const id of data.objectOrder) {
    const target = data.objects[id]?.target;
    if (target === undefined || target.kind === 'reserved') continue;
    index.set(target.id, [...(index.get(target.id) ?? []), id]);
  }
  return index;
}

/** Whole-file refusal: no usable key column. */
export type DiffOutcome =
  | { readonly ok: true; readonly diff: ImportDiff }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly paths: readonly string[] };

export function diffImport(doc: CadDocument, table: SourceTable, keyColumn: KeyColumn): DiffOutcome {
  const data = getPlantData(doc);
  const columns: Column[] = table.header.map((header, index) => {
    const role: Role = header === '' ? 'blank' : (BASE_ROLES[header.toLowerCase()] ?? 'property');
    return { index, header, role };
  });
  const idColumn = columns.find((column) => column.role === 'objectId');
  const tagColumn = columns.find((column) => column.role === 'tag');
  if (
    keyColumn === 'ObjectId'
      ? idColumn === undefined
      : keyColumn === 'Tag'
        ? tagColumn === undefined
        : idColumn === undefined && tagColumn === undefined
  )
    return {
      ok: false,
      code: 'DAT_IMPORT_KEY_MISSING',
      message: `the sheet has no ${keyColumn === 'auto' ? 'ObjectId or Tag' : keyColumn} column in row 1 (headers: ${table.header.join(', ')})`,
      paths: ['header'],
    };
  const rejected: ImportRejection[] = [];
  let rejectedCount = 0;
  const reject = (entry: ImportRejection): void => {
    rejectedCount++;
    if (rejected.length < MAX_REJECTIONS) rejected.push(entry);
  };
  const unknown = new Set<number>();
  for (const column of columns)
    if (column.role === 'property' && !knownProperty(data, column.header)) {
      unknown.add(column.index);
      reject({
        code: 'DAT_IMPORT_UNKNOWN_COLUMN',
        message: `no class defines a property headed "${column.header}": the whole column is ignored`,
        row: 1,
        column: column.header,
        cell: cellReference(column.index, 1),
      });
    }
  const lookup = new ClassColumns(columns);
  const byModel = modelIndex(data);
  const changes: ImportChange[] = [];
  const seenObjects = new Map<string, number>();
  let unchanged = 0;
  let rowsRead = 0;
  let rowsMatched = 0;
  for (const sheetRow of table.rows) {
    if (sheetRow.cells.every(isBlank)) continue;
    rowsRead++;
    const found = resolveRow(data, sheetRow, idColumn, tagColumn, keyColumn, byModel);
    if (!found.ok) {
      reject({ ...found.rejection, row: sheetRow.row });
      continue;
    }
    const { object } = found;
    const earlier = seenObjects.get(object.id);
    if (earlier !== undefined) {
      reject({
        code: 'DAT_IMPORT_DUPLICATE_ROW',
        message: `${object.tag} is already listed at row ${earlier}`,
        row: sheetRow.row,
        column: (idColumn ?? tagColumn)?.header ?? '',
        cell: cellReference((idColumn ?? tagColumn)?.index ?? 0, sheetRow.row),
        tag: object.tag,
        objectId: object.id,
      });
      continue;
    }
    seenObjects.set(object.id, sheetRow.row);
    rowsMatched++;
    const resolved = resolvedOrNull(data, object.className);
    for (const column of columns) {
      if (column.role === 'blank' || column.role === 'ignored' || column.role === 'objectId' || unknown.has(column.index)) continue;
      const cell = sheetRow.cells[column.index] ?? null;
      const here = {
        row: sheetRow.row,
        column: column.header,
        cell: cellReference(column.index, sheetRow.row),
        tag: object.tag,
        objectId: object.id,
      };
      if (column.role !== 'property') {
        const current = column.role === 'tag' ? object.tag : column.role === 'class' ? object.className : pathOf(data, object.hierarchyId);
        if (isBlank(cell) || (typeof cell !== 'object' && String(cell).normalize('NFC').trim() === current)) unchanged++;
        else
          reject({
            ...here,
            code: 'DAT_IMPORT_READONLY_COLUMN',
            message: `${column.header} of ${object.tag} is derived and read-only (sheet "${String(typeof cell === 'object' ? cell?.detail : cell).slice(0, 60)}", document "${current}")`,
          });
        continue;
      }
      const target = resolved === null ? null : lookup.of(resolved, column.header);
      if (target === null) {
        if (!isBlank(cell))
          reject({ ...here, code: 'DAT_IMPORT_UNKNOWN_COLUMN', message: `${object.className} has no property headed "${column.header}"` });
        continue;
      }
      const { definition, match } = target;
      const current = object.properties[definition.name];
      if (definition.readOnly === true || definition.derivedFrom !== undefined) {
        const text = typeof cell === 'object' ? null : cell;
        if (isBlank(cell) || (text !== null && sameValue(current, text as PlantValue))) unchanged++;
        else reject({ ...here, code: 'DAT_IMPORT_READONLY_COLUMN', message: `${definition.name} of ${object.tag} is read-only` });
        continue;
      }
      const input = cellToInput(definition, cell, match.unit);
      if (!input.ok) {
        reject({
          ...here,
          code: typeof cell === 'object' && cell?.unreadable === 'formula' ? 'DAT_IMPORT_FORMULA' : 'DAT_IMPORT_TYPE',
          message: `${object.tag} ${definition.name}: ${input.message}`,
        });
        continue;
      }
      const coerced = coerceValue(definition, input.input);
      if (!coerced.ok) {
        reject({ ...here, code: 'DAT_IMPORT_TYPE', message: `${object.tag}: ${coerced.message}` });
        continue;
      }
      if (sameValue(current, coerced.value)) {
        unchanged++;
        continue;
      }
      if (changes.length >= MAX_CHANGES)
        return {
          ok: false,
          code: 'DAT_IMPORT_FORMAT',
          message: `the sheet changes more than ${MAX_CHANGES} values: split it (export one hierarchy node or class at a time)`,
          paths: [here.cell],
        };
      changes.push({
        changeId: sha256Hex(`${object.id}|${definition.name}|${JSON.stringify(coerced.value)}`).slice(0, 12),
        objectId: object.id,
        tag: object.tag,
        property: definition.name,
        from: current ?? null,
        to: coerced.value,
        cell: here.cell,
        row: sheetRow.row,
      });
    }
  }
  return { ok: true, diff: { changes, rejected, rejectedCount, unchanged, rowsRead, rowsMatched } };
}

type Found = { readonly ok: true; readonly object: PlantObject } | { readonly ok: false; readonly rejection: Omit<ImportRejection, 'row'> };

/** The plant object a row stands for: the ObjectId cell (plant object id, then the id of its model object), else the Tag cell. */
function resolveRow(
  data: PlantDataModel,
  row: SheetRow,
  idColumn: Column | undefined,
  tagColumn: Column | undefined,
  keyColumn: KeyColumn,
  byModel: ReadonlyMap<string, string[]>,
): Found {
  const text = (column: Column | undefined): string => {
    const cell = column === undefined ? null : (row.cells[column.index] ?? null);
    return cell === null || typeof cell === 'object' ? '' : String(cell).normalize('NFC').trim();
  };
  const idText = keyColumn === 'Tag' ? '' : text(idColumn);
  const tagText = keyColumn === 'ObjectId' ? '' : text(tagColumn);
  const column = idText !== '' ? idColumn : tagColumn;
  const miss = (code: string, message: string): Found => ({
    ok: false,
    rejection: { code, message, column: column?.header ?? '', cell: cellReference(column?.index ?? 0, row.row) },
  });
  if (idText === '' && tagText === '') return miss('DAT_IMPORT_KEY_MISSING', 'the row has neither an ObjectId nor a Tag');
  if (idText !== '') {
    const direct = data.objects[idText];
    if (direct !== undefined) return { ok: true, object: direct };
    const modelIds = byModel.get(idText) ?? [];
    if (modelIds.length === 1) return { ok: true, object: data.objects[modelIds[0] as string] as PlantObject };
    if (modelIds.length > 1) return miss('DAT_IMPORT_UNKNOWN_OBJECT', `"${idText}" stands for several plant objects: use the Tag key`);
    if (tagText === '' || keyColumn === 'ObjectId')
      return miss('DAT_IMPORT_UNKNOWN_OBJECT', `no plant object has the id "${idText.slice(0, 80)}"`);
  }
  const viaTag = objectByRef(data, tagText);
  if (viaTag === 'ambiguous')
    return miss('DAT_IMPORT_UNKNOWN_OBJECT', `the tag "${tagText}" exists in several scopes: use the ObjectId key`);
  if (viaTag === null) return miss('DAT_IMPORT_UNKNOWN_OBJECT', `no plant object has the tag "${tagText.slice(0, 80)}"`);
  return { ok: true, object: viaTag };
}
