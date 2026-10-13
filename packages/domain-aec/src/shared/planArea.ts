import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { polygonArea, type Point2 } from '@lib/polygon';

/** Plan area of a closed outline, in m² (outline given in document units). */
export const planAreaM2 = (
  doc: Pick<CadDocument, 'units'>,
  outline: ReadonlyArray<Point2>,
): number => polygonArea(outline) * toMetres(doc, 1) ** 2;
