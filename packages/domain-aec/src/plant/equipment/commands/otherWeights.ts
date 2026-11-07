/** `equipment_weights` for exchangers, tanks and pumps (the vessel path stays in `equipmentWeights`). */

import { report } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { toMetres } from '@core/model/units';
import { STEEL_DENSITY_KG_PER_M3 } from '@aec/steel/profiles';
import type { EquipmentElement } from '@aec/building/types';
import { resolveExchanger } from '../geometry/exchangerFrame';
import { exchangerMass } from '../geometry/exchangerMass';
import { exchangerWallOf, neckMassParts, tankWallOf } from '../geometry/nozzleMass';
import { tankMass } from '../geometry/tankMass';
import { TEST_WATER_KG_PER_M3, type MassPart } from '../geometry/vesselMass';
import { refuse } from '../model';
import type { NozzleRecord } from '../plantData';

interface Body {
  readonly parts: readonly MassPart[];
  readonly emptyKg: number;
  readonly operatingKg: number;
  readonly testKg: number;
  readonly densityKgM3: number;
  readonly densityDefaulted: boolean;
  readonly volumesM3: Record<string, number>;
  readonly warnings: Array<{ code: string; message: string; paths: string[] }>;
  readonly defaulted: string[];
  readonly notIncluded: string[];
  readonly wallOf: (nozzle: NozzleRecord) => number;
}

function exchangerBody(scale: number, element: EquipmentElement): Body | null {
  const template = element.plant?.template;
  if (template?.kind !== 'exchanger') return null;
  const geometry = resolveExchanger(template);
  const mass = exchangerMass(scale, template, geometry);
  const warnings: Body['warnings'] = [];
  for (const [name, side] of [
    ['shellSide', mass.shellSide],
    ['tubeSide', mass.tubeSide],
  ] as const)
    if (side.specificGravity === null)
      warnings.push({
        code: 'EQP_DESIGN_DATA_MISSING',
        message: `no specific gravity for the ${name}: it adds nothing to operatingKg`,
        paths: [`design.${name}.specificGravity`],
      });
  return {
    ...mass,
    volumesM3: { shellSide: mass.shellSide.volumeM3, tubeSide: mass.tubeSide.volumeM3 },
    warnings,
    defaulted: [],
    notIncluded: [
      'floating head, floating tubesheet, U-bends',
      'baffles, tie rods, pass partitions',
      'saddle plates, insulation',
      'operating weight assumes both sides full',
    ],
    wallOf: exchangerWallOf(geometry),
  };
}

function tankBody(scale: number, element: EquipmentElement): Body | null {
  const template = element.plant?.template;
  if (template?.kind !== 'tank') return null;
  const mass = tankMass(scale, template);
  return {
    ...mass,
    volumesM3: { shell: mass.totalVolumeM3, designLiquid: mass.operatingLiquidM3 },
    warnings: [],
    defaulted:
      template.thicknessSource === 'user'
        ? []
        : [
            `course thicknesses are the API 650 ${template.thicknessSource === 'one_foot' ? 'one-foot governing' : 'minimum'} values, not an input`,
          ],
    notIncluded: ['rim angle, stiffeners, roof framing', 'appurtenances, insulation'],
    wallOf: tankWallOf(template),
  };
}

/**
 * The weights of an exchanger, tank or pump as the `equipment_weights` answer, or null when `element` is none of them.
 * @failure a pump without weightKg -> EQP_DESIGN_DATA_MISSING (the standards give no pump weight)
 */
export function otherEquipmentWeights(doc: CadDocument, element: EquipmentElement, include: readonly string[]): CommandResult | null {
  const template = element.plant?.template;
  if (template === undefined) return null;
  const scale = toMetres(doc, 1);
  const parts = new Set(include);
  let body: Body | null;
  if (template.kind === 'pump') {
    if (template.weightKg === undefined)
      return refuse(
        doc,
        'equipment_weights',
        'EQP_DESIGN_DATA_MISSING',
        `${element.mark} has no weightKg: the ISO 2858 / B73.1 rows give no pump weight (take it from the vendor datasheet)`,
        [element.id],
        ['weightKg'],
      );
    const kg = template.weightKg;
    body = {
      parts: [{ part: 'pump set', kg, method: 'vendor weight given by the user' }],
      emptyKg: kg,
      operatingKg: kg,
      testKg: kg,
      densityKgM3: STEEL_DENSITY_KG_PER_M3,
      densityDefaulted: false,
      volumesM3: {},
      warnings: [],
      defaulted: [],
      notIncluded: ['driver and baseplate are part of the vendor weight only if the vendor says so', 'oil, seal fluid, insulation'],
      wallOf: () => 0,
    };
  } else body = exchangerBody(scale, element) ?? tankBody(scale, element);
  if (body === null) return null;
  const nozzles = element.plant?.nozzles ?? [];
  const nozzleParts = parts.has('nozzles') ? neckMassParts(scale, body.wallOf, nozzles, body.densityKgM3) : [];
  const nozzlesKg = nozzleParts.reduce((sum, part) => sum + part.kg, 0);
  const defaulted = [...body.defaulted, `test water density = ${TEST_WATER_KG_PER_M3} kg/m3 (named default)`];
  if (body.densityDefaulted) defaulted.push(`materialDensityKgM3 = ${STEEL_DENSITY_KG_PER_M3} kg/m3 (steel, named default)`);
  for (const nozzle of nozzles)
    if (parts.has('nozzles') && nozzle.flange.placeholder)
      defaulted.push(`nozzle ${nozzle.mark}: flange is a placeholder (no catalogue row)`);
  const data = {
    equipment: element.mark,
    elementId: element.id,
    body: { emptyKg: body.emptyKg, operatingKg: body.operatingKg, testKg: body.testKg },
    ...(parts.has('nozzles') ? { nozzles: { kg: nozzlesKg } } : {}),
    total: { emptyKg: body.emptyKg + nozzlesKg, operatingKg: body.operatingKg + nozzlesKg, testKg: body.testKg + nozzlesKg },
    volumesM3: body.volumesM3,
    breakdown: [...body.parts, ...nozzleParts],
    densityKgM3: body.densityKgM3,
    defaulted,
    warnings: body.warnings,
    unverified:
      (parts.has('nozzles') && nozzles.some((nozzle) => nozzle.flange.unverified || nozzle.flange.placeholder)) ||
      (template.kind === 'pump' && template.envelope.grade !== 'A'),
    notIncluded: body.notIncluded,
  };
  return report(
    doc,
    `equipment_weights: ${element.mark} empty ${data.total.emptyKg.toPrecision(8)} kg, operating ${data.total.operatingKg.toPrecision(8)} kg, test ${data.total.testKg.toPrecision(8)} kg (${[...parts].join(' + ')}).`,
    data,
  );
}
