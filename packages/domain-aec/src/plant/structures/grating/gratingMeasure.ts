/** Areas and masses of grating panels (06 STA takeoff and checks). */

import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { polygonArea } from '@lib/polygon';
import type { GratingElement } from '@aec/building/types';
import { findGratingType } from './gratingTypes';

/** Plan area of the panel, m². */
export const gratingAreaM2 = (doc: CadDocument, grating: GratingElement): number => polygonArea(grating.boundary) * toMetres(doc, 1) ** 2;

/** Mass of the panel, kg (0 for a type that left the catalogue). */
export const gratingMassKg = (doc: CadDocument, grating: GratingElement): number =>
  gratingAreaM2(doc, grating) * (findGratingType(grating.gratingType)?.massKgM2 ?? 0);
