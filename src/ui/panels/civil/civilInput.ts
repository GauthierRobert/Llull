/**
 * @layer ui/panels/civil
 * @pure Text-field parsing for the civil forms (param gathering only; the commands validate).
 */

import type { CadDocument, Vec2 } from '@core/model/types';

/** A finite number, or undefined for blank / invalid text. */
export function parseNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : undefined;
}

/** `{ [key]: number }` when `text` is a number, `{}` when blank or invalid. */
export function optionalNumber<K extends string>(key: K, text: string): Partial<Record<K, number>> {
  const value = parseNumber(text);
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

/** Splits on `;` or new lines, dropping blank rows. */
const rows = (text: string): string[] =>
  text
    .split(/[;\n]/)
    .map((row) => row.trim())
    .filter((row) => row !== '');

/** Numeric fields of one "a, b, c" (or space separated) row; null when one is not a number. */
function numbersOf(row: string): number[] | null {
  const values = row
    .split(/[,\s]+/)
    .filter((field) => field !== '')
    .map(Number);
  return values.every(Number.isFinite) ? values : null;
}

/** "x,y; x,y; …" (or one point per line) -> plan points; null when a row is not "x, y". */
export function parsePoints(text: string): Vec2[] | null {
  const points: Vec2[] = [];
  for (const row of rows(text)) {
    const values = numbersOf(row);
    if (values?.length !== 2) return null;
    points.push([values[0] ?? 0, values[1] ?? 0]);
  }
  return points;
}

/** "10, 20, 0" -> [10, 20, 0]; null when a value is not a number. */
export function parseNumberList(text: string): number[] | null {
  return text.trim() === '' ? [] : numbersOf(text.replace(/;/g, ','));
}

export interface PviInput {
  station: number;
  elevation: number;
  curveLength?: number;
}

/** "station, elevation[, curveLength]" per row -> PVIs; null when a row is malformed. */
export function parsePvis(text: string): PviInput[] | null {
  const pvis: PviInput[] = [];
  for (const row of rows(text)) {
    const values = numbersOf(row);
    if (values === null || values.length < 2 || values.length > 3) return null;
    const [station = 0, elevation = 0, curveLength] = values;
    pvis.push(
      curveLength === undefined ? { station, elevation } : { station, elevation, curveLength },
    );
  }
  return pvis;
}

/** World plan vertices of the single selected polyline, or null. */
export function selectedPolylinePoints(doc: CadDocument): Vec2[] | null {
  if (doc.selection.length !== 1) return null;
  const entity = doc.entities[doc.selection[0] ?? ''];
  if (entity?.kind !== 'polyline') return null;
  const cos = Math.cos(entity.rotation[2]);
  const sin = Math.sin(entity.rotation[2]);
  return entity.points.map(
    ([x, y]): Vec2 => [
      entity.position[0] + x * cos - y * sin,
      entity.position[1] + x * sin + y * cos,
    ],
  );
}

/** Plan points as the "x,y; x,y" text the point fields accept. */
export function formatPoints(points: ReadonlyArray<Vec2>): string {
  return points.map(([x, y]) => `${Number(x.toFixed(3))},${Number(y.toFixed(3))}`).join('; ');
}
