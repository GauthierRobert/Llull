import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

export function run(doc: CadDocument, name: string, params: unknown): CadDocument {
  return execute(doc, name, params).document;
}

/** Closed 10 m × 8 m rectangle of 300 mm walls (wall-1..wall-4). */
export const drawHouseWalls = (doc: CadDocument): CadDocument =>
  run(doc, 'draw_walls', {
    points: [
      [0, 0],
      [10000, 0],
      [10000, 8000],
      [0, 8000],
    ],
    closed: true,
    thickness: 300,
  });
