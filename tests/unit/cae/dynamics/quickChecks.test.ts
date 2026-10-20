/**
 * PHY-09 quick-check commands (sdof_response, psd_rms, damping_coefficients, shock_response_spectrum) and check_structural_dynamics:
 * the validation plan dyn_quick_checks (VC-DYN-01..14 through the registry), refusals (VC-DYN-42 codes) and purity.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { mustRun, readyRandomStrip, SOURCE, strip } from './fixtures';

const codeOf = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
type Data = Record<string, unknown>;
const dataOf = (result: ReturnType<typeof execute>): Data => result.data as Data;

const PLAN = path.resolve(__dirname, '../../../../docs/physics/09-structural-dynamics/validation/plans/dyn_quick_checks.plan.json');

describe('validation plan dyn_quick_checks', () => {
  it('runs every step through the registry and reproduces VC-DYN-01, 05, 10, 11 and 13', () => {
    const steps = JSON.parse(readFileSync(PLAN, 'utf8')) as { command: string; params: Record<string, unknown> }[];
    let doc = createEmptyDocument();
    const results = steps.map((step) => {
      const result = execute(doc, step.command, step.params);
      expect(result.rejected, `${step.command}: ${result.summary}`).not.toBe(true);
      doc = result.document;
      return result;
    });
    const [, psd, randomSdof, harmonic, srs, damping] = results.map((r) => (r.data ?? {}) as Data);
    expect(psd?.['grms']).toBeCloseTo(14.1356137191, 9);
    expect(psd?.['unverified']).toBe(true);
    expect(randomSdof?.['milesGrms']).toBeCloseTo(22.4199648656, 8);
    expect(Math.abs((randomSdof?.['exactGrms'] as number) / 22.4035959181 - 1)).toBeLessThan(1e-6);
    expect(randomSdof?.['answerOfRecord']).toBe('exact');
    expect(harmonic?.['amplificationAtFn']).toBeCloseTo(10, 9);
    expect((harmonic?.['halfPower'] as Data)['qEstimate']).toBeCloseTo(9.97484240779, 9);
    expect(((srs?.['maximax'] as number[])[4] ?? 0) / 1.64827469856).toBeCloseTo(1, 2);
    expect(damping?.['alpha']).toBeCloseTo(2.28479465716, 9);
    expect(((damping?.['zetaAt'] as Data[])[1] ?? {})['zeta']).toBeCloseTo(0.0114991914915, 12);
  });
});

describe('sdof_response', () => {
  const doc = createEmptyDocument();
  it('white noise: closed forms (VC-DYN-07, 08), the named 3-sigma peak, Miles beside it', () => {
    const result = execute(doc, 'sdof_response', { fnHz: 100, Q: 10, input: { kind: 'random', asdG2PerHz: 0.04 } });
    expect(dataOf(result)).toMatchObject({
      method: 'closed_form_white_noise',
      answerOfRecord: 'exact',
      peakFactor: { value: 3, defaulted: true },
    });
    expect(dataOf(result)['exactGrms']).toBeCloseTo(7.96618927735, 9);
    expect(dataOf(result)['relativeDisplacementRmsMm']).toBeCloseTo(0.196902338045, 11);
    expect(dataOf(result)['milesGrms']).toBeCloseTo(7.92665459521, 9);
    expect(result.summary).toContain('answer of record');
    const banded = execute(doc, 'sdof_response', {
      fnHz: 100,
      zeta: 0.05,
      input: { kind: 'random', asdG2PerHz: 0.04 },
      bandHz: [1e-4, 1e6],
    });
    expect(Math.abs((dataOf(banded)['exactGrms'] as number) / 7.96618927077 - 1)).toBeLessThan(1e-6);
    const inline = execute(doc, 'sdof_response', {
      fnHz: 200,
      zeta: 0.05,
      input: {
        kind: 'random',
        points: [
          [20, 0.026],
          [50, 0.16],
          [800, 0.16],
          [2000, 0.026],
        ],
      },
    });
    expect(Math.abs((dataOf(inline)['exactGrms'] as number) / 22.4035959181 - 1)).toBeLessThan(1e-6);
  });

  it('refuses missing / doubled / invalid damping (DYN_DAMPING_UNSET, DYN_DAMPING_INVALID) and bad inputs; is pure', () => {
    const before = JSON.stringify(doc);
    expect(codeOf(execute(doc, 'sdof_response', { fnHz: 100, input: { kind: 'harmonic' } }))).toBe('DYN_DAMPING_UNSET');
    expect(codeOf(execute(doc, 'sdof_response', { fnHz: 100, zeta: 0.1, Q: 5, input: { kind: 'harmonic' } }))).toBe('DYN_DAMPING_INVALID');
    expect(codeOf(execute(doc, 'sdof_response', { fnHz: 100, zeta: 1.2, input: { kind: 'harmonic' } }))).toBe('DYN_DAMPING_INVALID');
    expect(codeOf(execute(doc, 'sdof_response', { fnHz: 0, zeta: 0.1, input: { kind: 'harmonic' } }))).toBe('FEA_PARAM_INVALID');
    expect(codeOf(execute(doc, 'sdof_response', { fnHz: 10, zeta: 0.1, input: { kind: 'harmonic', asdG2PerHz: 1 } }))).toBe(
      'DYN_PARAM_NOT_APPLICABLE',
    );
    expect(codeOf(execute(doc, 'sdof_response', { fnHz: 10, zeta: 0.1, input: { kind: 'random' } }))).toBe('DYN_SPECTRUM_INVALID');
    expect(codeOf(execute(doc, 'sdof_response', { fnHz: 10, zeta: 0.1, input: { kind: 'random', spectrum: 'none' } }))).toBe(
      'DYN_SPECTRUM_UNKNOWN',
    );
    expect(codeOf(execute(doc, 'sdof_response', { fnHz: 10, zeta: 0.1, input: { kind: 'random', asdG2PerHz: -1 } }))).toBe(
      'DYN_SPECTRUM_INVALID',
    );
    expect(codeOf(execute(doc, 'sdof_response', { fnHz: 10, zeta: 0.1, input: { kind: 'random', asdG2PerHz: 1, spectrum: 'x' } }))).toBe(
      'DYN_SPECTRUM_INVALID',
    );
    expect(codeOf(execute(doc, 'sdof_response', { fnHz: 10, zeta: 0.1, input: { kind: 'random', asdG2PerHz: 1 }, bandHz: [5, 1] }))).toBe(
      'DYN_SPECTRUM_INVALID',
    );
    expect(
      codeOf(
        execute(doc, 'sdof_response', {
          fnHz: 10,
          zeta: 0.1,
          input: {
            kind: 'random',
            points: [
              [20, 1],
              [30, 1],
            ],
          },
          bandHz: [40, 50],
        }),
      ),
    ).toBe('DYN_SPECTRUM_INVALID');
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('psd_rms / damping_coefficients', () => {
  it('psd_rms by name and inline, with band and refusals', () => {
    const doc = mustRun(createEmptyDocument(), 'define_vibration_spectrum', { name: 'gevs_a', library: 'gevs_component_accept' });
    expect(dataOf(execute(doc, 'psd_rms', { spectrum: 'gevs_a' }))['grms']).toBeCloseTo(9.99538831703, 9);
    const banded = execute(doc, 'psd_rms', {
      points: [
        [10, 0.01],
        [100, 0.01],
      ],
      bandHz: [20, 50],
    });
    expect(dataOf(banded)).toMatchObject({ grade: null, unverified: true });
    expect(dataOf(banded)['totalG2']).toBeCloseTo(0.3, 14);
    expect(codeOf(execute(doc, 'psd_rms', {}))).toBe('DYN_SPECTRUM_INVALID');
    expect(codeOf(execute(doc, 'psd_rms', { points: [[10, 1]] }))).toBe('DYN_SPECTRUM_INVALID');
    expect(
      codeOf(
        execute(doc, 'psd_rms', {
          points: [
            [10, 1],
            [20, 1],
          ],
          bandHz: [1],
        }),
      ),
    ).toBe('DYN_SPECTRUM_INVALID');
  });

  it('damping_coefficients from coefficients and refusals', () => {
    const doc = createEmptyDocument();
    const known = execute(doc, 'damping_coefficients', { fromCoefficients: { alpha: 5000, beta: 0 }, fHz: [13096.03] });
    expect(((dataOf(known)['zetaAt'] as Data[])[0] ?? {})['zeta']).toBeCloseTo(5000 / (2 * 2 * Math.PI * 13096.03), 12);
    expect(codeOf(execute(doc, 'damping_coefficients', {}))).toBe('DYN_DAMPING_INVALID');
    expect(codeOf(execute(doc, 'damping_coefficients', { fromRatios: { f1Hz: 10, f2Hz: 5, zeta: 0.02 } }))).toBe('DYN_DAMPING_INVALID');
    expect(codeOf(execute(doc, 'damping_coefficients', { fromCoefficients: { alpha: -1, beta: 0 } }))).toBe('DYN_DAMPING_INVALID');
    expect(codeOf(execute(doc, 'damping_coefficients', { fromCoefficients: { alpha: 1, beta: 0 }, fHz: [0] }))).toBe('DYN_DAMPING_INVALID');
  });
});

describe('shock_response_spectrum', () => {
  it('history input by name and inline; octave frequencies; refusals (DYN_SAMPLING_TOO_COARSE, DYN_HISTORY_INVALID)', () => {
    const dt = 0.011 / 1000;
    const timeS = Array.from({ length: 1001 }, (_, i) => i * dt);
    const accelG = timeS.map((t) => Math.sin((Math.PI * t) / 0.011));
    const doc = mustRun(createEmptyDocument(), 'define_time_history', { name: 'pulse', unit: 'g', timeS, values: accelG, source: SOURCE });
    const byName = execute(doc, 'shock_response_spectrum', {
      input: { kind: 'history', history: 'pulse' },
      Q: 10,
      fMinHz: 50,
      fMaxHz: 400,
      octaveFraction: 1,
    });
    expect(dataOf(byName)['fHz']).toEqual([50, 100, 200, 400]);
    const inline = execute(doc, 'shock_response_spectrum', { input: { kind: 'history', timeS, accelG }, Q: 10, frequenciesHz: [80] });
    expect(((dataOf(inline)['maximax'] as number[])[0] ?? 0) / 1.64827469856).toBeCloseTo(1, 2);
    expect(
      codeOf(execute(doc, 'shock_response_spectrum', { input: { kind: 'history', timeS, accelG }, Q: 10, frequenciesHz: [20000] })),
    ).toBe('DYN_SAMPLING_TOO_COARSE');
    const uneven = [...timeS];
    uneven[3] = (uneven[3] ?? 0) + dt / 3;
    expect(
      codeOf(execute(doc, 'shock_response_spectrum', { input: { kind: 'history', timeS: uneven, accelG }, Q: 10, frequenciesHz: [80] })),
    ).toBe('DYN_HISTORY_INVALID');
    expect(
      codeOf(execute(doc, 'shock_response_spectrum', { input: { kind: 'history', history: 'none' }, Q: 10, frequenciesHz: [80] })),
    ).toBe('DYN_HISTORY_UNKNOWN');
    const notG = mustRun(doc, 'define_time_history', { name: 'force', unit: 'N', timeS: [0, 1], values: [0, 1], source: SOURCE });
    expect(
      codeOf(execute(notG, 'shock_response_spectrum', { input: { kind: 'history', history: 'force' }, Q: 10, frequenciesHz: [1] })),
    ).toBe('DYN_HISTORY_INVALID');
    expect(codeOf(execute(doc, 'shock_response_spectrum', { input: { kind: 'history' }, Q: 10, frequenciesHz: [80] }))).toBe(
      'DYN_HISTORY_INVALID',
    );
    expect(codeOf(execute(doc, 'shock_response_spectrum', { input: { kind: 'half_sine', peakG: 1 }, Q: 10, frequenciesHz: [80] }))).toBe(
      'DYN_HISTORY_INVALID',
    );
    expect(
      codeOf(
        execute(doc, 'shock_response_spectrum', { input: { kind: 'half_sine', peakG: 1, durationS: 0.01 }, Q: 0.2, frequenciesHz: [80] }),
      ),
    ).toBe('FEA_PARAM_INVALID');
    expect(codeOf(execute(doc, 'shock_response_spectrum', { input: { kind: 'half_sine', peakG: 1, durationS: 0.01 }, Q: 10 }))).toBe(
      'FEA_PARAM_INVALID',
    );
    expect(
      codeOf(
        execute(doc, 'shock_response_spectrum', { input: { kind: 'half_sine', peakG: 1, durationS: 0.01 }, Q: 10, frequenciesHz: [-1] }),
      ),
    ).toBe('FEA_PARAM_INVALID');
  });
});

describe('check_structural_dynamics (set-up items)', () => {
  it('lists the missing pieces of a bare random case and is clean apart from warnings once ready', () => {
    const bare = strip();
    const result = execute(bare.doc, 'check_structural_dynamics', { analysisId: bare.analysisId });
    const codes = (dataOf(result)['items'] as { code: string }[]).map((item) => item.code);
    expect(codes).toEqual(['DYN_DAMPING_UNSET', 'DYN_SWEEP_UNSET', 'DYN_BASE_UNSET', 'DYN_TRUNCATION_THRESHOLD_UNSET']);
    expect(dataOf(result)).toMatchObject({ status: 'error', state: 'unmeshed', reviewRequired: true });
    const ready = readyRandomStrip();
    const warnings = execute(ready.doc, 'check_structural_dynamics', { analysisId: ready.analysisId });
    expect(dataOf(warnings)).toMatchObject({ status: 'warning' });
    expect((dataOf(warnings)['items'] as { code: string }[]).map((item) => item.code)).toEqual([
      'DYN_SPECTRUM_UNVERIFIED',
      'DYN_TRUNCATION_THRESHOLD_UNSET',
    ]);
    const thresholded = mustRun(ready.doc, 'set_dynamic_basis', { analysisId: ready.analysisId, modalTruncationThreshold: 0.8 });
    const graded = mustRun(thresholded, 'define_vibration_spectrum', {
      name: 'flat',
      points: [
        [20, 0.01],
        [2000, 0.01],
      ],
      source: { citation: 'spec', grade: 'A' },
    });
    const flat = mustRun(graded, 'set_base_excitation', { analysisId: ready.analysisId, direction: 'z', spectrum: 'flat' });
    expect(dataOf(execute(flat, 'check_structural_dynamics', { analysisId: ready.analysisId }))).toMatchObject({ status: 'ok', items: [] });
  });

  it('frequency_response without load or base, structural damping without a loss factor, refusals', () => {
    const harmonic = strip({ type: 'frequency_response' });
    const structural = mustRun(harmonic.doc, 'set_dynamic_damping', { analysisId: harmonic.analysisId, model: 'structural_material' });
    const codes = (
      dataOf(execute(structural, 'check_structural_dynamics', { analysisId: harmonic.analysisId }))['items'] as { code: string }[]
    ).map((i) => i.code);
    expect(codes).toEqual(['DYN_MATERIAL_NO_DAMPING', 'DYN_SWEEP_UNSET', 'FEA_NO_LOADS']);
    expect(codeOf(execute(structural, 'check_structural_dynamics', { analysisId: 'nope' }))).toBe('FEA_ANALYSIS_NOT_FOUND');
    const statik = mustRun(structural, 'create_analysis', { name: 's', analysisType: 'static' });
    expect(codeOf(execute(statik, 'check_structural_dynamics', { analysisId: statik.analysis?.caseOrder.at(-1) ?? '' }))).toBe(
      'DYN_CASE_TYPE',
    );
  });
});
