/**
 * ASME BPVC VIII-1 internal-pressure thickness of a parametric vessel (plant 03 EQP §5.5). Pure: the formulas of UG-27(c) (cylindrical
 * shell) and UG-32 (2:1 ellipsoidal, ASME F&D torispherical, hemispherical heads), UG-99(b) test pressure. The Code is paywalled: formulas
 * and worked examples are cited in validation/data/asme_viii_div1_examples.json (grade A). Lengths mm, pressures and stresses MPa.
 */

import type { PlantEquipmentData, PressureQuantity, VesselTemplate } from '../plantData';
import { resolveVessel } from '../geometry/vesselFrame';
import type { HeadShape } from '../geometry/heads';
import { pressureToMpa, stressToMpa } from './units';

/** A coded finding: a refusal of a query, a warning or a failed check of `check_equipment`. */
export interface CodeFinding {
  readonly code: string;
  readonly message: string;
  readonly paths: readonly string[];
}

export interface ComponentResult {
  readonly key: string;
  readonly clause: string;
  readonly formula: string;
  /** Including the corrosion allowance. */
  readonly requiredThicknessMm: number;
  readonly requiredCorrodedThicknessMm: number;
  readonly nominalThicknessMm: number;
  /** Nominal minus the corrosion allowance. */
  readonly availableThicknessMm: number;
  readonly mawpMPa: number;
  readonly status: 'fail' | 'pass_with_review';
  /** EQP_SHELL_UNDER_THICKNESS / EQP_HEAD_UNDER_THICKNESS and EQP_MAWP_BELOW_DESIGN when they apply. */
  readonly failures: readonly string[];
  readonly inputs: Readonly<Record<string, number | string | boolean>>;
  readonly longitudinal?: { readonly formula: string; readonly requiredThicknessMm: number; readonly mawpMPa: number };
  readonly pressureLimitMPa?: number;
}

export type PartOutcome =
  | { readonly key: string; readonly result: ComponentResult }
  | { readonly key: string; readonly refusal: CodeFinding };

export interface AsmeResult {
  readonly pressureMPa: number;
  readonly allowableStressMPa: number;
  readonly allowableStressSource: string | null;
  readonly jointEfficiency: { readonly shell: number; readonly heads: number };
  readonly corroded: boolean;
  readonly parts: readonly PartOutcome[];
  readonly warnings: readonly CodeFinding[];
  readonly staticHeadMPa: number | null;
  readonly hydrotest: { readonly ratio: number; readonly ratioDefaulted: boolean };
}

export interface AsmeOptions {
  readonly mmPerUnit: number;
  readonly corroded: boolean;
  readonly pressure?: PressureQuantity | undefined;
}

const TOLERANCE = 1e-9;
const GRAVITY = 9.80665;
const FD_KNUCKLE_RATIO = 0.06;

const refusal = (code: string, message: string, paths: string[]): { refusal: CodeFinding } => ({ refusal: { code, message, paths } });

interface Inputs {
  readonly pressure: number;
  readonly stress: number;
  readonly efficiency: { readonly shell: number; readonly heads: number };
  readonly pressurePath: string;
}

/** Pressure, S and E, or the first missing one (never defaulted). */
function designInputs(plant: PlantEquipmentData, options: AsmeOptions): Inputs | { refusal: CodeFinding } {
  const design = plant.design;
  const pressure = options.pressure ?? design?.pressure;
  const pressurePath = options.pressure === undefined ? 'design.pressure' : 'pressure';
  if (pressure === undefined)
    return refusal('EQP_DESIGN_DATA_MISSING', 'design pressure is missing (design.pressure or the pressure override)', ['design.pressure']);
  const p = pressureToMpa(pressure.value, pressure.unit);
  if (!(p > 0))
    return refusal('EQP_PARAM_INVALID', 'internal design pressure must be above 0 (external pressure, UG-28, is not covered)', [
      pressurePath,
    ]);
  if (design?.allowableStress === undefined)
    return refusal('EQP_ALLOWABLE_MISSING', 'allowable stress S is missing: llull never defaults it', ['design.allowableStress']);
  if (design.jointEfficiency === undefined)
    return refusal('EQP_ALLOWABLE_MISSING', 'joint efficiency E is missing: llull never defaults it', ['design.jointEfficiency']);
  return {
    pressure: p,
    stress: stressToMpa(design.allowableStress.value, design.allowableStress.unit),
    efficiency: design.jointEfficiency,
    pressurePath,
  };
}

interface Basis {
  readonly key: string;
  readonly nominal: number;
  readonly corrosion: number;
  readonly pressure: number;
  readonly se: number;
  readonly corroded: boolean;
  readonly isHead: boolean;
}

function finish(
  basis: Basis,
  clause: string,
  formula: string,
  requiredCorroded: number,
  mawp: number,
  inputs: ComponentResult['inputs'],
  extra: Partial<ComponentResult> = {},
): ComponentResult {
  const available = basis.nominal - basis.corrosion;
  const failures: string[] = [];
  if (available < requiredCorroded * (1 - TOLERANCE))
    failures.push(basis.isHead ? 'EQP_HEAD_UNDER_THICKNESS' : 'EQP_SHELL_UNDER_THICKNESS');
  if (mawp < basis.pressure * (1 - TOLERANCE)) failures.push('EQP_MAWP_BELOW_DESIGN');
  return {
    key: basis.key,
    clause,
    formula,
    requiredThicknessMm: requiredCorroded + basis.corrosion,
    requiredCorrodedThicknessMm: requiredCorroded,
    nominalThicknessMm: basis.nominal,
    availableThicknessMm: available,
    mawpMPa: mawp,
    status: failures.length > 0 ? 'fail' : 'pass_with_review',
    failures,
    inputs: {
      ...inputs,
      pressureMPa: basis.pressure,
      SE_MPa: basis.se,
      corrosionAllowanceMm: basis.corrosion,
      corrodedDimensions: basis.corroded,
    },
    ...extra,
  };
}

const basisOf = (
  key: string,
  nominalUnits: number,
  template: VesselTemplate,
  mm: number,
  inputs: Inputs,
  corroded: boolean,
  isHead: boolean,
): Basis => ({
  key,
  nominal: nominalUnits * mm,
  corrosion: template.corrosionAllowance * mm,
  pressure: inputs.pressure,
  se: inputs.stress * (isHead ? inputs.efficiency.heads : inputs.efficiency.shell),
  corroded,
  isHead,
});

/** UG-27(c)(1) circumferential stress; (c)(2) longitudinal reported. Refuses P > 0.385 S E and t > R/2. */
function shellPart(template: VesselTemplate, mm: number, inputs: Inputs, corroded: boolean): PartOutcome {
  const basis = basisOf('shell', template.shellThickness, template, mm, inputs, corroded, false);
  const radius = (template.insideDiameter * mm) / 2 + (corroded ? basis.corrosion : 0);
  const limit = 0.385 * basis.se;
  const outOfRange = (message: string, path: string): PartOutcome => ({
    key: 'shell',
    ...refusal('EQP_FORMULA_OUT_OF_RANGE', message, [path]),
  });
  if (inputs.pressure > limit)
    return outOfRange(`UG-27(c)(1) needs P <= 0.385 S E = ${limit.toPrecision(8)} MPa, P is ${inputs.pressure}`, inputs.pressurePath);
  const available = basis.nominal - basis.corrosion;
  if (available > radius / 2)
    return outOfRange(`UG-27(c)(1) needs t <= R/2: corroded thickness ${available} mm, R ${radius} mm`, 'shellThickness');
  const p = inputs.pressure;
  const result = finish(
    basis,
    'UG-27(c)(1)',
    't = P R / (S E - 0.6 P); P = S E t / (R + 0.6 t)',
    (p * radius) / (basis.se - 0.6 * p),
    (basis.se * available) / (radius + 0.6 * available),
    { radiusMm: radius },
    {
      longitudinal: {
        formula: 'UG-27(c)(2): t = P R / (2 S E + 0.4 P); P = 2 S E t / (R - 0.4 t)',
        requiredThicknessMm: (p * radius) / (2 * basis.se + 0.4 * p),
        mawpMPa: (2 * basis.se * available) / (radius - 0.4 * available),
      },
      pressureLimitMPa: limit,
    },
  );
  return { key: 'shell', result };
}

/** UG-32 head formulas by type, or the coded refusal. */
function headPart(
  key: string,
  path: string,
  shape: HeadShape,
  template: VesselTemplate,
  mm: number,
  inputs: Inputs,
  corroded: boolean,
): PartOutcome {
  const basis = basisOf(key, template.headThickness, template, mm, inputs, corroded, true);
  const grow = corroded ? basis.corrosion : 0;
  const available = basis.nominal - basis.corrosion;
  const { pressure: p, se } = basis;
  const notCovered = (why: string): PartOutcome => ({ key, ...refusal('EQP_HEAD_NOT_COVERED', why, [path]) });
  if (shape.kind === 'ellipsoidal') {
    const ratio = template.insideDiameter / (2 * shape.depth);
    if (Math.abs(ratio - 2) > TOLERANCE) return notCovered(`UG-32(d) covers 2:1 ellipsoidal heads only; this head has ratio ${ratio}`);
    const diameter = template.insideDiameter * mm + 2 * grow;
    const formula = 't = P D / (2 S E - 0.2 P); P = 2 S E t / (D + 0.2 t)';
    const required = (p * diameter) / (2 * se - 0.2 * p);
    return {
      key,
      result: finish(basis, 'UG-32(d)', formula, required, (2 * se * available) / (diameter + 0.2 * available), { diameterMm: diameter }),
    };
  }
  if (shape.kind === 'spherical') {
    const crown = (template.insideDiameter * mm) / 2 + grow;
    const formula = 't = P L / (2 S E - 0.2 P); P = 2 S E t / (L + 0.2 t)';
    const required = (p * crown) / (2 * se - 0.2 * p);
    return {
      key,
      result: finish(basis, 'UG-32(f)', formula, required, (2 * se * available) / (crown + 0.2 * available), { crownRadiusMm: crown }),
    };
  }
  if (shape.kind === 'torispherical') {
    const proportions = shape.knuckleRadius / shape.crownRadius;
    if (Math.abs(proportions - FD_KNUCKLE_RATIO) > 1e-6 || shape.crownRadius > template.insideDiameter * (1 + TOLERANCE))
      return notCovered(
        `UG-32(e) is built for ASME flanged and dished proportions only (knuckle 6 % of the crown radius, crown radius <= D); this head has k/L ${proportions}`,
      );
    const crown = shape.crownRadius * mm + grow;
    const formula = 't = 0.885 P L / (S E - 0.1 P); P = S E t / (0.885 L + 0.1 t)';
    const required = (0.885 * p * crown) / (se - 0.1 * p);
    return {
      key,
      result: finish(basis, 'UG-32(e)', formula, required, (se * available) / (0.885 * crown + 0.1 * available), { crownRadiusMm: crown }),
    };
  }
  return notCovered(
    `${shape.kind} heads have no MVP formula (use 2:1 ellipsoidal, ASME F&D torispherical or hemispherical, or review manually)`,
  );
}

/**
 * Thickness of every part of `plant`'s vessel. A whole-vessel refusal (`{ refusal }`) means pressure, S or E is missing (or the plant is not a
 * valid vessel); a part outside the formulas refuses only itself so a check can still judge the others.
 * @invariant corroded dimensions (R + CA, D + 2 CA, L + CA) unless `options.corroded` is false; available = nominal - CA; S, E never defaulted
 */
export function asmeThickness(plant: PlantEquipmentData, options: AsmeOptions): AsmeResult | { refusal: CodeFinding } {
  const { template } = plant;
  if (template.kind !== 'vessel') return refusal('EQP_NOT_PARAMETRIC', 'not a parametric vessel', ['equipment']);
  const geometry = resolveVessel(template);
  if ('error' in geometry) return refusal('EQP_HEAD_INVALID', geometry.error, [geometry.path]);
  const inputs = designInputs(plant, options);
  if ('refusal' in inputs) return inputs;
  const vertical = template.orientation === 'vertical';
  const mm = options.mmPerUnit;
  const parts: PartOutcome[] = [
    shellPart(template, mm, inputs, options.corroded),
    headPart(vertical ? 'headBottom' : 'headLeft', 'heads.first', geometry.first, template, mm, inputs, options.corroded),
    headPart(vertical ? 'headTop' : 'headRight', 'heads.second', geometry.second, template, mm, inputs, options.corroded),
  ];
  const design = plant.design;
  const stress = design?.allowableStress;
  const warnings: CodeFinding[] = [];
  if (stress !== undefined && (stress.source === undefined || stress.source === ''))
    warnings.push({ code: 'EQP_VALUE_UNSOURCED', message: 'allowable stress S has no source', paths: ['design.allowableStress.source'] });
  const test = design?.allowableStressAtTest;
  const liquid = design?.operatingLiquid;
  const column = liquid === undefined ? 0 : liquid.levelAboveBottomTangent + (vertical ? geometry.first.depth : 0);
  return {
    pressureMPa: inputs.pressure,
    allowableStressMPa: inputs.stress,
    allowableStressSource: stress?.source ?? null,
    jointEfficiency: inputs.efficiency,
    corroded: options.corroded,
    parts,
    warnings,
    staticHeadMPa: liquid === undefined ? null : (liquid.specificGravity * 1000 * GRAVITY * ((column * mm) / 1000)) / 1e6,
    hydrotest: { ratio: test === undefined ? 1 : stressToMpa(test.value, test.unit) / inputs.stress, ratioDefaulted: test === undefined },
  };
}
