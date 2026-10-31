/**
 * XLSX reader for untrusted files (SpreadsheetML subset, ISO/IEC 29500): sheet names in order, hidden state and cell VALUES. Formulas are never
 * evaluated: a formula cell yields its cached value, or an `unreadable` marker when it has none. Pure; never throws, returns a coded error.
 * @invariant only workbook.xml, its rels, sharedStrings.xml and worksheet parts are inflated (other entries are skipped), and only up to `maxInflatedBytes`
 *   in total, so a zip bomb costs at most that much; entry names are checked (length, count, no traversal) before anything is inflated; XML goes through
 *   `readXml` (no DTD, bounded depth and elements); rows, columns, cells and string lengths are bounded; linear in the file
 */

import { readXml, xmlAttr, xmlChildren, xmlText, type XmlElement } from './xmlRead';
import { unzip } from './zipRead';

interface XlsxUnreadable {
  readonly unreadable: 'formula' | 'error' | 'text';
  readonly detail: string;
}

export type XlsxReadCell = string | number | boolean | null | XlsxUnreadable;

interface XlsxReadRow {
  /** 1-based sheet row. */
  readonly row: number;
  /** Cells from column A, holes are null. */
  readonly cells: XlsxReadCell[];
}

export interface XlsxReadSheet {
  readonly name: string;
  readonly hidden: boolean;
  /** Rows that hold at least one cell, in ascending row order. */
  readonly rows: XlsxReadRow[];
}

export interface XlsxReadLimits {
  /** Size of the file (default 32 MiB). */
  readonly maxFileBytes?: number;
  /** Decompressed size of all read parts together (default 48 MiB). */
  readonly maxInflatedBytes?: number;
  /** Entries of the archive (default 512). */
  readonly maxEntries?: number;
  /** Columns of a sheet (default 1 024). */
  readonly maxColumns?: number;
  /** Rows of a sheet (default 1 048 576). */
  readonly maxRows?: number;
  /** Cells held in memory over all sheets, holes included (default 4 000 000). */
  readonly maxCells?: number;
}

type XlsxErrorCode = 'XLSX_ZIP' | 'XLSX_UNSAFE_ENTRY' | 'XLSX_TOO_LARGE' | 'XLSX_XML' | 'XLSX_STRUCTURE';

export type XlsxReadResult =
  | { readonly ok: true; readonly sheets: XlsxReadSheet[] }
  | { readonly ok: false; readonly code: XlsxErrorCode; readonly message: string };

class XlsxFailure {
  constructor(
    readonly code: XlsxErrorCode,
    readonly message: string,
  ) {}
}

const MAX_NAME_LENGTH = 255;
const MAX_SHEETS = 255;
const MAX_CELL_CHARS = 32_767;
const MAX_RATIO = 1000;
const RATIO_FLOOR = 8 << 20;
const NEEDED = /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/;
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CELL_REFERENCE = /^([A-Z]{1,3})([0-9]{1,7})$/;

function unsafeName(name: string): boolean {
  return (
    name.length > MAX_NAME_LENGTH ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((part) => part === '..')
  );
}

function columnIndex(letters: string): number {
  let index = 0;
  for (let at = 0; at < letters.length; at++) index = index * 26 + letters.charCodeAt(at) - 64;
  return index - 1;
}

function parseXml(bytes: Uint8Array | undefined, part: string, maxChars: number): XmlElement {
  if (bytes === undefined) throw new XlsxFailure('XLSX_STRUCTURE', `the workbook has no ${part}`);
  const parsed = readXml(new TextDecoder().decode(bytes), { maxChars, maxDepth: 64, maxElements: 4_000_000 });
  if (!parsed.ok) throw new XlsxFailure('XLSX_XML', `${part}: ${parsed.error.code} at line ${parsed.error.line}: ${parsed.error.message}`);
  return parsed.root;
}

/** Text of a `si` / `is` element: its `t` children and the `t` of its runs, phonetic runs skipped; null when longer than a cell may be. */
function richText(element: XmlElement): string | null {
  let text = '';
  for (const child of element.children) {
    if (child.type !== 'element') continue;
    if (child.local === 't') text += xmlText(child);
    else if (child.local === 'r') for (const part of xmlChildren(child, 't')) text += xmlText(part);
    if (text.length > MAX_CELL_CHARS) return null;
  }
  return text;
}

/** Part name of a relationship target of the workbook: relative to `xl/`, `.` and `..` resolved, never above the package root. */
function partOf(target: string): string {
  const parts: string[] = target.startsWith('/') ? [] : ['xl'];
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.pop() === undefined)
        throw new XlsxFailure('XLSX_UNSAFE_ENTRY', `relationship target "${target.slice(0, 80)}" leaves the package`);
    } else parts.push(segment);
  }
  return parts.join('/');
}

function cellValue(cell: XmlElement, shared: readonly (string | null)[]): XlsxReadCell {
  const type = xmlAttr(cell, 't') ?? 'n';
  const valueElement = xmlChildren(cell, 'v')[0];
  const raw = valueElement === undefined ? '' : xmlText(valueElement);
  const formula = xmlChildren(cell, 'f')[0];
  if (type === 'inlineStr') {
    const inline = xmlChildren(cell, 'is')[0];
    const text = inline === undefined ? '' : richText(inline);
    return text === null ? { unreadable: 'text', detail: `text longer than ${MAX_CELL_CHARS} characters` } : text;
  }
  if (formula !== undefined && raw === '')
    return { unreadable: 'formula', detail: `=${xmlText(formula).slice(0, 80)} has no cached value (formulas are never evaluated)` };
  if (type === 'e') return { unreadable: 'error', detail: raw.slice(0, 40) };
  if (type === 's') {
    const index = /^[0-9]{1,9}$/.test(raw.trim()) ? Number(raw) : -1;
    const text = shared[index];
    if (text === undefined) return { unreadable: 'error', detail: `shared string ${raw.slice(0, 20)} does not exist` };
    return text === null ? { unreadable: 'text', detail: `text longer than ${MAX_CELL_CHARS} characters` } : text;
  }
  if (type === 'b') return raw.trim() === '1';
  if (type === 'str' || type === 'd') return raw.length > MAX_CELL_CHARS ? { unreadable: 'text', detail: 'text too long' } : raw;
  if (raw.trim() === '') return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : { unreadable: 'error', detail: `"${raw.slice(0, 40)}" is not a number` };
}

interface Budget {
  cells: number;
}

function readSheet(root: XmlElement, shared: readonly (string | null)[], limits: Required<XlsxReadLimits>, budget: Budget): XlsxReadRow[] {
  const rows: XlsxReadRow[] = [];
  const data = xmlChildren(root, 'sheetData')[0];
  if (data === undefined) return rows;
  let previous = 0;
  for (const rowElement of xmlChildren(data, 'row')) {
    const declared = xmlAttr(rowElement, 'r');
    const row = declared === undefined ? previous + 1 : /^[0-9]{1,8}$/.test(declared) ? Number(declared) : 0;
    if (row < 1 || row > limits.maxRows)
      throw new XlsxFailure('XLSX_STRUCTURE', `row ${declared ?? previous + 1} is outside 1..${limits.maxRows}`);
    if (row <= previous) throw new XlsxFailure('XLSX_STRUCTURE', `row ${row} follows row ${previous}: rows must ascend`);
    previous = row;
    const cells: XlsxReadCell[] = [];
    let next = 0;
    for (const cell of xmlChildren(rowElement, 'c')) {
      const reference = CELL_REFERENCE.exec(xmlAttr(cell, 'r') ?? '');
      const column = reference === null ? next : columnIndex(reference[1] as string);
      if (column >= limits.maxColumns)
        throw new XlsxFailure('XLSX_STRUCTURE', `column ${column + 1} of row ${row} is beyond the ${limits.maxColumns} column limit`);
      next = column + 1;
      const value = cellValue(cell, shared);
      if (value === null && cells.length <= column) continue;
      while (cells.length < column) cells.push(null);
      cells[column] = value;
    }
    budget.cells += cells.length;
    if (budget.cells > limits.maxCells) throw new XlsxFailure('XLSX_TOO_LARGE', `more than ${limits.maxCells} cells`);
    if (cells.some((cell) => cell !== null)) rows.push({ row, cells });
  }
  return rows;
}

function sharedStrings(bytes: Uint8Array | undefined, maxChars: number): (string | null)[] {
  if (bytes === undefined) return [];
  return xmlChildren(parseXml(bytes, 'xl/sharedStrings.xml', maxChars), 'si').map(richText);
}

function readPackage(bytes: Uint8Array, limits: Required<XlsxReadLimits>): XlsxReadSheet[] {
  if (bytes.length > limits.maxFileBytes)
    throw new XlsxFailure('XLSX_TOO_LARGE', `the file has ${bytes.length} bytes, the limit is ${limits.maxFileBytes}`);
  let entries = 0;
  let parts: ReturnType<typeof unzip>;
  try {
    parts = unzip(bytes, {
      maxBytes: limits.maxInflatedBytes,
      select: (name) => {
        if (++entries > limits.maxEntries) throw new XlsxFailure('XLSX_TOO_LARGE', `more than ${limits.maxEntries} archive entries`);
        if (unsafeName(name))
          throw new XlsxFailure('XLSX_UNSAFE_ENTRY', `archive entry name "${name.slice(0, 80)}" is not a plain relative path`);
        return NEEDED.test(name);
      },
    });
  } catch (error) {
    if (error instanceof XlsxFailure) throw error;
    const message = error instanceof Error ? error.message : 'unreadable archive';
    throw new XlsxFailure(/limit|exceeds/.test(message) ? 'XLSX_TOO_LARGE' : 'XLSX_ZIP', message);
  }
  const files = new Map(parts.map((part) => [part.name, part.data] as const));
  const inflated = parts.reduce((sum, part) => sum + part.data.length, 0);
  if (inflated > RATIO_FLOOR && inflated / Math.max(1, bytes.length) > MAX_RATIO)
    throw new XlsxFailure('XLSX_TOO_LARGE', `the parts inflate ${Math.round(inflated / bytes.length)} times (a zip bomb)`);
  const maxChars = limits.maxInflatedBytes;
  const workbook = parseXml(files.get('xl/workbook.xml'), 'xl/workbook.xml', maxChars);
  const relationships = new Map<string, string>();
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (rels !== undefined)
    for (const rel of xmlChildren(parseXml(rels, 'xl/_rels/workbook.xml.rels', maxChars), 'Relationship')) {
      const id = xmlAttr(rel, 'Id');
      const target = xmlAttr(rel, 'Target');
      if (id !== undefined && target !== undefined) relationships.set(id, target);
    }
  const declared = xmlChildren(xmlChildren(workbook, 'sheets')[0] ?? workbook, 'sheet');
  if (declared.length === 0) throw new XlsxFailure('XLSX_STRUCTURE', 'the workbook lists no sheet');
  if (declared.length > MAX_SHEETS) throw new XlsxFailure('XLSX_TOO_LARGE', `more than ${MAX_SHEETS} sheets`);
  const shared = sharedStrings(files.get('xl/sharedStrings.xml'), maxChars);
  const budget: Budget = { cells: 0 };
  return declared.map((sheet, index): XlsxReadSheet => {
    const relationship = sheet.attributes.find((attribute) => attribute.local === 'id' && attribute.namespace === NS_REL)?.value;
    const target = relationship === undefined ? undefined : relationships.get(relationship);
    const part = partOf(target ?? `worksheets/sheet${index + 1}.xml`);
    const name = xmlAttr(sheet, 'name') ?? `Sheet${index + 1}`;
    const state = xmlAttr(sheet, 'state');
    return {
      name,
      hidden: state === 'hidden' || state === 'veryHidden',
      rows: readSheet(parseXml(files.get(part), part, maxChars), shared, limits, budget),
    };
  });
}

/** Reads an XLSX workbook. Never throws. */
export function readXlsx(bytes: Uint8Array, limits: XlsxReadLimits = {}): XlsxReadResult {
  const resolved: Required<XlsxReadLimits> = {
    maxFileBytes: limits.maxFileBytes ?? 32 << 20,
    maxInflatedBytes: limits.maxInflatedBytes ?? 48 << 20,
    maxEntries: limits.maxEntries ?? 512,
    maxColumns: limits.maxColumns ?? 1024,
    maxRows: limits.maxRows ?? 1_048_576,
    maxCells: limits.maxCells ?? 4_000_000,
  };
  try {
    return { ok: true, sheets: readPackage(bytes, resolved) };
  } catch (error) {
    if (error instanceof XlsxFailure) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'XLSX_ZIP', message: error instanceof Error ? error.message : 'the file could not be read' };
  }
}
