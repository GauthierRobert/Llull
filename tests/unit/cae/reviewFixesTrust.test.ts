/** Review fixes 4 and 6: recorded summaries and dispositions are claims, re-verified on read; replay without artifacts ends `missing`. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { AnalysisCase, HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { applyLiveCommand, documentHash, type LiveCommandEvent } from '@protocol/liveSync';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { withCase } from '@cae/shared/access';
import { stateOf } from '@cae/shared/state';
import { barDocument, portOf, solvedBar, type SolvedBar } from './deckFixtures';
import { caseIn } from './helpers';
import { machineContext, must } from './thermal/fixtures';
import { HOT_T, solvedWall } from './thermal/solved';
import { thermoFixture, withThermalSource } from './thermomech/fixtures';

const ctxOf = (bar: SolvedBar): ExecutionContext => ({ ...defaultContext(), feaArtifacts: bar.port });

function recordedBar(bar: SolvedBar): CadDocument {
  const meshed = execute(
    bar.doc,
    'record_fe_mesh',
    { analysisId: bar.analysisId, summary: meshSummary(bar.mesh, bar.meshHash) },
    ctxOf(bar),
  );
  const solved = execute(
    meshed.document,
    'record_fea_results',
    { analysisId: bar.analysisId, summary: resultsSummary(bar.doc, bar.analysisId, bar.mesh, bar.results, bar.resultsHash) },
    ctxOf(bar),
  );
  expect(solved.rejected).toBeUndefined();
  return solved.document;
}

const data = <T>(doc: CadDocument, command: string, params: Record<string, unknown>, ctx?: ExecutionContext): T =>
  execute(doc, command, params, ctx).data as T;

interface ReportData {
  state: string;
  mesh: unknown;
  results: unknown;
  problem: { code: string } | null;
  probes: unknown[];
}

const patchedCase = (doc: CadDocument, analysisId: string, patch: (analysisCase: AnalysisCase) => AnalysisCase): CadDocument =>
  withCase(doc, patch(caseIn(doc, analysisId)));

function limitedWall(): { wall: ReturnType<typeof solvedWall>; doc: CadDocument; rowId: string } {
  let limitId = '';
  const wall = solvedWall({}, 1, undefined, (fixture) => {
    const added = must(fixture.doc, 'add_temperature_limit', {
      analysisId: fixture.analysisId,
      name: 'max',
      entityId: fixture.boxId,
      max: { value: 150, unit: 'degC' },
      source: { citation: 'test' },
    });
    limitId = added.affected[0] ?? '';
    return { doc: added.document };
  });
  return { wall, doc: wall.solved, rowId: `${limitId}:max` };
}

describe('tampered and unverifiable summaries (review finding 4)', () => {
  it('fea_report recomputes from the artifact: a tampered results summary is untrusted and its numbers are withheld', () => {
    const bar = solvedBar();
    const solved = recordedBar(bar);
    const honest = data<ReportData>(solved, 'fea_report', { analysisId: bar.analysisId }, ctxOf(bar));
    expect(honest.state).toBe('solved');
    const tampered = patchedCase(solved, bar.analysisId, (analysisCase) => ({
      ...analysisCase,
      results: {
        ...analysisCase.results!,
        loadCases: analysisCase.results!.loadCases.map((lc) => ({ ...lc, maxVonMises: { ...lc.maxVonMises, value: 1 } })),
      },
    }));
    const report = execute(tampered, 'fea_report', { analysisId: bar.analysisId }, ctxOf(bar));
    expect(report.data).toMatchObject({ state: 'untrusted', results: null, probes: [], problem: { code: 'FEA_SUMMARY_MISMATCH' } });
    expect(report.summary).toContain('FEA_SUMMARY_MISMATCH');
    expect(JSON.stringify(report.data)).not.toContain('"value":1,');
    const check = data<{ state: string; status: string; items: { code: string }[] }>(
      tampered,
      'check_analysis',
      { analysisId: bar.analysisId },
      ctxOf(bar),
    );
    expect(check).toMatchObject({ state: 'untrusted', status: 'fail' });
    expect(check.items.map((item) => item.code)).toContain('FEA_SUMMARY_MISMATCH');
    const described = data<{ state: string; case: AnalysisCase }>(
      tampered,
      'describe_analysis',
      { analysisId: bar.analysisId },
      ctxOf(bar),
    );
    expect(described.state).toBe('untrusted');
    expect(described.case.results).toBeUndefined();
  });

  it('a tampered mesh summary is untrusted too, and so is a summary whose artifact content was altered', () => {
    const bar = solvedBar();
    const solved = recordedBar(bar);
    const inflated = patchedCase(solved, bar.analysisId, (analysisCase) => ({
      ...analysisCase,
      meshSummary: { ...analysisCase.meshSummary!, nodes: 9999 },
    }));
    expect(data<ReportData>(inflated, 'fea_report', { analysisId: bar.analysisId }, ctxOf(bar))).toMatchObject({
      state: 'untrusted',
      mesh: null,
      results: null,
    });
    const lying = { get: (hash: string) => (hash === bar.resultsHash ? { ...bar.results, solver: 'forged' } : bar.port.get(hash)) };
    const altered = data<ReportData>(solved, 'fea_report', { analysisId: bar.analysisId }, { ...defaultContext(), feaArtifacts: lying });
    expect(altered).toMatchObject({ state: 'untrusted', results: null, problem: { code: 'FEA_SUMMARY_MISMATCH' } });
  });

  it('without an artifact store the state is missing and no recorded number is shown', () => {
    const bar = solvedBar();
    const solved = recordedBar(bar);
    for (const ctx of [undefined, { ...defaultContext(), feaArtifacts: portOf() }]) {
      const report = data<ReportData>(solved, 'fea_report', { analysisId: bar.analysisId }, ctx);
      expect(report).toMatchObject({ state: 'missing', mesh: null, results: null, probes: [] });
      const check = data<{ state: string; items: { code: string }[] }>(solved, 'check_analysis', { analysisId: bar.analysisId }, ctx);
      expect(check.state).toBe('missing');
      expect(check.items.map((item) => item.code)).toEqual(['FEA_MESH_MISSING', 'FEA_RESULTS_MISSING']);
      const described = data<{ state: string; case: AnalysisCase }>(solved, 'describe_analysis', { analysisId: bar.analysisId }, ctx);
      expect(described.state).toBe('missing');
      expect(described.case.meshSummary).toBeUndefined();
      expect(described.case.results).toBeUndefined();
    }
    const listed = data<{ analyses: { state: string }[] }>(solved, 'describe_analysis', {});
    expect(listed.analyses[0]?.state).toBe('missing');
  });

  it('thermal read paths recompute the thermal summary: tampered -> untrusted, no store -> missing, numbers withheld', () => {
    const wall = solvedWall();
    const honest = data<{ state: string; maxT: { value: number } }>(
      wall.solved,
      'thermal_report',
      { analysisId: wall.analysisId },
      machineContext(),
    );
    expect(honest.state).toBe('solved');
    expect(honest.maxT.value).toBeCloseTo(HOT_T, 9);
    const tampered = patchedCase(wall.solved, wall.analysisId, (analysisCase) => ({
      ...analysisCase,
      results: {
        ...analysisCase.results!,
        thermal: { ...analysisCase.results!.thermal!, maxT: { ...analysisCase.results!.thermal!.maxT, value: 20 } },
      },
    }));
    const report = data<Record<string, unknown>>(tampered, 'thermal_report', { analysisId: wall.analysisId }, machineContext());
    expect(report).toMatchObject({ state: 'untrusted', problem: { code: 'FEA_SUMMARY_MISMATCH' } });
    expect(report).not.toHaveProperty('maxT');
    const check = data<{ state: string; items: { code: string }[] }>(
      tampered,
      'check_thermal',
      { analysisId: wall.analysisId },
      machineContext(),
    );
    expect(check.state).toBe('untrusted');
    expect(check.items.map((item) => item.code)).toContain('FEA_SUMMARY_MISMATCH');
    const withLimit = limitedWall();
    const tamperedLimits = patchedCase(withLimit.doc, withLimit.wall.analysisId, (analysisCase) => ({
      ...analysisCase,
      results: {
        ...analysisCase.results!,
        thermal: { ...analysisCase.results!.thermal!, maxT: { ...analysisCase.results!.thermal!.maxT, value: 20 } },
      },
    }));
    expect(
      execute(tamperedLimits, 'check_temperature_limits', { analysisId: withLimit.wall.analysisId }, machineContext()).error?.code,
    ).toBe('FEA_SUMMARY_MISMATCH');
    for (const ctx of [defaultContext(), { ...defaultContext(), feaArtifacts: portOf() }]) {
      const missing = data<Record<string, unknown>>(wall.solved, 'thermal_report', { analysisId: wall.analysisId }, ctx);
      expect(missing).toMatchObject({ state: 'missing' });
      expect(missing).not.toHaveProperty('maxT');
      const check2 = data<{ state: string }>(wall.solved, 'check_thermal', { analysisId: wall.analysisId }, ctx);
      expect(check2.state).toBe('missing');
    }
  });

  it('check_thermo_mechanical refuses a thermal source whose summary was tampered with, or cannot be verified', () => {
    const source = withThermalSource(thermoFixture());
    const ok = execute(
      source.fixture.doc,
      'check_thermo_mechanical',
      { analysisId: source.fixture.analysisId },
      { ...defaultContext(), feaArtifacts: source.artifacts },
    );
    expect((ok.data as { items: { code: string }[] }).items.map((item) => item.code)).not.toContain('FEA_SUMMARY_MISMATCH');
    const tampered = patchedCase(source.fixture.doc, source.thermalId, (analysisCase) => ({
      ...analysisCase,
      results: { ...analysisCase.results!, solver: 'forged' },
    }));
    const refused = execute(
      tampered,
      'check_thermo_mechanical',
      { analysisId: source.fixture.analysisId },
      { ...defaultContext(), feaArtifacts: source.artifacts },
    );
    expect((refused.data as { items: { code: string }[] }).items.map((item) => item.code)).toContain('FEA_SUMMARY_MISMATCH');
  });
});

describe('dispositions are re-verified through the signing port (review finding 4)', () => {
  const justification = 'accepted for the qualification test';
  const signer = (accept: boolean): HumanSignaturePort => ({
    verify: (signature) => (accept && signature === 'good' ? { signer: 'alice', signatureId: 'sig-7' } : null),
  });

  const rowOf = (result: ReturnType<typeof execute>, rowId: string): { disposition: unknown; unverifiedDisposition?: { reason: string } } =>
    (result.data as { rows: { rowId: string; disposition: unknown; unverifiedDisposition?: { reason: string } }[] }).rows.find(
      (row) => row.rowId === rowId,
    )!;

  it('a planted disposition without a verifiable signature keeps the row pending_human', () => {
    const { wall, doc, rowId } = limitedWall();
    const planted = patchedCase(doc, wall.analysisId, (analysisCase) => ({
      ...analysisCase,
      thermal: {
        ...analysisCase.thermal!,
        dispositions: {
          [rowId]: { decision: 'accepted', justification, resultsHash: wall.resultsHash, signer: 'alice', signatureId: 'sig-7' },
        },
      },
    }));
    for (const humanSignature of [null, signer(true), signer(false)]) {
      const result = execute(planted, 'check_temperature_limits', { analysisId: wall.analysisId }, { ...machineContext(), humanSignature });
      const row = rowOf(result, rowId);
      expect(row.disposition).toBe('pending_human');
      expect(row.unverifiedDisposition?.reason).toBeTruthy();
      const items = (result.data as { items: { code: string }[]; summary: { pendingHuman: number } }).items.map((item) => item.code);
      expect(items).toContain('THM_DISPOSITION_UNVERIFIED');
      expect(items).toContain('THM_DISPOSITION_PENDING');
    }
    // a stored signature that the port rejects is not counted either
    const forged = patchedCase(planted, wall.analysisId, (analysisCase) => ({
      ...analysisCase,
      thermal: {
        ...analysisCase.thermal!,
        dispositions: { [rowId]: { ...analysisCase.thermal!.dispositions[rowId]!, signature: 'forged' } },
      },
    }));
    const rejected = execute(
      forged,
      'check_temperature_limits',
      { analysisId: wall.analysisId },
      { ...machineContext(), humanSignature: signer(true) },
    );
    expect(rowOf(rejected, rowId).disposition).toBe('pending_human');
  });

  it('a disposition recorded through dispose_thermal_limit counts only where its signature verifies', () => {
    const { wall, doc, rowId } = limitedWall();
    const withSigner = { ...machineContext(), humanSignature: signer(true) };
    const recorded = execute(
      doc,
      'dispose_thermal_limit',
      { analysisId: wall.analysisId, rowId, decision: 'accepted', justification, signature: 'good' },
      withSigner,
    );
    expect(recorded.rejected).toBeUndefined();
    expect(
      rowOf(execute(recorded.document, 'check_temperature_limits', { analysisId: wall.analysisId }, withSigner), rowId).disposition,
    ).toMatchObject({ decision: 'accepted', signer: 'alice' });
    const elsewhere = execute(recorded.document, 'check_temperature_limits', { analysisId: wall.analysisId }, machineContext());
    expect(rowOf(elsewhere, rowId).disposition).toBe('pending_human');
    expect(rowOf(elsewhere, rowId).unverifiedDisposition?.reason).toContain('signing port');
  });
});

describe('replay without artifacts ends missing, not unmeshed (review finding 6)', () => {
  it('replay_history without a port keeps the recorded summaries flagged verified:false (state missing, numbers never read)', () => {
    const bar = solvedBar();
    const solved = recordedBar(bar);
    expect(solved.featureHistory.map((step) => step.name)).toContain('record_fe_mesh');
    const replayed = execute(solved, 'replay_history', {}, defaultContext());
    expect(replayed.rejected).toBeUndefined();
    const analysisCase = caseIn(replayed.document, bar.analysisId);
    expect(analysisCase.meshSummary).toMatchObject({ meshHash: bar.meshHash, verified: false });
    expect(analysisCase.results).toMatchObject({ resultsHash: bar.resultsHash, verified: false });
    expect(stateOf(replayed.document, analysisCase)).toBe('missing');
    expect(replayed.document.featureHistory.map((step) => step.name)).toEqual(solved.featureHistory.map((step) => step.name));
    // not even a machine that HAS the artifacts reads numbers from a flagged record
    const report = data<ReportData>(replayed.document, 'fea_report', { analysisId: bar.analysisId }, ctxOf(bar));
    expect(report).toMatchObject({ state: 'missing', mesh: null, results: null, probes: [] });
    // replayed where the store is, the same history verifies completely
    const again = execute(replayed.document, 'replay_history', {}, ctxOf(bar));
    expect(caseIn(again.document, bar.analysisId).results?.verified).toBeUndefined();
    expect(data<ReportData>(again.document, 'fea_report', { analysisId: bar.analysisId }, ctxOf(bar)).state).toBe('solved');
  });

  it('with a port and the artifacts the full checks still refuse a mismatching summary', () => {
    const bar = solvedBar();
    const forged = { ...meshSummary(bar.mesh, bar.meshHash), nodes: 9999 };
    const refused = execute(bar.doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: forged }, ctxOf(bar));
    expect(refused.rejected).toBe(true);
    expect(refused.error?.code).toBe('FEA_SUMMARY_MISMATCH');
  });

  it('a live replica without the store converges with the server (the verified flag is not part of the state hash)', () => {
    const bar = solvedBar();
    const summary = meshSummary(bar.mesh, bar.meshHash);
    const server = execute(bar.doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary }, ctxOf(bar));
    expect(server.rejected).toBeUndefined();
    const event: LiveCommandEvent = {
      epoch: 'e',
      seq: 1,
      name: 'record_fe_mesh',
      params: { analysisId: bar.analysisId, summary },
      stateHash: documentHash(server.document),
    };
    const replica = applyLiveCommand(bar.doc, 0, event);
    expect(replica.ok).toBe(true);
    if (replica.ok) expect(caseIn(replica.document, bar.analysisId).meshSummary?.verified).toBe(false);
    expect(applyLiveCommand(bar.doc, 0, { ...event, stateHash: 'other' })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('a bare analysis stays unmeshed (nothing recorded, nothing flagged)', () => {
    const bar = barDocument();
    expect(stateOf(bar.doc, caseIn(bar.doc, bar.analysisId))).toBe('unmeshed');
  });
});
