/**
 * Survey point file parsing (PENZD / PNEZD / ENZ / NEZ, comma / tab / space / semicolon separated).
 * @layer domain-aec/civil
 * @pure
 */

export const SURVEY_FORMATS = ['PENZD', 'PNEZD', 'PENZ', 'PNEZ', 'ENZ', 'NEZ'] as const;

export type SurveyFormat = (typeof SURVEY_FORMATS)[number];

export interface ParsedPoint {
  readonly number: string;
  readonly easting: number;
  readonly northing: number;
  readonly elevation: number;
  readonly code?: string;
}

export interface ParsedSurvey {
  readonly points: ParsedPoint[];
  /** 1-based line numbers that held text but no valid point (headers, comments excluded). */
  readonly rejectedLines: number[];
}

function splitFields(line: string): string[] {
  const delimiter = line.includes(',')
    ? ','
    : line.includes(';')
      ? ';'
      : line.includes('\t')
        ? '\t'
        : /\s+/;
  return line
    .split(delimiter)
    .map((field) => field.trim())
    .filter((field, index, all) => field !== '' || index < all.length - 1);
}

function isNumber(text: string | undefined): boolean {
  return text !== undefined && text !== '' && Number.isFinite(Number(text));
}

/** Parse survey text; the first line is skipped as a header when its coordinates are not numeric. */
export function parseSurvey(text: string, format: SurveyFormat): ParsedSurvey {
  const numbered = format.startsWith('P');
  const eastFirst = format.replace('P', '').startsWith('E');
  const points: ParsedPoint[] = [];
  const rejectedLines: number[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('//')) return;
    const fields = splitFields(line);
    const offset = numbered ? 1 : 0;
    const [first, second, third] = [fields[offset], fields[offset + 1], fields[offset + 2]];
    if (!isNumber(first) || !isNumber(second) || !isNumber(third)) {
      if (index > 0 || points.length > 0) rejectedLines.push(index + 1);
      return;
    }
    const a = Number(first);
    const b = Number(second);
    const code = format.endsWith('D') ? fields.slice(offset + 3).join(' ') : '';
    points.push({
      number: numbered ? (fields[0] as string) : String(points.length + 1),
      easting: eastFirst ? a : b,
      northing: eastFirst ? b : a,
      elevation: Number(third),
      ...(code !== '' ? { code } : {}),
    });
  });
  return { points, rejectedLines };
}
