/**
 * Mass of the nozzles of an equipment (plant 03 EQP §5.3): neck annulus beyond the outside wall plus the weld-neck flange as a bored disc.
 * The flange bore is the neck bore; flange rows of the catalogue are outside diameter and thickness only, so hub and bolt holes are not
 * deducted (named in the method). Flanges that are placeholders or unverified make the caller report it.
 */

import type { NozzleRecord, TankTemplate } from '../plantData';
import type { ExchangerGeometry } from './exchangerFrame';
import { thicknessAt } from './tankFrame';
import type { MassPart } from './vesselMass';
import { headSurfaceHeight, type VesselGeometry } from './vesselFrame';

const annulus = (outer: number, inner: number): number => Math.PI * (outer * outer - inner * inner);

/** Distance from the projection origin (axis / tangent line) to the outside of the wall at the nozzle; 0 for free nozzles. */
function vesselWall(geometry: VesselGeometry, nozzle: NozzleRecord): number {
  const { location } = nozzle;
  if (location.on === 'shell') return geometry.radius + geometry.shellThickness;
  if (location.on === 'head') {
    const first = location.head === 'bottom' || location.head === 'left';
    return headSurfaceHeight(first ? geometry.first : geometry.second, geometry.radius, location.radialOffset) + geometry.headThickness;
  }
  return 0;
}

/**
 * One part per nozzle, `nozzle <mark>`, in kg.
 * @param scale metres per document unit
 * @param wallOf distance from the projection origin to the outside of the wall at the nozzle (0 = nothing to subtract)
 */
export function neckMassParts(
  scale: number,
  wallOf: (nozzle: NozzleRecord) => number,
  nozzles: readonly NozzleRecord[],
  density: number,
): MassPart[] {
  return nozzles.map((nozzle) => {
    const outer = nozzle.neckOutsideDiameter / 2;
    const bore = Math.max(0, outer - nozzle.neckWall);
    const neck = annulus(outer, bore) * Math.max(0, nozzle.projection - wallOf(nozzle) - nozzle.flange.thickness);
    const flange = annulus(nozzle.flange.outsideDiameter / 2, bore) * nozzle.flange.thickness;
    return {
      part: `nozzle ${nozzle.mark}`,
      kg: (neck + flange) * scale ** 3 * density,
      method:
        'neck annulus beyond the outside wall + flange as a bored disc (OD x thickness from the catalogue; hub and bolt holes ignored)',
    };
  });
}

/** Nozzle parts of a vessel. */
export const nozzleMassParts = (scale: number, geometry: VesselGeometry, nozzles: readonly NozzleRecord[], density: number): MassPart[] =>
  neckMassParts(scale, (nozzle) => vesselWall(geometry, nozzle), nozzles, density);

/** Wall distance of an exchanger nozzle (shell: shell outside radius; channel: channel outside radius; free: 0). */
export const exchangerWallOf =
  (geometry: ExchangerGeometry) =>
  (nozzle: NozzleRecord): number =>
    nozzle.location.on === 'shell'
      ? geometry.radius + geometry.shellThickness
      : nozzle.location.on === 'channel'
        ? geometry.radius + (nozzle.location.channel === 'front' ? geometry.front : geometry.rear).channelThickness
        : 0;

/** Wall distance of a tank nozzle (shell by elevation: outside radius of the course at that elevation; roof / free: 0). */
export const tankWallOf =
  (template: TankTemplate) =>
  (nozzle: NozzleRecord): number =>
    nozzle.location.on === 'shell' && 'elevation' in nozzle.location
      ? template.diameter / 2 + thicknessAt(template, nozzle.location.elevation)
      : 0;
