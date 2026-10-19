/**
 * PHY-09 results: the random-response summary through record_fea_results on the Euler-Bernoulli strip (VC-DYN-21 to the generator's
 * quadrature accuracy, since the modal data are exact), the nodal rms field and its maxima, effective-mass bookkeeping, post-solve checks,
 * and the frequency-response peaks of complex steady-state sets.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeResultsArtifact } from '@core/model/analysis';
import type { DynamicSummary } from '@core/model/structuralDynamics';
import { analysisInputHash } from '@cae/hash/inputHash';
import { resultsSummary } from '@cae/results/summary';
import { reciprocal } from '@cae/dynamics/math/sdof';
import { mustRun, readyRandomStrip, SOURCE, strip } from './fixtures';
import { modalResults, recordSolved, solvedRandom, stripMesh } from './solvedFixtures';

const VC21 = (
  JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../../docs/physics/09-structural-dynamics/validation/expected_results.json'), 'utf8'),
  ) as { cases: { id: string; value: number[]; effectiveMassFraction: number[] }[] }
).cases.find((entry) => entry.id === 'VC-DYN-21');

function withProbes(): ReturnType<typeof readyRandomStrip> {
  const ready = readyRandomStrip();
  let doc = ready.doc;
  const { analysisId } = ready;
  doc = mustRun(doc, 'add_result_probe', { analysisId, name: 'tip', point: [100, 10, 1.5], quantity: 'a_z' });
  doc = mustRun(doc, 'add_result_probe', { analysisId, name: 'tip_rel', point: [100, 10, 1.5], quantity: 'u_z_rel' });
  doc = mustRun(doc, 'add_result_probe', { analysisId, name: 'root_top', point: [0, 10, 3], quantity: 's_xx' });
  doc = mustRun(doc, 'add_result_probe', { analysisId, name: 'side', point: [100, 10, 1.5], quantity: 'a_x' });
  return { ...ready, doc };
}

const summaryOf = (doc: ReturnType<typeof withProbes>['doc'], analysisId: string): DynamicSummary => {
  const found = doc.analysis?.cases[analysisId]?.results?.dynamics;
  if (found === undefined) throw new Error('no dynamic summary');
  return found;
};

describe('random_response summary (VC-DYN-21 on exact EB modal data)', () => {
  const ready = withProbes();
  const solved = solvedRandom(ready.doc, ready.analysisId, ready.boxId);

  it('records verified results whose probes reproduce the generator rms (1e-6) with the named 3-sigma peak', () => {
    const summary = summaryOf(solved.doc, ready.analysisId);
    const [acc, disp, stress] = VC21?.value ?? [];
    const byName = new Map(summary.probes.map((probe) => [probe.probe, probe]));
    const rms = (name: string): number => {
      const probe = byName.get(name);
      return probe?.kind === 'random' ? probe.rms : Number.NaN;
    };
    expect(Math.abs(rms('tip') / (acc ?? 0) - 1)).toBeLessThan(1e-6);
    expect(Math.abs(rms('tip_rel') / (disp ?? 0) - 1)).toBeLessThan(1e-6);
    expect(Math.abs(rms('root_top') / (stress ?? 0) - 1)).toBeLessThan(1e-6);
    expect(rms('side')).toBe(0);
    expect(byName.get('tip')).toMatchObject({ unit: 'g', peakFactor: { value: 3, defaulted: true } });
    expect(byName.get('root_top')).toMatchObject({ unit: 'MPa' });
    const tip = byName.get('tip');
    expect(tip?.kind === 'random' && tip.zeroUpcrossingHz).toBeGreaterThan(251);
    expect(summary).toMatchObject({ type: 'random_response', modesKept: 6, unverified: true, reviewRequired: true });
    expect(summary.unverifiedReasons.some((reason) => reason.startsWith('DYN_SPECTRUM_UNVERIFIED'))).toBe(true);
    expect(summary.dampingPerMode.map((entry) => entry.zeta)).toEqual([0.02, 0.02, 0.02, 0.02, 0.02, 0.02]);
    expect(summary.massParticipation.z).toBeCloseTo(
      (VC21?.effectiveMassFraction ?? []).reduce((a, b) => a + b, 0),
      9,
    );
  });

  it('stores the nodal rms field and reports the maxima per component (tip for u_z_rel / a_z, root for s_xx)', () => {
    const summary = summaryOf(solved.doc, ready.analysisId);
    expect(summary.nodalField).toMatchObject({ engine: 'ts', nodes: solved.mesh.nodes.length });
    const max = new Map((summary.nodalMax ?? []).map((entry) => [entry.quantity, entry]));
    expect([...max.keys()]).toEqual(['u_x_rel', 'u_y_rel', 'u_z_rel', 'a_x', 'a_y', 'a_z', 's_xx', 's_yy', 's_zz', 's_xy', 's_yz', 's_zx']);
    expect(max.get('a_z')?.at[0]).toBe(100);
    expect(max.get('u_z_rel')?.unit).toBe('mm');
    expect(Math.abs((max.get('u_z_rel')?.rms ?? 0) / (VC21?.value[1] ?? 1) - 1)).toBeLessThan(1e-6);
    expect(max.get('s_xx')?.at[0]).toBe(0);
    expect(max.get('a_x')?.rms).toBe(0);
  });

  it('post-solve checks: review pending, truncation and band rules, staleness after a damping change', () => {
    const { analysisId } = ready;
    const items = (doc: typeof solved.doc, ctx = solved.ctx): string[] =>
      ((execute(doc, 'check_structural_dynamics', { analysisId }, ctx).data as { items: { code: string }[] }).items ?? []).map(
        (i) => i.code,
      );
    expect(items(solved.doc)).toEqual(['DYN_SPECTRUM_UNVERIFIED', 'DYN_TRUNCATION_THRESHOLD_UNSET', 'DYN_REVIEW_PENDING']);
    const changed = mustRun(solved.doc, 'set_dynamic_damping', {
      analysisId,
      model: 'modal',
      ratios: [{ fromMode: 1, toMode: 6, zeta: 0.05 }],
      source: SOURCE,
    });
    expect(items(changed)).toContain('DYN_RESULTS_STALE');
    const strict = mustRun(ready.doc, 'set_dynamic_basis', { analysisId, modalTruncationThreshold: 0.95, fMaxHz: 1000 });
    const resolved = solvedRandom(strict, analysisId, ready.boxId);
    expect(items(resolved.doc, resolved.ctx)).toEqual([
      'DYN_SPECTRUM_UNVERIFIED',
      'DYN_BAND_ABOVE_MODES',
      'DYN_MODAL_TRUNCATION',
      'DYN_REVIEW_PENDING',
    ]);
    expect(summaryOf(resolved.doc, analysisId).modesKept).toBe(1);
  });

  it('a summary that cannot be post-processed (no damping) is recorded empty and unverified', () => {
    const bare = strip();
    const mesh = stripMesh(bare.doc, bare.analysisId, bare.boxId);
    const solvedBare = recordSolved(bare.doc, bare.analysisId, mesh, (meshHash) => ({
      kind: 'fe_results',
      meshHash,
      inputHash: analysisInputHash(bare.doc, bare.analysisId, 'full'),
      solver: 'calculix',
      solverVersion: 'test',
      ...modalResults(mesh, 2),
    }));
    expect(summaryOf(solvedBare.doc, bare.analysisId)).toMatchObject({
      modesKept: 0,
      unverified: true,
      unverifiedReasons: ['DYN_DAMPING_UNSET: the case has no damping'],
    });
  });
});

describe('frequency_response summary', () => {
  it('peaks, phases, nearest modes and the half-power Q of complex steady-state sets (DISP + DISPI)', () => {
    const base = strip({ type: 'frequency_response', modes: 2 });
    let doc = mustRun(base.doc, 'set_dynamic_damping', {
      analysisId: base.analysisId,
      model: 'modal',
      ratios: [{ fromMode: 1, toMode: 2, zeta: 0.05 }],
      source: { citation: 't', grade: 'A' },
    });
    doc = mustRun(doc, 'set_frequency_sweep', { analysisId: base.analysisId, fMinHz: 150, fMaxHz: 400, pointsPerInterval: 30, bias: 1 });
    doc = mustRun(doc, 'add_result_probe', { analysisId: base.analysisId, name: 'tip', point: [100, 10, 1.5], quantity: 'u_z' });
    doc = mustRun(doc, 'add_result_probe', { analysisId: base.analysisId, name: 'root', point: [0, 10, 3], quantity: 's_xx' });
    const mesh = stripMesh(doc, base.analysisId, base.boxId);
    const modal = modalResults(mesh, 2);
    const f1 = (modal.steps[0]?.time ?? 0) as number;
    const frequencies = Array.from({ length: 201 }, (_, i) => 150 + i * 1.25);
    const ssd = frequencies.map((f) => {
      const g = reciprocal(1 - (f / f1) ** 2, 2 * 0.05 * (f / f1));
      const real: Record<string, number[]> = {};
      const imaginary: Record<string, number[]> = {};
      const stressRe: Record<string, number[]> = {};
      const stressIm: Record<string, number[]> = {};
      for (const [id] of mesh.nodes) {
        const shape = modal.steps[0]?.fields['DISP']?.values[String(id)]?.[2] ?? 0;
        const sxx = modal.steps[0]?.fields['STRESS']?.values[String(id)]?.[0] ?? 0;
        real[String(id)] = [0, 0, shape * g.re];
        imaginary[String(id)] = [0, 0, shape * g.im];
        stressRe[String(id)] = [sxx * g.re, 0, 0, 0, 0, 0];
        stressIm[String(id)] = [sxx * g.im, 0, 0, 0, 0, 0];
      }
      const six = ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'];
      return {
        step: 2,
        time: f,
        fields: {
          DISP: { components: ['D1', 'D2', 'D3'], values: real },
          DISPI: { components: ['D1', 'D2', 'D3'], values: imaginary },
          STRESS: { components: six, values: stressRe },
          STRESSI: { components: six, values: stressIm },
        },
      };
    });
    const solved = recordSolved(doc, base.analysisId, mesh, (meshHash) => ({
      kind: 'fe_results',
      meshHash,
      inputHash: analysisInputHash(doc, base.analysisId, 'full'),
      solver: 'calculix',
      solverVersion: 'test',
      dat: modal.dat,
      steps: [...modal.steps, ...ssd],
    }));
    const summary = summaryOf(solved.doc, base.analysisId);
    expect(summary.frequencyPointsHz).toHaveLength(201);
    const tip = summary.probes[0];
    expect(tip?.kind).toBe('frf');
    if (tip?.kind !== 'frf') return;
    expect(tip.peaks).toHaveLength(1);
    expect(tip.peaks[0]?.mode).toBe(1);
    expect(Math.abs((tip.peaks[0]?.fHz ?? 0) / (f1 * Math.sqrt(1 - 2 * 0.05 ** 2)) - 1)).toBeLessThan(0.005);
    expect(tip.peaks[0]?.phaseDeg).toBeLessThan(-80);
    expect(tip.qHalfPower).toBeGreaterThan(9.7);
    expect(tip.qHalfPower).toBeLessThan(10.3);
    expect(summary.probes[1]).toMatchObject({ kind: 'frf', unit: 'MPa' });
    expect(summary.unverified).toBe(false);
    const recomputed = resultsSummary(solved.doc, base.analysisId, mesh, solved.results as FeResultsArtifact, solved.resultsHash);
    expect(recomputed.dynamics).toEqual(summary);
  });
});
