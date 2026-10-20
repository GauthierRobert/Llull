/** fe_explicit artifact, record_explicit_results (trust model), explicit_report and explicit_energy_check (VC-EXP-40/41/60/61/64/65). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ExplicitResultsSummary, FeExplicitArtifact } from '@core/model/explicit';
import type { CadDocument } from '@core/model/types';
import { buildExplicitArtifact, buildExplicitJob, explicitSummary, type ExplicitJob } from '@cae/index';
import { artifactStore, barModel, code, contextWith, data, must } from './support';

const model = barModel({ size: 5 });

function jobOf(doc: CadDocument): ExplicitJob {
  const built = buildExplicitJob(doc, model.analysisId, null);
  if (!built.ok) throw new Error(built.message);
  return built.job;
}

/** A synthetic run: KE 392.5 mJ turned into internal energy, a 1 % hourglass share, one wall force pulse, peak stress in element 7. */
function syntheticRun(job: ExplicitJob, overrides: Record<string, unknown> = {}): { text: string; fields: Float64Array } {
  const elements = job.mesh.hex8.length / 8;
  const fields = new Float64Array(6 * elements);
  for (let element = 0; element < elements; element++) {
    fields[6 * element] = element === 7 ? 396 : 10;
    fields[6 * element + 1] = element === 9 ? 0.02 : 0;
    fields[6 * element + 3] = 2.5;
    fields[6 * element + 4] = 2.5;
    fields[6 * element + 5] = 2.5 + 5 * element;
  }
  const result = {
    version: 1,
    termination: 'normal',
    message: '',
    cycles: 465,
    finalTime: 1.6e-4,
    minTimeStep: 3.4e-7,
    initialMass: 1.57e-4,
    addedMass: 0,
    device: 'cpu',
    deterministic: true,
    energy: [
      [0, 7.85, 0, 0, 0, 0, 0],
      [8e-5, 0.1, 7.6, 0.07, 0.07, 0.02, 0],
      [1.6e-4, 7.7, 0.1, 0.0, 0.07, 0, 0],
    ],
    walls: [{ name: 'anvil', t: [4e-5, 8e-5, 1.2e-4], force: [39600, 39600, 0] }],
    ...overrides,
  };
  return { text: JSON.stringify(result), fields };
}

function artifactOf(doc: CadDocument, overrides: Record<string, unknown> = {}): FeExplicitArtifact {
  const job = jobOf(doc);
  const run = syntheticRun(job, overrides);
  const artifact = buildExplicitArtifact(job, run.text, run.fields, '0.1.0');
  if (typeof artifact === 'string') throw new Error(artifact);
  return artifact;
}

describe('buildExplicitArtifact and explicitSummary', () => {
  it('builds the artifact and a summary with energies, wall impulse and extremes', () => {
    const artifact = artifactOf(model.doc);
    expect(artifact.elements).toEqual({ hex8: 160, tet4: 0 });
    expect(artifact.solver).toEqual({ job: 'explicit', name: 'llull-explicit', version: '0.1.0', device: 'cpu', deterministic: true });
    const analysisCase = model.doc.analysis?.cases[model.analysisId];
    if (analysisCase === undefined) throw new Error('no case');
    const summary = explicitSummary(model.doc, analysisCase, artifact, 'h');
    if (typeof summary === 'string') throw new Error(summary);
    expect(summary.energy.initialKinetic).toBe(7.85);
    expect(summary.energy.errorFinal).toBeCloseTo((7.7 + 0.1 + 0.07 - 7.85) / 7.85, 12);
    expect(summary.energy.hourglassRatioMax).toBeCloseTo(0.07 / 7.6, 12);
    expect(summary.energy.contactRatioMax).toBeCloseTo(0.02 / 7.6, 12);
    expect(summary.energy.finalContact).toBe(0);
    expect(summary.maxVonMises).toEqual({ value: 396, unit: 'MPa', at: [2.5, 2.5, 37.5], element: 7 });
    expect(summary.maxPlasticStrain.element).toBe(9);
    expect(summary.walls['anvil']?.peakForce).toBe(39600);
    expect(summary.walls['anvil']?.impulse).toBeCloseTo(39600 * 8e-5, 9);
    expect(summary).toMatchObject({ reviewRequired: true, certificationEvidence: false, energyUnit: 'mJ', failedElements: 0 });
  });

  it('refuses outputs that break the job contract', () => {
    const job = jobOf(model.doc);
    const run = syntheticRun(job);
    expect(buildExplicitArtifact(job, 'nope', run.fields, '1')).toBe('result.json is not JSON');
    expect(buildExplicitArtifact(job, '3', run.fields, '1')).toBe('result.json is not an object');
    expect(buildExplicitArtifact(job, syntheticRun(job, { termination: 'odd' }).text, run.fields, '1')).toContain('lacks');
    expect(buildExplicitArtifact(job, syntheticRun(job, { energy: [[1, 2]] }).text, run.fields, '1')).toContain('lacks');
    expect(buildExplicitArtifact(job, syntheticRun(job, { walls: [{ name: 'a', t: [1], force: [] }] }).text, run.fields, '1')).toContain(
      'lacks',
    );
    expect(buildExplicitArtifact(job, run.text, new Float64Array(3), '1')).toContain('fields.f64 holds 3 values');
  });
});

describe('record_explicit_results', () => {
  const artifact = artifactOf(model.doc);
  const store = artifactStore();
  const hash = store.put(artifact);
  const ctx = contextWith(store.port);
  const recorded = must(model.doc, 'record_explicit_results', { analysisId: model.analysisId, artifactHash: hash }, ctx);
  const summary = recorded.document.analysis?.cases[model.analysisId]?.explicit?.results as ExplicitResultsSummary;

  it('records the summary recomputed from the artifact, purely', () => {
    const before = structuredClone(model.doc);
    must(model.doc, 'record_explicit_results', { analysisId: model.analysisId, artifactHash: hash }, ctx);
    expect(model.doc).toEqual(before);
    expect(summary.artifactHash).toBe(hash);
    expect(recorded.summary).toContain('normal termination after 465 cycles');
    expect(recorded.summary).toContain('review required');
    const again = must(model.doc, 'record_explicit_results', { analysisId: model.analysisId, artifactHash: hash, summary }, ctx);
    expect(again.document.analysis?.cases[model.analysisId]?.explicit?.results).toEqual(summary);
  });

  it('refuses invented numbers, unknown artifacts, stale inputs and wrong cases (VC-EXP-64, 65)', () => {
    const params = { analysisId: model.analysisId, artifactHash: hash };
    expect(code(execute(model.doc, 'record_explicit_results', { ...params, summary: { ...summary, cycles: 1 } }, ctx))).toBe(
      'EXP_SUMMARY_MISMATCH',
    );
    expect(code(execute(model.doc, 'record_explicit_results', { ...params, artifactHash: 'f'.repeat(64) }, ctx))).toBe(
      'EXP_ARTIFACT_NOT_FOUND',
    );
    const moved = must(model.doc, 'set_initial_velocity', {
      analysisId: model.analysisId,
      entityId: model.barId,
      velocity: { vector: [0, 0, -1], unit: 'm/s' },
    }).document;
    expect(code(execute(moved, 'record_explicit_results', params, ctx))).toBe('EXP_RESULT_STALE');
    expect(code(execute(model.doc, 'record_explicit_results', { ...params, analysisId: 'an-404' }, ctx))).toBe('FEA_ANALYSIS_NOT_FOUND');
    const tampered = { get: () => ({ ...artifact, cycles: 2 }) };
    expect(code(execute(model.doc, 'record_explicit_results', params, contextWith(tampered)))).toBe('EXP_SUMMARY_MISMATCH');
    const fresh = must(model.doc, 'create_analysis', { name: 'b', analysisType: 'explicit_dynamics' });
    expect(code(execute(fresh.document, 'record_explicit_results', { ...params, analysisId: fresh.affected[0] }, ctx))).toBe(
      'EXP_CONTROLS_MISSING',
    );
  });

  it('keeps a replayed summary without its artifact as unverified (state missing)', () => {
    const replay = must(
      model.doc,
      'record_explicit_results',
      { analysisId: model.analysisId, artifactHash: hash, summary },
      contextWith(null),
    );
    expect(replay.summary).toContain('UNVERIFIED');
    const report = must(replay.document, 'explicit_report', { analysisId: model.analysisId }, ctx);
    expect(data(report)['state']).toBe('missing');
    expect(data(report)['result']).toBeNull();
  });

  it('explicit_report shows verified numbers, thinned histories and the review flags (VC-EXP-61)', () => {
    const report = must(recorded.document, 'explicit_report', { analysisId: model.analysisId, maxPoints: 2 }, ctx);
    const view = data<{
      state: string;
      result: ExplicitResultsSummary;
      histories: { energy: { error: number }[]; walls: { t: number[] }[] };
      reviewRequired: boolean;
      certificationEvidence: boolean;
    }>(report);
    expect(view.state).toBe('solved');
    expect(view.result).toEqual(summary);
    expect(view.histories.energy).toHaveLength(2);
    expect(view.histories.walls[0]?.t).toEqual([4e-5, 1.2e-4]);
    expect(view.reviewRequired).toBe(true);
    expect(view.certificationEvidence).toBe(false);
    expect(report.summary).toContain('not approved');
    const unsolved = must(model.doc, 'explicit_report', { analysisId: model.analysisId }, ctx);
    expect(data(unsolved)['state']).toBe('unsolved');
    const untrusted = must(
      recorded.document,
      'explicit_report',
      { analysisId: model.analysisId },
      contextWith({ get: () => ({ ...artifact, cycles: 9 }) }),
    );
    expect(data(untrusted)['state']).toBe('untrusted');
    expect(code(execute(model.doc, 'explicit_report', { analysisId: 'an-404' }))).toBe('FEA_ANALYSIS_NOT_FOUND');
  });

  it('explicit_energy_check names the hourglass default and warns on unset limits (VC-EXP-40, 41, 60)', () => {
    const check = must(recorded.document, 'explicit_energy_check', { analysisId: model.analysisId }, ctx);
    const view = data<{ status: string; items: { code: string | null; limit: { value: number; defaulted: boolean } | null }[] }>(check);
    expect(view.status).toBe('warn');
    expect(view.items.map((item) => item.code)).toEqual([null, null, 'EXP_ENERGY_LIMIT_UNSET']);
    expect(view.items[1]?.limit).toMatchObject({ value: 0.1, defaulted: true });
    const strict = must(
      recorded.document,
      'explicit_energy_check',
      { analysisId: model.analysisId, hourglassLimit: 0.001, energyErrorLimit: 0.001, addedMassLimit: 0.1, contactLimit: 0.001 },
      ctx,
    );
    expect(data<{ status: string }>(strict).status).toBe('fail');
    expect(strict.summary).toContain('EXP_HOURGLASS_HIGH');
    expect(strict.summary).toContain('EXP_ENERGY_ERROR_HIGH');
    expect(strict.summary).toContain('EXP_CONTACT_ENERGY_HIGH');
    const loose = must(recorded.document, 'explicit_energy_check', { analysisId: model.analysisId, energyErrorLimit: 0.5 }, ctx);
    expect(data<{ status: string }>(loose).status).toBe('pass');
    expect(code(execute(model.doc, 'explicit_energy_check', { analysisId: model.analysisId }, ctx))).toBe('EXP_RESULTS_MISSING');
  });

  it('flags abnormal termination and added mass against the case limit', () => {
    const scaled = must(model.doc, 'set_explicit_controls', {
      analysisId: model.analysisId,
      endTime: { value: 0.00016, unit: 's' },
      historyInterval: { value: 1e-6, unit: 's' },
      mesh: { kind: 'structured_hex', size: 5 },
      massScaling: { mode: 'selective', targetTimeStep: { value: 1e-6, unit: 's' }, maxAddedMassRatio: 0.01 },
    }).document;
    const abnormal = artifactOf(scaled, { termination: 'abnormal', addedMass: 1e-5 });
    const own = artifactStore();
    const abnormalHash = own.put(abnormal);
    const done = must(
      scaled,
      'record_explicit_results',
      { analysisId: model.analysisId, artifactHash: abnormalHash },
      contextWith(own.port),
    );
    const check = must(
      done.document,
      'explicit_energy_check',
      { analysisId: model.analysisId, energyErrorLimit: 1 },
      contextWith(own.port),
    );
    expect(check.summary).toContain('EXP_ABNORMAL_TERMINATION');
    expect(check.summary).toContain('EXP_ADDED_MASS_HIGH');
    const noLimit = must(
      must(done.document, 'set_explicit_controls', {
        analysisId: model.analysisId,
        endTime: { value: 0.00016, unit: 's' },
        historyInterval: { value: 1e-6, unit: 's' },
        mesh: { kind: 'structured_hex', size: 5 },
      }).document,
      'explicit_report',
      { analysisId: model.analysisId },
      contextWith(own.port),
    );
    expect(data(noLimit)['state']).toBe('stale');
  });
});
