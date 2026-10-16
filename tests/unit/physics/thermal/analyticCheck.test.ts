/** PHY-03: thermal_analytic_check against docs/physics/03-thermal-analysis/validation (VC-THM-01, 02, 06–13, 60, 61 refusals). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { roundDeep } from '@lib/significant';
import { expectCase, packCase } from '../benchmarkCases';

const PACK = '03-thermal-analysis';
const doc = createEmptyDocument();

type Q = { value: number; unit: string };
type Out = Record<string, Q>;
interface Data {
  value: number;
  unit: string;
  primary: string;
  outputs: Out;
  formula: string;
  inputs: Record<string, Q>;
  validity?: { Bi: number; limit: number; ok: boolean };
  physicalConstants?: unknown;
  deckValue?: { unitSystem: string; quantity: string; value: number };
  warnings: string[];
}

const q = (value: number, unit: string): Q => ({ value, unit });

const check = (name: string, inputs: Record<string, Q>, extra: Record<string, unknown> = {}): { result: CommandResult; data: Data } => {
  const result = execute(doc, 'thermal_analytic_check', { check: name, inputs, ...extra });
  return { result, data: result.data as Data };
};

/** Judged by the PHY-00 judge and held to the generator's 12 significant digits (TR-THM-40). */
const exact = (caseId: string, measured: Q): void => {
  expectCase(PACK, caseId, measured.value, measured.unit);
  const reference = packCase(PACK, caseId)['value'] as number;
  expect(Math.abs(measured.value - reference) / Math.abs(reference), caseId).toBeLessThan(1e-11);
};

const WALL = {
  L: q(0.05, 'm'),
  k: q(15, 'W/(m*K)'),
  h1: q(50, 'W/(m^2*K)'),
  Tinf1: q(200, 'degC'),
  h2: q(10, 'W/(m^2*K)'),
  Tinf2: q(20, 'degC'),
};

describe('thermal_analytic_check closed forms', () => {
  it('plane wall with convection on both faces (VC-THM-01.a-d)', () => {
    const { result, data } = check('plane_wall', WALL);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.rejected).toBeUndefined();
    exact('VC-THM-01.a', data.outputs['q'] as Q);
    exact('VC-THM-01.b', data.outputs['Ts1'] as Q);
    exact('VC-THM-01.c', data.outputs['Ts2'] as Q);
    expectCase(PACK, 'VC-THM-01.d', (data.outputs['heatBalanceResidual'] as Q).value, (data.outputs['heatBalanceResidual'] as Q).unit);
    expect(data.value).toBe((data.outputs['q'] as Q).value);
    expect(data.unit).toBe('W/m^2');
    expect(data.formula).toContain('1/h1 + L/k + 1/h2');
    expect(data.inputs).toEqual(WALL);
    expect(result.summary).toMatch(/plane_wall: q = 1459\.46 W\/m\^2; Ts1 = 170\.811 degC; Ts2 = 165\.946 degC/);
  });

  it('is unit-independent and reports temperatures in the unit of the first temperature input', () => {
    const mixed = { ...WALL, L: q(50, 'mm'), Tinf1: q(392, 'degF'), Tinf2: q(293.15, 'K') };
    const { data } = check('plane_wall', mixed);
    expect(data.outputs['q']?.value).toBeCloseTo(1459.4594594594, 6);
    expect(data.outputs['Ts1']?.unit).toBe('degF');
    expect(data.outputs['Ts1']?.value).toBeCloseTo(170.8108108 * 1.8 + 32, 6);
  });

  it('slab with uniform generation (VC-THM-02)', () => {
    const { data } = check('slab_generation', {
      half_thickness: q(0.01, 'm'),
      k: q(20, 'W/(m*K)'),
      qgen: q(1e7, 'W/m^3'),
      Ts: q(50, 'degC'),
    });
    exact('VC-THM-02', data.outputs['Tmax'] as Q);
  });

  it('semi-infinite solid (VC-THM-06) and the erf series at other arguments', () => {
    const inputs = { Ti: q(20, 'degC'), Ts: q(200, 'degC'), alpha: q(1e-5, 'm^2/s'), x: q(0.01, 'm'), t: q(10, 's') };
    exact('VC-THM-06', check('semi_infinite', inputs).data.outputs['T'] as Q);
    const known: Array<[number, number]> = [
      [0, 0],
      [0.1, 0.1124629160182849],
      [1, 0.8427007929497149],
      [2, 0.9953222650189527],
      [3, 0.9999779095030014],
      [4, 0.9999999845827421],
      [7, 1],
    ];
    for (const [eta, erfValue] of known) {
      // T = Ts + (Ti - Ts) erf(eta) with Ti = 0, Ts = 1 gives 1 - erf(eta); alpha t = 1/4, x = eta
      const t = check('semi_infinite', { Ti: q(0, 'K'), Ts: q(1, 'K'), alpha: q(0.25, 'm^2/s'), x: q(eta, 'm'), t: q(1, 's') }).data
        .outputs['T'] as Q;
      expect(1 - t.value).toBeCloseTo(erfValue, 13);
    }
  });

  it('lumped-capacitance sphere with its Biot validity (VC-THM-07.a, b)', () => {
    const base = { d: q(0.01, 'm'), rho: q(2700, 'kg/m^3'), c: q(900, 'J/(kg*K)'), k: q(200, 'W/(m*K)'), h: q(50, 'W/(m^2*K)') };
    const inputs = { ...base, Ti: q(300, 'degC'), Tinf: q(20, 'degC'), t: q(60, 's') };
    const { data } = check('lumped', inputs);
    exact('VC-THM-07.a', data.outputs['T'] as Q);
    exact('VC-THM-07.b', data.outputs['Bi'] as Q);
    expect(data.outputs['tau']?.value).toBeCloseTo(packCase(PACK, 'VC-THM-07.b')['time_constant_s'] as number, 6);
    expect(data.validity).toMatchObject({ ok: true, limit: 0.1 });
    expect(data.warnings).toEqual([]);
    const thick = check('lumped', { ...inputs, d: q(0.5, 'm'), h: q(500, 'W/(m^2*K)') });
    expect(thick.data.validity?.ok).toBe(false);
    expect(thick.data.warnings[0]).toMatch(/Bi = .* >= 0\.1/);
    expect(thick.result.summary).toMatch(/WARNING/);
  });

  it('pin fin efficiency (VC-THM-08)', () => {
    const { data } = check('fin', { h: q(100, 'W/(m^2*K)'), k: q(200, 'W/(m*K)'), d: q(5, 'mm'), L: q(0.05, 'm') });
    exact('VC-THM-08', data.outputs['eta'] as Q);
    expect(data.outputs['m']?.unit).toBe('1/m');
  });

  it('grey parallel plates with named constants (VC-THM-10, VC-THM-60)', () => {
    const { data } = check('parallel_plates', { T1: q(400, 'K'), T2: q(300, 'K'), eps1: q(0.8, '1'), eps2: q(0.5, '1') });
    exact('VC-THM-10', data.outputs['q'] as Q);
    expectCase(PACK, 'VC-THM-60', roundDeep({ physicalConstants: data.physicalConstants }) as never, '-');
    const celsius = check('parallel_plates', { T1: q(126.85, 'degC'), T2: q(26.85, 'degC'), eps1: q(0.8, '1'), eps2: q(0.5, '1') });
    expect(celsius.data.value).toBeCloseTo(data.value, 9);
  });

  it('interface conductance in series (VC-THM-11.a, b)', () => {
    const { data } = check('interface', {
      L1: q(0.01, 'm'),
      k1: q(150, 'W/(m*K)'),
      hc: q(2000, 'W/(m^2*K)'),
      L2: q(0.01, 'm'),
      k2: q(15, 'W/(m*K)'),
      T_hot: q(100, 'degC'),
      T_cold: q(20, 'degC'),
    });
    exact('VC-THM-11.a', data.outputs['q'] as Q);
    exact('VC-THM-11.b', data.outputs['interfaceJump'] as Q);
    expect(data.outputs['totalResistance']?.unit).toBe('m^2*K/W');
  });

  it('Neumann one-phase melting (VC-THM-12.a, b)', () => {
    const { data } = check('stefan', {
      k: q(0.6, 'W/(m*K)'),
      rho: q(1000, 'kg/m^3'),
      cp: q(4200, 'J/(kg*K)'),
      latent: q(334000, 'J/kg'),
      dT: q(10, 'K'),
      t: q(1, 'h'),
    });
    exact('VC-THM-12.a', data.outputs['lambda'] as Q);
    exact('VC-THM-12.b', data.outputs['front'] as Q);
    expect(data.outputs['stefanNumber']?.value).toBeCloseTo(packCase(PACK, 'VC-THM-12.a')['stefanNumber'] as number, 10);
    expect(data.primary).toBe('front');
  });

  it('Stefan-Boltzmann constant from the exact SI constants and its deck values (VC-THM-13)', () => {
    const { data } = check('stefan_boltzmann', {}, { unitSystem: 'N-mm-t-s' });
    expectCase(PACK, 'VC-THM-13', data.value);
    expect(data.deckValue?.value).toBeCloseTo(packCase(PACK, 'VC-THM-13')['inMmTonneSecond'] as number, 20);
    expect(data.deckValue).toMatchObject({ unitSystem: 'N-mm-t-s', quantity: 'stefanBoltzmann' });
    const si = check('stefan_boltzmann', {}, { unitSystem: 'N-m-kg-s' }).data;
    expect(si.deckValue?.value).toBe(si.value);
  });

  it('reports the named defaults of VC-THM-60 exactly', () => {
    const { data } = check('stefan_boltzmann', {});
    expectCase(PACK, 'VC-THM-60', roundDeep({ physicalConstants: data.physicalConstants }) as never, '-');
  });

  it('flux results convert to a deck unit system, temperatures do not', () => {
    const wall = check('plane_wall', WALL, { unitSystem: 'N-mm-t-s' }).data;
    expect(wall.deckValue?.value).toBeCloseTo(wall.value * 1e-3, 12);
    expect(check('plane_wall', WALL, { unitSystem: 'lbf-in-slinch-s' }).data.deckValue?.quantity).toBe('flux');
    expect(
      check('semi_infinite', { Ti: q(0, 'K'), Ts: q(1, 'K'), alpha: q(1, 'm^2/s'), x: q(1, 'm'), t: q(1, 's') }, { unitSystem: 'N-mm-t-s' })
        .data.deckValue,
    ).toBeUndefined();
  });
});

describe('thermal_analytic_check view factors (VC-THM-09)', () => {
  it('parallel, perpendicular, coaxial and the cube summation rule', () => {
    const parallel = check('view_factor', { a: q(1, 'm'), b: q(1, 'm'), c: q(1, 'm') }, { configuration: 'parallel_rectangles' }).data;
    exact('VC-THM-09.a', parallel.outputs['F'] as Q);
    const perpendicular = check(
      'view_factor',
      { l: q(1, 'm'), w: q(1, 'm'), h: q(1, 'm') },
      { configuration: 'perpendicular_rectangles' },
    ).data;
    exact('VC-THM-09.b', perpendicular.outputs['F'] as Q);
    const cube = check('view_factor', { a: q(2, 'm') }, { configuration: 'cube_summation' }).data;
    exact('VC-THM-09.c', cube.outputs['sum'] as Q);
    expect(cube.outputs['opposite']?.value).toBeCloseTo(parallel.value, 15);
    exact(
      'VC-THM-09.d',
      check('view_factor', { r1: q(1, 'm'), r2: q(1, 'm'), L: q(1, 'm') }, { configuration: 'coaxial_discs' }).data.outputs['F'] as Q,
    );
  });

  it('reproduces every row of view_factors.csv', () => {
    const rows = readFileSync('docs/physics/03-thermal-analysis/validation/view_factors.csv', 'utf8').trim().split('\n').slice(1);
    expect(rows).toHaveLength(16);
    for (const row of rows) {
      const [name, parameter, closed] = row.split(',') as [string, string, string];
      const r = Number(parameter);
      const [configuration, inputs] = name.startsWith('parallel')
        ? ['parallel_rectangles', { a: q(r, 'm'), b: q(r, 'm'), c: q(1, 'm') }]
        : name.startsWith('perpendicular')
          ? ['perpendicular_rectangles', { l: q(1, 'm'), w: q(1, 'm'), h: q(r, 'm') }]
          : ['coaxial_discs', { r1: q(r, 'm'), r2: q(r, 'm'), L: q(1, 'm') }];
      const value = check('view_factor', inputs as Record<string, Q>, { configuration }).data.value;
      expect(Math.abs(value - Number(closed)) / Number(closed), row).toBeLessThan(2e-8);
    }
  });
});

describe('thermal_analytic_check refusals (VC-THM-61)', () => {
  const refused = (name: string, inputs: Record<string, Q>, code: string, extra: Record<string, unknown> = {}): CommandResult => {
    const { result } = check(name, inputs, extra);
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.error?.code).toBe(code);
    expect(result.error?.remediation.length).toBeGreaterThan(10);
    expect(result.summary).toContain(code);
    return result;
  };
  const plates = { T1: q(400, 'K'), T2: q(300, 'K'), eps1: q(0.8, '1'), eps2: q(0.5, '1') };

  it('refuses an emissivity outside (0, 1]', () => {
    expect(refused('parallel_plates', { ...plates, eps1: q(1.2, '1') }, 'THM_EMISSIVITY_INVALID').error?.paths).toEqual(['inputs.eps1']);
    refused('parallel_plates', { ...plates, eps2: q(0, '1') }, 'THM_EMISSIVITY_INVALID');
    refused('parallel_plates', { ...plates, eps2: q(-0.1, '1') }, 'THM_EMISSIVITY_INVALID');
  });

  it('refuses a wrong dimension or temperature scale', () => {
    refused('plane_wall', { ...WALL, k: q(15, 'W/m^2') }, 'THM_UNITS_MISMATCH');
    refused('plane_wall', { ...WALL, Tinf1: q(200, 'furlong') }, 'THM_UNITS_MISMATCH');
    refused('plane_wall', { ...WALL, Tinf1: q(200, 'm') }, 'THM_UNITS_MISMATCH');
    const difference = refused('stefan', stefanInputs({ dT: q(10, 'degC') }), 'THM_UNITS_MISMATCH');
    expect(difference.summary).toContain('absolute temperature scale');
  });

  it('refuses a non-positive film coefficient and other non-physical values', () => {
    refused('plane_wall', { ...WALL, h2: q(0, 'W/(m^2*K)') }, 'THM_FILM_INVALID');
    refused('interface', interfaceInputs({ hc: q(-5, 'W/(m^2*K)') }), 'THM_FILM_INVALID');
    refused('plane_wall', { ...WALL, L: q(-0.05, 'm') }, 'THM_INPUT_INVALID');
    refused('semi_infinite', { Ti: q(0, 'K'), Ts: q(1, 'K'), alpha: q(1, 'm^2/s'), x: q(-1, 'm'), t: q(1, 's') }, 'THM_INPUT_INVALID');
    refused('parallel_plates', { ...plates, T2: q(-300, 'degC') }, 'THM_INPUT_INVALID');
  });

  it('refuses missing, unknown inputs and a view_factor without configuration', () => {
    const incomplete = Object.fromEntries(Object.entries(WALL).filter(([name]) => name !== 'Tinf2'));
    expect(refused('plane_wall', incomplete, 'THM_INPUT_INVALID').summary).toContain('missing inputs Tinf2');
    expect(refused('plane_wall', { ...WALL, bogus: q(1, '1') }, 'THM_INPUT_INVALID').summary).toContain('unknown inputs bogus');
    refused('plane_wall', { ...incomplete, bogus: q(1, '1') }, 'THM_INPUT_INVALID');
    refused('view_factor', { a: q(1, 'm') }, 'THM_INPUT_INVALID');
    refused('stefan_boltzmann', { x: q(1, 'm') }, 'THM_INPUT_INVALID');
  });

  it('refuses a Stefan number outside the bracketed root and unknown check names (schema)', () => {
    refused('stefan', stefanInputs({ dT: q(1e9, 'K') }), 'THM_INPUT_INVALID');
    refused('stefan', stefanInputs({ dT: q(1e-20, 'K') }), 'THM_INPUT_INVALID');
    const unknown = execute(doc, 'thermal_analytic_check', { check: 'nope', inputs: {} });
    expect(unknown.document).toBe(doc);
    expect(unknown.summary).toMatch(/rejected: invalid params/);
  });

  it('does not mutate the document', () => {
    const before = JSON.stringify(doc);
    check('plane_wall', WALL);
    check('plane_wall', { ...WALL, h1: q(-1, 'W/(m^2*K)') });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

function stefanInputs(override: Record<string, Q>): Record<string, Q> {
  return {
    k: q(0.6, 'W/(m*K)'),
    rho: q(1000, 'kg/m^3'),
    cp: q(4200, 'J/(kg*K)'),
    latent: q(334000, 'J/kg'),
    dT: q(10, 'K'),
    t: q(3600, 's'),
    ...override,
  };
}

function interfaceInputs(override: Record<string, Q>): Record<string, Q> {
  return {
    L1: q(0.01, 'm'),
    k1: q(150, 'W/(m*K)'),
    hc: q(2000, 'W/(m^2*K)'),
    L2: q(0.01, 'm'),
    k2: q(15, 'W/(m*K)'),
    T_hot: q(100, 'degC'),
    T_cold: q(20, 'degC'),
    ...override,
  };
}
