import type { CadDocument, Vec2 } from '@core/model/types';
import { fixedNumber } from '@lib/compactNumber';
import { parseNumberRow } from '@ui/numberText';
import { localToWorld2D } from '@ui/viewport/2d/snapping/geometry';

/** Splits on `;` or new lines, dropping blank rows. */
const rows = (text: string): string[] =>
  text
    .split(/[;\n]/)
    .map((row) => row.trim())
    .filter((row) => row !== '');

/** "x,y; x,y; …" (or one point per line) -> plan points; null when a row is not "x, y". */
export function parsePoints(text: string): Vec2[] | null {
  const points: Vec2[] = [];
  for (const row of rows(text)) {
    const values = parseNumberRow(row);
    if (values?.length !== 2) return null;
    points.push([values[0] ?? 0, values[1] ?? 0]);
  }
  return points;
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
    const values = parseNumberRow(row);
    if (values === null || values.length < 2 || values.length > 3) return null;
    const [station = 0, elevation = 0, curveLength] = values;
    pvis.push(curveLength === undefined ? { station, elevation } : { station, elevation, curveLength });
  }
  return pvis;
}

/** World plan vertices of the single selected polyline, or null. */
export function selectedPolylinePoints(doc: CadDocument): Vec2[] | null {
  if (doc.selection.length !== 1) return null;
  const entity = doc.entities[doc.selection[0] ?? ''];
  if (entity?.kind !== 'polyline') return null;
  return entity.points.map(([x, y]): Vec2 => localToWorld2D(entity, x, y));
}

/** Plan points as the "x,y; x,y" text the point fields accept. */
export function formatPoints(points: ReadonlyArray<Vec2>): string {
  return points.map(([x, y]) => `${fixedNumber(x, 3)},${fixedNumber(y, 3)}`).join('; ');
}
