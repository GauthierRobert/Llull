/** Test-side XLSX reader (an oracle independent of the writer): sheet names in order and their cells as rows of strings / numbers / booleans, plus protection and unlocked columns. */

import { unzip } from './unzipStore';

export type Cell = string | number | boolean | null;

export interface ReadSheet {
  readonly name: string;
  readonly rows: Cell[][];
  readonly protectedSheet: boolean;
  /** Cell style index per reference (`B2` -> 1). */
  readonly styles: Map<string, number>;
}

const decode = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const text = (bytes: Uint8Array | undefined): string => (bytes === undefined ? '' : new TextDecoder().decode(bytes));

function columnIndex(reference: string): number {
  let index = 0;
  for (const letter of /^[A-Z]+/.exec(reference)?.[0] ?? '') index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

export function readXlsx(bytes: Uint8Array): { files: Map<string, Uint8Array>; sheets: ReadSheet[]; unlockedStyles: Set<number> } {
  const files = unzip(bytes);
  const shared = [...text(files.get('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    decode([...(match[1] as string).matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join('')),
  );
  const workbook = text(files.get('xl/workbook.xml'));
  const names = [...workbook.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((match) => decode(match[1] as string));
  const sheets = names.map((name, index): ReadSheet => {
    const xml = text(files.get(`xl/worksheets/sheet${index + 1}.xml`));
    const rows: Cell[][] = [];
    const styles = new Map<string, number>();
    for (const row of xml.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: Cell[] = [];
      for (const cell of (row[2] as string).matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1] as string;
        const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1] as string;
        const type = /t="([^"]*)"/.exec(attributes)?.[1];
        styles.set(reference, Number(/s="(\d+)"/.exec(attributes)?.[1] ?? 0));
        const inner = cell[2] ?? '';
        let value: Cell = null;
        if (type === 'inlineStr') value = decode(/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '');
        else if (type === 's') value = shared[Number(/<v>(.*?)<\/v>/.exec(inner)?.[1])] ?? null;
        else if (type === 'b') value = /<v>1<\/v>/.test(inner);
        else if (/<v>/.test(inner)) value = Number(/<v>(.*?)<\/v>/.exec(inner)?.[1]);
        cells[columnIndex(reference)] = value;
      }
      rows.push(Array.from(cells, (value) => value ?? null));
    }
    return { name, rows, protectedSheet: /<sheetProtection [^>]*sheet="1"/.test(xml), styles };
  });
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(text(files.get('xl/styles.xml')))?.[1] ?? '';
  const unlockedStyles = new Set(
    [...xfs.matchAll(/<xf [^>]*?(?:\/>|>([\s\S]*?)<\/xf>)/g)].flatMap((xf, index) => (/locked="0"/.test(xf[1] ?? '') ? [index] : [])),
  );
  return { files, sheets, unlockedStyles };
}
