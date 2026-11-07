/** The centre-of-gravity model of an exchanger, tank or pump for `equipment_cog` (the vessel path stays in `equipmentCog`). */

import { toMetres } from '@core/model/units';
import type { CadDocument } from '@core/model/types';
import { STEEL_DENSITY_KG_PER_M3 } from '@aec/steel/profiles';
import type { EquipmentElement } from '@aec/building/types';
import { resolveExchanger } from '../geometry/exchangerFrame';
import { exchangerWallOf, neckMassParts, tankWallOf } from '../geometry/nozzleMass';
import { exchangerCog, pumpCog, tankCog } from '../geometry/otherCog';
import { nozzleLumpsOf, type CogPart, type VesselCog } from '../geometry/vesselCog';
import type { NozzleRecord } from '../plantData';

export interface OtherCog {
  readonly cog: VesselCog;
  readonly warnings: Array<{ code: string; message: string; paths: string[] }>;
  readonly notIncluded: string[];
}

/** Null for a kind that is not an exchanger / tank / pump; `{ missing }` for a pump without a vendor weight. */
export function otherEquipmentCog(
  doc: CadDocument,
  element: EquipmentElement,
  withNozzles: boolean,
): OtherCog | { missing: string } | null {
  const template = element.plant?.template;
  if (template === undefined) return null;
  const scale = toMetres(doc, 1);
  const nozzles: readonly NozzleRecord[] = withNozzles ? (element.plant?.nozzles ?? []) : [];
  const lumps = (wallOf: (nozzle: NozzleRecord) => number, density: number): CogPart[] =>
    template.kind === 'block' || template.kind === 'vessel'
      ? []
      : nozzleLumpsOf(template, nozzles, neckMassParts(scale, wallOf, nozzles, density));
  if (template.kind === 'exchanger') {
    const warnings: OtherCog['warnings'] = [];
    for (const side of ['shellSide', 'tubeSide'] as const)
      if (template.design?.[side]?.specificGravity === undefined)
        warnings.push({
          code: 'EQP_DESIGN_DATA_MISSING',
          message: `no specific gravity for the ${side}: it adds nothing to the operating state`,
          paths: [`design.${side}.specificGravity`],
        });
    const density = template.design?.materialDensityKgM3 ?? STEEL_DENSITY_KG_PER_M3;
    return {
      cog: exchangerCog(scale, template, lumps(exchangerWallOf(resolveExchanger(template)), density)),
      warnings,
      notIncluded: ['floating head, floating tubesheet, U-bends', 'baffles, tie rods, pass partitions', 'saddle plates, insulation'],
    };
  }
  if (template.kind === 'tank')
    return {
      cog: tankCog(scale, template, lumps(tankWallOf(template), template.design.materialDensityKgM3 ?? STEEL_DENSITY_KG_PER_M3)),
      warnings: [],
      notIncluded: ['rim angle, stiffeners, roof framing', 'appurtenances, insulation'],
    };
  if (template.kind === 'pump') {
    if (template.weightKg === undefined)
      return {
        missing: `${element.mark} has no weightKg: the ISO 2858 / B73.1 rows give no pump weight (take it from the vendor datasheet)`,
      };
    return {
      cog: pumpCog(
        template,
        template.weightKg,
        lumps(() => 0, STEEL_DENSITY_KG_PER_M3),
      ),
      warnings: [],
      notIncluded: ['driver and baseplate are part of the vendor weight only if the vendor says so', 'oil, seal fluid, insulation'],
    };
  }
  return null;
}
