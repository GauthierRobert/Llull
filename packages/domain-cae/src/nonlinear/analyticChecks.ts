/** The five `nonlinear_analytic_check` hand checks: input reading and result values (formulas in analyticFormulas.ts). */

import { inputValue, inputValues, isInputProblem, type InputProblem, type InputSpec } from '../creep/inputs';
import { SUPPORTS, elastica, momentRatio, plasticHinge, pressureAtPlasticRadius, thickCylinder } from './analyticFormulas';

export const CHECKS = [
  'plastic_hinge_beam',
  'moment_curvature_rectangle',
  'thick_cylinder_pressure',
  'elastica_cantilever',
  'imperfect_column',
] as const;
export type NonlinearCheck = (typeof CHECKS)[number];

export interface CheckValue {
  readonly value: number;
  readonly unit: string;
}

export interface CheckOutput {
  readonly values: Readonly<Record<string, CheckValue>>;
  readonly formula: string;
  readonly source: string;
  readonly warnings: readonly string[];
}

export interface CheckFailure {
  readonly code: 'NLS_INPUT_MISSING' | 'NLS_INPUT_INVALID';
  readonly message: string;
  readonly key: string;
}

type Inputs = Readonly<Record<string, unknown>>;
type Result = CheckOutput | CheckFailure;

export const isCheckFailure = (value: Result): value is CheckFailure => 'code' in value;

const plain = <K extends string>(key: K): InputSpec<K> => ({ key, unit: null, sign: 'positive' });
const mm = <K extends string>(key: K): InputSpec<K> => ({ key, unit: 'mm', sign: 'positive' });
const mpa = <K extends string>(key: K): InputSpec<K> => ({ key, unit: 'MPa', sign: 'positive' });
const quantity = (value: number, unit: string): CheckValue => ({ value, unit });
const invalid = (key: string, message: string): CheckFailure => ({ code: 'NLS_INPUT_INVALID', key, message: `input ${key}: ${message}` });

const asFailure = (problem: InputProblem): CheckFailure => ({
  code: problem.code === 'CRP_INPUT_MISSING' ? 'NLS_INPUT_MISSING' : 'NLS_INPUT_INVALID',
  key: problem.key,
  message: problem.message,
});

/** Optional section inputs b_mm, h_mm, sigmaY_MPa: all or none. */
function optionalSection(inputs: Inputs): { readonly b: number; readonly h: number; readonly sigmaY: number } | CheckFailure | null {
  const keys = ['b_mm', 'h_mm', 'sigmaY_MPa'];
  const given = keys.filter((key) => Object.hasOwn(inputs, key));
  if (given.length === 0) return null;
  const v = inputValues(inputs, [mm('b_mm'), mm('h_mm'), mpa('sigmaY_MPa')]);
  return isInputProblem(v) ? asFailure(v) : { b: v.b_mm, h: v.h_mm, sigmaY: v.sigmaY_MPa };
}

function plasticHingeBeam(inputs: Inputs): Result {
  const raw = Object.hasOwn(inputs, 'support') ? inputs['support'] : undefined;
  if (raw === undefined)
    return { code: 'NLS_INPUT_MISSING', key: 'support', message: `input support is missing (${SUPPORTS.join(' | ')})` };
  const support = SUPPORTS.find((name) => name === raw);
  if (support === undefined) return invalid('support', `must be one of ${SUPPORTS.join(', ')}`);
  const v = inputValues(inputs, [mm('b_mm'), mm('h_mm'), mpa('sigmaY_MPa'), mm('L_mm')]);
  if (isInputProblem(v)) return asFailure(v);
  const hinge = plasticHinge(support, v.b_mm, v.h_mm, v.sigmaY_MPa, v.L_mm);
  return {
    values: {
      plasticMoment: quantity(hinge.plasticMomentNmm, 'N*mm'),
      yieldMoment: quantity(hinge.yieldMomentNmm, 'N*mm'),
      shapeFactor: quantity(hinge.shapeFactor, '1'),
      collapseLoad: quantity(hinge.collapseLoadN, 'N'),
    },
    formula:
      'M_p = sigmaY b h^2/4, M_y = sigmaY b h^2/6; collapse load (virtual work, small deflection): cantilever tip M_p/L, simply supported central 4 M_p/L, propped cantilever central 6 M_p/L, fixed-fixed central 8 M_p/L',
    source: 'textbook plastic analysis, generate_nls_reference.py (VC-NLS-40.a-d)',
    warnings:
      support === 'fixed_fixed' ? ['fixed-fixed: small-deflection collapse; membrane action under large deflection is excluded'] : [],
  };
}

function momentCurvature(inputs: Inputs): Result {
  const ratio = inputValue(inputs, plain('kappaOverKappaY'));
  if (isInputProblem(ratio)) return asFailure(ratio);
  const section = optionalSection(inputs);
  if (section !== null && 'code' in section) return section;
  const values: Record<string, CheckValue> = { momentOverYieldMoment: quantity(momentRatio(ratio), '1') };
  if (section !== null) {
    const yieldMoment = (section.sigmaY * section.b * section.h * section.h) / 6;
    values['yieldMoment'] = quantity(yieldMoment, 'N*mm');
    values['moment'] = quantity(momentRatio(ratio) * yieldMoment, 'N*mm');
    if (Object.hasOwn(inputs, 'E_MPa')) {
      const young = inputValue(inputs, mpa('E_MPa'));
      if (isInputProblem(young)) return asFailure(young);
      values['yieldCurvature'] = quantity((2 * section.sigmaY) / (young * section.h), '1/mm');
    }
  } else if (Object.hasOwn(inputs, 'E_MPa'))
    return invalid('E_MPa', 'the yield curvature needs the section: give b_mm, h_mm and sigmaY_MPa as well');
  return {
    values,
    formula: 'M/M_y = kappa/kappa_y (kappa <= kappa_y); 1.5 (1 - (kappa_y/kappa)^2/3) (kappa > kappa_y); kappa_y = 2 sigmaY/(E h)',
    source: 'stress-block derivation, generate_nls_reference.py (VC-NLS-40.e)',
    warnings: [],
  };
}

function thickCylinderPressure(inputs: Inputs): Result {
  const v = inputValues(inputs, [mm('a_mm'), mm('b_mm'), mpa('sigmaY_MPa'), { key: 'nu', unit: null, sign: 'nonNegative' }]);
  if (isInputProblem(v)) return asFailure(v);
  const { a_mm: a, b_mm: b, sigmaY_MPa: sigmaY, nu } = v;
  if (!(b > a)) return invalid('b_mm', 'the outer radius must exceed the bore radius a_mm');
  if (!(nu < 0.5)) return invalid('nu', 'must be < 0.5');
  const cylinder = thickCylinder(a, b, sigmaY, nu);
  const values: Record<string, CheckValue> = {
    trescaFirstYieldPressure: quantity(cylinder.trescaFirstYieldMPa, 'MPa'),
    trescaCollapsePressure: quantity(cylinder.trescaCollapseMPa, 'MPa'),
    misesFirstYieldPressure: quantity(cylinder.misesFirstYieldMPa, 'MPa'),
    misesCollapsePressure: quantity(cylinder.misesCollapseMPa, 'MPa'),
  };
  if (Object.hasOwn(inputs, 'c_mm')) {
    const c = inputValue(inputs, mm('c_mm'));
    if (isInputProblem(c)) return asFailure(c);
    if (c < a || c > b) return invalid('c_mm', 'the plastic radius must lie between a_mm and b_mm');
    values['trescaPressureAtPlasticRadius'] = quantity(pressureAtPlasticRadius(a, b, c, sigmaY / 2), 'MPa');
    values['misesPressureAtPlasticRadius'] = quantity(pressureAtPlasticRadius(a, b, c, sigmaY / Math.sqrt(3)), 'MPa');
  }
  return {
    values,
    formula:
      'Tresca p_y = (sigmaY/2)(1 - a^2/b^2), p_c = sigmaY ln(b/a); von Mises first yield: Lame stresses at r = a with sigma_z = nu (sigma_r + sigma_theta); von Mises collapse (incompressible, k = sigmaY/sqrt3) p_c = (2/sqrt3) sigmaY ln(b/a); plastic radius c: p = k (1 - c^2/b^2 + 2 ln(c/a))',
    source: 'Lame + limit analysis (Hill), generate_nls_reference.py (VC-NLS-30.a-e)',
    warnings: [
      'first yield and collapse are closed forms of the elastic-perfectly plastic tube; the plane-strain first yield depends on nu',
    ],
  };
}

function elasticaCantilever(inputs: Inputs): Result {
  const lambda = inputValue(inputs, plain('lambda'));
  if (isInputProblem(lambda)) return asFailure(lambda);
  const result = elastica(lambda);
  return {
    values: {
      deltaVOverL: quantity(result.deltaVOverL, '1'),
      deltaHOverL: quantity(result.deltaHOverL, '1'),
      tipSlope: quantity(result.tipSlopeRad, 'rad'),
      linearDeltaVOverL: quantity(result.linearDeltaVOverL, '1'),
    },
    formula:
      'k^2 = (1 + sin theta0)/2, sin phi1 = 1/(k sqrt2), alpha L = K(k) - F(phi1,k), lambda = P L^2/EI = (alpha L)^2, dv/L = 1 - 2 (E(k) - E(phi1,k))/(alpha L), x_tip/L = sqrt(2 sin theta0)/(alpha L); linear theory dv/L = lambda/3',
    source: 'Bisshopp & Drucker 1945 (elastica), generate_nls_reference.py (VC-NLS-10.a-d)',
    warnings: [],
  };
}

function imperfectColumn(inputs: Inputs): Result {
  const v = inputValues(inputs, [mpa('E_MPa'), mm('L_mm'), mm('w0_mm')]);
  if (isInputProblem(v)) return asFailure(v);
  let inertia: number;
  if (Object.hasOwn(inputs, 'I_mm4')) {
    const given = inputValue(inputs, { key: 'I_mm4', unit: 'mm^4', sign: 'positive' });
    if (isInputProblem(given)) return asFailure(given);
    inertia = given;
  } else {
    const section = inputValues(inputs, [mm('b_mm'), mm('h_mm')]);
    if (isInputProblem(section))
      return {
        code: 'NLS_INPUT_MISSING',
        key: 'I_mm4',
        message: 'input I_mm4 (mm^4), or b_mm and h_mm of a rectangle (weak axis), is missing',
      };
    inertia = (Math.max(section.b_mm, section.h_mm) * Math.min(section.b_mm, section.h_mm) ** 3) / 12;
  }
  const critical = (Math.PI ** 2 * v.E_MPa * inertia) / v.L_mm ** 2;
  const hasLoad = Object.hasOwn(inputs, 'P_N');
  const hasRatio = Object.hasOwn(inputs, 'PoverPcr');
  if (hasLoad === hasRatio) return invalid(hasLoad ? 'P_N' : 'PoverPcr', 'give exactly one of P_N (N) and PoverPcr');
  const load = hasLoad
    ? inputValue(inputs, { key: 'P_N', unit: 'N', sign: 'nonNegative' })
    : inputValue(inputs, { key: 'PoverPcr', unit: null, sign: 'nonNegative' });
  if (isInputProblem(load)) return asFailure(load);
  const ratio = hasLoad ? load / critical : load;
  if (!(ratio < 1))
    return invalid(
      hasLoad ? 'P_N' : 'PoverPcr',
      `the load must stay below the Euler load ${critical} N (the amplification diverges at P_cr)`,
    );
  const amplification = 1 / (1 - ratio);
  return {
    values: {
      eulerLoad: quantity(critical, 'N'),
      loadOverEulerLoad: quantity(ratio, '1'),
      amplification: quantity(amplification, '1'),
      midSpanDeflection: quantity(v.w0_mm * amplification, 'mm'),
      additionalDeflection: quantity(v.w0_mm * (amplification - 1), 'mm'),
    },
    formula: 'P_cr = pi^2 E I/L^2; w = w0/(1 - P/P_cr) (first-mode imperfection, small deflection); additional deflection w - w0',
    source: 'Timoshenko & Gere, Theory of Elastic Stability (imperfect column), generate_nls_reference.py (VC-NLS-50.a-c)',
    warnings: [],
  };
}

const RUN: Readonly<Record<NonlinearCheck, (inputs: Inputs) => Result>> = {
  plastic_hinge_beam: plasticHingeBeam,
  moment_curvature_rectangle: momentCurvature,
  thick_cylinder_pressure: thickCylinderPressure,
  elastica_cantilever: elasticaCantilever,
  imperfect_column: imperfectColumn,
};

export const runCheck = (check: NonlinearCheck, inputs: Inputs): Result => RUN[check](inputs);
