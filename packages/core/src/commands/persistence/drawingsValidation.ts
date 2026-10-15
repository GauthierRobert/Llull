import { PAPER_SIZES, PROJECTION_ANGLES, VIEW_DIRECTIONS, VIEW_KINDS } from '../../model/sheet';
import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isReservedKey } from '../../lib/reservedKey';

const isOneOf = (list: ReadonlyArray<string>, value: unknown): boolean => typeof value === 'string' && list.includes(value);
const isPair = (value: unknown): boolean => Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
const isOptional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value);
const isPositive = (value: unknown): boolean => isFiniteNumber(value) && value > 0;

function viewProblem(sheetId: string, index: number, view: unknown, viewIds: ReadonlySet<string>): string | null {
  const where = `sheet '${sheetId}': views[${index}]`;
  if (!isRecord(view)) return `${where} is not an object`;
  if (typeof view['id'] !== 'string' || typeof view['label'] !== 'string') return `${where}: id and label must be strings`;
  const kind = view['kind'];
  if (!isOneOf(VIEW_KINDS, kind)) return `${where}: kind must be one of ${VIEW_KINDS.join(', ')}`;
  if (kind !== 'detail' && !isOneOf(VIEW_DIRECTIONS, view['direction']))
    return `${where}: direction must be one of ${VIEW_DIRECTIONS.join(', ')}`;
  if (view['entityIds'] !== undefined && !isStringArray(view['entityIds'])) return `${where}: entityIds must be an array of strings`;
  if (!isOptional(view['position'], isPair)) return `${where}: position must be [x, y] of finite numbers`;
  if (!isOptional(view['scale'], isPositive)) return `${where}: scale must be a positive number`;
  if (!isOptional(view['mark'], (v) => typeof v === 'string')) return `${where}: mark must be a string`;
  const section = view['section'];
  if (kind === 'section') {
    if (!isRecord(section) || !isFiniteNumber(section['offset'])) return `${where}: a section view needs section.offset (finite number)`;
    const parent = section['parentViewId'];
    if (parent !== undefined && (typeof parent !== 'string' || !viewIds.has(parent)))
      return `${where}: section.parentViewId is not a view of this sheet`;
  }
  const detail = view['detail'];
  if (kind === 'detail') {
    if (!isRecord(detail) || !isPair(detail['center']) || !isPositive(detail['radius']))
      return `${where}: a detail view needs detail.center [x, y] and detail.radius > 0`;
    if (typeof detail['parentViewId'] !== 'string' || !viewIds.has(detail['parentViewId']))
      return `${where}: detail.parentViewId is not a view of this sheet`;
  }
  return null;
}

/** First problem of a saved drawing sheet, or null. */
function sheetProblem(key: string, sheet: unknown): string | null {
  if (!isRecord(sheet)) return `sheet '${key}' is not an object`;
  if (sheet['id'] !== key) return `sheet record key '${key}' does not match sheet.id '${String(sheet['id'])}'`;
  if (typeof sheet['name'] !== 'string') return `sheet '${key}': name must be a string`;
  if (!isOneOf(PAPER_SIZES, sheet['paper'])) return `sheet '${key}': paper must be one of ${PAPER_SIZES.join(', ')}`;
  if (!isOneOf(PROJECTION_ANGLES, sheet['projectionAngle'])) return `sheet '${key}': projectionAngle must be first or third`;
  if (!isOptional(sheet['scale'], isPositive)) return `sheet '${key}': scale must be a positive number`;
  const block = sheet['titleBlock'];
  const fields = ['title', 'drawnBy', 'partNumber', 'revision', 'date'];
  if (!isRecord(block) || typeof block['title'] !== 'string' || !fields.every((f) => isOptional(block[f], (v) => typeof v === 'string')))
    return `sheet '${key}': titleBlock needs a string title; drawnBy, partNumber, revision, date must be strings when present`;
  const views = sheet['views'];
  if (!Array.isArray(views)) return `sheet '${key}': views must be an array`;
  const ids = views.map((view) => (isRecord(view) ? view['id'] : undefined));
  if (new Set(ids).size !== ids.length) return `sheet '${key}': duplicate view ids`;
  const known = new Set(ids.filter((id): id is string => typeof id === 'string'));
  for (let index = 0; index < views.length; index++) {
    const problem = viewProblem(key, index, views[index], known);
    if (problem !== null) return problem;
  }
  return null;
}

/** Problems of the optional `drawings` field of a raw document (absent is valid). */
export function drawingsProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value) || !isRecord(value['sheets']) || !isStringArray(value['order']))
    return ['drawings must be { sheets: object, order: string[] }'];
  const { sheets, order } = value;
  const errors: string[] = [];
  for (const [key, sheet] of Object.entries(sheets)) {
    if (isReservedKey(key)) errors.push(`drawings.sheets: id '${key}' is a reserved JavaScript property name`);
    const problem = sheetProblem(key, sheet);
    if (problem !== null) errors.push(problem);
  }
  const listed = new Set(order);
  if (listed.size !== order.length) errors.push('drawings.order contains duplicate sheet ids');
  for (const id of order) if (!Object.hasOwn(sheets, id)) errors.push(`drawings.order: '${id}' does not reference a known sheet`);
  for (const id of Object.keys(sheets)) if (!listed.has(id)) errors.push(`drawings.order is missing sheet '${id}'`);
  return errors;
}
