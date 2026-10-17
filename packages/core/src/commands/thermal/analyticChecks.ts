/** The closed-form checks of thermal_analytic_check as a table: named inputs (kind + domain) and a pure SI computation each (TR-THM-40). */

import {
  interfaceSlabs,
  lumpedBody,
  lumpedSphere,
  neumannMelting,
  parallelPlates,
  planeWall,
  semiInfinite,
  slabGenerationRise,
  straightFin,
  STEFAN_BOLTZMANN,
  viewFactorCoaxialDiscs,
  viewFactorParallel,
  viewFactorPerpendicular,
} from '../../lib/thermalClosedForms';
import type { ThermalKind } from '../../lib/thermalUnits';

/** positive: > 0 · nonnegative: >= 0 · any · absolute: absolute temperature > 0 K · emissivity: 0 < eps <= 1 */
export type Domain = 'positive' | 'nonnegative' | 'any' | 'absolute' | 'emissivity';

export interface InputSpec {
  readonly name: string;
  readonly kind: ThermalKind;
  readonly domain: Domain;
  readonly describe: string;
  /** may be omitted by the caller; `compute` then sees the key absent */
  readonly optional?: boolean;
}

export interface Output {
  readonly kind: ThermalKind;
  /** SI value (temperatures in K) */
  readonly value: number;
}

export interface Computation {
  readonly primary: string;
  readonly outputs: Readonly<Record<string, Output>>;
  readonly validity?: { readonly Bi: number; readonly limit: number; readonly ok: boolean };
  readonly usesConstants?: boolean;
  readonly warnings?: readonly string[];
}

export interface ComputationFailure {
  readonly code: 'THM_INPUT_INVALID';
  readonly reason: string;
}

export interface CheckSpec {
  readonly formula: string;
  readonly inputs: readonly InputSpec[];
  readonly compute: (v: Readonly<Record<string, number>>) => Computation | ComputationFailure;
}

const input = (name: string, kind: ThermalKind, domain: Domain, describe: string): InputSpec => ({ name, kind, domain, describe });
const optionalInput = (name: string, kind: ThermalKind, domain: Domain, describe: string): InputSpec => ({
  name,
  kind,
  domain,
  describe,
  optional: true,
});
const has = (v: Readonly<Record<string, number>>, name: string): boolean => v[name] !== undefined;
const out = (kind: ThermalKind, value: number): Output => ({ kind, value });
/** SI inputs are validated against their declared names before `compute`, so a missing key cannot occur. */
const n = (v: Readonly<Record<string, number>>, name: string): number => v[name] ?? Number.NaN;

const LUMPED_BIOT_LIMIT = 0.1;

export const CHECK_SPECS: Readonly<Record<string, CheckSpec>> = {
  plane_wall: {
    formula:
      'q = (Tinf1 - Tinf2)/(1/h1 + L/k + 1/h2); Ts1 = Tinf1 - q/h1; Ts2 = Tinf2 + q/h2; residual = |h1 (Tinf1 - Ts1) - h2 (Ts2 - Tinf2)| / (h1 (Tinf1 - Ts1))',
    inputs: [
      input('L', 'length', 'positive', 'wall thickness'),
      input('k', 'conductivity', 'positive', 'thermal conductivity'),
      input('h1', 'film', 'positive', 'film coefficient on face 1'),
      input('Tinf1', 'temperature', 'any', 'fluid temperature on face 1'),
      input('h2', 'film', 'positive', 'film coefficient on face 2'),
      input('Tinf2', 'temperature', 'any', 'fluid temperature on face 2'),
    ],
    compute: (v) => {
      const wall = planeWall(n(v, 'L'), n(v, 'k'), n(v, 'h1'), n(v, 'Tinf1'), n(v, 'h2'), n(v, 'Tinf2'));
      return {
        primary: 'q',
        outputs: {
          q: out('flux', wall.flux),
          Ts1: out('temperature', wall.surface1),
          Ts2: out('temperature', wall.surface2),
          heatBalanceResidual: out('ratio', wall.balanceResidual),
          totalResistance: out('resistance', wall.resistance),
        },
      };
    },
  },
  slab_generation: {
    formula: "Tmax = Ts + q''' L^2 / (2 k), L = half thickness, both faces at Ts",
    inputs: [
      input('half_thickness', 'length', 'positive', 'half thickness of the slab'),
      input('k', 'conductivity', 'positive', 'thermal conductivity'),
      input('qgen', 'generation', 'any', 'volumetric heat generation (positive = source)'),
      input('Ts', 'temperature', 'any', 'face temperature'),
    ],
    compute: (v) => ({
      primary: 'Tmax',
      outputs: { Tmax: out('temperature', n(v, 'Ts') + slabGenerationRise(n(v, 'half_thickness'), n(v, 'k'), n(v, 'qgen'))) },
    }),
  },
  semi_infinite: {
    formula: 'T(x,t) = Ts + (Ti - Ts) erf(x / (2 sqrt(alpha t)))',
    inputs: [
      input('Ti', 'temperature', 'any', 'initial uniform temperature'),
      input('Ts', 'temperature', 'any', 'surface temperature applied at t = 0'),
      input('alpha', 'diffusivity', 'positive', 'thermal diffusivity k/(rho cp)'),
      input('x', 'length', 'nonnegative', 'depth below the surface'),
      input('t', 'time', 'positive', 'time since the step'),
    ],
    compute: (v) => ({
      primary: 'T',
      outputs: { T: out('temperature', semiInfinite(n(v, 'Ti'), n(v, 'Ts'), n(v, 'alpha'), n(v, 'x'), n(v, 't'))) },
    }),
  },
  lumped: {
    formula:
      'T = Tinf + (Ti - Tinf) exp(-t/tau), tau = rho c Lc / h, Lc = V/As (sphere shorthand d: Lc = d/6); Bi = h Lc / k, valid when Bi < 0.1',
    inputs: [
      optionalInput('V', 'volume', 'positive', 'body volume (with As: any shape)'),
      optionalInput('As', 'area', 'positive', 'convecting surface area (with V)'),
      optionalInput('d', 'length', 'positive', 'sphere diameter (shorthand for V and As of a sphere; give V and As or d)'),
      input('rho', 'density', 'positive', 'density'),
      input('c', 'specificHeat', 'positive', 'specific heat'),
      input('k', 'conductivity', 'positive', 'thermal conductivity'),
      input('h', 'film', 'positive', 'film coefficient'),
      input('Ti', 'temperature', 'any', 'initial temperature'),
      input('Tinf', 'temperature', 'any', 'fluid temperature'),
      input('t', 'time', 'nonnegative', 'time'),
    ],
    compute: (v) => {
      const common = [n(v, 'rho'), n(v, 'c'), n(v, 'k'), n(v, 'h'), n(v, 'Ti'), n(v, 'Tinf'), n(v, 't')] as const;
      let body: ReturnType<typeof lumpedBody>;
      if (has(v, 'V') || has(v, 'As')) {
        if (!has(v, 'V') || !has(v, 'As')) return { code: 'THM_INPUT_INVALID', reason: 'give both V and As (or the sphere diameter d)' };
        body = lumpedBody(n(v, 'V'), n(v, 'As'), ...common);
      } else if (has(v, 'd')) {
        const sphere = lumpedSphere(n(v, 'd'), ...common);
        body = { ...sphere, characteristicLength: n(v, 'd') / 6 };
      } else {
        return { code: 'THM_INPUT_INVALID', reason: 'give the body as V and As (any shape) or the sphere diameter d' };
      }
      const ok = body.biot < LUMPED_BIOT_LIMIT;
      return {
        primary: 'T',
        outputs: {
          T: out('temperature', body.temperature),
          Bi: out('ratio', body.biot),
          tau: out('time', body.timeConstant),
          Lc: out('length', body.characteristicLength),
        },
        validity: { Bi: body.biot, limit: LUMPED_BIOT_LIMIT, ok },
        ...(ok
          ? {}
          : { warnings: [`Bi = ${body.biot.toPrecision(4)} >= ${LUMPED_BIOT_LIMIT}: the lumped-capacitance assumption is not valid`] }),
      };
    },
  },
  fin: {
    formula:
      'm = sqrt(hP/(kA)), M = sqrt(hPkA); eta = tanh(mL)/(mL); adiabatic tip: Q = M tanh(mL) (Tb-Tinf), theta(L)/theta_b = 1/cosh(mL); ' +
      'convective tip: Q = M (sinh mL + B cosh mL)/(cosh mL + B sinh mL) (Tb-Tinf), theta(L)/theta_b = 1/(cosh mL + B sinh mL), B = h/(mk); ' +
      'corrected length: Q = M tanh(m Lc) (Tb-Tinf), Lc = L + A/P (pin: P = pi d, A = pi d^2/4)',
    inputs: [
      input('h', 'film', 'positive', 'film coefficient'),
      input('k', 'conductivity', 'positive', 'thermal conductivity'),
      optionalInput('d', 'length', 'positive', 'pin diameter (gives P = pi d, A = pi d^2/4; or give P and A)'),
      optionalInput('P', 'length', 'positive', 'section perimeter (with A, for any uniform section)'),
      optionalInput('A', 'area', 'positive', 'section cross-sectional area (with P)'),
      input('L', 'length', 'positive', 'fin length'),
      optionalInput('Tb', 'temperature', 'any', 'base temperature (with Tinf: adds heat rates and tip temperatures)'),
      optionalInput('Tinf', 'temperature', 'any', 'fluid temperature (with Tb)'),
    ],
    compute: (v) => {
      let perimeter: number;
      let area: number;
      if (has(v, 'P') || has(v, 'A')) {
        if (!has(v, 'P') || !has(v, 'A')) return { code: 'THM_INPUT_INVALID', reason: 'give both P and A (or the pin diameter d)' };
        perimeter = n(v, 'P');
        area = n(v, 'A');
      } else if (has(v, 'd')) {
        perimeter = Math.PI * n(v, 'd');
        area = (Math.PI * n(v, 'd') ** 2) / 4;
      } else {
        return { code: 'THM_INPUT_INVALID', reason: 'give the section as d (pin) or P and A' };
      }
      if (has(v, 'Tb') !== has(v, 'Tinf')) return { code: 'THM_INPUT_INVALID', reason: 'give both Tb and Tinf (or neither)' };
      const fin = straightFin(n(v, 'h'), n(v, 'k'), perimeter, area, n(v, 'L'));
      const outputs: Record<string, Output> = { eta: out('ratio', fin.efficiency), m: out('inverseLength', fin.m) };
      if (has(v, 'Tb')) {
        const base = n(v, 'Tb') - n(v, 'Tinf');
        const tip = (ratio: number): Output => out('temperature', n(v, 'Tinf') + base * ratio);
        Object.assign(outputs, {
          Q: out('power', fin.adiabaticPerKelvin * base),
          Q_convective_tip: out('power', fin.convectiveTipPerKelvin * base),
          Q_corrected: out('power', fin.correctedPerKelvin * base),
          Lc: out('length', fin.correctedLength),
          tip_ratio: out('ratio', fin.adiabaticTipRatio),
          tip_ratio_convective: out('ratio', fin.convectiveTipRatio),
          T_tip: tip(fin.adiabaticTipRatio),
          T_tip_convective: tip(fin.convectiveTipRatio),
        });
      }
      return { primary: 'eta', outputs };
    },
  },
  parallel_plates: {
    formula: 'q = sigma (T1^4 - T2^4) / (1/eps1 + 1/eps2 - 1), sigma from the exact 2019 SI constants',
    inputs: [
      input('T1', 'temperature', 'absolute', 'temperature of plate 1 (degC or K; converted to absolute)'),
      input('T2', 'temperature', 'absolute', 'temperature of plate 2'),
      input('eps1', 'ratio', 'emissivity', 'emissivity of plate 1, 0 < eps <= 1 (unit "1")'),
      input('eps2', 'ratio', 'emissivity', 'emissivity of plate 2, 0 < eps <= 1 (unit "1")'),
    ],
    compute: (v) => ({
      primary: 'q',
      outputs: { q: out('flux', parallelPlates(n(v, 'T1'), n(v, 'T2'), n(v, 'eps1'), n(v, 'eps2'))) },
      usesConstants: true,
    }),
  },
  'view_factor:parallel_rectangles': {
    formula:
      'Howell C-11: F = 2/(pi X Y) {ln sqrt((1+X^2)(1+Y^2)/(1+X^2+Y^2)) + X sqrt(1+Y^2) atan(X/sqrt(1+Y^2)) + Y sqrt(1+X^2) atan(Y/sqrt(1+X^2)) - X atan X - Y atan Y}, X = a/c, Y = b/c',
    inputs: [
      input('a', 'length', 'positive', 'rectangle side a'),
      input('b', 'length', 'positive', 'rectangle side b'),
      input('c', 'length', 'positive', 'spacing between the identical, directly opposed rectangles'),
    ],
    compute: (v) => ({ primary: 'F', outputs: { F: out('ratio', viewFactorParallel(n(v, 'a'), n(v, 'b'), n(v, 'c'))) } }),
  },
  'view_factor:perpendicular_rectangles': {
    formula:
      'Hottel closed form for rectangles sharing an edge of length l at 90 degrees, W = w/l, H = h/l (F from surface 1 to surface 2)',
    inputs: [
      input('l', 'length', 'positive', 'length of the common edge'),
      input('w', 'length', 'positive', 'width of surface 1 (normal to the common edge)'),
      input('h', 'length', 'positive', 'height of surface 2 (normal to the common edge)'),
    ],
    compute: (v) => ({ primary: 'F', outputs: { F: out('ratio', viewFactorPerpendicular(n(v, 'l'), n(v, 'w'), n(v, 'h'))) } }),
  },
  'view_factor:coaxial_discs': {
    formula: 'F = (S - sqrt(S^2 - 4 (R2/R1)^2))/2, S = 1 + (1 + R2^2)/R1^2, R = r/L (F from disc 1 to disc 2)',
    inputs: [
      input('r1', 'length', 'positive', 'radius of disc 1'),
      input('r2', 'length', 'positive', 'radius of disc 2'),
      input('L', 'length', 'positive', 'distance between the coaxial parallel discs'),
    ],
    compute: (v) => ({ primary: 'F', outputs: { F: out('ratio', viewFactorCoaxialDiscs(n(v, 'r1'), n(v, 'r2'), n(v, 'L'))) } }),
  },
  'view_factor:cube_summation': {
    formula:
      'summation rule inside a cube: F(opposite) + 4 F(adjacent) = 1, each from the parallel / perpendicular closed forms with a = b = c = side',
    inputs: [input('a', 'length', 'positive', 'cube side')],
    compute: (v) => {
      const side = n(v, 'a');
      const opposite = viewFactorParallel(side, side, side);
      const adjacent = viewFactorPerpendicular(side, side, side);
      return {
        primary: 'sum',
        outputs: { sum: out('ratio', opposite + 4 * adjacent), opposite: out('ratio', opposite), adjacent: out('ratio', adjacent) },
      };
    },
  },
  stefan: {
    formula:
      'Neumann one-phase melting: lam exp(lam^2) erf(lam) = Ste/sqrt(pi), Ste = cp dT / L, front s = 2 lam sqrt(alpha t), alpha = k/(rho cp)',
    inputs: [
      input('k', 'conductivity', 'positive', 'conductivity of the liquid'),
      input('rho', 'density', 'positive', 'density'),
      input('cp', 'specificHeat', 'positive', 'specific heat of the liquid'),
      input('latent', 'latentHeat', 'positive', 'latent heat of fusion'),
      input('dT', 'temperatureDifference', 'positive', 'wall temperature minus melting temperature (unit K)'),
      input('t', 'time', 'positive', 'time since the wall was raised'),
    ],
    compute: (v) => {
      const melt = neumannMelting(n(v, 'k'), n(v, 'rho'), n(v, 'cp'), n(v, 'latent'), n(v, 'dT'), n(v, 't'));
      if (melt === null) {
        return { code: 'THM_INPUT_INVALID', reason: 'the Stefan number is outside the range where the Neumann root lies in [1e-9, 3]' };
      }
      return {
        primary: 'front',
        outputs: { front: out('length', melt.front), lambda: out('ratio', melt.lambda), stefanNumber: out('ratio', melt.stefanNumber) },
      };
    },
  },
  stefan_boltzmann: {
    formula: 'sigma = 2 pi^5 kB^4 / (15 h^3 c^2) with the exact 2019 SI defining constants',
    inputs: [],
    compute: () => ({ primary: 'sigma', outputs: { sigma: out('stefanBoltzmann', STEFAN_BOLTZMANN) }, usesConstants: true }),
  },
  interface: {
    formula: 'q = (T_hot - T_cold)/(L1/k1 + 1/hc + L2/k2); interface jump = q/hc',
    inputs: [
      input('L1', 'length', 'positive', 'thickness of slab 1'),
      input('k1', 'conductivity', 'positive', 'conductivity of slab 1'),
      input('hc', 'film', 'positive', 'interface (gap) conductance'),
      input('L2', 'length', 'positive', 'thickness of slab 2'),
      input('k2', 'conductivity', 'positive', 'conductivity of slab 2'),
      input('T_hot', 'temperature', 'any', 'outer face temperature of slab 1'),
      input('T_cold', 'temperature', 'any', 'outer face temperature of slab 2'),
    ],
    compute: (v) => {
      const slabs = interfaceSlabs(n(v, 'L1'), n(v, 'k1'), n(v, 'hc'), n(v, 'L2'), n(v, 'k2'), n(v, 'T_hot'), n(v, 'T_cold'));
      return {
        primary: 'q',
        outputs: {
          q: out('flux', slabs.flux),
          interfaceJump: out('temperatureDifference', slabs.jump),
          totalResistance: out('resistance', slabs.resistance),
        },
      };
    },
  },
};
