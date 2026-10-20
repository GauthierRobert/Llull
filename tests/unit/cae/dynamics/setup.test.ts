/** PHY-09 set-up and library commands: happy paths, refusals with their DYN_* codes (VC-DYN-42), purity, staleness (VC-DYN-45). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { dynamicsErrors } from '@cae/dynamics/validate';
import { mustRun, readyRandomStrip, SOURCE, strip } from './fixtures';

const codeOf = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
const dynamicsOf = (doc: CadDocument, id: string): unknown => doc.analysis?.cases[id]?.dynamics;

describe('create_analysis with dynamic types', () => {
  it('creates frequency_response / random_response cases with a basis and refuses a missing one (DYN_BASIS_MISSING)', () => {
    const { doc, analysisId } = strip({ type: 'frequency_response', modes: 10 });
    expect(doc.analysis?.cases[analysisId]).toMatchObject({ type: 'frequency_response', modes: 10, dynamics: { basis: {} } });
    const empty = createEmptyDocument();
    expect(codeOf(execute(empty, 'create_analysis', { name: 'r', analysisType: 'random_response' }))).toBe('DYN_BASIS_MISSING');
    const byBand = execute(empty, 'create_analysis', { name: 'r', analysisType: 'random_response', fMaxHz: 3000 });
    expect(byBand.document.analysis?.cases[byBand.affected[0] ?? '']).toMatchObject({ modes: 100, dynamics: { basis: { fMaxHz: 3000 } } });
    expect(codeOf(execute(empty, 'create_analysis', { name: 's', analysisType: 'static', fMaxHz: 10 }))).toBe('FEA_PARAM_NOT_APPLICABLE');
    expect(codeOf(execute(empty, 'create_analysis', { name: 'r', analysisType: 'random_response', fMaxHz: -1 }))).toBe('FEA_PARAM_INVALID');
  });
});

describe('set_dynamic_damping', () => {
  it('stores modal, rayleigh and resolved rayleigh_from_ratios damping with their source', () => {
    const { doc, analysisId } = strip();
    const modal = execute(doc, 'set_dynamic_damping', {
      analysisId,
      model: 'modal',
      ratios: [{ fromMode: 1, toMode: 6, zeta: 0.02 }],
      source: SOURCE,
    });
    expect(modal.affected).toEqual([analysisId]);
    expect(modal.summary).toContain('modes 1-6 zeta 0.02');
    const ratios = execute(doc, 'set_dynamic_damping', {
      analysisId,
      model: 'rayleigh_from_ratios',
      f1Hz: 10,
      f2Hz: 100,
      zeta1: 0.02,
      source: SOURCE,
    });
    expect(dynamicsOf(ratios.document, analysisId)).toMatchObject({ damping: { model: 'rayleigh_from_ratios', zeta2: 0.02 } });
    const damping = (dynamicsOf(ratios.document, analysisId) as { damping: { alpha: number; beta: number } }).damping;
    expect(damping.alpha).toBeCloseTo(2.28479465716, 9);
    expect(damping.beta).toBeCloseTo(5.78745247607e-5, 14);
    const rayleigh = execute(doc, 'set_dynamic_damping', {
      analysisId,
      model: 'rayleigh',
      alpha: 5000,
      beta: 0,
      source: { citation: 'beamdy8', grade: 'A' },
    });
    expect(dynamicsOf(rayleigh.document, analysisId)).toMatchObject({
      damping: { model: 'rayleigh', alpha: 5000, beta: 0, source: { grade: 'A' } },
    });
    const structural = execute(doc, 'set_dynamic_damping', { analysisId, model: 'structural_material' });
    expect(dynamicsOf(structural.document, analysisId)).toMatchObject({
      damping: { model: 'structural_material', propertyName: 'structuralLossFactor' },
    });
  });

  it('refuses invalid damping, missing citations, stray parameters and non-dynamic cases; is pure', () => {
    const { doc, analysisId } = strip();
    const before = JSON.stringify(doc);
    const bad = [
      { model: 'modal', ratios: [{ fromMode: 1, toMode: 6, zeta: 1.2 }], source: SOURCE },
      { model: 'modal', ratios: [], source: SOURCE },
      { model: 'modal', ratios: [{ fromMode: 3, toMode: 2, zeta: 0.02 }], source: SOURCE },
      { model: 'rayleigh', alpha: -1, beta: 0, source: SOURCE },
      { model: 'rayleigh', alpha: 0, beta: 0, source: SOURCE },
      { model: 'rayleigh_from_ratios', f1Hz: 100, f2Hz: 10, zeta1: 0.02, source: SOURCE },
      { model: 'rayleigh_from_ratios', f1Hz: 10, f2Hz: 100, zeta1: 0.2, zeta2: 0.001, source: SOURCE },
      { model: 'rayleigh_from_ratios', f1Hz: 10, f2Hz: 100, zeta1: 1.5, source: SOURCE },
      { model: 'modal', ratios: [{ fromMode: 1, toMode: 1, zeta: 0.02 }], source: { citation: ' ' } },
    ];
    for (const params of bad) expect(codeOf(execute(doc, 'set_dynamic_damping', { analysisId, ...params }))).toBe('DYN_DAMPING_INVALID');
    expect(codeOf(execute(doc, 'set_dynamic_damping', { analysisId, model: 'modal', alpha: 1, source: SOURCE }))).toBe(
      'DYN_PARAM_NOT_APPLICABLE',
    );
    expect(codeOf(execute(doc, 'set_dynamic_damping', { analysisId: 'nope', model: 'structural_material' }))).toBe(
      'FEA_ANALYSIS_NOT_FOUND',
    );
    const statik = mustRun(doc, 'create_analysis', { name: 's', analysisType: 'static' });
    const staticId = statik.analysis?.caseOrder.at(-1) ?? '';
    expect(codeOf(execute(statik, 'set_dynamic_damping', { analysisId: staticId, model: 'structural_material' }))).toBe('DYN_CASE_TYPE');
    execute(doc, 'set_dynamic_damping', { analysisId, model: 'rayleigh', alpha: 1, beta: 0, source: SOURCE });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('set_frequency_sweep / set_base_excitation / set_dynamic_basis', () => {
  it('records the sweep with the CalculiX defaults named, and refuses bad bands (DYN_SWEEP_INVALID)', () => {
    const { doc, analysisId } = strip();
    const set = execute(doc, 'set_frequency_sweep', { analysisId, fMinHz: 20, fMaxHz: 2000 });
    expect(set.summary).toContain('CalculiX defaults: points 20, bias 3');
    expect(dynamicsOf(set.document, analysisId)).toMatchObject({ sweep: { fMinHz: 20, fMaxHz: 2000, pointsPerInterval: 20, bias: 3 } });
    for (const params of [
      { fMinHz: 0, fMaxHz: 10 },
      { fMinHz: 10, fMaxHz: 5 },
      { fMinHz: 1, fMaxHz: 5, pointsPerInterval: 1 },
      { fMinHz: 1, fMaxHz: 5, bias: 0.5 },
    ])
      expect(codeOf(execute(doc, 'set_frequency_sweep', { analysisId, ...params }))).toBe('DYN_SWEEP_INVALID');
  });

  it('base excitation: spectrum for random, amplitude for harmonic, a constraint on the DOF, a known spectrum', () => {
    const ready = readyRandomStrip();
    expect(dynamicsOf(ready.doc, ready.analysisId)).toMatchObject({ base: { kind: 'acceleration', direction: 'z', spectrum: 'gevs_q' } });
    const { doc, analysisId } = strip();
    expect(codeOf(execute(doc, 'set_base_excitation', { analysisId, direction: 'z', spectrum: 'nope' }))).toBe('DYN_SPECTRUM_UNKNOWN');
    expect(codeOf(execute(doc, 'set_base_excitation', { analysisId, direction: 'z', amplitudeG: 1 }))).toBe('DYN_BASE_INVALID');
    const loose = strip({ constraint: false });
    const withSpectrum = mustRun(loose.doc, 'define_vibration_spectrum', {
      name: 'w',
      points: [
        [10, 0.01],
        [100, 0.01],
      ],
      source: SOURCE,
    });
    expect(codeOf(execute(withSpectrum, 'set_base_excitation', { analysisId: loose.analysisId, direction: 'x', spectrum: 'w' }))).toBe(
      'DYN_BASE_NO_CONSTRAINT',
    );
    const harmonic = strip({ type: 'frequency_response' });
    const ok = execute(harmonic.doc, 'set_base_excitation', { analysisId: harmonic.analysisId, direction: 'x', amplitudeG: 2 });
    expect(ok.summary).toContain('2 g harmonic');
    expect(codeOf(execute(harmonic.doc, 'set_base_excitation', { analysisId: harmonic.analysisId, direction: 'x', amplitudeG: 0 }))).toBe(
      'DYN_BASE_INVALID',
    );
  });

  it('set_dynamic_basis changes modes, fMaxHz and the truncation threshold; refuses empty / out-of-range values', () => {
    const { doc, analysisId } = strip();
    const set = execute(doc, 'set_dynamic_basis', { analysisId, modes: 12, fMaxHz: 3000, modalTruncationThreshold: 0.9 });
    expect(set.document.analysis?.cases[analysisId]).toMatchObject({
      modes: 12,
      dynamics: { basis: { fMaxHz: 3000 }, modalTruncationThreshold: 0.9 },
    });
    expect(codeOf(execute(doc, 'set_dynamic_basis', { analysisId }))).toBe('DYN_BASIS_MISSING');
    expect(codeOf(execute(doc, 'set_dynamic_basis', { analysisId, modes: 0 }))).toBe('FEA_PARAM_INVALID');
    expect(codeOf(execute(doc, 'set_dynamic_basis', { analysisId, fMaxHz: 0 }))).toBe('FEA_PARAM_INVALID');
    expect(codeOf(execute(doc, 'set_dynamic_basis', { analysisId, modalTruncationThreshold: 1.5 }))).toBe('FEA_PARAM_INVALID');
  });

  it('any change of damping, sweep, base or spectrum marks the results stale (VC-DYN-45 staleAfterDampingChange)', () => {
    const { doc, analysisId } = readyRandomStrip();
    const hash = analysisInputHash(doc, analysisId, 'full');
    const changedDamping = mustRun(doc, 'set_dynamic_damping', {
      analysisId,
      model: 'modal',
      ratios: [{ fromMode: 1, toMode: 6, zeta: 0.03 }],
      source: SOURCE,
    });
    expect(analysisInputHash(changedDamping, analysisId, 'full')).not.toBe(hash);
    expect(analysisInputHash(changedDamping, analysisId, 'mesh')).toBe(analysisInputHash(doc, analysisId, 'mesh'));
    const changedSweep = mustRun(doc, 'set_frequency_sweep', { analysisId, fMinHz: 20, fMaxHz: 1000 });
    expect(analysisInputHash(changedSweep, analysisId, 'full')).not.toBe(hash);
  });
});

describe('vibration library', () => {
  it('library spectra are grade B and unverified (VC-DYN-43); points need a citation; names unique and well formed', () => {
    const doc = createEmptyDocument();
    const gevs = execute(doc, 'define_vibration_spectrum', { name: 'gevs_q', library: 'gevs_component_qual' });
    expect(gevs.summary).toContain('14.1356 g rms');
    expect(gevs.summary).toContain('DYN_SPECTRUM_UNVERIFIED');
    expect(gevs.document.analysis?.vibration?.spectra['gevs_q']).toMatchObject({
      unverified: true,
      source: { grade: 'B' },
      library: 'gevs_component_qual',
    });
    const mine = execute(doc, 'define_vibration_spectrum', {
      name: 'flat',
      points: [
        [10, 0.01],
        [100, 0.01],
      ],
      unit: '(m/s2)2/Hz',
      source: { citation: 'spec', grade: 'A' },
    });
    expect(mine.document.analysis?.vibration?.spectra['flat']).toMatchObject({ unverified: false, unit: '(m/s2)2/Hz' });
    expect(codeOf(execute(gevs.document, 'define_vibration_spectrum', { name: 'gevs_q', library: 'gevs_component_accept' }))).toBe(
      'DYN_NAME_TAKEN',
    );
    expect(codeOf(execute(doc, 'define_vibration_spectrum', { name: 'Bad Name', library: 'gevs_component_accept' }))).toBe(
      'DYN_NAME_INVALID',
    );
    expect(
      codeOf(
        execute(doc, 'define_vibration_spectrum', {
          name: 'x',
          points: [
            [10, 1],
            [5, 1],
          ],
          source: SOURCE,
        }),
      ),
    ).toBe('DYN_SPECTRUM_INVALID');
    expect(
      codeOf(
        execute(doc, 'define_vibration_spectrum', {
          name: 'x',
          points: [
            [10, 1],
            [50, 1],
          ],
        }),
      ),
    ).toBe('DYN_SPECTRUM_INVALID');
    expect(codeOf(execute(doc, 'define_vibration_spectrum', { name: 'x' }))).toBe('DYN_SPECTRUM_INVALID');
    expect(codeOf(execute(doc, 'define_vibration_spectrum', { name: 'x', library: 'gevs_component_qual', unit: 'g2/Hz' }))).toBe(
      'DYN_SPECTRUM_INVALID',
    );
    const listed = execute(gevs.document, 'describe_vibration_library', {});
    expect(listed.data).toMatchObject({ spectra: [{ name: 'gevs_q' }], builtIn: ['gevs_component_qual', 'gevs_component_accept'] });
  });

  it('delete refuses a spectrum in use; histories define / delete with validation; the slice validates', () => {
    const { doc } = readyRandomStrip();
    expect(codeOf(execute(doc, 'delete_vibration_spectrum', { name: 'gevs_q' }))).toBe('DYN_SPECTRUM_IN_USE');
    expect(codeOf(execute(doc, 'delete_vibration_spectrum', { name: 'none' }))).toBe('DYN_SPECTRUM_UNKNOWN');
    const spare = mustRun(doc, 'define_vibration_spectrum', { name: 'spare', library: 'gevs_component_accept' });
    expect(execute(spare, 'delete_vibration_spectrum', { name: 'spare' }).document.analysis?.vibration?.spectrumOrder).toEqual(['gevs_q']);
    const history = execute(doc, 'define_time_history', {
      name: 'pulse',
      unit: 'g',
      timeS: [0, 0.001, 0.002],
      values: [0, 1, 0],
      source: SOURCE,
    });
    expect(history.affected).toEqual(['pulse']);
    expect(codeOf(execute(doc, 'define_time_history', { name: 'p', unit: 'g', timeS: [0, 0], values: [0, 1], source: SOURCE }))).toBe(
      'DYN_HISTORY_INVALID',
    );
    expect(codeOf(execute(doc, 'define_time_history', { name: 'p', unit: 'g', timeS: [0, 1], values: [0], source: SOURCE }))).toBe(
      'DYN_HISTORY_INVALID',
    );
    expect(
      codeOf(execute(doc, 'define_time_history', { name: 'p', unit: 'g', timeS: [0, 1], values: [0, 1], source: { citation: '' } })),
    ).toBe('DYN_HISTORY_INVALID');
    expect(
      codeOf(execute(history.document, 'define_time_history', { name: 'pulse', unit: 'g', timeS: [0, 1], values: [0, 1], source: SOURCE })),
    ).toBe('DYN_NAME_TAKEN');
    expect(execute(history.document, 'delete_time_history', { name: 'pulse' }).document.analysis?.vibration?.historyOrder).toEqual([]);
    expect(codeOf(execute(doc, 'delete_time_history', { name: 'pulse' }))).toBe('DYN_HISTORY_UNKNOWN');
    const raw = JSON.parse(JSON.stringify(history.document)) as Record<string, unknown>;
    expect(dynamicsErrors(raw)).toEqual([]);
    const broken = JSON.parse(JSON.stringify(raw)) as {
      analysis: { vibration: { spectra: { gevs_q: { points: unknown } } }; cases: Record<string, { dynamics?: unknown }> };
    };
    broken.analysis.vibration.spectra.gevs_q.points = [[1, 1]];
    for (const c of Object.values(broken.analysis.cases)) delete c.dynamics;
    expect(dynamicsErrors(broken as unknown as Record<string, unknown>).length).toBe(2);
  });
});

describe('add_result_probe on dynamic cases', () => {
  it('accepts the quantities of the case type and refuses the others (DYN_PROBE_QUANTITY)', () => {
    const { doc, analysisId } = strip();
    expect(execute(doc, 'add_result_probe', { analysisId, name: 'tip', point: [100, 10, 1.5], quantity: 'a_z' }).affected).toHaveLength(1);
    expect(codeOf(execute(doc, 'add_result_probe', { analysisId, name: 'tip', point: [100, 10, 1.5], quantity: 'von_mises' }))).toBe(
      'DYN_PROBE_QUANTITY',
    );
    const statik = mustRun(createEmptyDocument(), 'create_analysis', { name: 's', analysisType: 'static' });
    const staticId = statik.analysis?.caseOrder[0] ?? '';
    expect(codeOf(execute(statik, 'add_result_probe', { analysisId: staticId, name: 'p', point: [0, 0, 0], quantity: 'a_x' }))).toBe(
      'DYN_PROBE_QUANTITY',
    );
  });
});
