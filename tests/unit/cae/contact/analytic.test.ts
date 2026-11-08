/** PHY-06 M1 hand checks against the validation generator: hertz_contact (VC-CNT-10..13), interference_fit (VC-CNT-20), bolted_joint_check (VC-CNT-40, 62, 63). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

const DIR = 'docs/physics/06-contact-joints/validation';
const expected = JSON.parse(readFileSync(`${DIR}/expected_results.json`, 'utf8')) as {
  cases: { id: string; value: unknown; extra?: Record<string, number>; depthOverA?: number; depthOverB?: number }[];
};
const worked = JSON.parse(readFileSync(`${DIR}/bolted_joint_nasa5020.json`, 'utf8')) as { results: Record<string, number | boolean> };
const query = JSON.parse(readFileSync(`${DIR}/plans/cnt_bolted_joint_check.query.json`, 'utf8')) as Record<string, unknown>;

const value = (id: string): number => {
  const found = expected.cases.find((entry) => entry.id === id);
  if (found === undefined || typeof found.value !== 'number') throw new Error(`no numeric case ${id}`);
  return found.value;
};
const caseOf = (id: string): (typeof expected.cases)[number] => {
  const found = expected.cases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

/** |a / b - 1| <= tol (the generator rounds to 12 significant digits, so 1e-9 is the TR-CNT-20 bound). */
const close = (actual: unknown, reference: number, tol = 1e-9): void => {
  expect(typeof actual).toBe('number');
  expect(Math.abs((actual as number) / reference - 1)).toBeLessThanOrEqual(tol);
};

const doc = createEmptyDocument();
const data = (name: string, params: Record<string, unknown>): Record<string, unknown> => {
  const result = execute(doc, name, params);
  if (result.error !== undefined) throw new Error(result.summary);
  expect(result.document).toBe(doc);
  expect(result.affected).toEqual([]);
  return result.data as Record<string, unknown>;
};

describe('hertz_contact', () => {
  it('reproduces SSNP154 (VC-CNT-10): b 6.2146 mm, p0 3585.36 MPa at 1e-9 vs the generator, reviewRequired, subsurface unverified', () => {
    const out = data('hertz_contact', {
      inputs: { pair: 'cylinder_plane', R1_mm: 50, E1_MPa: 210000, nu1: 0.3, E2_MPa: 70000, nu2: 0.3, loadPerLength_N_per_mm: 35000 },
    });
    close(out['halfWidth_mm'], value('VC-CNT-10.a'));
    close(out['p0_MPa'], value('VC-CNT-10.b'));
    expect(out['reviewRequired']).toBe(true);
    expect(out['subsurface']).toMatchObject({ unverified: true });
    expect((out['items'] as { code: string }[]).map((entry) => entry.code)).toEqual(['CNT_SUBSURFACE_UNVERIFIED']);
    const line = out['subsurface'] as { tauMaxOverP0: number; depthOverHalfWidth: number };
    close(line.tauMaxOverP0, value('VC-CNT-13.b'), 1e-9);
    close(line.depthOverHalfWidth, caseOf('VC-CNT-13.b').depthOverB ?? 0, 1e-6);
  });

  it('reproduces SSNV104 under approach (VC-CNT-11) and the ball on a flat under force (VC-CNT-12), with the sphere subsurface (VC-CNT-13.a)', () => {
    const spheres = data('hertz_contact', {
      inputs: { pair: 'sphere_sphere', R1_mm: 50, R2_mm: 50, E1_MPa: 20000, nu1: 0.3, E2_MPa: 20000, nu2: 0.3, approach_mm: 4 },
    });
    close(spheres['p0_MPa'], value('VC-CNT-11.a'));
    close(spheres['contactRadius_mm'], value('VC-CNT-11.b'));
    close(spheres['load_N'], value('VC-CNT-11.c'));
    const ball = data('hertz_contact', {
      inputs: { pair: 'sphere_plane', R1_mm: 10, E1_MPa: 210000, nu1: 0.3, E2_MPa: 210000, nu2: 0.3, load_N: 1000 },
    });
    close(ball['contactRadius_mm'], value('VC-CNT-12'));
    close(ball['p0_MPa'], caseOf('VC-CNT-12').extra?.['p0_MPa'] ?? 0);
    close(ball['approach_mm'], caseOf('VC-CNT-12').extra?.['approach_mm'] ?? 0);
    const sphere = ball['subsurface'] as { tauMaxOverP0: number; depthOverHalfWidth: number };
    close(sphere.tauMaxOverP0, value('VC-CNT-13.a'));
    close(sphere.depthOverHalfWidth, caseOf('VC-CNT-13.a').depthOverA ?? 0, 1e-6);
    const rollers = data('hertz_contact', {
      inputs: {
        pair: 'cylinder_cylinder',
        R1_mm: 100,
        R2_mm: 100,
        E1_MPa: 210000,
        nu1: 0.3,
        E2_MPa: 70000,
        nu2: 0.3,
        loadPerLength_N_per_mm: 35000,
      },
    });
    close(rollers['halfWidth_mm'], value('VC-CNT-10.a'));
  });

  it.each([
    [{ pair: 'cylinder_plane', R1_mm: 50, E1_MPa: 210000, nu1: 0.3, E2_MPa: 70000, nu2: 0.3, approach_mm: 1 }, 'inputs.approach_mm'],
    [{ pair: 'sphere_sphere', R1_mm: 50, E1_MPa: 1, nu1: 0.3, E2_MPa: 1, nu2: 0.3, load_N: 1 }, 'inputs.R2_mm'],
    [{ pair: 'sphere_plane', R1_mm: 50, R2_mm: 3, E1_MPa: 1, nu1: 0.3, E2_MPa: 1, nu2: 0.3, load_N: 1 }, 'inputs.R2_mm'],
    [{ pair: 'sphere_plane', R1_mm: 50, E1_MPa: 1, nu1: 0.3, E2_MPa: 1, nu2: 0.3, load_N: 1, approach_mm: 1 }, 'inputs.load_N'],
    [{ pair: 'sphere_plane', R1_mm: 50, E1_MPa: 1, nu1: 0.3, E2_MPa: 1, nu2: 0.3, load_N: -1 }, 'inputs.load_N'],
    [{ pair: 'sphere_plane', R1_mm: 0, E1_MPa: 1, nu1: 0.3, E2_MPa: 1, nu2: 0.3, load_N: 1 }, 'inputs.R1_mm'],
    [{ pair: 'sphere_plane', R1_mm: 5, E1_MPa: 0, nu1: 0.3, E2_MPa: 1, nu2: 0.3, load_N: 1 }, 'inputs.E1_MPa'],
    [{ pair: 'sphere_plane', R1_mm: 5, E1_MPa: 1, nu1: 0.6, E2_MPa: 1, nu2: 0.3, load_N: 1 }, 'inputs.nu1'],
  ])('refuses invalid inputs with CNT_HERTZ_INPUT_INVALID (%#)', (inputs, path) => {
    const result = execute(doc, 'hertz_contact', { inputs });
    expect(result.error?.code).toBe('CNT_HERTZ_INPUT_INVALID');
    expect(result.error?.paths).toEqual([path]);
    expect(result.document).toBe(doc);
  });
});

describe('interference_fit', () => {
  const fit = {
    inner: { innerRadius: 0, outerRadius: 20, E: 210000, nu: 0.3 },
    outer: { outerRadius: 40, E: 210000, nu: 0.3 },
    radialInterference: 0.01,
  };

  it('reproduces VC-CNT-20 in plane stress (p 39.375 MPa, hub bore hoop 65.625 MPa) at 1e-9 and a solid shaft under -p', () => {
    const out = data('interference_fit', { ...fit, plane: 'stress' });
    close(out['contactPressure_MPa'], value('VC-CNT-20.a'));
    const outer = out['outer'] as { atInterface: { hoop_MPa: number; radial_MPa: number }; atOuter: { radial_MPa: number } };
    close(outer.atInterface.hoop_MPa, value('VC-CNT-20.b'));
    close(-outer.atInterface.radial_MPa, value('VC-CNT-20.a'), 1e-9);
    expect(Math.abs(outer.atOuter.radial_MPa)).toBeLessThan(1e-9);
    const inner = out['inner'] as { atBore: unknown; atInterface: { hoop_MPa: number } };
    expect(inner.atBore).toBeNull();
    close(-inner.atInterface.hoop_MPa, value('VC-CNT-20.a'), 1e-6);
    expect(out['reviewRequired']).toBe(true);
  });

  it('raises the pressure in plane strain (stiffer rings) and reports the bore of a hollow shaft', () => {
    const strain = data('interference_fit', { ...fit, plane: 'strain' });
    close(strain['contactPressure_MPa'], value('VC-CNT-20.a') / (1 - 0.3 ** 2), 1e-9);
    const hollow = data('interference_fit', { ...fit, inner: { ...fit.inner, innerRadius: 10 }, plane: 'stress' });
    const bore = (hollow['inner'] as { atBore: { radial_MPa: number; hoop_MPa: number } }).atBore;
    expect(Math.abs(bore.radial_MPa)).toBeLessThan(1e-9);
    expect(bore.hoop_MPa).toBeLessThan(0);
  });

  it.each([
    [{ ...fit, radialInterference: 0 }],
    [{ ...fit, inner: { ...fit.inner, outerRadius: 50 } }],
    [{ ...fit, outer: { ...fit.outer, nu: 0.5 } }],
    [{ ...fit, inner: { ...fit.inner, innerRadius: -1 } }],
  ])('refuses inconsistent radii / values with CNT_LAME_INPUT_INVALID (%#)', (input) => {
    const result = execute(doc, 'interference_fit', { ...input, plane: 'stress' });
    expect(result.error?.code).toBe('CNT_LAME_INPUT_INVALID');
    expect(result.document).toBe(doc);
  });
});

describe('bolted_joint_check', () => {
  const r = worked.results;
  const num = (key: string): number => r[key] as number;

  it('reproduces the NASA-STD-5020 worked example (VC-CNT-40.a-f, h) at 1e-9 with the edition, defaults named and every margin unverified', () => {
    const out = data('bolted_joint_check', query) as {
      standard: string;
      preload: Record<string, unknown> & { gamma: unknown; relaxation: unknown };
      linearTheory: Record<string, unknown>;
      margins: { criterion: string; ms: number; equation: string; unverified: boolean }[];
      status: string;
      items: { code: string }[];
      unverified: boolean;
      unverifiedReasons: string[];
      reviewRequired: boolean;
    };
    expect(out.standard).toBe('NASA-STD-5020 (2012)');
    close(out.preload['nominalN'], num('Ppi_nom_N'));
    close(out.preload['initialMinSeparationN'], num('Ppi_min_separation_critical_N'));
    close(out.preload['initialMinSlipN'], num('Ppi_min_slip_and_non_critical_N'));
    close(out.preload['minSeparationN'], value('VC-CNT-40.a'));
    close(out.preload['minSlipN'], value('VC-CNT-40.b'));
    close(out.preload['maxN'], value('VC-CNT-40.c'));
    close(out.linearTheory['nPhi'], num('n_phi'));
    close(out.linearTheory['PsepPrimeN'], value('VC-CNT-40.f'));
    close(out.linearTheory['PtuPrimeN'], num('P_tu_prime_N'));
    expect(out.linearTheory['separationBeforeRupture']).toBe(true);
    const ms = Object.fromEntries(out.margins.map((margin) => [margin.criterion, margin]));
    expect(Math.abs((ms['joint_separation']?.ms ?? 0) - value('VC-CNT-40.d'))).toBeLessThan(1e-9);
    expect(Math.abs((ms['joint_slip']?.ms ?? 0) - value('VC-CNT-40.e'))).toBeLessThan(1e-9);
    expect(ms['joint_slip']?.equation).toBe('A.10-4');
    expect(ms['fastener_ultimate']).toBeUndefined();
    expect(out.preload.gamma).toEqual({ value: 0.25, source: 'NASA-STD-5020 6.1.d(1)A', defaulted: true });
    expect(out.preload.relaxation).toMatchObject({ kind: 'fraction', value: 0.05, defaulted: true });
    expect(out.status).toBe('incomplete');
    expect(out.items.map((entry) => entry.code)).toEqual(['CNT_DEFAULT_GAMMA_USED', 'CNT_ULTIMATE_MARGIN_PENDING']);
    expect(out.unverified).toBe(true);
    expect(out.unverifiedReasons).toContain('nut factor without test record');
    expect(out.margins.every((margin) => margin.unverified)).toBe(true);
    expect(out.reviewRequired).toBe(true);
  });

  it('uses the 35 % default dry (VC-CNT-40.h), a tested set-up is verified, A.10-5 without joint tension, 6-11 when rupture comes first', () => {
    const dry = data('bolted_joint_check', { ...query, lubricated: false }) as { preload: { gamma: { value: number } } };
    expect(dry.preload.gamma.value).toBe(0.35);
    const tested = data('bolted_joint_check', {
      ...query,
      nutFactor: { value: 0.2, source: 'test', tested: true },
      gamma: { value: 0.25, source: 'test report', statisticalBasis: '90/95' },
      friction: { mu: 0.2, surface: 'uncoated_clean_metal', testRecord: 'TR-1' },
      limitLoads: { tensionPerFastener: { value: 2000, unit: 'N' }, shearJoint: { value: 3000, unit: 'N' } },
    }) as { unverified: boolean; items: unknown[]; margins: { criterion: string; ms: number; equation: string }[] };
    expect(tested.unverified).toBe(false);
    const slip = tested.margins.find((margin) => margin.criterion === 'joint_slip');
    expect(slip?.equation).toBe('A.10-5');
    expect(Math.abs((slip?.ms ?? 0) - num('MS_slip_no_tension_A10_5'))).toBeLessThan(1e-9);
    const rupture = data('bolted_joint_check', {
      ...query,
      loadingPlaneFactor: { value: 1, source: 'test' },
      stiffness: { phi: 0.9, source: 'test' },
    }) as { margins: { criterion: string; equation: string }[]; linearTheory: { separationBeforeRupture: boolean } };
    expect(rupture.linearTheory.separationBeforeRupture).toBe(false);
    expect((rupture as unknown as { status: string }).status).toBe('pass');
    expect(rupture.margins.map((margin) => margin.equation)).toContain('6-11');
    const perFastener = data('bolted_joint_check', {
      ...query,
      control: 'stretch',
      preloadNominal: { value: 8, unit: 'kN' },
      limitLoads: { tensionPerFastener: { value: 2000, unit: 'N' }, shearPerFastener: { value: 500, unit: 'N' } },
    }) as { preload: { gamma: { value: number }; nominalN: number }; margins: { equation: string }[] };
    expect(perFastener.preload.gamma.value).toBe(0.1);
    expect(perFastener.preload.nominalN).toBe(8000);
    expect(perFastener.margins.map((margin) => margin.equation)).toContain('A.10-6');
  });

  it('fails above the friction cap without a test record (VC-CNT-40.g) and on a negative margin', () => {
    const capped = data('bolted_joint_check', { ...query, friction: { mu: 0.3, surface: 'uncoated_clean_metal' } }) as {
      status: string;
      items: { code: string }[];
    };
    expect(capped.status).toBe('fail');
    expect(capped.items.map((entry) => entry.code)).toContain('CNT_FRICTION_ABOVE_CAP');
    const negative = data('bolted_joint_check', { ...query, limitLoads: { tensionPerFastener: { value: 9000, unit: 'N' } } }) as {
      status: string;
      items: { code: string }[];
    };
    expect(negative.status).toBe('fail');
    expect(negative.items.map((entry) => entry.code)).toContain('CNT_MS_NEGATIVE');
  });

  it.each([
    [{ separationCritical: true }, 'CNT_GAMMA_TEST_DATA_REQUIRED'],
    [{ separationCritical: true, gamma: { value: 0.2, source: 'estimate' } }, 'CNT_GAMMA_TEST_DATA_REQUIRED'],
    [{ nutFactor: undefined }, 'CNT_NUT_FACTOR_MISSING'],
    [{ factors: undefined }, 'CNT_FACTORS_UNSET'],
    [{ torque: undefined }, 'CNT_INPUT_INVALID'],
    [{ control: 'turn' }, 'CNT_INPUT_INVALID'],
    [{ metallicJoint: false }, 'CNT_INPUT_INVALID'],
    [{ nominalDiameter: { value: 6.35, unit: 'kg' } }, 'CNT_INPUT_INVALID'],
    [{ torque: { nominal: { value: 10, unit: 'N*m' }, tolerance: { value: 0.5, unit: 'N*m' }, aboveRunning: false } }, 'CNT_INPUT_INVALID'],
    [{ stiffness: { phi: 1.2, source: 'x' } }, 'CNT_INPUT_INVALID'],
    [{ loadingPlaneFactor: { value: 0, source: 'x' } }, 'CNT_INPUT_INVALID'],
    [{ fastenerCount: 0 }, 'CNT_INPUT_INVALID'],
    [{ allowableTensile: { value: 0, unit: 'N' } }, 'CNT_INPUT_INVALID'],
    [{ gamma: { value: 1.5, source: 'x' } }, 'CNT_INPUT_INVALID'],
    [{ friction: { mu: -0.1, surface: 'other' } }, 'CNT_INPUT_INVALID'],
  ])('refuses %j with %s (VC-CNT-40.i), leaving the document unchanged', (patch, code) => {
    const params = Object.fromEntries(Object.entries({ ...query, ...patch }).filter(([, entry]) => entry !== undefined));
    const result = execute(doc, 'bolted_joint_check', params);
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
  });

  it('subtracts running / breakaway torque when the spec is not above running torque (A.2-4..7)', () => {
    const out = data('bolted_joint_check', {
      ...query,
      torque: {
        nominal: { value: 10, unit: 'N*m' },
        tolerance: { value: 0.5, unit: 'N*m' },
        runningTorqueMax: { value: 1, unit: 'N*m' },
        breakawayMin: { value: 0.5, unit: 'N*m' },
        aboveRunning: false,
      },
    }) as { preload: { initialMaxN: number; initialMinSeparationN: number } };
    close(out.preload.initialMaxN, (1.25 * 10) / (0.2 * 0.00635));
    close(out.preload.initialMinSeparationN, (0.75 * 8.5) / (0.2 * 0.00635));
  });
});
