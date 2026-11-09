/** The eleven `creep_closed_form` checks (PHY-11 §5.2): input specs, formula text and the values they return. */

import {
  beamElasticOuter,
  beamStationary,
  boltEffectiveModulus,
  kelvinVoigtCompliance,
  nortonStrain,
  pronyModulus,
  relaxedStress,
  slsCompliance,
  timeToFraction,
  tubeStationary,
  wlfLogShift,
} from './closedForm';
import { isInputProblem, inputValue, inputValues, type InputProblem, type InputSpec } from './inputs';
import { convertNortonA } from '@core/model/materialLaws/nortonUnits';

export const CHECKS = [
  'norton_constant_stress',
  'norton_relaxation',
  'bolt_relaxation',
  'thick_cylinder_stationary',
  'beam_stationary',
  'maxwell',
  'kelvin_voigt',
  'sls',
  'prony_relaxation',
  'wlf_shift',
  'convert_norton_a',
] as const;
export type CreepCheck = (typeof CHECKS)[number];

interface CheckValue {
  readonly value: number;
  readonly unit: string;
}

interface CheckOutput {
  readonly values: Readonly<Record<string, CheckValue>>;
  readonly formula: string;
  readonly warnings: readonly string[];
}

/** A refusal with its stable code (`key`: the offending input, when it is one). */
export interface CheckFailure {
  readonly code: 'CRP_INPUT_MISSING' | 'CRP_INPUT_INVALID' | 'CRP_WLF_OUT_OF_RANGE';
  readonly message: string;
  readonly key?: string;
}

type Inputs = Readonly<Record<string, unknown>>;
type Result = CheckOutput | CheckFailure;

const plain = <K extends string>(key: K, sign: InputSpec['sign'] = 'positive'): InputSpec<K> => ({ key, unit: null, sign });
const mpa = <K extends string>(key: K, sign: InputSpec['sign'] = 'positive'): InputSpec<K> => ({ key, unit: 'MPa', sign });
const seconds = <K extends string>(key: K, sign: InputSpec['sign'] = 'positive'): InputSpec<K> => ({ key, unit: 's', sign });
const metres = <K extends string>(key: K): InputSpec<K> => ({ key, unit: 'm', sign: 'positive' });
const mm = <K extends string>(key: K): InputSpec<K> => ({ key, unit: 'mm', sign: 'positive' });
const value = (v: number, unit: string): CheckValue => ({ value: v, unit });
const fail = (code: CheckFailure['code'], message: string, key?: string): CheckFailure => ({
  code,
  message,
  ...(key !== undefined ? { key } : {}),
});
const invalid = (key: string, message: string): CheckFailure => fail('CRP_INPUT_INVALID', `input ${key}: ${message}`, key);
const asFailure = (problem: InputProblem): CheckFailure => fail(problem.code, problem.message, problem.key);

/** An `m` other than 0 is refused where the closed form assumes ε̇ = A σⁿ (relaxation checks). */
function relaxationExponent(inputs: Inputs): CheckFailure | null {
  const raw = inputs['m'];
  return raw === undefined || raw === 0 ? null : invalid('m', 'the relaxation closed form holds for m = 0 (no time hardening)');
}

function nortonConstantStress(inputs: Inputs): Result {
  const v = inputValues(inputs, [plain('A'), plain('n'), plain('m', 'any'), mpa('sigma_MPa'), seconds('t_s', 'nonNegative')]);
  if (isInputProblem(v)) return asFailure(v);
  const { A, n, m, sigma_MPa: sigma, t_s: t } = v;
  if (!(m > -1)) return invalid('m', 'must be > -1');
  return {
    values: { equivalentCreepStrain: value(nortonStrain(A, n, m, sigma, t), '-') },
    formula: 'eps = A sigma^n t^(m+1)/(m+1) (CalculiX *CREEP LAW=NORTON, time hardening; A in MPa^-n s^-(m+1))',
    warnings: [],
  };
}

function nortonRelaxation(inputs: Inputs): Result {
  const v = inputValues(inputs, [mpa('E_MPa'), plain('A'), plain('n'), mpa('sigma0_MPa')]);
  if (isInputProblem(v)) return asFailure(v);
  const exponent = relaxationExponent(inputs);
  if (exponent !== null) return exponent;
  const { E_MPa: E, A, n, sigma0_MPa: sigma0 } = v;
  const values: Record<string, CheckValue> = {};
  if (Object.hasOwn(inputs, 't_s')) {
    const t = inputValue(inputs, seconds('t_s', 'nonNegative'));
    if (isInputProblem(t)) return asFailure(t);
    values['stressMPa'] = value(relaxedStress(sigma0, E, A, n, t), 'MPa');
  }
  if (Object.hasOwn(inputs, 'fraction')) {
    const f = inputValue(inputs, plain('fraction'));
    if (isInputProblem(f)) return asFailure(f);
    if (!(f < 1)) return invalid('fraction', 'must be in (0, 1)');
    values['timeToFractionS'] = value(timeToFraction(sigma0, E, A, n, f), 's');
  }
  if (Object.keys(values).length === 0)
    return fail('CRP_INPUT_MISSING', 'input t_s (s) or fraction (0..1) is missing: give at least one', 't_s');
  return {
    values,
    formula: 'sigma = [sigma0^(1-n) + (n-1) E A t]^(1/(1-n)); t_f = sigma0^(1-n)(f^(1-n) - 1)/((n-1) E A); n = 1: sigma0 exp(-E A t)',
    warnings: [],
  };
}

function boltRelaxation(inputs: Inputs): Result {
  const v = inputValues(inputs, [
    mpa('E_MPa'),
    plain('A'),
    plain('n'),
    mpa('sigma0_MPa'),
    plain('kb_over_km', 'nonNegative'),
    seconds('t_s', 'nonNegative'),
  ]);
  if (isInputProblem(v)) return asFailure(v);
  const exponent = relaxationExponent(inputs);
  if (exponent !== null) return exponent;
  const { E_MPa: E, A, n, sigma0_MPa: sigma0, kb_over_km: ratio, t_s: t } = v;
  const effective = boltEffectiveModulus(E, ratio);
  const sigma = relaxedStress(sigma0, effective, A, n, t);
  return {
    values: { preloadRatio: value(sigma / sigma0, '-'), boltStressMPa: value(sigma, 'MPa'), effectiveModulusMPa: value(effective, 'MPa') },
    formula: "F/F0 = sigma/sigma0 of the relaxation law with E' = E/(1 + kb/km) (kb/km = 0: rigid members)",
    warnings: [],
  };
}

function thickCylinder(inputs: Inputs): Result {
  const v = inputValues(inputs, [mpa('p_MPa'), metres('a_m'), metres('b_m'), plain('n')]);
  if (isInputProblem(v)) return asFailure(v);
  const { p_MPa: p, a_m: a, b_m: b, n } = v;
  if (!(b > a)) return invalid('b_m', 'the outer radius must exceed the bore radius a_m');
  const values: Record<string, CheckValue> = {};
  const at = (label: string, r: number): void => {
    const s = tubeStationary(p, a, b, n, r);
    values[`hoopAt${label}MPa`] = value(s.hoop, 'MPa');
    values[`radialAt${label}MPa`] = value(s.radial, 'MPa');
    values[`axialAt${label}MPa`] = value(s.axial, 'MPa');
    values[`vonMisesAt${label}MPa`] = value(s.vonMises, 'MPa');
  };
  at('Bore', a);
  at('Outer', b);
  if (Object.hasOwn(inputs, 'r_m')) {
    const r = inputValue(inputs, metres('r_m'));
    if (isInputProblem(r)) return asFailure(r);
    if (r < a || r > b) return invalid('r_m', 'must lie between a_m and b_m');
    at('R', r);
  }
  values['lameHoopAtBoreMPa'] = value((p * (b * b + a * a)) / (b * b - a * a), 'MPa');
  return {
    values,
    formula:
      'sigma_r = -p[(b/r)^(2/n) - 1]/[(b/a)^(2/n) - 1]; sigma_t = p[1 + (2/n - 1)(b/r)^(2/n)]/[(b/a)^(2/n) - 1]; sigma_z = (sigma_r + sigma_t)/2; sigma_eq = sqrt(3)/2 (sigma_t - sigma_r); n = 1 is Lame',
    warnings: [
      'the stationary-creep closed form is derived in generate_creep_reference.py; a textbook confirmation is still open (sources.md)',
    ],
  };
}

function beamStationaryCheck(inputs: Inputs): Result {
  const v = inputValues(inputs, [{ key: 'M_Nmm', unit: 'N*mm', sign: 'positive' }, mm('b_mm'), mm('h_mm'), plain('n')]);
  if (isInputProblem(v)) return asFailure(v);
  const { M_Nmm: M, b_mm: b, h_mm: h, n } = v;
  const values: Record<string, CheckValue> = {
    outerFibreMPa: value(beamStationary(M, b, h, n, h / 2), 'MPa'),
    elasticOuterFibreMPa: value(beamElasticOuter(M, b, h), 'MPa'),
    atQuarterHeightMPa: value(beamStationary(M, b, h, n, h / 4), 'MPa'),
  };
  if (Object.hasOwn(inputs, 'y_mm')) {
    const y = inputValue(inputs, { key: 'y_mm', unit: 'mm', sign: 'any' });
    if (isInputProblem(y)) return asFailure(y);
    if (Math.abs(y) > h / 2) return invalid('y_mm', 'must lie within +-h/2');
    values['atYMPa'] = value(beamStationary(M, b, h, n, y), 'MPa');
  }
  return {
    values,
    formula: 'sigma(y) = M |y|^(1/n) sign(y)/I_n, I_n = 2b(h/2)^(2+1/n)/(2+1/n); sigma_max = (2n+1)/(3n) 6M/(b h^2)',
    warnings: [],
  };
}

function maxwell(inputs: Inputs): Result {
  const v = inputValues(inputs, [mpa('E_MPa'), seconds('tau_s'), seconds('t_s', 'nonNegative')]);
  if (isInputProblem(v)) return asFailure(v);
  const { E_MPa: E, tau_s: tau, t_s: t } = v;
  return {
    values: { relaxationModulusMPa: value(pronyModulus(0, [{ E, tau }], t), 'MPa') },
    formula: 'E(t) = E exp(-t/tau)',
    warnings: [],
  };
}

function kelvinVoigt(inputs: Inputs): Result {
  const v = inputValues(inputs, [mpa('E_MPa'), seconds('tau_s'), seconds('t_s', 'nonNegative')]);
  if (isInputProblem(v)) return asFailure(v);
  const { E_MPa: E, tau_s: tau, t_s: t } = v;
  return {
    values: { creepComplianceInvMPa: value(kelvinVoigtCompliance(E, tau, t), '1/MPa') },
    formula: 'J(t) = (1 - exp(-t/tau))/E',
    warnings: [],
  };
}

function sls(inputs: Inputs): Result {
  const v = inputValues(inputs, [mpa('Einf_MPa'), mpa('E1_MPa'), seconds('tau_s'), seconds('t_s', 'nonNegative')]);
  if (isInputProblem(v)) return asFailure(v);
  const { Einf_MPa: Einf, E1_MPa: E1, tau_s: tau, t_s: t } = v;
  const E = pronyModulus(Einf, [{ E: E1, tau }], t);
  const J = slsCompliance(Einf, E1, tau, t);
  return {
    values: {
      relaxationModulusMPa: value(E, 'MPa'),
      creepComplianceInvMPa: value(J, '1/MPa'),
      retardationTimeS: value((tau * (Einf + E1)) / Einf, 's'),
      modulusTimesCompliance: value(E * J, '-'),
    },
    formula: 'E(t) = Einf + E1 exp(-t/tau); J(t) = 1/Einf - E1/(E0 Einf) exp(-t Einf/(tau E0)), E0 = Einf + E1',
    warnings: [],
  };
}

function pronyRelaxation(inputs: Inputs): Result {
  const v = inputValues(inputs, [mpa('Einf_MPa', 'nonNegative'), seconds('t_s', 'nonNegative')]);
  if (isInputProblem(v)) return asFailure(v);
  const raw = inputs['terms'];
  if (raw === undefined) return fail('CRP_INPUT_MISSING', 'input terms ([{ E_MPa, tau_s }, ...]) is missing', 'terms');
  if (!Array.isArray(raw) || raw.length === 0) return invalid('terms', 'must be a non-empty array of { E_MPa, tau_s }');
  const terms: { E: number; tau: number }[] = [];
  for (const [index, entry] of raw.entries()) {
    const term =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? inputValues(entry as Inputs, [mpa('E_MPa'), seconds('tau_s')])
        : null;
    if (term === null) return invalid(`terms[${index}]`, 'must be { E_MPa, tau_s }');
    if (isInputProblem(term)) return fail(term.code, `terms[${index}]: ${term.message}`, `terms[${index}].${term.key}`);
    terms.push({ E: term.E_MPa, tau: term.tau_s });
  }
  return {
    values: { relaxationModulusMPa: value(pronyModulus(v.Einf_MPa, terms, v.t_s), 'MPa') },
    formula: 'E(t) = Einf + sum_i E_i exp(-t/tau_i)',
    warnings: [],
  };
}

const SHIFTED = ['Einf_MPa', 'E1_MPa', 'tau_s', 't_s'] as const;

function wlfShift(inputs: Inputs): Result {
  const v = inputValues(inputs, [
    plain('C1'),
    { key: 'C2_K', unit: 'K', sign: 'positive' },
    { key: 'T_minus_Tr_K', unit: 'K', sign: 'any' },
  ]);
  if (isInputProblem(v)) return asFailure(v);
  const { C1, C2_K: C2, T_minus_Tr_K: delta } = v;
  if (delta < 0)
    return fail('CRP_WLF_OUT_OF_RANGE', `T - Tr = ${delta} K is below the reference temperature: WLF is not valid there`, 'T_minus_Tr_K');
  const log = wlfLogShift(C1, C2, delta);
  const values: Record<string, CheckValue> = { log10ShiftFactor: value(log, '-'), shiftFactor: value(10 ** log, '-') };
  if (SHIFTED.some((key) => Object.hasOwn(inputs, key))) {
    const shifted = inputValues(inputs, [mpa('Einf_MPa'), mpa('E1_MPa'), seconds('tau_s'), seconds('t_s', 'nonNegative')]);
    if (isInputProblem(shifted)) return asFailure(shifted);
    const terms = [{ E: shifted.E1_MPa, tau: shifted.tau_s }];
    values['shiftedModulusMPa'] = value(pronyModulus(shifted.Einf_MPa, terms, shifted.t_s / 10 ** log), 'MPa');
  }
  return { values, formula: 'log10 aT = -C1 (T - Tr)/(C2 + T - Tr); E(t, T) = E_ref(t/aT)', warnings: [] };
}

const UNIT_KEYS = ['from_stress_unit', 'from_time_unit', 'to_stress_unit', 'to_time_unit'] as const;

function convertNorton(inputs: Inputs): Result {
  const v = inputValues(inputs, [plain('A'), plain('n'), plain('m', 'any')]);
  if (isInputProblem(v)) return asFailure(v);
  const units: Record<string, string> = {};
  for (const key of UNIT_KEYS) {
    const raw = inputs[key];
    if (raw === undefined) return fail('CRP_INPUT_MISSING', `input ${key} (a unit text, e.g. "MPa") is missing`, key);
    if (typeof raw !== 'string') return invalid(key, 'must be a unit text');
    units[key] = raw;
  }
  const { A, n, m } = v;
  const from = { stress: units['from_stress_unit'] ?? '', time: units['from_time_unit'] ?? '' };
  const to = { stress: units['to_stress_unit'] ?? '', time: units['to_time_unit'] ?? '' };
  const converted = convertNortonA(A, n, m, from, to);
  if ('problem' in converted) return invalid('units', converted.problem);
  return {
    values: { A: value(converted.A, `${to.stress}^-n ${to.time}^-(m+1)`) },
    formula: 'A_new = A_old c_s^(-n) c_t^(m+1), sigma_new = c_s sigma_old, t_old = c_t t_new',
    warnings: [],
  };
}

const RUNNERS: Readonly<Record<CreepCheck, (inputs: Inputs) => Result>> = {
  norton_constant_stress: nortonConstantStress,
  norton_relaxation: nortonRelaxation,
  bolt_relaxation: boltRelaxation,
  thick_cylinder_stationary: thickCylinder,
  beam_stationary: beamStationaryCheck,
  maxwell,
  kelvin_voigt: kelvinVoigt,
  sls,
  prony_relaxation: pronyRelaxation,
  wlf_shift: wlfShift,
  convert_norton_a: convertNorton,
};

/** One check on `inputs`; the first problem comes back as a failure with its code. */
export const runCheck = (check: CreepCheck, inputs: Inputs): Result => RUNNERS[check](inputs);
export const isCheckFailure = (result: Result): result is CheckFailure => 'code' in result;
