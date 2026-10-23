/**
 * Legacy equipment fields derived from the plant data (decision Q1 / D6): `size` (outside bounding box of body and supports), `shape` and the
 * operating `weight`, so clash checks, floor loads, schedules, IFC and plans keep working unchanged. Weights use closed forms (shell annulus,
 * exact offset-solid heads, skirt annulus, square legs, liquid by Jones), never meshes.
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { EquipmentShape } from '@aec/building/types';
import { toMetres } from '@core/model/units';
import { STEEL_DENSITY_KG_PER_M3 } from '@aec/steel/profiles';
import type { PlantEquipmentData, VesselDesignData, VesselTemplate } from '../plantData';
import { headMetalVolume } from './headOffset';
import { horizontalVolume, verticalVolume } from './partialVolume';
import { resolveVessel, skirtRadii, type VesselGeometry } from './vesselFrame';

export interface LegacyFields {
  readonly size: Vec3;
  readonly shape: EquipmentShape;
  /** Operating weight, kg. */
  readonly weight: number;
  /** Named assumptions: density default, liquid not computed, saddles not included. */
  readonly notes: readonly string[];
}

const annulus = (outer: number, inner: number): number => Math.PI * (outer * outer - inner * inner);

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
  const top = geometry.datum + geometry.length + geometry.second.depth + geometry.headThickness;
  return { radius: Math.max(outer, supportRadius), top };
}

function supportMetalVolume(template: VesselTemplate, geometry: VesselGeometry): number {
  const { support } = template;
  const outer = geometry.radius + geometry.shellThickness;
  if (support.type === 'skirt')
    return (
      annulus(skirtRadii(geometry, support.thickness).outer, outer) * support.height +
      (support.baseRingWidth > 0
        ? annulus(skirtRadii(geometry, support.thickness).outer + support.baseRingWidth, outer) * support.thickness
        : 0)
    );
  if (support.type === 'legs') return support.count * support.legWidth * support.legWidth * support.height;
  return 0;
}

function liquidVolume(template: VesselTemplate, geometry: VesselGeometry, design: VesselDesignData | undefined): number | null {
  const liquid = design?.operatingLiquid;
  if (liquid === undefined) return 0;
  const { radius, length, first, second } = geometry;
  if (template.orientation === 'vertical')
    return verticalVolume(radius, length, first, second, first.depth + liquid.levelAboveBottomTangent);
  return horizontalVolume(radius, length, first, second, liquid.levelAboveBottomTangent);
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
  const scale = toMetres(doc, 1);
  const notes: string[] = [];
  const density = plant.design?.materialDensityKgM3 ?? STEEL_DENSITY_KG_PER_M3;
  if (plant.design?.materialDensityKgM3 === undefined) notes.push(`material density defaulted to ${STEEL_DENSITY_KG_PER_M3} kg/m3 (steel)`);
  const shell = annulus(outer, geometry.radius) * geometry.length;
  const heads = [geometry.first, geometry.second].reduce(
    (sum, head) => sum + headMetalVolume(head, geometry.radius, geometry.headThickness),
    0,
  );
  const metal = (shell + heads + supportMetalVolume(template, geometry)) * scale ** 3 * density;
  const liquid = liquidVolume(template, geometry, plant.design);
  if (liquid === null)
    notes.push('operating liquid not added: no closed form at this level for a torispherical head of a horizontal vessel');
  if (template.support.type === 'saddles') notes.push('saddle plates are not part of the weight');
  const specificGravity = plant.design?.operatingLiquid?.specificGravity ?? 0;
  const weight = metal + (liquid ?? 0) * scale ** 3 * specificGravity * 1000;
  if (template.orientation === 'vertical') {
    const { radius, top } = verticalExtent(template, geometry);
    return { size: [2 * radius, 2 * radius, top], shape: 'vertical_vessel', weight, notes };
  }
  const total = geometry.length + geometry.first.depth + geometry.second.depth + 2 * geometry.headThickness;
  const raised = geometry.datum - outer > 1e-9;
  return raised
    ? { size: [total, 2 * outer, geometry.datum + outer], shape: 'box', weight, notes }
    : { size: [total, 2 * outer, 2 * outer], shape: 'horizontal_vessel', weight, notes };
}
