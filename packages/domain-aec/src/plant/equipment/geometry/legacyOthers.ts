/** Legacy equipment fields (`size`, `shape`, operating `weight`) of exchangers, tanks and pumps (decision Q1 / D6); same contract as `legacyFields`. */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { EquipmentShape } from '@aec/building/types';
import { toMetres } from '@core/model/units';
import { STEEL_DENSITY_KG_PER_M3 } from '@aec/steel/profiles';
import type { ExchangerTemplate, PumpTemplate, TankTemplate } from '../plantData';
import { resolveExchanger } from './exchangerFrame';
import { exchangerMass } from './exchangerMass';
import { pumpLayout } from './pumpLayout';
import { eaveRadius, roofRise, tankBase } from './tankFrame';
import { tankMass } from './tankMass';

export interface LegacyFields {
  readonly size: Vec3;
  readonly shape: EquipmentShape;
  /** Operating weight, kg. */
  readonly weight: number;
  /** Named assumptions behind the numbers. */
  readonly notes: readonly string[];
}

type Units = Pick<CadDocument, 'units'>;

/** @invariant on the floor -> `horizontal_vessel` [outside length, D, D]; raised on saddles -> `box` of the full height; nozzles are in the ports only */
export function exchangerLegacy(doc: Units, template: ExchangerTemplate): LegacyFields {
  const geometry = resolveExchanger(template);
  const mass = exchangerMass(toMetres(doc, 1), template, geometry);
  const notes = [
    'operating weight = empty + both sides full at their specific gravity (a side without specificGravity adds nothing)',
    'floating head, floating tubesheet, U-bends, baffles, tie rods, pass partitions, saddle plates and nozzles are not part of the weight',
  ];
  if (mass.densityDefaulted) notes.push(`material density defaulted to ${STEEL_DENSITY_KG_PER_M3} kg/m3 (steel)`);
  const diameter = 2 * geometry.outerRadius;
  const raised = geometry.datum - geometry.outerRadius > 1e-9;
  return raised
    ? {
        size: [geometry.outsideOverallLength, diameter, geometry.datum + geometry.outerRadius],
        shape: 'box',
        weight: mass.operatingKg,
        notes,
      }
    : { size: [geometry.outsideOverallLength, diameter, diameter], shape: 'horizontal_vessel', weight: mass.operatingKg, notes };
}

/** @invariant `vertical_vessel` [D, D, top of the roof]; weight = empty + liquid of the design level */
export function tankLegacy(doc: Units, template: TankTemplate): LegacyFields {
  const mass = tankMass(toMetres(doc, 1), template);
  const diameter = 2 * eaveRadius(template);
  const notes = ['rim angle, stiffeners, roof framing, appurtenances and nozzles are not part of the weight'];
  if (mass.densityDefaulted) notes.push(`material density defaulted to ${STEEL_DENSITY_KG_PER_M3} kg/m3 (steel)`);
  return {
    size: [diameter, diameter, tankBase(template) + template.shellHeight + roofRise(template)],
    shape: 'vertical_vessel',
    weight: mass.operatingKg,
    notes,
  };
}

/** @invariant `box` of the envelope, baseplate and driver; weight = the vendor weight, 0 when none was given (named in the notes) */
export function pumpLegacy(template: PumpTemplate): LegacyFields {
  const notes =
    template.weightKg === undefined
      ? ['no weightKg: the standards give no pump weight, so the weight is 0 until the vendor value is set']
      : [`weight is the user-given vendor weight ${template.weightKg} kg`];
  return { size: pumpLayout(template).size, shape: 'box', weight: template.weightKg ?? 0, notes };
}
