/**
 * BLD M5 on the native OCCT kernel (docs/design/06-variable-blends 13.25): variable chamfers on the three edges that meet at a corner of a cube. The tools overlap there and the chamfer faces meet along the
 * mitre lines of their planes (a point for three planes), so the corner needs no patch and is G0 by construction. Closed forms: three equal constant legs d on edges of length L remove 3/2 d^2 L - 3/4 d^3 (the
 * union of three wedges: 3 wedges - 3 pair overlaps d^3 / 3 + the triple overlap d^3 / 4); variable legs against a grid union of the three wedges (laws in each edge's own arc length from its start).
 * Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
interface Edge {
  readonly index: number;
  readonly curve: string;
  readonly start: number[];
  readonly end: number[];
  readonly length: number;
}
const L = 20;

describeNative('BLD M5: variable chamfers meeting at a corner (native OCCT kernel)', () => {
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
    const result = execute(createEmptyDocument(), 'add_box', { size: [L, L, L], position: [L / 2, L / 2, L / 2] });
    expect(result.rejected, result.summary).toBeUndefined();
    return { doc: result.document, id: result.affected[0] as string };
  };
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const edges = (doc: Doc, id: string): Edge[] => (execute(doc, 'inspect_topology', { id }).data as { edges: Edge[] }).edges;
  const AT_ORIGIN: number[][] = [
    [L / 2, 0, 0],
    [0, L / 2, 0],
    [0, 0, L / 2],
  ];
  const chamfer = (doc: Doc, id: string, extra: Record<string, unknown>): ReturnType<typeof execute> =>
    execute(doc, 'chamfer_edge', { id, edgesNear: AT_ORIGIN, ...extra });
  /** For each of the three edges at the origin: does it start there (its leg law then grows away from the corner)? */
  const startsAtOrigin = (doc: Doc, id: string): boolean[] =>
    AT_ORIGIN.map((near) => {
      const edge = edges(doc, id).find(
        (candidate) =>
          candidate.curve === 'line' &&
          candidate.start.map((c, k) => (c + (candidate.end[k] as number)) / 2).every((c, k) => Math.abs(c - (near[k] as number)) < 1e-6),
      );
      expect(edge).toBeDefined();
      return (edge as Edge).start.every((c) => Math.abs(c) < 1e-9);
    });

  /** check_blends reads the legs of the three chamfers at the stations the mitre has not trimmed (the ones next to the corner have no contact line and are counted as skipped): on the law to 1e-9, status pass. */
  const expectRead = (doc: Doc, count: number): void => {
    const read = execute(doc, 'check_blends', {}).data as {
      status: string;
      chamfers: Array<{ maxDeviation: number | null; skipped: number; note?: string }>;
    };
    expect(read.status).toBe('pass');
    expect(read.chamfers).toHaveLength(count);
    for (const row of read.chamfers) {
      expect(row.note).toBeUndefined();
      expect(row.maxDeviation).toBeLessThan(1e-9);
      expect(row.skipped).toBeGreaterThanOrEqual(1);
    }
  };

  it('three equal constant legs d = 2 at a cube corner (variable path, first = last): the removed volume is 3/2 d^2 L - 3/4 d^3 = 114, and the faces meet at the mitre point (d/2, d/2, d/2)', () => {
    const { doc, id } = cube();
    const done = chamfer(doc, id, { distance: 2, distanceEnd: 2 });
    expect(done.rejected, done.summary).toBeUndefined();
    const removed = volume(doc, id) - volume(done.document, done.affected[0] as string);
    expect(Math.abs(removed - 114) / 114).toBeLessThan(1e-9);
    expectRead(done.document, 3);
    const result = edges(done.document, done.affected[0] as string);
    // the three chamfer planes meet in one vertex (1, 1, 1)
    expect(result.some((edge) => [edge.start, edge.end].some((p) => p.every((c) => Math.abs(c - 1) < 1e-9)))).toBe(true);
  });

  it('variable legs 1 -> 3 along each edge (each from its own start) match the grid union of the three wedges within 2e-3', () => {
    const { doc, id } = cube();
    const done = chamfer(doc, id, { distance: 1, distanceEnd: 3 });
    expect(done.rejected, done.summary).toBeUndefined();
    const removed = volume(doc, id) - volume(done.document, done.affected[0] as string);
    expectRead(done.document, 3);
    const grows = startsAtOrigin(doc, id);
    // leg of edge i at distance t from the origin along its axis
    const leg = (i: number, t: number): number => (grows[i] ? 1 + (2 * t) / L : 3 - (2 * t) / L);
    const dmax = 3;
    const n = 240;
    const h = dmax / n;
    let corner = 0;
    for (let a = 0; a < n; a++)
      for (let b = 0; b < n; b++)
        for (let c = 0; c < n; c++) {
          const p = [(a + 0.5) * h, (b + 0.5) * h, (c + 0.5) * h];
          const cut = [0, 1, 2].some((i) => {
            const u = p[(i + 1) % 3] as number;
            const v = p[(i + 2) % 3] as number;
            return (u + v) / leg(i, p[i] as number) < 1;
          });
          if (cut) corner += 1;
        }
    // tails of every wedge beyond the corner cube: 1/2 integral of leg^2 along the axis; the wedge inside [0, dmax] along its own axis is in the grid
    let tails = 0;
    for (let i = 0; i < 3; i++) {
      const m = 4000;
      for (let k = 0; k < m; k++) {
        const t = dmax + ((k + 0.5) * (L - dmax)) / m;
        tails += 0.5 * leg(i, t) ** 2 * ((L - dmax) / m);
      }
    }
    const expected = corner * h ** 3 + tails;
    expect(Math.abs(removed - expected) / expected).toBeLessThan(2e-3);
  });

  it('a vertex where a concave edge (the foot of a step) meets two convex edges is refused with the reason, the document unchanged; the concave foot alone and the two convex edges alone build', () => {
    const low = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5], position: [10, 5, 2.5] });
    const high = execute(low.document, 'add_box', { size: [10, 10, 5], position: [5, 5, 7.5] });
    const step = execute(high.document, 'boolean', { op: 'union', a: low.affected[0] as string, b: high.affected[0] as string });
    expect(step.rejected, step.summary).toBeUndefined();
    const id = step.affected[0] as string;
    const mixed = execute(step.document, 'chamfer_edge', {
      id,
      edgesNear: [
        [10, 5, 5],
        [10, 0, 7.5],
        [15, 0, 5],
      ],
      distance: 1,
      distanceEnd: 2,
    });
    expect(mixed.summary).toContain('all convex or all concave');
    expect(mixed.document).toBe(step.document);
    expect(execute(step.document, 'chamfer_edge', { id, edgesNear: [[10, 5, 5]], distance: 1, distanceEnd: 2 }).rejected).toBeUndefined();
    expect(
      execute(step.document, 'chamfer_edge', {
        id,
        edgesNear: [
          [10, 0, 7.5],
          [15, 0, 5],
        ],
        distance: 1,
        distanceEnd: 2,
      }).rejected,
    ).toBeUndefined();
  });
});
