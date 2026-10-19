/**
 * PHY-09 math against docs/physics/09-structural-dynamics/validation/expected_results.json (generator values, analytic derivations
 * quoted there): SDOF FRFs (VC-DYN-01..04), Rayleigh (05), CalculiX beamdy8 modal coordinate (06), random SDOF (07, 08, 11),
 * Gaussian 3-sigma (09), GEVS grms (10), SRS (13, 14) and the Euler-Bernoulli strip on the GEVS ASD (21).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { halfPower, milesGrms, receptance, receptancePeak, reciprocal, transmissibility } from '@cae/dynamics/math/sdof';
import { frfMagnitude, whiteNoiseAccelerationRms, whiteNoiseRelativeDisplacementRms } from '@cae/dynamics/math/sdof';
import { asdAt, integrateAsd, spectrumProblem, type AsdPoint } from '@cae/dynamics/math/psd';
import { rayleighFromRatios, rayleighZeta, zetaOfMode, dampingTerms } from '@cae/dynamics/math/damping';
import { DEFAULT_PEAK_FACTOR, gaussianExceedance, peakFactorOf } from '@cae/dynamics/math/gaussian';
import { halfSineSrs, historySrs, octaveFrequencies } from '@cae/dynamics/math/srs';
import { integrationGrid, meanSquare, modalForms, nodalRmsReference, rmsOf, type ModalBasis } from '@cae/dynamics/math/randomResponse';
import { ebModes } from './ebCantilever';

interface Case {
  readonly id: string;
  readonly value: unknown;
  readonly tolerance: { readonly rel?: number; readonly abs?: number };
  readonly table?: number[][];
}
const EXPECTED = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../docs/physics/09-structural-dynamics/validation/expected_results.json'), 'utf8'),
) as { cases: Case[] };
const vc = (id: string): Case => {
  const found = EXPECTED.cases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const values = (id: string): number[] => {
  const value = vc(id).value;
  return Array.isArray(value) ? (value as number[]) : [value as number];
};
const near = (actual: number, expected: number, rel: number): void =>
  expect(Math.abs(actual - expected) / Math.abs(expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(rel);

const GEVS_QUAL: AsdPoint[] = [
  [20, 0.026],
  [50, 0.16],
  [800, 0.16],
  [2000, 0.026],
];
const GEVS_ACC: AsdPoint[] = [
  [20, 0.013],
  [50, 0.08],
  [800, 0.08],
  [2000, 0.013],
];

describe('SDOF frequency response (VC-DYN-01..04)', () => {
  it('amplification, peak, half-power and transmissibility match the closed forms to 1e-9', () => {
    near(frfMagnitude(receptance(1, 0.05)), values('VC-DYN-01')[0] ?? 0, 1e-9);
    const peak = receptancePeak(0.05);
    near(peak?.r ?? 0, values('VC-DYN-02')[0] ?? 0, 1e-9);
    near(peak?.amplification ?? 0, values('VC-DYN-02')[1] ?? 0, 1e-9);
    const hp = halfPower(0.05);
    values('VC-DYN-03').forEach((v, i) => near([hp?.r1, hp?.r2, hp?.q][i] ?? 0, v, 1e-9));
    const t = [frfMagnitude(transmissibility(1, 0.05)), ...[0.01, 0.05, 0.2].map((z) => frfMagnitude(transmissibility(Math.SQRT2, z)))];
    values('VC-DYN-04').forEach((v, i) => near(t[i] ?? 0, v, 1e-9));
    expect(receptancePeak(0.8)).toBeNull();
    expect(halfPower(0.8)).toBeNull();
    expect(receptancePeak(0)).toBeNull();
  });
});

describe('damping helpers (VC-DYN-05, VC-DYN-47 zeta_eq)', () => {
  it('Rayleigh alpha, beta for 2 % at 10 and 100 Hz and the dip at the geometric mean', () => {
    const { alpha, beta } = rayleighFromRatios(10, 100, 0.02, 0.02);
    const [a, b, mid] = values('VC-DYN-05');
    near(alpha, a ?? 0, 1e-9);
    near(beta, b ?? 0, 1e-9);
    near(rayleighZeta(alpha, beta, Math.sqrt(1000)), mid ?? 0, 1e-9);
    const unequal = rayleighFromRatios(10, 100, 0.01, 0.03);
    near(rayleighZeta(unequal.alpha, unequal.beta, 10), 0.01, 1e-12);
    near(rayleighZeta(unequal.alpha, unequal.beta, 100), 0.03, 1e-12);
  });

  it('per-mode ratios: modal ranges (last wins), structural eta / 2, Rayleigh', () => {
    const modal = {
      model: 'modal' as const,
      ratios: [
        { fromMode: 1, toMode: 6, zeta: 0.02 },
        { fromMode: 3, toMode: 3, zeta: 0.05 },
      ],
      source: { citation: 't' },
    };
    expect(zetaOfMode(modal, 1, 10, null)).toBe(0.02);
    expect(zetaOfMode(modal, 3, 10, null)).toBe(0.05);
    expect(zetaOfMode(modal, 7, 10, null)).toBeNull();
    expect(zetaOfMode({ model: 'structural_material', propertyName: 'structuralLossFactor' }, 1, 10, 0.02)).toBe(0.01);
    expect(dampingTerms({ model: 'structural_material', propertyName: 'structuralLossFactor' }, 1, 100, null)).toBeNull();
    expect(dampingTerms({ model: 'structural_material', propertyName: 'structuralLossFactor' }, 1, 100, 0.02)).toEqual({ a: 200, b: 0 });
    expect(dampingTerms(modal, 7, 100, null)).toBeNull();
    expect(dampingTerms({ model: 'rayleigh', alpha: 5, beta: 0.001, source: { citation: 't' } }, 1, 100, null)).toEqual({ a: 0, b: 15 });
  });
});

describe('CalculiX beamdy8 modal coordinate (VC-DYN-06)', () => {
  // Reference modal coordinates of mode 1 (Re, Im) from beamdy8.dat.ref (S2, pinned sha256 in calculix_dynamics_cases.json), as quoted
  // by generate_dynamics_reference.py REF_Q1.
  const REF_Q1: [number, number, number][] = [
    [0.12e5, 0.5349862e-3, -0.1857317e-3],
    [0.1211305531535e5, 0.5779606e-3, -0.2248237e-3],
    [0.1254801552883e5, 0.7796817e-3, -0.5539915e-3],
    [0.1298297574231e5, 0.4211571e-3, -0.1475796e-2],
    [0.1309603105766e5, -0.3667531e-17, -0.1582207e-2],
    [0.1318927521633e5, -0.3478933e-3, -0.1489781e-2],
    [0.1354801552883e5, -0.7600527e-3, -0.6804337e-3],
    [0.1390675584133e5, -0.5998997e-3, -0.3032582e-3],
    [0.14e5, -0.5577889e-3, -0.2537049e-3],
  ];
  it('the SDOF modal FRF with zeta = alpha / (2 w1) predicts the 8 other points from the resonance one within 2e-6', () => {
    const w1 = 0.8228479e5;
    const alpha = 5000;
    const dynamic = (f: number): [number, number] => {
      const w = 2 * Math.PI * f;
      return [w1 * w1 - w * w, alpha * w];
    };
    const [fr, qr, qi] = REF_Q1[4] ?? [0, 0, 0];
    const [dr, di] = dynamic(fr);
    const force = { re: qr * dr - qi * di, im: qr * di + qi * dr };
    let worst = 0;
    for (const [f, re, im] of REF_Q1) {
      const g = reciprocal(...dynamic(f));
      const q = { re: force.re * g.re - force.im * g.im, im: force.re * g.im + force.im * g.re };
      worst = Math.max(worst, Math.hypot(q.re - re, q.im - im) / Math.hypot(re, im));
    }
    expect(worst).toBeLessThanOrEqual(vc('VC-DYN-06').tolerance.abs ?? 0);
    near(worst, values('VC-DYN-06')[0] ?? 0, 1e-3);
  });
});

describe('random vibration of an SDOF (VC-DYN-07, 08, 11) and the Gaussian peak (09)', () => {
  it('Miles, exact white-noise acceleration and relative displacement', () => {
    const [miles, exact] = values('VC-DYN-07');
    near(milesGrms(100, 10, 0.04), miles ?? 0, 1e-9);
    near(whiteNoiseAccelerationRms(100, 0.05, 0.04), exact ?? 0, 1e-9);
    near(whiteNoiseRelativeDisplacementRms(100, 0.05, 0.04) * 1000, values('VC-DYN-08')[0] ?? 0, 1e-9);
  });

  it('the adaptive grid integrates the SDOF on the GEVS ASD within 1e-6 of the exact band-limited value', () => {
    const [miles, exact] = values('VC-DYN-11');
    near(milesGrms(200, 10, asdAt(GEVS_QUAL, 200)), miles ?? 0, 1e-9);
    const basis: ModalBasis = { omega: [2 * Math.PI * 200], dampingA: [0], dampingB: [2 * 0.05 * 2 * Math.PI * 200] };
    const grid = integrationGrid(GEVS_QUAL, [20, 2000], [{ fHz: 200, zeta: 0.05 }]);
    const q = meanSquare(modalForms(basis, grid), Float64Array.of(1), { kind: 'absolute', unity: true, scale: 1 });
    near(rmsOf(q, { kind: 'absolute', unity: true, scale: 1 }), exact ?? 0, 1e-6);
    const finer = integrationGrid(GEVS_QUAL, [20, 2000], [{ fHz: 200, zeta: 0.05 }], 2);
    expect(finer.intervals).toBe(grid.intervals * 2);
  });

  it('white-noise quadrature over ten decades agrees with the closed form (VC-DYN-07 third value)', () => {
    const white: AsdPoint[] = [
      [1e-4, 0.04],
      [1e6, 0.04],
    ];
    const basis: ModalBasis = { omega: [2 * Math.PI * 100], dampingA: [0], dampingB: [2 * 0.05 * 2 * Math.PI * 100] };
    const grid = integrationGrid(white, [1e-4, 1e6], [{ fHz: 100, zeta: 0.05 }]);
    const component = { kind: 'absolute' as const, unity: true, scale: 1 };
    near(rmsOf(meanSquare(modalForms(basis, grid), Float64Array.of(1), component), component), values('VC-DYN-07')[2] ?? 0, 1e-6);
  });

  it('3-sigma exceedance and the named peak-factor default (VC-DYN-09, VC-DYN-41)', () => {
    near(gaussianExceedance(3), values('VC-DYN-09')[0] ?? 0, 1e-9);
    expect(peakFactorOf(undefined, undefined)).toEqual(
      vc('VC-DYN-41').value && (vc('VC-DYN-41').value as { peakFactor: unknown }).peakFactor,
    );
    expect(DEFAULT_PEAK_FACTOR.defaulted).toBe(true);
    expect(peakFactorOf(4, undefined)).toMatchObject({ value: 4, defaulted: false, source: 'set by the caller' });
    expect(peakFactorOf(4, undefined).rationale).toContain('0.00633');
  });
});

describe('PSD integration (VC-DYN-10)', () => {
  it('GEVS qualification and acceptance grms, slopes and band clipping', () => {
    const [qual, accept] = values('VC-DYN-10');
    near(integrateAsd(GEVS_QUAL).rms, qual ?? 0, 1e-9);
    near(integrateAsd(GEVS_ACC).rms, accept ?? 0, 1e-9);
    const segments = integrateAsd(GEVS_QUAL).segments;
    expect(segments.map((s) => Math.round(s.slopeDbPerOct * 100) / 100)).toEqual([5.97, 0, -5.97]);
    const clipped = integrateAsd(GEVS_QUAL, [100, 400]);
    near(clipped.total, 0.16 * 300, 1e-12);
    expect(asdAt(GEVS_QUAL, 10)).toBe(0);
    const minusOne: AsdPoint[] = [
      [10, 1],
      [100, 0.1],
    ];
    near(integrateAsd(minusOne).total, 10 * Math.log(10), 1e-12);
  });

  it('refuses malformed breakpoints', () => {
    expect(spectrumProblem([[10, 1]])?.message).toContain('at least 2');
    expect(
      spectrumProblem([
        [10, 1],
        [5, 1],
      ])?.index,
    ).toBe(1);
    expect(
      spectrumProblem([
        [10, 1],
        [20, 0],
      ])?.message,
    ).toContain('level > 0');
    expect(
      spectrumProblem([
        [10, 1],
        [20, Number.NaN],
      ])?.message,
    ).toContain('finite');
    expect(spectrumProblem(GEVS_QUAL)).toBeNull();
  });
});

describe('shock response spectrum (VC-DYN-13, 14)', () => {
  it('Smallwood maximax of the 11 ms half-sine within 0.5 % of the exact solution, and the low-frequency asymptote', () => {
    const freqs = [10, 20, 31.5, 50, 80, 100, 160, 250, 400, 630, 1000, 2000];
    values('VC-DYN-13').forEach((v, i) => near(halfSineSrs(freqs[i] ?? 0, 10, 1, 0.011).maximax, v, 0.005));
    const dv = (2 * 1 * 0.011) / Math.PI;
    near(halfSineSrs(1, 10, 1, 0.011).maximax / (2 * Math.PI * dv), values('VC-DYN-14')[0] ?? 0, 0.02);
  });

  it('a sampled history gives the same spectrum as the generated pulse; octave frequencies', () => {
    const dt = 0.011 / 2000;
    const samples = Array.from({ length: 2001 }, (_, i) => Math.sin((Math.PI * i * dt) / 0.011));
    const fromHistory = historySrs(400, 10, samples, dt);
    near(fromHistory.maximax, halfSineSrs(400, 10, 1, 0.011).maximax, 1e-3);
    expect(fromHistory.positive).toBeGreaterThan(fromHistory.negative);
    expect(octaveFrequencies(10, 80, 1)).toEqual([10, 20, 40, 80]);
  });
});

describe('Euler-Bernoulli strip on the GEVS ASD (VC-DYN-21)', () => {
  it('tip absolute acceleration, tip relative displacement and root stress rms match the generator within 1e-6', () => {
    const modes = ebModes(6);
    values('VC-DYN-21');
    const g0 = 9806.65;
    const basis: ModalBasis = {
      omega: modes.map((m) => m.omega),
      dampingA: modes.map(() => 0),
      dampingB: modes.map((m) => 2 * 0.02 * m.omega),
    };
    const grid = integrationGrid(
      GEVS_QUAL,
      [20, 2000],
      modes.map((m) => ({ fHz: m.fHz, zeta: 0.02 })),
    );
    const job = {
      nodeCount: 2,
      modes: 6,
      sources: 2,
      basis,
      gamma: modes.map((m) => m.gamma),
      grid,
      components: [
        { source: 0, kind: 'absolute' as const, unity: true, scale: 1 },
        { source: 0, kind: 'relative' as const, unity: false, scale: g0 },
        { source: 1, kind: 'relative' as const, unity: false, scale: g0 },
      ],
    };
    const modal = new Float64Array(2 * 6 * 2);
    modes.forEach((m, j) => {
      modal[j * 2] = m.tip;
      modal[j * 2 + 1] = m.rootStress;
    });
    const field = nodalRmsReference(job, modal);
    const [acc, disp, stress] = values('VC-DYN-21');
    near(field[0] ?? 0, acc ?? 0, 1e-6);
    near(field[1] ?? 0, disp ?? 0, 1e-6);
    near(field[2] ?? 0, stress ?? 0, 1e-6);
    near(field[3] ?? 0, integrateAsd(GEVS_QUAL).rms, 1e-9);
    expect(Array.from(field.subarray(4))).toEqual([0, 0]);
  });
});
