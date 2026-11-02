/**
 * Legacy equipment fields derived from the plant data (decision Q1 / D6): `size` (outside bounding box of body and supports), `shape` and the
 * operating `weight`, so clash checks, floor loads, schedules, IFC and plans keep working unchanged. Weights use closed forms (shell annulus,
 * exact offset-solid heads, skirt annulus, square legs, liquid by Jones), never meshes.
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { EquipmentShape } from '@aec/building/types';
import { toMetres } from '@core/model/units';
import { STEEL_DENSITY_KG_PER_M3 } from '@aec/steel/profiles';
import type { PlantEquipmentData, VesselTemplate } from '../plantData';
import { headApexHeight } from './vesselProfile';
import { resolveVessel, skirtRadii, type VesselGeometry } from './vesselFrame';
import { vesselMass } from './vesselMass';

export interface LegacyFields {
  readonly size: Vec3;
  readonly shape: EquipmentShape;
  /** Operating weight, kg. */
  readonly weight: number;
  /** Named assumptions: density default, liquid not computed, saddles not included. */
  readonly notes: readonly string[];
}

/** Footprint radius and top elevation (above the level) of a vertical vessel with its support. */
function verticalExtent(template: VesselTemplate, geometry: VesselGeometry): { radius: number; top: number } {
  const outer = geometry.radius + geometry.shellThickness;
  const { support } = template;
  const supportRadius =
    support.type === 'skirt'
      ? skirtRadii(geometry, support.thickness).outer + support.baseRingWidth
      : support.type === 'legs'
        ? support.pitchDiameter / 2 + support.legWidth / 2
        : 0;
  const top = geometry.datum + geometry.length + headApexHeight(geometry.second, geometry.radius, geometry.headThickness);
  return { radius: Math.max(outer, supportRadius), top };
}

/**
 * @returns size / shape / weight for a vessel template; null for a block (legacy fields stay as the user set them) or an invalid head
 * @invariant vertical -> `vertical_vessel` [D, D, top]; horizontal on the floor -> `horizontal_vessel`, raised on saddles -> `box` of the full
 *   height; nozzles are not part of the bounding box (their reach is in the ports); saddle plates are not part of the weight
 */
export function legacyFields(doc: Pick<CadDocument, 'units'>, plant: PlantEquipmentData): LegacyFields | null {
  const { template } = plant;
  if (template.kind !== 'vessel') return null;
  const geometry = resolveVessel(template);
  if ('error' in geometry) return null;
  const outer = geometry.radius + geometry.shellThickness;
  const notes: string[] = [];
  const mass = vesselMass(toMetres(doc, 1), template, geometry, plant.design);
  if (mass.densityDefaulted) notes.push(`material density defaulted to ${STEEL_DENSITY_KG_PER_M3} kg/m3 (steel)`);
  if (mass.operatingKg === null)
    notes.push('operating liquid not added: no closed form at this level for a torispherical head of a horizontal vessel');
  notes.push('nozzles are not part of the weight (see equipment_weights include nozzles)');
  if (template.support.type === 'saddles') notes.push('saddle plates are not part of the weight');
  const weight = mass.operatingKg ?? mass.emptyKg;
  if (template.orientation === 'vertical') {
    const { radius, top } = verticalExtent(template, geometry);
    return { size: [2 * radius, 2 * radius, top], shape: 'vertical_vessel', weight, notes };
  }
  const total =
    geometry.length +
    headApexHeight(geometry.first, geometry.radius, geometry.headThickness) +
    headApexHeight(geometry.second, geometry.radius, geometry.headThickness);
  const raised = geometry.datum - outer > 1e-9;
  return raised
    ? { size: [total, 2 * outer, geometry.datum + outer], shape: 'box', weight, notes }
    : { size: [total, 2 * outer, 2 * outer], shape: 'horizontal_vessel', weight, notes };
}
