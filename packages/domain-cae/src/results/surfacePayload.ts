/** The painted-surface payload of render_fea_results (surface: true): plotted triangles as flat arrays in DOCUMENT units. */

import type { FieldFace } from './fieldFaces';

/** Corners (3 per triangle) returned at most. */
export const SURFACE_CORNER_BUDGET = 150_000;
const METRES_PER_ANALYSIS_LENGTH: Readonly<Record<string, number>> = { mm: 0.001, m: 1, in: 0.0254 };

export interface SurfacePayload {
  /** Flat xyz per triangle corner, deformed as plotted, document units. */
  readonly positions: number[];
  /** Field value per corner. */
  readonly values: number[];
  readonly triangles: number;
  readonly truncated: boolean;
}

/**
 * @invariant mesh coordinates are in the analysis length unit; `documentMetres` is the metres of one document unit; faces beyond the
 *   budget are dropped and `truncated` says so
 */
export function surfacePayload(
  faces: readonly FieldFace[],
  analysisLengthUnit: string,
  documentMetres: number,
  cornerBudget: number,
): SurfacePayload {
  const toDocument = (METRES_PER_ANALYSIS_LENGTH[analysisLengthUnit] ?? 0.001) / documentMetres;
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
