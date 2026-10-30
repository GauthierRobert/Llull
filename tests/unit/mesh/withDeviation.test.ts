/**
 * One job round (TECHNICAL_SPEC 13.9): an engine that measures the deviation of an op's result in the same job saves the separate `deviation` job that the
 * command asked for after it. The command asks for it with `withDeviation`, uses the engine's answer, and measures separately only when the engine gave none.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { DEVIATION_MAX_SAMPLES, type DeviationSummary } from '@core/geometry/mesh/deviation';
import { MESH_TS_TRIANGLE_CAP, type MeshOp, type MeshOpResult, type MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import { docWithMeshes, gridMesh, icosphere } from '../../helpers/meshFixtures';
import { contextWith, quadSphere } from '../../helpers/quadFixtures';

const PROVENANCE: MeshOpResult['provenance'] = {
  engine: 'native',
  version: 'stub',
  algorithm: 'stub',
  reference: 'test',
  deterministic: true,
};
const MEASURED: DeviationSummary = {
  forwardMax: 0.5,
  backwardMax: 0.25,
  hausdorff: 0.5,
  mean: 0.125,
  rms: 0.2,
  samples: 123,
  histogram: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  worst: { point: [1, 2, 3], mesh: 'a', distance: 0.5 },
};

/** An engine that answers the ops in `answers`, records every op it is asked, and (when `measures`) attaches MEASURED to the result of an op that asked for it. */
function recordingEngine(answers: Partial<Record<MeshOp['op'], MeshOpResult>>, measures: boolean, seen: MeshOp[]): MeshProcessingEngine {
  const ops = Object.keys(answers) as MeshOp['op'][];
  return {
    name: 'recording',
    capabilities: () => new Map(ops.map((op) => [op, Infinity] as const)),
    run(_, op) {
      seen.push(op);
      const answer = answers[op.op];
      if (answer === undefined) return { code: 'MESH_ENGINE_UNSUPPORTED', message: 'not stubbed' };
      const asked = 'withDeviation' in op && op.withDeviation !== undefined;
      return measures && asked ? { ...answer, deviation: MEASURED } : answer;
    },
  };
}

const deviationOf = (result: { data?: unknown }): { hausdorff: number; mean: number } =>
  (result.data as { deviation: { hausdorff: number; mean: number } }).deviation;

describe('quad_remesh with an engine that measures in the same job', () => {
  const source = docWithMeshes(icosphere(10, 3));
  const id = source.ids[0] as string;
  const quads = quadSphere(10, 6);

  it('asks for the deviation with the job, reports the engine measure and never asks the separate deviation op', () => {
    const seen: MeshOp[] = [];
    const engine = recordingEngine({ quad_remesh: { quads, report: {}, provenance: PROVENANCE } }, true, seen);
    const result = execute(source.doc, 'quad_remesh', { id, targetQuadCount: 216 }, contextWith(engine));
    expect(result.error).toBeUndefined();
    expect(seen.map((op) => op.op)).toEqual(['quad_remesh']);
    expect(seen[0]).toMatchObject({ op: 'quad_remesh', withDeviation: DEVIATION_MAX_SAMPLES });
    expect(deviationOf(result)).toMatchObject({
      hausdorff: MEASURED.hausdorff,
      mean: MEASURED.mean,
      samples: 123,
      max: MEASURED.hausdorff,
    });
  });

  it('measures separately, through the engines, when the engine gave no deviation', () => {
    const seen: MeshOp[] = [];
    const engine = recordingEngine({ quad_remesh: { quads, report: {}, provenance: PROVENANCE } }, false, seen);
    const result = execute(source.doc, 'quad_remesh', { id, targetQuadCount: 216 }, contextWith(engine));
    expect(result.error).toBeUndefined();
    expect(deviationOf(result).hausdorff).not.toBe(MEASURED.hausdorff);
    expect(deviationOf(result).hausdorff).toBeGreaterThan(0);
    expect(deviationOf(result).hausdorff).toBeLessThan(1);
  });
});

describe('decimate_mesh, smooth_mesh, remesh_mesh, repair_mesh and fill_mesh_holes on a mesh above the TypeScript cap', () => {
  const triangles = MESH_TS_TRIANGLE_CAP + 4_800;
  const side = Math.ceil(Math.sqrt(triangles / 2));
  const big = docWithMeshes(gridMesh(100, side));
  const id = big.ids[0] as string;
  const small = gridMesh(100, 8);
  const result = (report: Record<string, unknown>): MeshOpResult => ({
    mesh: { positions: small.positions, indices: small.indices },
    report,
    provenance: PROVENANCE,
  });
  const decimateReport = {
    trianglesBefore: triangles,
    trianglesAfter: 128,
    reachedTarget: true,
    stoppedBy: 'target',
    collapses: 1,
    rejected: {},
    maxCollapseCost: 0,
  };
  const smoothReport = { meanDisplacement: 0, maxDisplacement: 0, volumeCorrected: false };
  const remeshReport = {
    mode: 'isotropic',
    iterations: 3,
    trianglesBefore: triangles,
    trianglesAfter: 128,
    splits: 0,
    collapses: 1,
    flips: 0,
    edgeLength: { min: 1, max: 2, mean: 1.5, p5: 1, p95: 2 },
    fractionInBand: 0.9,
    featureEdges: 0,
  };

  const repairReport = {
    mode: 'close_holes',
    changes: {
      welded: 0,
      duplicatesRemoved: 0,
      degenerateRemoved: 0,
      flipped: 0,
      stitched: 0,
      holesFilled: 1,
      componentsRemoved: 0,
      facesRemovedWithComponents: 0,
    },
    notes: [],
    skippedHoles: 0,
  };
  const fillReport = { totalLoops: 0, filled: [], skipped: [] };

  it.each([
    ['decimate_mesh', { id, targetTriangles: 128 }, 'decimate', decimateReport],
    ['repair_mesh', { id, mode: 'close_holes' }, 'repair', repairReport],
    ['fill_mesh_holes', { id }, 'fill_holes', fillReport],
    ['smooth_mesh', { id, iterations: 2 }, 'smooth', smoothReport],
    ['remesh_mesh', { id, targetEdgeLength: 10 }, 'remesh', remeshReport],
  ] as const)(
    '%s: one engine call carries the deviation, and the command does not ask for it again',
    (command, params, op, report) => {
      const seen: MeshOp[] = [];
      const engine = recordingEngine({ [op]: result(report) }, true, seen);
      const done = execute(big.doc, command, params, contextWith(engine));
      expect(done.error).toBeUndefined();
      expect(seen.map((asked) => asked.op)).toEqual([op]);
      expect(seen[0]).toMatchObject({ withDeviation: DEVIATION_MAX_SAMPLES });
      expect(deviationOf(done)).toMatchObject({ hausdorff: MEASURED.hausdorff, samples: 123 });
    },
    60_000,
  );

  it('sculpt_mesh measures no deviation, so its job is not asked for one', () => {
    const seen: MeshOp[] = [];
    const sculptReport = {
      movedVertices: 1,
      maxDisplacement: 0.5,
      displacedVolume: 1,
      volumeBasis: 'height-field-sum',
      symmetryError: null,
      refinedEdges: 0,
      stampsApplied: 1,
    };
    const engine = recordingEngine({ sculpt: result(sculptReport) }, true, seen);
    const done = execute(
      big.doc,
      'sculpt_mesh',
      { id, brush: 'draw', stamps: [{ center: [0, 0, 0] }], radius: 5, strength: 1 },
      contextWith(engine),
    );
    expect(done.error).toBeUndefined();
    expect(seen.map((asked) => asked.op)).toEqual(['sculpt']);
    expect(seen[0]).not.toHaveProperty('withDeviation');
    expect(done.data).not.toHaveProperty('deviation');
  }, 60_000);

  it('an engine without a deviation in its answer leaves the separate measure to the engines', () => {
    const seen: MeshOp[] = [];
    const engine = recordingEngine(
      { decimate: result(decimateReport), deviation: { deviation: MEASURED, report: {}, provenance: PROVENANCE } },
      false,
      seen,
    );
    const done = execute(big.doc, 'decimate_mesh', { id, targetTriangles: 128 }, contextWith(engine));
    expect(done.error).toBeUndefined();
    expect(seen.map((asked) => asked.op)).toEqual(['decimate', 'deviation']);
    expect(deviationOf(done).hausdorff).toBe(MEASURED.hausdorff);
  }, 60_000);
});
