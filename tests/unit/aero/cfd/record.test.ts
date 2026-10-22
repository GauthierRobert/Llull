/**
 * 12 CFD M2: `record_cfd_results` (trust model of 05 §4.1: the summary is recomputed from the stored bundle; stale inputs and tampered
 * summaries are refused; a replay without the bundle keeps the record unverified), `cfd_report` (trust + staleness, VC-CFD-52 stale after the
 * geometry moved), `parseFlowResult` / `flowResultArtifact` (the solver's coefficients are cross-checked), and the `flow` toolset.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CfdResultArtifact, CfdResultPort } from '@core/model/cfdResult';
import type { CadDocument } from '@core/model/types';
import type { CfdCase, CfdResultSummary } from '@aero/cfd/types';
import { buildFlowJob, type FlowJob } from '@aero/cfd/flowJob';
import { flowResultArtifact, parseFlowResult } from '@aero/cfd/flowResult';
import { cfdSummary } from '@aero/cfd/summary';
import { toolsetOf } from '@protocol/toolsets';
import { cfdPlugin } from '@aero/index';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { expectPure } from '../../../helpers/expectNoOp';
import { expectRefusal } from '../../../helpers/commandAssertions';
import { addBody, metreDocument, ok, withCase } from './fixtures';

const ball = addBody(metreDocument(), 'add_sphere', { radius: 0.5, position: [0, 0, 0] });
const base = withCase(ball.doc, [ball.id], {
  freestream: { speedMS: 1, air: { densityKgM3: 1, temperatureK: 288.15, viscosityPaS: 0.01 } },
  reference: { areaM2: 0.7853981634, lengthM: 1 },
  cellsPerReferenceLength: 8,
});
const caseOf = (doc: CadDocument): CfdCase => doc.cfd?.cases['c1'] as CfdCase;

function jobOf(doc: CadDocument): FlowJob {
  const built = buildFlowJob(doc, caseOf(doc), null, { maxSteps: 100 });
  if (!built.ok) throw new Error(built.message);
  return built.job;
}

/** A result.json consistent with the job (forces chosen, coefficients derived), as the solver would write it. */
function fakeResult(job: FlowJob, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { reference, flow } = job.caseJson;
  const q = 0.5 * flow.densityKgM3 * flow.speedMS ** 2;
  const totalN = [0.5, 0.01, 0.02];
  const momentNm = [0, 0.03, 0];
  return {
    version: 1,
    caseId: job.caseJson.caseId,
    solver: 'lbm',
    status: 'converged',
    converged: true,
    steps: 1200,
    averagedSteps: 400,
    samples: 20,
    timeS: 3.2,
    elapsedS: 1.5,
    device: 'cpu',
    deterministic: true,
    precision: 'f64',
    halfModel: false,
    memory: { bytesPerCell: 395, gpuBytesPerCell: 204, cpuBytesPerCell: 395, bytes: 2880 * 395 },
    grid: { nx: 20, ny: 12, nz: 12, cellM: 0.125, cells: 2880, fluidCells: 2800, solidCells: 33, oddRows: 0, originM: [-1, -0.75, -0.75] },
    lattice: {
      tau: 0.6,
      uLattice: 0.0577,
      nuLattice: 0.033,
      dtS: 0.0072,
      flowThroughSteps: 400,
      sampleEvery: 8,
      les: true,
      smagorinsky: 0.1,
      reynolds: 100,
    },
    forces: {
      totalN,
      momentNm,
      dragN: totalN[0],
      liftN: totalN[2],
      sideN: totalN[1],
      cd: (totalN[0] ?? 0) / (q * reference.areaM2),
      cl: (totalN[2] ?? 0) / (q * reference.areaM2),
      cs: (totalN[1] ?? 0) / (q * reference.areaM2),
      cm: momentNm.map((m) => m / (q * reference.areaM2 * reference.lengthM)),
      cdAM2: (totalN[0] ?? 0) / q,
      dynamicPressurePa: q,
      referenceAreaM2: reference.areaM2,
      referenceLengthM: reference.lengthM,
      dragAxis: [1, 0, 0],
      liftAxis: [0, 0, 1],
      sideAxis: [0, 1, 0],
    },
    perBody: [{ entityId: ball.id, forceN: totalN }],
    peaks: [
      { field: 'p', min: -0.6, max: 0.5, minAt: [0, 0.5, 0], maxAt: [-0.5, 0, 0], unit: 'Pa' },
      { field: 'speed', min: 0, max: 1.4, minAt: [0.5, 0, 0], maxAt: [0, 0.6, 0], unit: 'm/s' },
    ],
    probes: [{ pointM: [2, 0, 0], velocityMS: [0.8, 0, 0], speedMS: 0.8, pressurePa: -0.01 }],
    history: [{ step: 400, timeS: 1, dragN: 0.6, cd: 1.5, forceN: [0.6, 0, 0], change: null, phase: 'transient' }],
    settings: {},
    surface: 'surface.bin',
    slices: ['slice-0.bin'],
    notModelled: ['wall-resolved boundary layer'],
    warnings: [],
    ...overrides,
  };
}

interface Bundle {
  readonly artifact: CfdResultArtifact;
  readonly hash: string;
  readonly summary: CfdResultSummary;
  readonly ctx: ExecutionContext;
}

function bundleOf(doc: CadDocument, overrides: Record<string, unknown> = {}): Bundle {
  const job = jobOf(doc);
  const parsed = parseFlowResult(JSON.stringify(fakeResult(job, overrides)));
  if (typeof parsed === 'string') throw new Error(parsed);
  const artifact = flowResultArtifact(
    parsed,
    job,
    { surface: new Uint8Array([76, 76, 83, 70]), slices: [{ name: 'slice-0.bin', bytes: new Uint8Array(8) }] },
    '9.9.9',
  );
  if (typeof artifact === 'string') throw new Error(artifact);
  const hash = sha256Hex(canonicalJson(artifact));
  const port: CfdResultPort = { get: (key) => (key === hash ? artifact : null) };
  return { artifact, hash, summary: cfdSummary(caseOf(doc), artifact, hash), ctx: { ...defaultContext(), cfdResults: port } };
}

describe('record_cfd_results', () => {
  it('records the summary recomputed from the bundle (coefficients from the forces and the case reference) and is pure', () => {
    const { hash, summary, ctx } = bundleOf(base);
    expectPure(base, () => execute(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary }, ctx));
    const result = ok(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary }, ctx);
    expect(result.affected).toEqual(['c1']);
    const recorded = result.document.cfd?.results['c1'];
    expect(recorded).toEqual(summary);
    expect(recorded?.verified).toBe(true);
    expect(recorded?.forces.cd).toBeCloseTo(0.5 / (0.5 * 0.7853981634), 10);
    expect(recorded?.forces.cl).toBeCloseTo(0.02 / (0.5 * 0.7853981634), 10);
    expect(recorded?.forces.cdAM2).toBeCloseTo(1, 10);
    expect(recorded?.forces.cm[1]).toBeCloseTo(0.03 / (0.5 * 0.7853981634), 10);
    expect(recorded?.provenance.device).toEqual({ backend: 'cpu', name: 'cpu (f64, deterministic)', driver: '' });
    expect(result.summary).toContain('converged after 1200 steps');
    expect(result.summary).toContain('Cd 1.2732');
    // The summary is optional: the recomputed one is stored either way.
    expect(ok(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash }, ctx).document.cfd?.results['c1']).toEqual(summary);
  });

  it('keeps a replayed summary unverified when the bundle is not on this machine', () => {
    const { hash, summary } = bundleOf(base);
    const result = ok(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary }, defaultContext());
    expect(result.document.cfd?.results['c1']).toMatchObject({ ...summary, verified: false });
    expect(result.summary).toContain('UNVERIFIED');
  });

  it('refuses unknown cases, missing bundles, foreign or tampered bundles and stale inputs', () => {
    const { hash, summary, ctx, artifact } = bundleOf(base);
    expectRefusal(base, 'record_cfd_results', { caseId: 'nope', resultsHash: hash }, 'CFD_CASE_NOT_FOUND');
    const missing = execute(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash }, defaultContext());
    expect(missing).toMatchObject({ rejected: true, error: { code: 'CFD_RESULT_MISSING' } });
    const unknown = execute(base, 'record_cfd_results', { caseId: 'c1', resultsHash: 'f'.repeat(64) }, ctx);
    expect(unknown).toMatchObject({ rejected: true, error: { code: 'CFD_RESULT_MISSING' } });
    // A store that answers the wrong content for a hash.
    const liar: ExecutionContext = { ...defaultContext(), cfdResults: { get: () => ({ ...artifact, steps: 7 }) } };
    expect(execute(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash }, liar)).toMatchObject({
      rejected: true,
      error: { code: 'CFD_RESULT_HASH_MISMATCH' },
    });
    // A bundle of another case.
    const other = ok(base, 'create_cfd_case', {
      id: 'c2',
      entityIds: [ball.id],
      freestream: { speedMS: 1 },
      reference: { areaM2: 1, lengthM: 1 },
    }).document;
    expect(execute(other, 'record_cfd_results', { caseId: 'c2', resultsHash: hash }, ctx)).toMatchObject({
      rejected: true,
      error: { code: 'CFD_RESULT_HASH_MISMATCH' },
    });
    // A tampered summary.
    const tampered = { ...summary, forces: { ...summary.forces, cd: 0.1 } };
    const refused = execute(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary: tampered }, ctx);
    expect(refused).toMatchObject({ rejected: true, error: { code: 'CFD_RESULT_HASH_MISMATCH' } });
    expect(refused.summary).toContain('forces');
    // The case changed after the solve.
    const edited = ok(base, 'update_cfd_case', { caseId: 'c1', quality: 'fine', cellsPerReferenceLength: undefined }).document;
    expect(execute(edited, 'record_cfd_results', { caseId: 'c1', resultsHash: hash }, ctx)).toMatchObject({
      rejected: true,
      error: { code: 'CFD_INPUT_STALE' },
    });
    // The geometry moved after the solve.
    const moved = ok(base, 'move_entities', { ids: [ball.id], delta: [0.3, 0, 0] }).document;
    const stale = execute(moved, 'record_cfd_results', { caseId: 'c1', resultsHash: hash }, ctx);
    expect(stale).toMatchObject({ rejected: true, error: { code: 'CFD_INPUT_STALE' } });
    expect(stale.summary).toContain('flow surface changed');
  });
});

describe('cfd_report', () => {
  it('reports the trusted result with every section, filters sections, and refuses without a result', () => {
    expectRefusal(base, 'cfd_report', { caseId: 'c1' }, 'CFD_NO_RESULT');
    expectRefusal(base, 'cfd_report', { caseId: 'zz' }, 'CFD_CASE_NOT_FOUND');
    const { hash, summary, ctx } = bundleOf(base);
    const solved = ok(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary }, ctx).document;
    const report = ok(solved, 'cfd_report', { caseId: 'c1' }, ctx);
    const data = report.data as Record<string, unknown> & {
      forces: { cd: number };
      convergence: { history: unknown[]; averagedSteps: number };
      warnings: unknown[];
    };
    expect(data).toMatchObject({
      caseId: 'c1',
      resultsHash: hash,
      stale: false,
      staleReasons: [],
      verified: true,
      trusted: true,
      converged: true,
      solver: 'lbm',
      reviewRequired: false,
    });
    expect(data.forces.cd).toBeCloseTo(1.2732395, 6);
    expect(data.convergence.history).toHaveLength(1);
    expect(data.convergence.averagedSteps).toBe(400);
    expect(data['probes']).toHaveLength(1);
    expect(data['peaks']).toHaveLength(2);
    expect(data['provenance']).toMatchObject({ solverVersion: '9.9.9', steps: 1200 });
    expect(data.warnings).toEqual([]);
    expect(report.summary).toContain('cfd_report c1: Cd 1.2732');
    const only = ok(solved, 'cfd_report', { caseId: 'c1', include: ['forces'] }, ctx).data as Record<string, unknown>;
    expect(only['forces']).toBeDefined();
    expect(only['peaks']).toBeUndefined();
    expect(only['provenance']).toBeUndefined();
    expectPure(solved, () => execute(solved, 'cfd_report', { caseId: 'c1' }, ctx));
  });

  it('flags a stale result after the geometry moved (VC-CFD-52) and an unverifiable one without the bundle', () => {
    const { hash, summary, ctx } = bundleOf(base);
    const solved = ok(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary }, ctx).document;
    const moved = ok(solved, 'move_entities', { ids: [ball.id], delta: [0, 0.2, 0] }).document;
    const stale = ok(moved, 'cfd_report', { caseId: 'c1' }, ctx);
    const data = stale.data as { stale: boolean; staleReasons: string[]; trusted: boolean; warnings: Array<{ code: string }> };
    expect(data.stale).toBe(true);
    expect(data.staleReasons).toEqual(['the flow surface changed since the solve']);
    expect(data.trusted).toBe(true);
    expect(data.warnings.map((entry) => entry.code)).toEqual(['CFD_RESULT_STALE']);
    expect(stale.summary).toContain('STALE');
    const checked = ok(moved, 'check_cfd', {}).data as { cases: Array<{ result: string; warning: string[] }> };
    expect(checked.cases[0]).toMatchObject({ result: 'stale', warning: ['CFD_RESULT_STALE'] });
    const elsewhere = ok(solved, 'cfd_report', { caseId: 'c1' }, defaultContext()).data as {
      trusted: boolean;
      warnings: Array<{ code: string }>;
    };
    expect(elsewhere.trusted).toBe(false);
    expect(elsewhere.warnings.map((entry) => entry.code)).toEqual(['CFD_RESULT_MISSING']);
    const replayed = ok(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary }, defaultContext()).document;
    const unverified = ok(replayed, 'cfd_report', { caseId: 'c1' }, ctx).data as { verified: boolean; trusted: boolean };
    expect(unverified).toMatchObject({ verified: false, trusted: false });
  });
});

describe('result.json parsing and the artifact', () => {
  it('rejects malformed results and solver coefficients that disagree with the forces', () => {
    expect(parseFlowResult('{')).toBe('result.json is not JSON');
    expect(parseFlowResult('{"version":1}')).toContain('caseId');
    const job = jobOf(base);
    const parsed = parseFlowResult(JSON.stringify(fakeResult(job)));
    expect(typeof parsed).toBe('object');
    if (typeof parsed === 'string') throw new Error(parsed);
    const files = { surface: new Uint8Array(4), slices: [] };
    expect(flowResultArtifact({ ...parsed, caseId: 'other' }, job, files, '1')).toContain("case 'other'");
    expect(flowResultArtifact({ ...parsed, forces: { ...parsed.forces, cd: 9 } }, job, files, '1')).toContain('disagree');
    expect(flowResultArtifact({ ...parsed, forces: { ...parsed.forces, dynamicPressurePa: 7 } }, job, files, '1')).toContain(
      'dynamic pressure',
    );
    const artifact = flowResultArtifact(parsed, job, files, '1.2.3');
    expect(artifact).toMatchObject({
      kind: 'cfd_result',
      caseId: 'c1',
      solverVersion: '1.2.3',
      caseHash: job.caseHash,
      geometryHash: job.geometryHash,
      kernel: 'none',
    });
  });

  it('files the record and report commands in the flow toolset', () => {
    expect(toolsetOf('record_cfd_results')).toBe('flow');
    expect(toolsetOf('cfd_report')).toBe('flow');
  });
});

describe('record_cfd_results trust ladder (review follow-ups)', () => {
  it('refuses a partial or malformed unverified summary instead of keeping it', () => {
    const { hash, summary } = bundleOf(base);
    const partial = { resultsHash: hash, caseHash: summary.caseHash };
    const refused = execute(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary: partial }, defaultContext());
    expect(refused).toMatchObject({ rejected: true, error: { code: 'CFD_RESULT_MISSING' } });
    expect(refused.summary).toContain('not a complete CfdResultSummary');
    const invented = { ...summary, forces: { ...summary.forces, cd: 'huge' } };
    expect(execute(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary: invented }, defaultContext())).toMatchObject({
      rejected: true,
      error: { code: 'CFD_RESULT_MISSING' },
    });
    const extra = { ...summary, bonus: 1 };
    expect(execute(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary: extra }, defaultContext())).toMatchObject({
      rejected: true,
      error: { code: 'CFD_RESULT_MISSING' },
    });
    const foreign = { ...summary, caseId: 'c2' };
    expect(execute(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary: foreign }, defaultContext())).toMatchObject({
      rejected: true,
      error: { code: 'CFD_RESULT_MISSING' },
    });
    // The complete summary is kept, flagged, and survives the plugin's load validation.
    const kept = ok(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary }, defaultContext());
    expect(kept.document.cfd?.results['c1']).toEqual({ ...summary, verified: false });
    expect(cfdPlugin.document?.validate(kept.document as unknown as Record<string, unknown>)).toEqual([]);
    expect(ok(kept.document, 'cfd_report', { caseId: 'c1' }, defaultContext()).data).toMatchObject({ verified: false, trusted: false });
  });

  it('refuses a given summary with an extra key against the bundle (CFD_RESULT_HASH_MISMATCH names it)', () => {
    const { hash, summary, ctx } = bundleOf(base);
    const refused = execute(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary: { ...summary, extraKey: true } }, ctx);
    expect(refused).toMatchObject({ rejected: true, error: { code: 'CFD_RESULT_HASH_MISMATCH' } });
    expect(refused.summary).toContain('extraKey');
    const stripped = { ...summary } as Record<string, unknown>;
    delete stripped['peaks'];
    expect(execute(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary: stripped }, ctx)).toMatchObject({
      rejected: true,
      error: { code: 'CFD_RESULT_HASH_MISMATCH' },
    });
  });

  it('reports the drag along the free-stream axis, not the case-frame x force', () => {
    const { hash, summary, ctx } = bundleOf(base, {
      forces: {
        totalN: [0.3, 0.0, 0.4],
        momentNm: [0, 0, 0],
        dragN: 0.5,
        liftN: 0.0,
        sideN: 0.0,
        cd: 0.5 / (0.5 * 0.7853981634),
        cl: 0,
        cs: 0,
        cm: [0, 0, 0],
        cdAM2: 1,
        dynamicPressurePa: 0.5,
        referenceAreaM2: 0.7853981634,
        referenceLengthM: 1,
        dragAxis: [0.6, 0, 0.8],
        liftAxis: [-0.8, 0, 0.6],
        sideAxis: [0, 1, 0],
      },
    });
    const result = ok(base, 'record_cfd_results', { caseId: 'c1', resultsHash: hash, summary }, ctx);
    expect(result.summary).toContain('drag 0.5 N');
    expect(result.summary).not.toContain('drag 0.3');
  });
});
