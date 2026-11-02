/**
 * Mass of the nozzles of a vessel (plant 03 EQP §5.3): neck annulus beyond the outside wall plus the weld-neck flange as a bored disc.
 * The flange bore is the neck bore; flange rows of the catalogue are outside diameter and thickness only, so hub and bolt holes are not
 * deducted (named in the method). Flanges that are placeholders or unverified make the caller report it.
 */

import type { NozzleRecord } from '../plantData';
import type { MassPart } from './vesselMass';
import { headSurfaceHeight, type VesselGeometry } from './vesselFrame';

const annulus = (outer: number, inner: number): number => Math.PI * (outer * outer - inner * inner);

/** Neck length from the outside wall to the back of the flange (document units, never negative). */
function neckLength(geometry: VesselGeometry, nozzle: NozzleRecord): number {
  const { location, projection, flange } = nozzle;
  let wall = 0;
  if (location.on === 'shell') wall = geometry.radius + geometry.shellThickness;
  else if (location.on === 'head') {
    const first = location.head === 'bottom' || location.head === 'left';
    wall = headSurfaceHeight(first ? geometry.first : geometry.second, geometry.radius, location.radialOffset) + geometry.headThickness;
  } else return Math.max(0, projection - flange.thickness);
  return Math.max(0, projection - wall - flange.thickness);
}

/** One part per nozzle, `nozzle <mark>`, in kg. `scale` = metres per document unit. */
export function nozzleMassParts(scale: number, geometry: VesselGeometry, nozzles: readonly NozzleRecord[], density: number): MassPart[] {
  return nozzles.map((nozzle) => {
    const outer = nozzle.neckOutsideDiameter / 2;
    const bore = Math.max(0, outer - nozzle.neckWall);
    const neck = annulus(outer, bore) * neckLength(geometry, nozzle);
    const flange = annulus(nozzle.flange.outsideDiameter / 2, bore) * nozzle.flange.thickness;
    return {
      part: `nozzle ${nozzle.mark}`,
      kg: (neck + flange) * scale ** 3 * density,
      method:
        'neck annulus beyond the outside wall + flange as a bored disc (OD x thickness from the catalogue; hub and bolt holes ignored)',
    };
  });
}
