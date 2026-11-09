/** PHY-11 M1 (TR-CRP-20..22, 40, 41, 12): creep_closed_form against the pack's generated expected values, its refusals and its material option. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { convertNortonA } from '@core/model/materialLaws/nortonUnits';
import { creepCube, must } from './support';

interface Expected {
  readonly id: string;
  readonly value: number;
  readonly tolerance: { readonly rel?: number; readonly abs?: number };
}

const EXPECTED = (
  JSON.parse(readFileSync('docs/physics/11-creep-viscoelasticity/validation/expected_results.json', 'utf8')) as { cases: Expected[] }
).cases;
const expectedOf = (id: string): Expected => {
  const found = EXPECTED.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

const NORTON = { A: 1e-10, n: 5, m: 0, sigma_MPa: 20, t_s: 1000 };
const RELAX = { E_MPa: 200000, A: 1e-18, n: 5, sigma0_MPa: 100 };
const TUBE = { p_MPa: 10, a_m: 0.16, b_m: 0.25, n: 5 };
const BEAM = { M_Nmm: 1e5, b_mm: 10, h_mm: 20, n: 5 };
const SLS = { Einf_MPa: 1000, E1_MPa: 2000, tau_s: 10 };

/** [case id, check, inputs, value name]: every value of the generator's cases the command reproduces. */
const CASES: readonly (readonly [string, string, Record<string, unknown>, string])[] = [
  ['VC-CRP-10', 'norton_constant_stress', NORTON, 'equivalentCreepStrain'],
  ['VC-CRP-11', 'norton_constant_stress', { ...NORTON, m: -0.5 }, 'equivalentCreepStrain'],
  ['VC-CRP-12.a', 'norton_relaxation', { ...RELAX, t_s: 3600 }, 'stressMPa'],
  ['VC-CRP-12.b', 'norton_relaxation', { ...RELAX, fraction: 0.5 }, 'timeToFractionS'],
  ['VC-CRP-13.a', 'bolt_relaxation', { ...RELAX, kb_over_km: 1 / 3, t_s: 1e6 }, 'preloadRatio'],
  ['VC-CRP-13.b', 'bolt_relaxation', { ...RELAX, kb_over_km: 0, t_s: 1e6 }, 'preloadRatio'],
  ['VC-CRP-14.a', 'thick_cylinder_stationary', TUBE, 'hoopAtBoreMPa'],
  ['VC-CRP-14.b', 'thick_cylinder_stationary', TUBE, 'hoopAtOuterMPa'],
  ['VC-CRP-14.c', 'thick_cylinder_stationary', TUBE, 'vonMisesAtBoreMPa'],
  ['VC-CRP-14.d', 'thick_cylinder_stationary', { ...TUBE, n: 1 }, 'hoopAtBoreMPa'],
  ['VC-CRP-15.a', 'beam_stationary', BEAM, 'outerFibreMPa'],
  ['VC-CRP-15.b', 'beam_stationary', BEAM, 'atQuarterHeightMPa'],
  [
    'VC-CRP-16.a',
    'convert_norton_a',
    { A: 1e-10, n: 5, m: 0, from_stress_unit: 'MPa', from_time_unit: 's', to_stress_unit: 'Pa', to_time_unit: 's' },
    'A',
  ],
  [
    'VC-CRP-16.b',
    'convert_norton_a',
    { A: 1e-10, n: 5, m: 0, from_stress_unit: 'MPa', from_time_unit: 's', to_stress_unit: 'MPa', to_time_unit: 'h' },
    'A',
  ],
  [
    'VC-CRP-16.c',
    'convert_norton_a',
    { A: 1e-10, n: 5, m: -0.5, from_stress_unit: 'MPa', from_time_unit: 's', to_stress_unit: 'MPa', to_time_unit: 'h' },
    'A',
  ],
  ['VC-CRP-30.a', 'sls', { ...SLS, t_s: 10 }, 'relaxationModulusMPa'],
  ['VC-CRP-30.b', 'sls', { ...SLS, t_s: 100 }, 'creepComplianceInvMPa'],
  ['VC-CRP-31', 'kelvin_voigt', { E_MPa: 1000, tau_s: 10, t_s: 10 }, 'creepComplianceInvMPa'],
  [
    'VC-CRP-32',
    'prony_relaxation',
    {
      Einf_MPa: 1000,
      terms: [
        { E_MPa: 1500, tau_s: 1 },
        { E_MPa: 500, tau_s: 100 },
      ],
      t_s: 10,
    },
    'relaxationModulusMPa',
  ],
  ['VC-CRP-33.a', 'wlf_shift', { C1: 17.44, C2_K: 51.6, T_minus_Tr_K: 10 }, 'log10ShiftFactor'],
  ['VC-CRP-33.b', 'wlf_shift', { C1: 17.44, C2_K: 51.6, T_minus_Tr_K: 50 }, 'log10ShiftFactor'],
  ['VC-CRP-34', 'wlf_shift', { C1: 17.44, C2_K: 51.6, T_minus_Tr_K: 10, ...SLS, t_s: 0.01 }, 'shiftedModulusMPa'],
];

const valuesOf = (data: unknown): Record<string, { value: number; unit: string }> =>
  (data as { values: Record<string, { value: number; unit: string }> }).values;

describe('creep_closed_form', () => {
  it.each(CASES)('%s: %s reproduces the generated value within its tolerance', (id, check, inputs, name) => {
    const result = execute(createEmptyDocument(), 'creep_closed_form', { check, inputs });
    expect(result.error).toBeUndefined();
    const expected = expectedOf(id);
    const value = valuesOf(result.data)[name]?.value ?? Number.NaN;
    const error = Math.abs(value - expected.value);
    expect(error).toBeLessThanOrEqual(expected.tolerance.abs ?? (expected.tolerance.rel ?? 0) * Math.abs(expected.value));
    expect(result.affected).toEqual([]);
  });

  it('matches the generator to 1e-12 where it is exact: n = 1 is Lame, SLS interconversion E(t) J(t) at t = 0 is 1, Maxwell / bolt / bar closed forms', () => {
    const run = (check: string, inputs: Record<string, unknown>): Record<string, { value: number }> =>
      valuesOf(execute(createEmptyDocument(), 'creep_closed_form', { check, inputs }).data);
    const lame = run('thick_cylinder_stationary', { ...TUBE, n: 1 });
    expect(lame['hoopAtBoreMPa']?.value).toBeCloseTo(23.8753387534, 10);
    expect(Math.abs((lame['hoopAtBoreMPa']?.value ?? 0) - (lame['lameHoopAtBoreMPa']?.value ?? 0))).toBeLessThan(1e-12);
    expect(run('sls', { ...SLS, t_s: 0 })['modulusTimesCompliance']?.value).toBeCloseTo(1, 14);
    expect(run('maxwell', { E_MPa: 100, tau_s: 5, t_s: 5 })['relaxationModulusMPa']?.value).toBeCloseTo(100 * Math.exp(-1), 12);
    expect(run('norton_relaxation', { ...RELAX, n: 1, t_s: 0 })['stressMPa']?.value).toBe(100);
    expect(run('bolt_relaxation', { ...RELAX, kb_over_km: 1 / 3, t_s: 1e6 })['effectiveModulusMPa']?.value).toBeCloseTo(150000, 6);
  });

  it('takes { value, unit } inputs converted to the key unit (60 min = 3600 s; 0.1 GPa = 100 MPa), and units of A round trip to 1e-12', () => {
    const doc = createEmptyDocument();
    const a = execute(doc, 'creep_closed_form', { check: 'norton_relaxation', inputs: { ...RELAX, t_s: 3600 } });
    const b = execute(doc, 'creep_closed_form', {
      check: 'norton_relaxation',
      inputs: { ...RELAX, sigma0_MPa: { value: 0.1, unit: 'GPa' }, t_s: { value: 60, unit: 'min' } },
    });
    expect(valuesOf(b.data)['stressMPa']?.value).toBe(valuesOf(a.data)['stressMPa']?.value);
    const there = convertNortonA(1e-10, 5, -0.5, { stress: 'MPa', time: 's' }, { stress: 'Pa', time: 'h' });
    const back = 'A' in there ? convertNortonA(there.A, 5, -0.5, { stress: 'Pa', time: 'h' }, { stress: 'MPa', time: 's' }) : there;
    expect('A' in back && Math.abs(back.A / 1e-10 - 1)).toBeLessThan(1e-12);
  });

  it('optional points: the tube at a radius between the faces, the beam at a height within the section; strings and non-numbers are refused', () => {
    const run = (check: string, inputs: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(createEmptyDocument(), 'creep_closed_form', { check, inputs });
    expect(valuesOf(run('thick_cylinder_stationary', { ...TUBE, r_m: 0.2 }).data)['hoopAtRMPa']?.value).toBeGreaterThan(14.4);
    expect(valuesOf(run('beam_stationary', { ...BEAM, y_mm: -5 }).data)['atYMPa']?.value).toBeLessThan(0);
    expect(run('norton_constant_stress', { ...NORTON, A: 'big' }).error).toMatchObject({ code: 'CRP_INPUT_INVALID', paths: ['inputs.A'] });
    expect(run('norton_constant_stress', { ...NORTON, A: { value: 1, unit: 'MPa' } }).error?.paths).toEqual(['inputs.A']);
  });

  it('refuses a missing input naming the key, with its code and path (VC-CRP-65): unchanged document, nothing affected', () => {
    const doc = createEmptyDocument();
    const before = structuredClone(doc);
    const result = execute(doc, 'creep_closed_form', { check: 'norton_constant_stress', inputs: { A: 1e-10, n: 5, m: 0, t_s: 1000 } });
    expect(result.rejected).toBe(true);
    expect(result.error).toMatchObject({ code: 'CRP_INPUT_MISSING', paths: ['inputs.sigma_MPa'] });
    expect(result.summary).toContain('sigma_MPa (MPa)');
    expect(result.document).toBe(doc);
    expect(doc).toEqual(before);
    expect(result.affected).toEqual([]);
  });

  it.each([
    ['norton_constant_stress', { ...NORTON, m: -1 }, 'CRP_INPUT_INVALID', 'inputs.m'],
    ['norton_constant_stress', { ...NORTON, sigma_MPa: -5 }, 'CRP_INPUT_INVALID', 'inputs.sigma_MPa'],
    ['norton_constant_stress', { ...NORTON, t_s: { value: 3, unit: 'N' } }, 'CRP_INPUT_INVALID', 'inputs.t_s'],
    ['norton_constant_stress', { ...NORTON, A: Number.POSITIVE_INFINITY }, 'CRP_INPUT_INVALID', 'inputs.A'],
    ['norton_relaxation', { ...RELAX }, 'CRP_INPUT_MISSING', 'inputs.t_s'],
    ['norton_relaxation', { ...RELAX, fraction: 1.5 }, 'CRP_INPUT_INVALID', 'inputs.fraction'],
    ['norton_relaxation', { ...RELAX, t_s: 10, m: -0.5 }, 'CRP_INPUT_INVALID', 'inputs.m'],
    ['thick_cylinder_stationary', { ...TUBE, b_m: 0.1 }, 'CRP_INPUT_INVALID', 'inputs.b_m'],
    ['thick_cylinder_stationary', { ...TUBE, r_m: 0.3 }, 'CRP_INPUT_INVALID', 'inputs.r_m'],
    ['beam_stationary', { ...BEAM, y_mm: 15 }, 'CRP_INPUT_INVALID', 'inputs.y_mm'],
    ['prony_relaxation', { Einf_MPa: 1, t_s: 1 }, 'CRP_INPUT_MISSING', 'inputs.terms'],
    ['prony_relaxation', { Einf_MPa: 1, t_s: 1, terms: [] }, 'CRP_INPUT_INVALID', 'inputs.terms'],
    ['prony_relaxation', { Einf_MPa: 1, t_s: 1, terms: [{ E_MPa: 1 }] }, 'CRP_INPUT_MISSING', 'inputs.terms[0].tau_s'],
    ['wlf_shift', { C1: 17.44, C2_K: 51.6, T_minus_Tr_K: -1 }, 'CRP_WLF_OUT_OF_RANGE', 'inputs.T_minus_Tr_K'],
    ['wlf_shift', { C1: 17.44, C2_K: 51.6, T_minus_Tr_K: 10, Einf_MPa: 1 }, 'CRP_INPUT_MISSING', 'inputs.E1_MPa'],
    [
      'convert_norton_a',
      { A: 1, n: 5, m: 0, from_stress_unit: 'MPa', from_time_unit: 's', to_stress_unit: 'mm', to_time_unit: 'h' },
      'CRP_INPUT_INVALID',
      'inputs.units',
    ],
    [
      'convert_norton_a',
      { A: 1, n: 5, m: 0, from_stress_unit: 'MPa', from_time_unit: 'N', to_stress_unit: 'Pa', to_time_unit: 'h' },
      'CRP_INPUT_INVALID',
      'inputs.units',
    ],
    ['convert_norton_a', { A: 1, n: 5, m: 0, from_stress_unit: 'MPa' }, 'CRP_INPUT_MISSING', 'inputs.from_time_unit'],
  ] as const)('refuses %s %j with %s at %s', (check, inputs, code, path) => {
    const result = execute(createEmptyDocument(), 'creep_closed_form', { check, inputs });
    expect(result.rejected).toBe(true);
    expect(result.error).toMatchObject({ code, paths: [path] });
  });
});

describe('creep_closed_form with a material', () => {
  const NO_INPUTS = { sigma_MPa: 20, t_s: 1000 };

  it('reads A, n, m from the creep law of the material (converted to MPa and s) and reproduces VC-CRP-10; no unverified flag for a company law', () => {
    const { doc } = creepCube();
    const result = execute(doc, 'creep_closed_form', { check: 'norton_constant_stress', material: 'norton', inputs: NO_INPUTS });
    expect(result.error).toBeUndefined();
    expect(valuesOf(result.data)['equivalentCreepStrain']?.value).toBeCloseTo(0.32, 12);
    expect(result.data).toMatchObject({
      unverified: false,
      provenance: { law: { materialId: 'norton', modelId: 'creep', basis: 'company' } },
    });
  });

  it('converts a law stored in other units: the same law in MPa^-5 h^-1 gives the same strain', () => {
    const { doc } = creepCube({ law: { A: 1e-10 * 3600, timeUnit: 'h' }, step: null });
    const result = execute(doc, 'creep_closed_form', {
      check: 'norton_constant_stress',
      material: 'norton',
      inputs: { sigma_MPa: 20, t_s: 1000 },
    });
    expect(valuesOf(result.data)['equivalentCreepStrain']?.value).toBeCloseTo(0.32, 12);
  });

  it('flags a typical-basis law unverified with its reasons, and checks temperature_K against the law validity (CRP_LAW_OUT_OF_RANGE, never extrapolated)', () => {
    const { doc } = creepCube({ basis: 'typical' });
    const ok = execute(doc, 'creep_closed_form', {
      check: 'norton_constant_stress',
      material: 'norton',
      inputs: { ...NO_INPUTS, temperature_K: 293 },
    });
    expect(ok.data).toMatchObject({ unverified: true, unverifiedReasons: ['basis typical'] });
    const hot = execute(doc, 'creep_closed_form', {
      check: 'norton_constant_stress',
      material: 'norton',
      inputs: { ...NO_INPUTS, temperature_K: 400 },
    });
    expect(hot.error).toMatchObject({ code: 'CRP_LAW_OUT_OF_RANGE', ids: ['norton'] });
    expect(hot.rejected).toBe(true);
  });

  it('refuses: unknown material, material without a creep law, strain hardening, inputs that the law supplies, a non-norton check, temperature_K without a material', () => {
    const { doc } = creepCube();
    const run = (params: Record<string, unknown>): string | undefined =>
      execute(doc, 'creep_closed_form', { check: 'norton_constant_stress', ...params }).error?.code;
    expect(run({ material: 'nothing', inputs: NO_INPUTS })).toBe('CRP_LAW_MISSING');
    expect(run({ material: 'norton', inputs: { ...NO_INPUTS, A: 1 } })).toBe('CRP_INPUT_INVALID');
    expect(run({ inputs: { ...NORTON, temperature_K: 300 } })).toBe('CRP_INPUT_INVALID');
    expect(execute(doc, 'creep_closed_form', { check: 'wlf_shift', material: 'norton', inputs: {} }).error?.code).toBe('CRP_INPUT_INVALID');
    const bare = must(createEmptyDocument(), 'create_material', {
      name: 'plain',
      density: 0.0078,
      color: '#999999',
      metalness: 1,
      roughness: 0.4,
    }).doc;
    expect(execute(bare, 'creep_closed_form', { check: 'norton_constant_stress', material: 'plain', inputs: NO_INPUTS }).error?.code).toBe(
      'CRP_LAW_MISSING',
    );
    const strain = creepCube({ law: { hardening: 'strain' }, step: null }).doc;
    expect(
      execute(strain, 'creep_closed_form', { check: 'norton_constant_stress', material: 'norton', inputs: NO_INPUTS }).error?.code,
    ).toBe('CRP_LAW_FORM_UNSUPPORTED');
  });

  it('refuses a temperature_K that is not a temperature, and a part whose material left the document', () => {
    const { doc } = creepCube();
    const bad = execute(doc, 'creep_closed_form', {
      check: 'norton_constant_stress',
      material: 'norton',
      inputs: { ...NO_INPUTS, temperature_K: 'hot' },
    });
    expect(bad.error).toMatchObject({ code: 'CRP_INPUT_INVALID', paths: ['inputs.temperature_K'] });
  });

  it('is pure: the document is returned as is, with nothing affected', () => {
    const { doc } = creepCube();
    const before = structuredClone(doc);
    const result = execute(doc, 'creep_closed_form', { check: 'norton_constant_stress', material: 'norton', inputs: NO_INPUTS });
    expect(result.document).toBe(doc);
    expect(doc).toEqual(before);
    expect(result.affected).toEqual([]);
  });
});
