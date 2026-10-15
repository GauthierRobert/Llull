/** Sheet bookkeeping shared by the drawing commands: lookup, immutable replace/remove, marks and scale text. */

import type { CadDocument } from '../../model/types';
import type { DrawingSheet, DrawingView, DrawingsModel } from '../../model/sheet';
import type { CommandResult } from '../types';
import { noop } from '../noop';

const EMPTY: DrawingsModel = { sheets: {}, order: [] };

/** Sheet ids in creation order. */
export const sheetList = (doc: CadDocument): DrawingSheet[] =>
  (doc.drawings ?? EMPTY).order.flatMap((id) => {
    const sheet = doc.drawings?.sheets[id];
    return sheet ? [sheet] : [];
  });

/** The sheet `id`, or undefined. */
export const findSheet = (doc: CadDocument, id: string): DrawingSheet | undefined =>
  doc.drawings !== undefined && Object.hasOwn(doc.drawings.sheets, id) ? doc.drawings.sheets[id] : undefined;

/** `doc` with `sheet` added (appended to the order) or replaced. */
export function withSheet(doc: CadDocument, sheet: DrawingSheet): CadDocument {
  const drawings = doc.drawings ?? EMPTY;
  const order = drawings.order.includes(sheet.id) ? drawings.order : [...drawings.order, sheet.id];
  return { ...doc, drawings: { sheets: { ...drawings.sheets, [sheet.id]: sheet }, order } };
}

/** `doc` without sheet `id`. */
export function withoutSheet(doc: CadDocument, id: string): CadDocument {
  const drawings = doc.drawings ?? EMPTY;
  const sheets = Object.fromEntries(Object.entries(drawings.sheets).filter(([key]) => key !== id));
  return { ...doc, drawings: { sheets, order: drawings.order.filter((key) => key !== id) } };
}

/** Resolves a sheet or reports the rejection every drawing command shares. */
export function requireSheet(doc: CadDocument, command: string, sheetId: string): DrawingSheet | CommandResult {
  const sheet = findSheet(doc, sheetId);
  if (sheet) return sheet;
  const known = sheetList(doc).map((s) => s.id);
  return noop(
    doc,
    `${command} rejected: no sheet '${sheetId}' (sheets: ${known.length > 0 ? known.join(', ') : 'none — call create_sheet'}).`,
  );
}

/** True when `requireSheet` returned a rejection rather than a sheet. */
export const isRejection = (value: DrawingSheet | CommandResult): value is CommandResult => 'summary' in value;

export const findView = (sheet: DrawingSheet, viewId: string): DrawingView | undefined => sheet.views.find((view) => view.id === viewId);

/** `sheet` with `view` replacing the same-id view (or appended). */
export const withView = (sheet: DrawingSheet, view: DrawingView): DrawingSheet => ({
  ...sheet,
  views: sheet.views.some((existing) => existing.id === view.id)
    ? sheet.views.map((existing) => (existing.id === view.id ? view : existing))
    : [...sheet.views, view],
});

const MARKS = 'ABCDEFGHJKLMNPRSTUVWXYZ';

/** First unused section/detail letter on `sheet` (ISO skips I, O, Q); "A1", "B1"… once the alphabet is exhausted. */
export function nextMark(sheet: DrawingSheet): string {
  const used = new Set(sheet.views.map((view) => view.mark));
  for (let round = 0; ; round++) {
    for (const letter of MARKS) {
      const mark = round === 0 ? letter : `${letter}${round}`;
      if (!used.has(mark)) return mark;
    }
  }
}

const trimmed = (value: number): string => String(Number(value.toFixed(3)));

/** Scale denominator N as drawing text: 50 -> "1:50", 0.5 -> "2:1", 1 -> "1:1". @pure */
export const scaleText = (denominator: number): string =>
  denominator >= 1 ? `1:${trimmed(denominator)}` : `${trimmed(1 / denominator)}:1`;
