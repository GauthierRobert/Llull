/**
 * @layer tests/production/oracle
 *
 * Drawing-sheet reader for issued SVG sheets: paper size, the texts printed on the sheet and the
 * title block — what a checker (vérificateur) reads before a sheet is signed off.
 */

export interface Sheet {
  widthMm: number;
  heightMm: number;
  title: string;
  /** Every <text>/<tspan> content, XML-unescaped, whitespace-collapsed. */
  texts: string[];
  /** Texts inside the element with id="title-block" (empty when it is missing). */
  titleBlock: string[];
  errors: string[];
}

/** ISO 216 landscape sheets, mm. */
export const ISO_PAPER: Record<string, [number, number]> = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
};

/** Standard drawing scales (1:N) a European office plots at. */
export const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];

function unescape(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function textsIn(markup: string): string[] {
  const texts: string[] = [];
  for (const match of markup.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)) {
    const inner = (match[1] ?? '').replace(/<[^>]+>/g, ' ');
    const text = unescape(inner).replace(/\s+/g, ' ').trim();
    if (text !== '') texts.push(text);
  }
  return texts;
}

/** The markup of the element carrying `id`, through its matching close tag. */
function elementById(svg: string, id: string): string {
  const start = svg.search(new RegExp(`<(\\w+)\\b[^>]*\\bid="${id}"`));
  if (start < 0) return '';
  const tag = /<(\w+)/.exec(svg.slice(start))?.[1] ?? 'g';
  let depth = 0;
  const pattern = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}>`, 'g');
  pattern.lastIndex = start;
  for (let match = pattern.exec(svg); match; match = pattern.exec(svg)) {
    if (match[0].startsWith('</')) depth--;
    else if (match[1] !== '/') depth++;
    if (depth === 0) return svg.slice(start, pattern.lastIndex);
  }
  return svg.slice(start);
}

export function parseSheet(svg: string): Sheet {
  const errors: string[] = [];
  if (!/^\s*(<\?xml[^>]*>\s*)?<svg\b/.test(svg)) errors.push('not an SVG document');
  if (!/<\/svg>\s*$/.test(svg)) errors.push('unterminated SVG');
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const widthMm = Number(/\bwidth="([\d.]+)mm"/.exec(root)?.[1] ?? NaN);
  const heightMm = Number(/\bheight="([\d.]+)mm"/.exec(root)?.[1] ?? NaN);
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm)) {
    errors.push('sheet size is not given in millimetres');
  }
  const viewBox = /\bviewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(root);
  if (!viewBox || Number(viewBox[1]) !== widthMm || Number(viewBox[2]) !== heightMm) {
    errors.push('viewBox user units are not millimetres (prints at the wrong scale)');
  }
  return {
    widthMm,
    heightMm,
    title: unescape(/<title>([\s\S]*?)<\/title>/.exec(svg)?.[1] ?? ''),
    texts: textsIn(svg),
    titleBlock: textsIn(elementById(svg, 'title-block')),
    errors,
  };
}

/** The ISO sheet name matching the paper size, or null. */
export function paperName(sheet: Sheet): string | null {
  const found = Object.entries(ISO_PAPER).find(
    ([, [w, h]]) => Math.abs(w - sheet.widthMm) < 0.5 && Math.abs(h - sheet.heightMm) < 0.5,
  );
  return found?.[0] ?? null;
}

/** Scale denominators printed on the sheet as "1:N" / "1 : N". */
export function printedScales(sheet: Sheet): number[] {
  const scales: number[] = [];
  for (const text of sheet.texts) {
    for (const match of text.matchAll(/\b1\s*:\s*(\d+)\b/g)) scales.push(Number(match[1]));
  }
  return scales;
}
