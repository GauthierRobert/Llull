/** The closed-form checks of thermal_stress_check: input specs (name, dimension) and evaluation, canonical units MPa, mm, 1/K, K. */

import {
  bimetalEquilibrium,
  bimetalTimoshenko,
  gradientBeam,
  hubBoreHoopStress,
  inclusion,
  restrained,
  shrinkFitPressure,
  thickCylinder,
} from './analytic';
import { linearLaw, reReferenceSecant, secantFromInstantaneous, tableLaw, type InstantaneousLaw } from '../../model/cteConversion';

export const CHECKS = ['restrained', 'inclusion', 'bimetal', 'thick_cylinder', 'gradient_beam', 'shrink_fit', 'cte_secant'] as const;
export type CheckName = (typeof CHECKS)[number];

export type InputKind = 'pressure' | 'length' | 'alpha' | 'alphaGradient' | 'delta' | 'temperature' | 'ratio';
export const CANONICAL_UNIT: Readonly<Record<InputKind, string>> = {
  pressure: 'MPa',
  length: 'mm',
  alpha: '1/K',
  alphaGradient: '1/K^2',
  delta: 'K',
  temperature: 'K',
  ratio: '1',
};

export interface InputSpec {
  readonly key: string;
  readonly kind: InputKind;
  readonly optional?: true;
  readonly meaning: string;
}

export type Values = Readonly<Record<string, number>>;
export interface Scalar {
  readonly value: number;
  readonly unit: string;
}

export interface CheckOutput {
  readonly results?: Readonly<Record<string, Scalar>>;
  readonly rows?: readonly Readonly<Record<string, number>>[];
  readonly units?: Readonly<Record<string, string>>;
  readonly formulas: readonly string[];
  readonly assumptions: readonly string[];
  readonly defaults?: readonly string[];
}

export interface Extras {
  /** Evaluation points in canonical units (radii mm for thick_cylinder; temperatures K for cte_secant). */
  readonly points: readonly number[];
  /** Instantaneous CTE table [T K, alpha 1/K] for cte_secant. */
  readonly table: readonly (readonly [number, number])[];
  /** Unit the temperature column is reported in. */
  readonly temperatureUnit: string;
  readonly fromKelvin: (kelvin: number) => number;
}

const E: InputSpec = { key: 'E', kind: 'pressure', meaning: "Young's modulus" };
const NU: InputSpec = { key: 'nu', kind: 'ratio', meaning: "Poisson's ratio, in (-1, 0.5)" };
const ALPHA: InputSpec = { key: 'alpha', kind: 'alpha', meaning: 'secant CTE' };

export const INPUT_SPECS: Readonly<Record<CheckName, readonly InputSpec[]>> = {
  restrained: [E, ALPHA, { key: 'dT', kind: 'delta', meaning: 'temperature rise from the stress-free state' }, NU],
  inclusion: [
    E,
    { key: 'alpha', kind: 'alpha', meaning: 'CTE of the inclusion minus CTE of the matrix' },
    { key: 'dT', kind: 'delta', meaning: 'temperature rise of the inclusion' },
    { key: 'a', kind: 'length', meaning: 'inclusion radius' },
    { key: 'r', kind: 'length', optional: true, meaning: 'radius of the outside point (>= a); default a (just outside the disc)' },
  ],
  bimetal: [
    { key: 't1', kind: 'length', meaning: 'thickness of layer 1 (low expansion)' },
    { key: 't2', kind: 'length', meaning: 'thickness of layer 2 (high expansion)' },
    { key: 'E1', kind: 'pressure', meaning: "Young's modulus of layer 1" },
    { key: 'E2', kind: 'pressure', meaning: "Young's modulus of layer 2" },
    { key: 'alpha1', kind: 'alpha', meaning: 'CTE of layer 1' },
    { key: 'alpha2', kind: 'alpha', meaning: 'CTE of layer 2' },
    { key: 'dT', kind: 'delta', meaning: 'uniform temperature rise' },
    { key: 'L', kind: 'length', optional: true, meaning: 'cantilever length for the tip deflection' },
  ],
  thick_cylinder: [
    E,
    NU,
    ALPHA,
    { key: 'a', kind: 'length', meaning: 'bore radius' },
    { key: 'b', kind: 'length', meaning: 'outer radius (> a)' },
    { key: 'dT', kind: 'delta', meaning: 'bore minus outer-surface temperature; T(r) = dT ln(b/r)/ln(b/a)' },
    { key: 'r', kind: 'length', optional: true, meaning: 'one radius in [a, b]; or use points; default both a and b' },
  ],
  gradient_beam: [
    ALPHA,
    { key: 'dT', kind: 'delta', meaning: 'temperature difference between the two faces' },
    { key: 'h', kind: 'length', meaning: 'beam depth' },
    { key: 'L', kind: 'length', meaning: 'span (simply supported) or length (cantilever)' },
  ],
  shrink_fit: [
    { key: 'b', kind: 'length', meaning: 'solid shaft radius' },
    { key: 'c', kind: 'length', meaning: 'hub outer radius (> b)' },
    { key: 'E_hub', kind: 'pressure', meaning: "hub Young's modulus" },
    { key: 'nu_hub', kind: 'ratio', meaning: "hub Poisson's ratio" },
    { key: 'E_shaft', kind: 'pressure', meaning: "shaft Young's modulus" },
    { key: 'nu_shaft', kind: 'ratio', meaning: "shaft Poisson's ratio" },
    { key: 'interferenceMax', kind: 'length', meaning: 'maximum DIAMETRAL interference at the specification temperature' },
    { key: 'interferenceMin', kind: 'length', optional: true, meaning: 'minimum diametral interference at the specification temperature' },
    { key: 'alpha_hub', kind: 'alpha', optional: true, meaning: 'hub secant CTE (with alpha_shaft, temperature, specTemperature)' },
    { key: 'alpha_shaft', kind: 'alpha', optional: true, meaning: 'shaft secant CTE' },
    { key: 'temperature', kind: 'temperature', optional: true, meaning: 'operating temperature (both parts)' },
    { key: 'specTemperature', kind: 'temperature', optional: true, meaning: 'temperature the interferences apply at' },
  ],
  cte_secant: [
    { key: 'referenceTemperature', kind: 'temperature', meaning: 'stress-free temperature the secant CTE is referenced to' },
    { key: 'alpha0', kind: 'alpha', optional: true, meaning: 'linear law: instantaneous CTE at lawTemperature' },
    { key: 'alpha1', kind: 'alphaGradient', optional: true, meaning: 'linear law: d(alpha)/dT' },
    { key: 'lawTemperature', kind: 'temperature', optional: true, meaning: 'linear law: temperature alpha0 is given at' },
    { key: 'rereferenceTo', kind: 'temperature', optional: true, meaning: 'also report the secant re-referenced to this temperature' },
  ],
};

const scalar = (value: number, unit: string): Scalar => ({ value, unit });

function evaluateCte(values: Values, extras: Extras): CheckOutput | string {
  const reference = values['referenceTemperature'] ?? Number.NaN;
  const law: InstantaneousLaw | undefined =
    extras.table.length > 0
      ? tableLaw(extras.table)
      : values['alpha0'] !== undefined && values['alpha1'] !== undefined && values['lawTemperature'] !== undefined
        ? linearLaw(values['alpha0'], values['alpha1'], values['lawTemperature'])
        : undefined;
  if (law === undefined)
    return 'give either a valid instantaneous `table` (strictly increasing T, at least 2 rows) or alpha0 + alpha1 + lawTemperature';
  if (extras.points.length === 0) return 'give `points` (temperatures to evaluate)';
  const newReference = values['rereferenceTo'];
  const rows = extras.points.map((temperature) => {
    const secant = secantFromInstantaneous(law, reference, temperature);
    const row: Record<string, number> = {
      T: extras.fromKelvin(temperature),
      alphaInstantaneous: law.alpha(temperature),
      alphaSecant: secant,
      thermalStrainFromReference: secant * (temperature - reference),
    };
    if (newReference !== undefined) {
      const direct = secantFromInstantaneous(law, newReference, temperature);
      row['alphaSecantRereferenced'] =
        temperature === newReference
          ? direct
          : reReferenceSecant((t) => secantFromInstantaneous(law, reference, t), reference, newReference, temperature);
    }
    return row;
  });
  if (rows.some((row) => Object.values(row).some((value) => !Number.isFinite(value))))
    return 'a temperature lies outside the table range (llull never extrapolates)';
  return {
    rows,
    units: {
      T: extras.temperatureUnit,
      alphaInstantaneous: '1/K',
      alphaSecant: '1/K',
      thermalStrainFromReference: '1',
      alphaSecantRereferenced: '1/K',
    },
    formulas: [
      'alpha_sec(T; Tref) = (1/(T - Tref)) integral from Tref to T of alpha_inst dT; alpha_sec(Tref) = alpha_inst(Tref)',
      'alpha_b(T) = [alpha_a(T)(T - Ta) - alpha_a(Tb)(Tb - Ta)] / (T - Tb)',
      'thermal strain between two temperatures does not depend on the reference',
    ],
    assumptions: ['integral exact: closed form for the linear law, trapezoid for the piecewise-linear table'],
  };
}

/** Evaluate a validated check. @returns the output, or a plain-language reason the inputs are physically invalid. */
export function evaluateCheck(check: CheckName, v: Values, extras: Extras): CheckOutput | string {
  const get = (key: string): number => v[key] ?? Number.NaN;
  switch (check) {
    case 'restrained': {
      if (!(get('nu') > -1 && get('nu') < 0.5)) return 'nu must lie in (-1, 0.5)';
      const s = restrained(get('E'), get('alpha'), get('dT'), get('nu'));
      return {
        results: { uniaxial: scalar(s.uniaxial, 'MPa'), biaxial: scalar(s.biaxial, 'MPa'), triaxial: scalar(s.triaxial, 'MPa') },
        formulas: ['uniaxial s = -E alpha dT', 'biaxial s = -E alpha dT / (1 - nu)', 'triaxial s = -E alpha dT / (1 - 2 nu)'],
        assumptions: ['fully restrained, elastic, uniform temperature change; negative = compression for dT > 0'],
      };
    }
    case 'inclusion': {
      const a = get('a');
      const r = v['r'] ?? a;
      if (!(a > 0) || !(r >= a)) return 'need a > 0 and r >= a';
      const s = inclusion(get('E'), get('alpha'), get('dT'), a, r);
      return {
        results: {
          insideRadial: scalar(s.insideRadial, 'MPa'),
          insideHoop: scalar(s.insideHoop, 'MPa'),
          outsideRadial: scalar(s.outsideRadial, 'MPa'),
          outsideHoop: scalar(s.outsideHoop, 'MPa'),
        },
        formulas: ['inside sr = st = -E alpha dT / 2', 'outside sr = -E alpha dT a^2 / (2 r^2), st = +E alpha dT a^2 / (2 r^2)'],
        assumptions: [
          'same E and nu inside and outside',
          'infinite plate, plane stress (NAFEMS T1 set-up; finite plates deviate by (a/W)^2)',
        ],
        ...(v['r'] === undefined ? { defaults: ['r = a (just outside the inclusion)'] } : {}),
      };
    }
    case 'bimetal': {
      const input = {
        t1: get('t1'),
        t2: get('t2'),
        E1: get('E1'),
        E2: get('E2'),
        alpha1: get('alpha1'),
        alpha2: get('alpha2'),
        dT: get('dT'),
      };
      if (!(input.t1 > 0 && input.t2 > 0 && input.E1 > 0 && input.E2 > 0)) return 'thicknesses and moduli must be positive';
      const curvature = bimetalTimoshenko(input);
      const results: Record<string, Scalar> = {
        curvature: scalar(curvature, '1/mm'),
        curvatureEquilibrium: scalar(bimetalEquilibrium(input), '1/mm'),
      };
      if (v['L'] !== undefined) results['cantileverTip'] = scalar((curvature * v['L'] ** 2) / 2, 'mm');
      return {
        results,
        formulas: [
          '1/rho = 6 (a2 - a1) dT (1+m)^2 / (h [3 (1+m)^2 + (1+m n)(m^2 + 1/(m n))]), m = t1/t2, n = E1/E2, h = t1 + t2 (Timoshenko 1925)',
          'curvatureEquilibrium: axial-force and moment equilibrium of the two layers (independent cross-check)',
          'cantileverTip w = kappa L^2 / 2 (small deflection)',
        ],
        assumptions: ['unit width, beam theory, uniform temperature, positive curvature = high-expansion layer 2 on the convex side'],
      };
    }
    case 'thick_cylinder': {
      const input = { E: get('E'), nu: get('nu'), alpha: get('alpha'), a: get('a'), b: get('b'), dT: get('dT') };
      if (!(input.a > 0 && input.b > input.a) || !(input.nu < 1)) return 'need 0 < a < b and nu < 1';
      const defaults: string[] = [];
      const radii = extras.points.length > 0 ? [...extras.points] : v['r'] !== undefined ? [get('r')] : [input.a, input.b];
      if (extras.points.length === 0 && v['r'] === undefined) defaults.push('radii = bore and outer surface');
      if (radii.some((r) => !(r >= input.a && r <= input.b))) return 'every radius must lie in [a, b]';
      const rows = radii.map((r) => {
        const s = thickCylinder(input, r);
        return {
          r,
          temperature: s.temperature,
          sigmaRadial: s.sigmaRadial,
          sigmaHoop: s.sigmaHoop,
          sigmaAxial: s.sigmaAxial,
          sigmaHoopQuadrature: s.sigmaHoopQuadrature,
          sigmaHoopClassic: s.sigmaHoopClassic,
        };
      });
      return {
        rows,
        units: {
          r: 'mm',
          temperature: 'K',
          sigmaRadial: 'MPa',
          sigmaHoop: 'MPa',
          sigmaAxial: 'MPa',
          sigmaHoopQuadrature: 'MPa',
          sigmaHoopClassic: 'MPa',
        },
        formulas: [
          'st = E a/(1-nu)/r^2 [ (r^2+a^2)/(b^2-a^2) I(b) + I(r) - T r^2 ], sr = E a/(1-nu)/r^2 [ (r^2-a^2)/(b^2-a^2) I(b) - I(r) ]',
          'sz = E a/(1-nu) [ 2 I(b)/(b^2-a^2) - T ], I(r) = integral from a to r of T r dr, T(r) = dT ln(b/r)/ln(b/a)',
          'sigmaHoopQuadrature: Simpson (2000 intervals) of the integral; sigmaHoopClassic: Timoshenko & Goodier explicit log form',
        ],
        assumptions: [
          'free ends (generalised plane strain), steady radial conduction, elastic, constant properties',
          'temperature is relative to the outer surface',
        ],
        ...(defaults.length > 0 ? { defaults } : {}),
      };
    }
    case 'gradient_beam': {
      if (!(get('h') > 0) || !(get('L') > 0)) return 'h and L must be positive';
      const s = gradientBeam(get('alpha'), get('dT'), get('h'), get('L'));
      return {
        results: {
          curvature: scalar(s.curvature, '1/mm'),
          midspanBow: scalar(s.midspanBow, 'mm'),
          cantileverTip: scalar(s.cantileverTip, 'mm'),
          stress: scalar(0, 'MPa'),
        },
        formulas: ['kappa = alpha dT / h', 'simply supported mid-span w = kappa L^2 / 8', 'cantilever tip w = kappa L^2 / 2'],
        assumptions: ['linear through-depth temperature, statically determinate beam: curvature and no stress', 'small deflection'],
      };
    }
    case 'shrink_fit':
      return evaluateShrinkFit(v);
    case 'cte_secant':
      return evaluateCte(v, extras);
  }
}

function evaluateShrinkFit(v: Values): CheckOutput | string {
  const get = (key: string): number => v[key] ?? Number.NaN;
  const input = { b: get('b'), c: get('c'), hubE: get('E_hub'), hubNu: get('nu_hub'), shaftE: get('E_shaft'), shaftNu: get('nu_shaft') };
  if (!(input.b > 0 && input.c > input.b) || !(input.hubE > 0 && input.shaftE > 0)) return 'need 0 < b < c and positive moduli';
  const pressureOf = (diametral: number): number => (diametral > 0 ? shrinkFitPressure(diametral / 2, input) : 0);
  const maxPressure = pressureOf(get('interferenceMax'));
  const results: Record<string, Scalar> = {
    contactPressureMax: scalar(maxPressure, 'MPa'),
    hubBoreHoopStressMax: scalar(hubBoreHoopStress(maxPressure, input.b, input.c), 'MPa'),
  };
  if (v['interferenceMin'] !== undefined) results['contactPressureMin'] = scalar(pressureOf(get('interferenceMin')), 'MPa');
  const thermal = ['alpha_hub', 'alpha_shaft', 'temperature', 'specTemperature'].map((key) => v[key]);
  if (thermal.some((value) => value !== undefined)) {
    if (thermal.some((value) => value === undefined))
      return 'thermal group needs alpha_hub, alpha_shaft, temperature and specTemperature together';
    const shift = 2 * input.b * (get('alpha_hub') - get('alpha_shaft')) * (get('temperature') - get('specTemperature'));
    const maxAt = get('interferenceMax') - shift;
    results['interferenceMaxAtTemperature'] = scalar(maxAt, 'mm');
    results['contactPressureMaxAtTemperature'] = scalar(pressureOf(maxAt), 'MPa');
    if (v['interferenceMin'] !== undefined) results['interferenceMinAtTemperature'] = scalar(get('interferenceMin') - shift, 'mm');
  }
  return {
    results,
    formulas: [
      'p = d_r / (b [((c^2+b^2)/(c^2-b^2) + nu_h)/E_h + (1 - nu_s)/E_s]), d_r = diametral interference / 2 (Lame, solid shaft)',
      'hub bore hoop stress = p (c^2 + b^2)/(c^2 - b^2)',
      'i(T) = i(T_spec) - 2 b (alpha_hub - alpha_shaft)(T - T_spec) (nominal-diameter linearisation; fit_at_temperature scales every limit diameter)',
    ],
    assumptions: ['elastic, plane stress hub, solid shaft, constant E and nu; negative interference = clearance (zero pressure)'],
  };
}
