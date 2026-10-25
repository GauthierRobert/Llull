/** PCF lexer (plant 05 ISO §5.1 step 1): lines, syntax limits, the ISOGEN-FILES header. Pure; every refusal carries its code and `line N` path. */

export const MAX_PCF_CHARS = 16 * 1024 * 1024;
export const MAX_PCF_LINES = 200_000;
export const MAX_PCF_LINE = 1024;

export interface LexLine {
  /** 1-based line number in the file. */
  readonly n: number;
  /** The line without its end of line and trailing blanks. */
  readonly raw: string;
  /** Starts with a blank: an attribute of the open record. */
  readonly indented: boolean;
  /** First word. */
  readonly key: string;
  /** Text after the key, blanks trimmed, inner spacing kept. */
  readonly rest: string;
}

export interface LexRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly paths: readonly string[];
}

export type LexResult = { readonly ok: true; readonly lines: readonly LexLine[] } | LexRefusal;

const refusal = (code: string, message: string, paths: readonly string[]): LexRefusal => ({ ok: false, code, message, paths });

/** Non-blank lines of `text`, or the first syntax refusal (size, TAB, 1024 characters, header) in file order. */
export function lexPcf(text: string): LexResult {
  if (text.length > MAX_PCF_CHARS)
    return refusal('ISO_PCF_TOO_LARGE', `the file has ${text.length} characters (limit ${MAX_PCF_CHARS})`, []);
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const physical = source.split('\n');
  if (physical.length > MAX_PCF_LINES)
    return refusal('ISO_PCF_TOO_LARGE', `the file has ${physical.length} lines (limit ${MAX_PCF_LINES})`, []);
  const lines: LexLine[] = [];
  for (const [index, physicalLine] of physical.entries()) {
    const n = index + 1;
    const line = physicalLine.endsWith('\r') ? physicalLine.slice(0, -1) : physicalLine;
    if (line.includes('\t')) return refusal('ISO_PCF_TAB', `TAB character on line ${n}`, [`line ${n}`]);
    if (line.length > MAX_PCF_LINE)
      return refusal('ISO_PCF_LINE_TOO_LONG', `line ${n} has ${line.length} characters (limit ${MAX_PCF_LINE})`, [`line ${n}`]);
    const raw = line.trimEnd();
    if (raw === '') continue;
    const trimmed = raw.trimStart();
    const split = trimmed.search(/\s/);
    const key = split < 0 ? trimmed : trimmed.slice(0, split);
    lines.push({ n, raw, indented: raw !== trimmed, key, rest: split < 0 ? '' : trimmed.slice(split).trim() });
  }
  const first = lines[0];
  if (first === undefined || first.indented || first.key !== 'ISOGEN-FILES')
    return refusal('ISO_PCF_HEADER', `the first line must start with ISOGEN-FILES (line ${first?.n ?? 1})`, [`line ${first?.n ?? 1}`]);
  return { ok: true, lines };
}
