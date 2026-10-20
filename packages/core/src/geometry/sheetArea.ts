/** Surface area of a sheet (02 SRF): the whole patch, or the region left by its trim loops. */

import type { NurbsSurfaceEntity } from '../model/types';
import { domainLoop, trimmedArea } from '../lib/nurbs/trimRegion';

/** Area of the sheet in document units squared (Gauss quadrature of |S_u x S_v|; Green's theorem over the trim loops). */
export function sheetArea(entity: NurbsSurfaceEntity): number {
  return trimmedArea(entity.surface, entity.trims !== undefined && entity.trims.length > 0 ? entity.trims : [domainLoop(entity.surface)]);
}
