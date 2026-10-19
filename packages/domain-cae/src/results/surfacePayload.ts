/** The painted-surface payload of render_fea_results (surface: true): plotted triangles as flat arrays in DOCUMENT units. */

import type { UnitSystem } from '@core/model/analysis';
import { analysisLengthMetres } from '../shared/defaults';
import type { FieldFace } from './fieldFaces';

/** Corners (3 per triangle) returned at most. */
export const SURFACE_CORNER_BUDGET = 150_000;

export interface SurfacePayload {
  /** Flat xyz per triangle corner, deformed as plotted, document units. */
  readonly positions: number[];
  /** Field value per corner. */
  readonly values: number[];
  readonly triangles: number;
  readonly truncated: boolean;
}

/**
 * @invariant mesh coordinates are in the length unit of `unitSystem`; `documentMetres` is the metres of one document unit; faces beyond the
 *   budget are dropped and `truncated` says so
 */
export function surfacePayload(
  faces: readonly FieldFace[],
  unitSystem: UnitSystem,
  documentMetres: number,
  cornerBudget: number,
): SurfacePayload {
  const toDocument = analysisLengthMetres(unitSystem) / documentMetres;
  const kept = faces.slice(0, Math.floor(cornerBudget / 3));
  const positions: number[] = [];
  const values: number[] = [];
  for (const face of kept)
    for (const corner of face.corners) {
      positions.push(corner.p[0] * toDocument, corner.p[1] * toDocument, corner.p[2] * toDocument);
      values.push(corner.v);
    }
  return { positions, values, triangles: kept.length, truncated: kept.length < faces.length };
}
