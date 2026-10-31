/**
 * Deterministic XLSX writer (SpreadsheetML subset, ISO/IEC 29500): one worksheet per table, inline strings, plain numbers, booleans, two cell
 * formats (locked, unlocked) and optional sheet protection (marks intent like Plant 3D, it is not security). Entries are written in a fixed order
 * with deflate and a fixed DOS timestamp, so equal input gives equal bytes. Pure.
 */

import { crc32 } from './crc32';
import { deflateRaw } from './deflate';
import { escapeXml } from './escapeXml';
import { zipChunked, type ZipChunkedEntry } from './zip';

export type XlsxCell = string | number | boolean | null;

interface XlsxColumn {
  /** Text of the header cell (always locked). */
  readonly header: string;
  /** Cells of the column are read-only when the sheet is protected (default true). */
  readonly locked?: boolean;
}

export interface XlsxSheet {
  /** Worksheet name: make it valid with `xlsxSheetName`. */
  readonly name: string;
  readonly columns: readonly XlsxColumn[];
  /** One array per row, one cell per column (a short row is padded with empty cells). */
  readonly rows: readonly (readonly XlsxCell[])[];
  /** Adds `<sheetProtection sheet="1"/>` (no password). */
  readonly protect?: boolean;
}

const XLSX_MAX_ROWS = 1_048_576;
const XLSX_MAX_COLUMNS = 16_384;
const NAME_LIMIT = 31;

/** A valid, unique worksheet name: forbidden characters `\ / ? * [ ] :` become `_`, at most 31 characters, never empty, not the same as a name in `taken` (case-insensitive). */
export function xlsxSheetName(wanted: string, taken: readonly string[]): string {
  const base =
    wanted
      .replace(/[\\/?*[\]:]/g, '_')
      .replace(/^'+|'+$/g, '')
      .slice(0, NAME_LIMIT) || 'Sheet';
  const used = new Set(taken.map((name) => name.toLowerCase()));
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n += 1) {
    const suffix = `_${n}`;
    name = `${base.slice(0, NAME_LIMIT - suffix.length)}${suffix}`;
  }
  return name;
}

/** Column letters of a zero-based column index: 0 -> A, 26 -> AA. */
export function xlsxColumnLetters(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const LOCKED = 0;
const UNLOCKED = 1;

function cellXml(reference: string, value: XlsxCell, style: number): string {
  if (typeof value === 'string' && value !== '')
    return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${reference}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return style === UNLOCKED ? `<c r="${reference}" s="${style}"/>` : '';
}

function sheetXml(sheet: XlsxSheet): string {
  const letters = sheet.columns.map((_column, index) => xlsxColumnLetters(index));
  const styles = sheet.columns.map((column) => (column.locked === false ? UNLOCKED : LOCKED));
  const parts: string[] = [XML_HEAD, `<worksheet xmlns="${NS_MAIN}"><sheetData>`];
  parts.push(`<row r="1">${sheet.columns.map((column, index) => cellXml(`${letters[index]}1`, column.header, LOCKED)).join('')}</row>`);
  sheet.rows.forEach((row, rowIndex) => {
    const number = rowIndex + 2;
    const cells = letters.map((letter, index) => cellXml(`${letter}${number}`, row[index] ?? null, styles[index] ?? LOCKED)).join('');
    parts.push(`<row r="${number}">${cells}</row>`);
  });
  parts.push('</sheetData>');
  if (sheet.protect === true) parts.push('<sheetProtection sheet="1"/>');
  parts.push('</worksheet>');
  return parts.join('');
}

const STYLES_XML =
  `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

function packageEntries(sheets: readonly XlsxSheet[]): { name: string; text: string }[] {
  const sheetNumbers = sheets.map((_sheet, index) => index + 1);
  return [
    {
      name: '[Content_Types].xml',
      text:
        `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheetNumbers
          .map(
            (n) =>
              `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      text:
        `${XML_HEAD}<Relationships xmlns="${NS_PACKAGE_REL}"><Relationship Id="rId1" ` +
        `Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      text:
        `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
        sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text:
        `${XML_HEAD}<Relationships xmlns="${NS_PACKAGE_REL}">` +
        sheetNumbers.map((n) => `<Relationship Id="rId${n}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${n}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/styles.xml', text: STYLES_XML },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, text: sheetXml(sheet) })),
  ];
}

function deflated(name: string, text: string): ZipChunkedEntry {
  const data = new TextEncoder().encode(text);
  const packed = deflateRaw(data);
  const smaller = packed.length < data.length;
  const body = smaller ? packed : data;
  return { name, method: smaller ? 8 : 0, crc: crc32(data), size: data.length, chunks: [body], storedSize: body.length };
}

/**
 * The bytes of an XLSX workbook with `sheets` in the given order.
 * @invariant equal input -> equal bytes (fixed entry order and timestamp)
 * @failure no sheet, a sheet over XLSX_MAX_ROWS rows or XLSX_MAX_COLUMNS columns, a name that is not valid (see xlsxSheetName) or duplicated -> Error
 */
export function xlsxWrite(sheets: readonly XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error('a workbook needs at least one sheet');
  const names = new Set<string>();
  for (const sheet of sheets) {
    const key = sheet.name.toLowerCase();
    if (sheet.name === '' || sheet.name.length > NAME_LIMIT || /[\\/?*[\]:]/.test(sheet.name) || names.has(key))
      throw new Error(`invalid or duplicate sheet name "${sheet.name}"`);
    if (sheet.rows.length + 1 > XLSX_MAX_ROWS || sheet.columns.length > XLSX_MAX_COLUMNS)
      throw new Error(`sheet "${sheet.name}" exceeds the ${XLSX_MAX_ROWS} row / ${XLSX_MAX_COLUMNS} column limit`);
    names.add(key);
  }
  return zipChunked(packageEntries(sheets).map((entry) => deflated(entry.name, entry.text)));
}
