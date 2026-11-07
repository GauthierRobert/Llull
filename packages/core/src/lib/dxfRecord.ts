/** One DXF record (a group-0 type plus its code/value pairs) and typed accessors, shared by the ASCII reader and its shape parsers. */

import type { Vec3 } from '../model/vectors';

export interface DxfRecord {
  readonly type: string;
  readonly codes: ReadonlyArray<readonly [number, string]>;
  /** VERTEX records of a POLYLINE. */
  readonly vertices?: readonly DxfRecord[];
}

export function codeValue(record: DxfRecord, code: number): string | undefined {
  return record.codes.find(([candidate]) => candidate === code)?.[1];
}

export function codeNumber(record: DxfRecord, code: number, fallback: number): number {
  const value = Number(codeValue(record, code));
  return codeValue(record, code) !== undefined && Number.isFinite(value) ? value : fallback;
}

/** The point of codes (10 + offset, 20 + offset, 30 + offset); missing coordinates are 0. */
export function point(record: DxfRecord, offset = 0): Vec3 {
  return [codeNumber(record, 10 + offset, 0), codeNumber(record, 20 + offset, 0), codeNumber(record, 30 + offset, 0)];
}

/** Decodes AutoCAD `\U+XXXX` escapes (what `export_dxf` writes for non-ASCII characters). */
export function decodeDxfText(text: string): string {
  return text.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

const CONTROL_CODES: Readonly<Record<string, string>> = { d: '\u00b0', p: '\u00b1', c: '\u00d8', '%': '%' };

/** Decodes the TEXT control codes `%%d` (degree), `%%p` (plus-minus), `%%c` (diameter) and `%%%` (percent). */
export function decodeTextControls(text: string): string {
  return text.replace(/%%([%dDpPcC])/g, (_match, code: string) => CONTROL_CODES[code.toLowerCase()] as string);
}

/** Single-line TEXT contents safe from control codes and escapes: a literal `%%` becomes `%%%` per percent, a backslash before `U+` is `\U+005C`. */
export function encodeTextLiterals(text: string): string {
  const percent = text.includes('%%') ? text.replace(/%/g, '%%%') : text;
  return percent.replace(/\\(?=U\+)/g, '\\U+005C');
}
