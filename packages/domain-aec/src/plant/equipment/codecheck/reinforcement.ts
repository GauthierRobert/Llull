/**
 * Opening reinforcement of a nozzle on a parametric vessel, ASME BPVC VIII-1 UG-36 / UG-37 area replacement (plant 03 EQP-FU, code-check depth).
 * Pure. Scope: a circular nozzle inserted through (or abutting) a shell or a head, no reinforcing pad, no inward projection, seamless neck, nozzle
 * and vessel metal of the same strength unless the design says otherwise. The Code is paywalled: the formulas are those printed in the public
 * sources of validation/sources.md. Lengths mm, stresses MPa, areas mm2.
 */

import type { NozzleRecord, PlantEquipmentData, VesselTemplate } from '../plantData';
import { resolveVessel, type VesselGeometry } from '../geometry/vesselFrame';
import type { HeadShape } from '../geometry/heads';
import { pressureToMpa, stressToMpa } from './units';
import type { CodeFinding } from './asme';

/** UG-37(a): K1 of a 2:1 semi-ellipsoidal head (the equivalent spherical radius is K1 D). */
const K1_TWO_TO_ONE = 0.9;
/** UG-36(b)(1): the opening must lie within the central 80 % of the head diameter for the spherical-radius rule. */
const CENTRAL_FRACTION = 0.8;

export interface ReinforcementResult {
  readonly mark: string;
  readonly on: 'shell' | 'head';
  readonly clause: string;
  /** Required thickness t_r of a seamless shell / sphere (corroded, E = 1). */
  readonly requiredShellThicknessMm: number;
  /** Required neck thickness t_rn (UG-27, corroded, E = 1). */
  readonly requiredNeckThicknessMm: number;
  readonly requiredAreaMm2: number;
  readonly a1Mm2: number;
  readonly a2Mm2: number;
  readonly a41Mm2: number;
  readonly availableAreaMm2: number;
  readonly marginMm2: number;
  /** UG-36(c)(3) small opening: no reinforcement is required, the areas are still reported. */
  readonly exempt: boolean;
  readonly status: 'fail' | 'pass_with_review' | 'exempt';
  readonly inputs: Readonly<Record<string, number | string>>;
  readonly notChecked: readonly string[];
}

export type NozzleReinforcement =
  | { readonly mark: string; readonly result: ReinforcementResult }
  | { readonly mark: string; readonly refusal: CodeFinding };

export interface ReinforcementOptions {
  readonly mmPerUnit: number;
  /** Pressure override, MPa gauge (what-if); default design.pressure. */
  readonly pressureMPa?: number | undefined;
  /** Allowable stress of the nozzle neck, MPa; default the vessel's S (same material, named assumption). */
  readonly nozzleStressMPa?: number | undefined;
}

export const NOT_CHECKED = [
  'weld sizes and weld-path strength (UG-41)',
  'reinforcing pad (A5) and fillet weld metal (A41): not modelled, so the available area is conservative',
  'inward projection (A3) and nozzle loads',
  'openings close to each other or to a seam (UG-36(c)(2), UG-37(e))',
];

const refusal = (mark: string, code: string, message: string, path: string): NozzleReinforcement => ({
  mark,
  refusal: { code, message: `nozzle ${mark}: ${message}`, paths: [`nozzles.${mark}.${path}`] },
});

interface Basis {
  readonly pressure: number;
  readonly stress: number;
  readonly nozzleStress: number;
}

/** Required thickness of a seamless sphere or cylinder carrying `p` (UG-27(c)(1) / (d)(2)), E = 1, corroded radius. */
const cylinderRequired = (p: number, radius: number, s: number): number => (p * radius) / (s - 0.6 * p);
const sphereRequired = (p: number, radius: number, s: number): number => (p * radius) / (2 * s - 0.2 * p);

interface Wall {
  readonly clause: string;
  readonly thicknessMm: number;
  readonly requiredMm: number;
}

function headWall(
  geometry: VesselGeometry,
  template: VesselTemplate,
  nozzle: NozzleRecord,
  basis: Basis,
  allowance: number,
  mm: number,
  openingRadius: number,
): Wall | CodeFinding {
  const { location } = nozzle;
  if (location.on !== 'head') return { code: 'EQP_PARAM_INVALID', message: 'not a head nozzle', paths: [] };
  const first = location.head === 'bottom' || location.head === 'left';
  const shape: HeadShape = first ? geometry.first : geometry.second;
  const path = [`nozzles.${nozzle.mark}.location.radialOffset`];
  const diameter = template.insideDiameter * mm + 2 * allowance;
  const offset = location.radialOffset * mm;
  const notCovered = (why: string): CodeFinding => ({
    code: 'EQP_HEAD_NOT_COVERED',
    message: `nozzle ${nozzle.mark}: ${why}`,
    paths: path,
  });
  const thicknessMm = template.headThickness * mm - allowance;
  if (shape.kind === 'ellipsoidal') {
    const ratio = template.insideDiameter / (2 * shape.depth);
    if (Math.abs(ratio - 2) > 1e-9) return notCovered(`UG-37(a) K1 is tabulated here for 2:1 heads only; this head has ratio ${ratio}`);
    if (offset + openingRadius > (CENTRAL_FRACTION * diameter) / 2)
      return notCovered('the opening is outside the central 80 % of the head diameter (UG-37(a) spherical-radius rule does not apply)');
    return {
      clause: 'UG-37(a), UG-32(d): sphere of radius K1 D, K1 = 0.9',
      thicknessMm,
      requiredMm: sphereRequired(basis.pressure, K1_TWO_TO_ONE * diameter, basis.stress),
    };
  }
  if (shape.kind === 'spherical')
    return {
      clause: 'UG-37(a), UG-27(d): sphere of the inside radius',
      thicknessMm,
      requiredMm: sphereRequired(basis.pressure, diameter / 2, basis.stress),
    };
  if (shape.kind === 'torispherical') {
    if (offset + openingRadius > shape.crownRadius * mm * Math.sin(shape.alpha))
      return notCovered('the opening reaches the knuckle (UG-37(a) covers the spherical crown)');
    return {
      clause: 'UG-37(a): sphere of the inside crown radius L',
      thicknessMm,
      requiredMm: sphereRequired(basis.pressure, shape.crownRadius * mm + allowance, basis.stress),
    };
  }
  return notCovered(`${shape.kind} heads have no reinforcement rule here`);
}

/**
 * UG-37 area replacement of one nozzle of a vessel.
 * @invariant F = 1, E1 = 1 (opening not through a weld seam); f_r1 = f_r2 = min(1, S_n / S_v); d and the walls are corroded by the vessel allowance;
 *   A41 = A5 = 0 (no weld metal or pad is modelled); small openings (UG-36(c)(3): d <= 89 mm for t <= 10 mm, d <= 60 mm above) are exempt
 */
function nozzleReinforcement(
  plant: PlantEquipmentData,
  template: VesselTemplate,
  geometry: VesselGeometry,
  nozzle: NozzleRecord,
  basis: Basis,
  mm: number,
): NozzleReinforcement {
  const { location } = nozzle;
  if (location.on !== 'shell' && location.on !== 'head')
    return refusal(nozzle.mark, 'EQP_PARAM_INVALID', 'only shell and head nozzles are checked', 'location.on');
  const allowance = template.corrosionAllowance * mm;
  const neckOutside = nozzle.neckOutsideDiameter * mm;
  const nominalWall = nozzle.neckWall * mm;
  const wallN = nominalWall - allowance;
  const d = neckOutside - 2 * nominalWall + 2 * allowance;
  if (!(wallN > 0 && d > 0))
    return refusal(nozzle.mark, 'EQP_PARAM_INVALID', 'the neck has no wall left after the corrosion allowance', 'neckWall');
  let wall: Wall | CodeFinding;
  if (location.on === 'shell') {
    const t = template.shellThickness * mm - allowance;
    wall = {
      clause: 'UG-37, UG-27(c)(1)',
      thicknessMm: t,
      requiredMm: cylinderRequired(basis.pressure, template.insideDiameter * mm * 0.5 + allowance, basis.stress),
    };
  } else wall = headWall(geometry, template, nozzle, basis, allowance, mm, d / 2);
  if ('code' in wall) return { mark: nozzle.mark, refusal: wall };
  const t = wall.thicknessMm;
  const tr = wall.requiredMm;
  const f = Math.min(1, basis.nozzleStress / basis.stress);
  const trn = cylinderRequired(basis.pressure, d / 2, basis.nozzleStress);
  const excess = t - tr;
  const required = d * tr + 2 * wallN * tr * (1 - f);
  const a1 = Math.max(d * excess - 2 * wallN * excess * (1 - f), 2 * (t + wallN) * excess - 2 * wallN * excess * (1 - f));
  const a2 = Math.max(0, Math.min(5 * (wallN - trn) * f * t, 5 * (wallN - trn) * f * wallN));
  const available = Math.max(0, a1) + a2;
  const exempt = d <= (t + allowance <= 10 ? 89 : 60);
  const status = available >= required * (1 - 1e-9) ? 'pass_with_review' : exempt ? 'exempt' : 'fail';
  return {
    mark: nozzle.mark,
    result: {
      mark: nozzle.mark,
      on: location.on,
      clause: wall.clause,
      requiredShellThicknessMm: tr,
      requiredNeckThicknessMm: trn,
      requiredAreaMm2: required,
      a1Mm2: Math.max(0, a1),
      a2Mm2: a2,
      a41Mm2: 0,
      availableAreaMm2: available,
      marginMm2: available - required,
      exempt,
      status,
      inputs: {
        pressureMPa: basis.pressure,
        S_vesselMPa: basis.stress,
        S_nozzleMPa: basis.nozzleStress,
        openingDiameterMm: d,
        neckWallCorrodedMm: wallN,
        wallCorrodedMm: t,
        fr: f,
        corrosionAllowanceMm: allowance,
        material: plant.design?.material ?? 'unspecified',
      },
      notChecked: NOT_CHECKED,
    },
  };
}

/**
 * UG-37 result of every shell / head nozzle of a vessel, or a whole-vessel refusal (missing pressure, S, invalid head). A nozzle outside the covered
 * cases refuses only itself.
 * @failure no design pressure / allowable stress -> EQP_DESIGN_DATA_MISSING / EQP_ALLOWABLE_MISSING; P <= 0 -> EQP_PARAM_INVALID
 */
export function vesselReinforcement(
  plant: PlantEquipmentData,
  options: ReinforcementOptions,
):
  | { readonly nozzles: readonly NozzleReinforcement[]; readonly pressureMPa: number; readonly stressMPa: number }
  | { readonly refusal: CodeFinding } {
  const { template } = plant;
  if (template.kind !== 'vessel')
    return { refusal: { code: 'EQP_NOT_PARAMETRIC', message: 'not a parametric vessel', paths: ['equipment'] } };
  const geometry = resolveVessel(template);
  if ('error' in geometry) return { refusal: { code: 'EQP_HEAD_INVALID', message: geometry.error, paths: [geometry.path] } };
  const design = plant.design;
  const pressure =
    options.pressureMPa ?? (design?.pressure === undefined ? undefined : pressureToMpa(design.pressure.value, design.pressure.unit));
  if (pressure === undefined)
    return {
      refusal: {
        code: 'EQP_DESIGN_DATA_MISSING',
        message: 'design pressure is missing (design.pressure or the pressure override)',
        paths: ['design.pressure'],
      },
    };
  if (!(pressure > 0))
    return { refusal: { code: 'EQP_PARAM_INVALID', message: 'internal design pressure must be above 0', paths: ['design.pressure'] } };
  if (design?.allowableStress === undefined)
    return {
      refusal: {
        code: 'EQP_ALLOWABLE_MISSING',
        message: 'allowable stress S is missing: llull never defaults it',
        paths: ['design.allowableStress'],
      },
    };
  const stress = stressToMpa(design.allowableStress.value, design.allowableStress.unit);
  const basis: Basis = { pressure, stress, nozzleStress: options.nozzleStressMPa ?? stress };
  return {
    nozzles: plant.nozzles.map((nozzle) => nozzleReinforcement(plant, template, geometry, nozzle, basis, options.mmPerUnit)),
    pressureMPa: pressure,
    stressMPa: stress,
  };
}
