import type { CommandResult } from '@core/commands/types';
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, ResultsSummary } from '@core/model/analysis';
import { analysisInputHash } from '@cae/hash/inputHash';
import { withCase } from '@cae/shared/access';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { hashOf, portOf, thermoFixture, type Fixture } from './fixtures';

/** Plate z = 0 (nodes 1-5, centre node 5) and an apex node 6 above it; the centre lifts by 0.2 mm. */
function solved(): { fixture: Fixture; port: ReturnType<typeof portOf>; mesh: FeMeshArtifact } {
  const base = thermoFixture();
  const mesh: FeMeshArtifact = {
    ...base.mesh,
    nodes: [
      [1, 0, 0, 0],
      [2, 10, 0, 0],
      [3, 10, 10, 0],
      [4, 0, 10, 0],
      [5, 5, 5, 0],
      [6, 5, 5, 10],
    ],
    blocks: [
      {
        type: 'C3D4',
        entityId: base.boxId,
        elements: [
          [1, 1, 2, 3, 5],
          [2, 1, 3, 4, 5],
          [3, 1, 2, 5, 6],
        ],
      },
    ],
    nodeSets: { 'C_fc-1.1': [1, 2, 3, 4, 5], tiny: [1, 2] },
  };
  const displacement = { 1: [0, 0, 0], 2: [0, 0, 0], 3: [0, 0, 0], 4: [0, 0, 0], 5: [0, 0, 0.2], 6: [0.1, 0, 0.3] };
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: 'x',
    solver: 'ccx',
    solverVersion: '2',
    steps: [{ step: 1, time: 1, fields: { DISP: { components: ['D1', 'D2', 'D3'], values: displacement } } }],
  };
  const resultsHash = hashOf(results);
  const analysisCase = base.doc.analysis?.cases[base.analysisId] as AnalysisCase;
  const withArtifacts: AnalysisCase = {
    ...analysisCase,
    meshSummary: { meshHash: hashOf(mesh), inputHash: analysisInputHash(base.doc, base.analysisId, 'mesh') } as never,
    results: { resultsHash, inputHash: analysisInputHash(base.doc, base.analysisId, 'full') } as unknown as ResultsSummary,
  };
  return {
    fixture: { ...base, mesh, doc: withCase(base.doc, withArtifacts) },
    port: portOf({ [hashOf(mesh)]: mesh, [resultsHash]: results }),
    mesh,
  };
}

const report = (fixture: Fixture, port: ReturnType<typeof portOf> | null, params: Record<string, unknown>): CommandResult =>
  execute(
    fixture.doc,
    'thermal_distortion_report',
    { analysisId: fixture.analysisId, ...params },
    { ...defaultContext(), feaArtifacts: port },
  );

interface FaceRow {
  name: string;
  nodes: number;
  flatnessBefore: number;
  flatnessAfter: number;
  change: number;
  tolerance?: number;
  withinTolerance?: boolean;
  reviewRequired: boolean;
}

describe('thermal_distortion_report', () => {
  it('reports flatness before / after of a node-set face and of a plane-selected face, with tolerance', () => {
    const { fixture, port } = solved();
    const result = report(fixture, port, {
      faces: [
        { name: 'by set', targetKey: 'C_fc-1.1', tolerance: 0.1 },
        { name: 'by plane', onPlane: { entityId: fixture.boxId, point: [0, 0, 0], normal: [0, 0, 5], distance: 0.01 }, tolerance: 0.25 },
      ],
      points: [{ name: 'centre', point: [5, 5, 0.1] }],
    });
    const data = result.data as {
      unit: string;
      maxDisplacement: number;
      faces: FaceRow[];
      points: { nodeId: number; magnitude: number; displacement: number[] }[];
      reviewRequired: boolean;
    };
    expect(result.rejected).toBeUndefined();
    expect(data.unit).toBe('mm');
    expect(data.reviewRequired).toBe(true);
    expect(data.faces[0]).toMatchObject({ name: 'by set', nodes: 5, tolerance: 0.1, withinTolerance: false, reviewRequired: true });
    expect(data.faces[0]?.flatnessBefore).toBeCloseTo(0, 12);
    expect(data.faces[0]?.flatnessAfter).toBeCloseTo(0.2, 12);
    expect(data.faces[0]?.change).toBeCloseTo(0.2, 12);
    expect(data.faces[1]).toMatchObject({ nodes: 5, withinTolerance: true });
    expect(data.points[0]).toMatchObject({ nodeId: 5, displacement: [0, 0, 0.2] });
    expect(data.points[0]?.magnitude).toBeCloseTo(0.2, 12);
    expect(data.maxDisplacement).toBeCloseTo(Math.hypot(0.1, 0.3), 12);
    expect(result.summary).toContain('review required');
    expect(result.summary).toContain('exceed');
  });

  it('converts analysis lengths to the document unit (in)', () => {
    const { fixture, port } = solved();
    const inches = { ...fixture, doc: { ...fixture.doc, units: 'in' as const } };
    const analysisCase = inches.doc.analysis?.cases[inches.analysisId] as AnalysisCase;
    const redone = withCase(inches.doc, {
      ...analysisCase,
      results: { ...analysisCase.results!, inputHash: analysisInputHash(inches.doc, inches.analysisId, 'full') },
    });
    const result = report({ ...inches, doc: redone }, port, { faces: [{ name: 'f', targetKey: 'C_fc-1.1' }] });
    const data = result.data as { faces: FaceRow[]; unit: string };
    expect(data.unit).toBe('in');
    expect(data.faces[0]?.flatnessAfter).toBeCloseTo(0.2 / 25.4, 10);
  });

  it('is pure and read-only', () => {
    const { fixture, port } = solved();
    expectPure(fixture.doc, () => report(fixture, port, { faces: [{ name: 'f', targetKey: 'C_fc-1.1' }] }));
    expect(report(fixture, port, {}).document).toBe(fixture.doc);
  });

  it('refuses unsolved, stale and artifact-less analyses with the FEA codes', () => {
    const { fixture, port } = solved();
    const bare = thermoFixture();
    expect(report(bare, port, {}).error?.code).toBe('FEA_RESULTS_MISSING');
    expect(report(fixture, null, {}).error?.code).toBe('FEA_RESULTS_MISSING');
    expect(report(fixture, portOf({}), {}).error?.code).toBe('FEA_RESULTS_MISSING');
    const stale = execute(fixture.doc, 'set_reference_temperature', { analysisId: fixture.analysisId, value: 25, unit: 'degC' }).document;
    const result = report({ ...fixture, doc: stale }, port, {});
    expectNoOp(result, stale);
    expect(result.error?.code).toBe('FEA_RESULTS_STALE');
    const unknown = execute(fixture.doc, 'thermal_distortion_report', { analysisId: 'nope' });
    expect(unknown.error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
  });

  it('refuses faces it cannot measure and results without displacements', () => {
    const { fixture, port } = solved();
    for (const face of [
      { name: 'x', targetKey: 'missing' },
      { name: 'x', targetKey: 'tiny' },
      { name: 'x' },
      { name: 'x', onPlane: { entityId: fixture.boxId, point: [0, 0, 0], normal: [0, 0, 0], distance: 1 } },
      { name: 'x', onPlane: { entityId: 'other', point: [0, 0, 0], normal: [0, 0, 1], distance: 1 } },
    ]) {
      const result = report(fixture, port, { faces: [face] });
      expect(result.error?.code, JSON.stringify(face)).toBe('FEA_TARGET_UNRESOLVED');
      expect(result.document).toBe(fixture.doc);
    }
    const analysisCase = fixture.doc.analysis?.cases[fixture.analysisId] as AnalysisCase;
    const noDisp: FeResultsArtifact = {
      kind: 'fe_results',
      meshHash: 'm',
      inputHash: 'x',
      solver: 'c',
      solverVersion: '1',
      steps: [{ step: 1, time: 1, fields: {} }],
    };
    const hash = hashOf(noDisp);
    const doc = withCase(fixture.doc, { ...analysisCase, results: { ...analysisCase.results!, resultsHash: hash } });
    const mesh = portOf({ [analysisCase.meshSummary!.meshHash]: fixture.mesh, [hash]: noDisp });
    expect(report({ ...fixture, doc }, mesh, {}).error?.code).toBe('FEA_RESULTS_MISSING');
  });
});
