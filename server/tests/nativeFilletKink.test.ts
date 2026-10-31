/**
 * Two circular fillet_edge steps on a box (board: "two circular fillet_edge steps read a 0.029 rad BLD_CHECK_G1_ANGLE where OCCT's step-2 B-spline blend meets the first blend"). The solid IS kinked there: the normals of
 * the two faces measured densely along the shared edge with the exact face projection (not through check_blends) agree with the check to 1e-6. Cause: a fillet of radius r2 along the rim of a round of radius r1 < r2 is a spindle
 * torus; OCCT answers with an approximating B-spline that is not tangent to the round (0.044 rad for r1 1, r2 2; 0.029 for r1 2, r2 3). fillet_edge refuses such a second step by name (BLD_FILLET_NOT_TANGENT) with the measured
 * angle; r2 <= r1 builds G1. Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;

describeNative('two circular fillet steps: a second blend larger than the round it meets (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const cube = (): { doc: Doc; id: string } => {
    const made = execute(createEmptyDocument(), 'add_box', { size: [20, 20, 20], position: [10, 10, 10] });
    return { doc: made.document, id: made.affected[0] as string };
  };
  const FOUR_VERTICAL = [
    [0, 0, 10],
    [20, 0, 10],
    [0, 20, 10],
    [20, 20, 10],
  ];
  const firstStep = (edgesNear: number[][], radius: number): { doc: Doc; id: string } => {
    const { doc, id } = cube();
    const done = execute(doc, 'fillet_edge', { id, edgesNear, radius });
    expect(done.rejected, done.summary).toBeUndefined();
    return { doc: done.document, id: done.affected[0] as string };
  };
  const g1Findings = (doc: Doc, id: string): Array<{ value: number }> =>
    ((execute(doc, 'check_blends', { ids: [id] }).data as { findings: Array<{ code: string; value: number }> }).findings ?? []).filter(
      (finding) => finding.code === 'BLD_CHECK_G1_ANGLE',
    );

  it('the kink is real: the normals of the two faces along the shared edge (exact projection, 41 points) differ by the angle check_blends reports, at every point', () => {
    // bypass the guard: build the second step as a recipe on the kernel and measure it
    const { doc, id } = firstStep([[0, 0, 10]], 1);
    const source = (doc.entities[id] as MeshSolidEntity).brep;
    const recipe = { op: 'fillet', source, edges: [] as number[], size: 2 } as never as Parameters<typeof kernel.evaluate>[0];
    const handle = kernel.evaluate(source as Parameters<typeof kernel.evaluate>[0]);
    expect(handle).not.toBeNull();
    const listed = (
      execute(doc, 'inspect_topology', { id }).data as { edges: Array<{ index: number; curve: string; start: number[]; end: number[] }> }
    ).edges;
    const top =
      listed.find(
        (edge) =>
          edge.curve === 'line' &&
          [edge.start, edge.end].every((p) => Math.abs((p[1] as number) - 0) < 1e-9 && Math.abs((p[2] as number) - 20) < 1e-9),
      )?.index ?? -1;
    expect(top).toBeGreaterThanOrEqual(0);
    const built = kernel.evaluate({ ...(recipe as object), edges: [top] } as Parameters<typeof kernel.evaluate>[0]);
    expect(built).not.toBeNull();
    const shape = built as NonNullable<typeof built>;
    const query = kernel.faceQuery as NonNullable<typeof kernel.faceQuery>;
    const graph = query.faceGraph(shape) as NonNullable<ReturnType<typeof query.faceGraph>>;
    const names = kernel.topology(shape)?.faces.map((face) => face.name) ?? [];
    const spline = names.findIndex((name) => name.startsWith('blend(e(blend('));
    expect(spline).toBeGreaterThanOrEqual(0);
    const kinked = graph.edgeFaces.findIndex(
      (faces, edge) =>
        faces.includes(spline) && faces.some((face) => face !== spline && names[face]?.startsWith('blend(e(box-')) && edge >= 0,
    );
    expect(kinked).toBeGreaterThanOrEqual(0);
    const pair = [...new Set(graph.edgeFaces[kinked])];
    const samples = query.edgeSamples(shape, kinked, 41) as NonNullable<ReturnType<typeof query.edgeSamples>>;
    const continuity = query.edgeContinuity(shape, kinked, 41) as NonNullable<ReturnType<typeof query.edgeContinuity>>;
    let worst = 0;
    samples.forEach((sample, k) => {
      const [a, b] = pair.map(
        (face) => (query.projectOnFace(shape, face, [sample.point]) as NonNullable<ReturnType<typeof query.projectOnFace>>)[0],
      );
      const dot = a!.normal[0] * b!.normal[0] + a!.normal[1] * b!.normal[1] + a!.normal[2] * b!.normal[2];
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      expect(Math.abs(angle - (continuity[k] as { g1: number }).g1)).toBeLessThan(1e-6);
      worst = Math.max(worst, angle);
    });
    expect(worst).toBeGreaterThan(0.04);
  });

  it.each([
    ['four vertical edges r 2, then a top edge r 3', FOUR_VERTICAL, 2, 3, 0.0294],
    ['one vertical edge r 1, then a top edge r 2', [[0, 0, 10]], 1, 2, 0.0442],
  ])('%s: refused by name with the measured angle, document unchanged', (_name, first, r1, r2, angle) => {
    const { doc, id } = firstStep(first as number[][], r1 as number);
    const second = execute(doc, 'fillet_edge', { id, edgesNear: [[10, 0, 20]], radius: r2 });
    expect(second.rejected).toBe(true);
    expect(second.error?.code).toBe('BLD_FILLET_NOT_TANGENT');
    expect(second.error?.paths).toEqual(['radius']);
    expect(second.summary).toContain(`${angle}`.slice(0, 5));
    expect(second.document).toBe(doc);
  });

  it.each([
    [2, 2],
    [2, 1],
    [1, 1],
  ])('a second step of radius %s.. on a round of radius %s builds and check_blends reads no G1 finding when r2 <= r1', (r1, r2) => {
    const { doc, id } = firstStep([[0, 0, 10]], r1);
    const second = execute(doc, 'fillet_edge', { id, edgesNear: [[10, 0, 20]], radius: r2 });
    expect(second.rejected, second.summary).toBeUndefined();
    expect(g1Findings(second.document, second.affected[0] as string)).toEqual([]);
  });

  it('the remedy the refusal names: both edges in one step build, and check_blends reads them G1', () => {
    const { doc, id } = cube();
    const together = execute(doc, 'fillet_edge', {
      id,
      edgesNear: [
        [0, 0, 10],
        [10, 0, 20],
      ],
      edges: undefined,
      radius: 2,
    });
    expect(together.rejected, together.summary).toBeUndefined();
    expect(g1Findings(together.document, together.affected[0] as string)).toEqual([]);
  });
});
