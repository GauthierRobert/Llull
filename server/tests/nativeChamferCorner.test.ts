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
    expect(mixed.error?.code).toBe('BLD_CHAMFER_FAILED');
    expect(mixed.error?.paths).toEqual(['distanceEnd']);
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

  /** Faces of the result and whether the exact kernel finds it valid and closed. */
  const faceCount = (doc: Doc, id: string): number => (execute(doc, 'inspect_topology', { id }).data as { faces: unknown[] }).faces.length;
  const healthy = (doc: Doc, id: string): boolean => {
    const recipe = (doc.entities[id] as { brep?: Parameters<typeof kernel.evaluate>[0] }).brep;
    const handle = recipe === undefined ? null : kernel.evaluate(recipe);
    const health = handle === null ? null : (kernel.analyze?.(handle) ?? null);
    return health !== null && health.valid && health.closed;
  };

  it('asymmetric legs at the corner (side 1 leg 1 -> 3, the other leg 2 -> 1) build 6 + 3 faces, valid, and remove the grid union of the wedges u / d1(t) + v / d2(t) < 1 within 2e-3', () => {
    const { doc, id } = cube();
    const done = chamfer(doc, id, { distance: 1, distanceEnd: 3, distance2: 2, distance2End: 1, side1Near: [0.1, 0.3, 0.2] });
    expect(done.rejected, done.summary).toBeUndefined();
    const out = done.affected[0] as string;
    expect(faceCount(done.document, out)).toBe(9);
    expect(healthy(done.document, out)).toBe(true);
    const removed = volume(doc, id) - volume(done.document, out);
    const grows = startsAtOrigin(doc, id);
    // per edge (x, y, z): the axis, the coordinate on side 1 (the face nearest to side1Near) and the other one; side 1 of edge x is z = 0 (leg along y), of edge y is x = 0 (leg along z), of edge z is x = 0 (leg along y)
    const sides: Array<[number, number, number]> = [
      [0, 1, 2],
      [1, 2, 0],
      [2, 1, 0],
    ];
    const d1 = (i: number, t: number): number => (grows[i] ? 1 + (2 * t) / L : 3 - (2 * t) / L);
    const d2 = (i: number, t: number): number => (grows[i] ? 2 - t / L : 1 + t / L);
    const dmax = 3;
    const n = 240;
    const h = dmax / n;
    let corner = 0;
    for (let a = 0; a < n; a++)
      for (let b = 0; b < n; b++)
        for (let c = 0; c < n; c++) {
          const p = [(a + 0.5) * h, (b + 0.5) * h, (c + 0.5) * h];
          if (
            sides.some(
              ([axis, u, v]) => (p[u] as number) / d1(axis, p[axis] as number) + (p[v] as number) / d2(axis, p[axis] as number) < 1,
            )
          )
            corner += 1;
        }
    let tails = 0;
    for (let axis = 0; axis < 3; axis++) {
      const m = 4000;
      for (let k = 0; k < m; k++) {
        const t = dmax + ((k + 0.5) * (L - dmax)) / m;
        tails += 0.5 * d1(axis, t) * d2(axis, t) * ((L - dmax) / m);
      }
    }
    const expected = corner * h ** 3 + tails;
    expect(Math.abs(removed - expected) / expected).toBeLessThan(2e-3);
  });

  /** A block 20 x 20 x 20 with a pocket 10 x 10 x 10 cut from its top corner (x, y in [0, 10], z in [10, 20]): the inner corner at (10, 10, 10) has three concave edges, each 10 long. */
  const pocket = (): { doc: Doc; id: string } => {
    const block = execute(createEmptyDocument(), 'add_box', { size: [20, 20, 20], position: [10, 10, 10] });
    const hole = execute(block.document, 'add_box', { size: [10, 10, 10], position: [5, 5, 15] });
    const cut = execute(hole.document, 'boolean', { op: 'subtract', a: block.affected[0] as string, b: hole.affected[0] as string });
    expect(cut.rejected, cut.summary).toBeUndefined();
    return { doc: cut.document, id: cut.affected[0] as string };
  };
  const INNER: number[][] = [
    [10, 5, 10],
    [5, 10, 10],
    [10, 10, 15],
  ];

  it('three concave edges at the inner corner of a pocket (d = 2, L = 10) add 3/2 d^2 L - 3/4 d^3 = 54, 9 + 3 faces, valid; the edges listed in reverse order give the same volume and face count', () => {
    const { doc, id } = pocket();
    const before = volume(doc, id);
    // one concave edge alone: the end faces of the fused tool are merged with the faces they end on (10 faces, not 11)
    const single = execute(doc, 'chamfer_edge', { id, edgesNear: [INNER[0] as number[]], distance: 2, distanceEnd: 2 });
    expect(faceCount(single.document, single.affected[0] as string)).toBe(10);
    const forward = execute(doc, 'chamfer_edge', { id, edgesNear: INNER, distance: 2, distanceEnd: 2 });
    expect(forward.rejected, forward.summary).toBeUndefined();
    const reversed = execute(doc, 'chamfer_edge', { id, edgesNear: [...INNER].reverse(), distance: 2, distanceEnd: 2 });
    expect(reversed.rejected, reversed.summary).toBeUndefined();
    for (const done of [forward, reversed]) {
      const out = done.affected[0] as string;
      expect(Math.abs(volume(done.document, out) - before - 54) / 54).toBeLessThan(1e-9);
      expect(faceCount(done.document, out)).toBe(12);
      expect(healthy(done.document, out)).toBe(true);
    }
  });

  it('the constant path (no distanceEnd, OCCT MakeChamfer) and the variable path with distance = distanceEnd = 2 on the same three edges: volume and face count', () => {
    const { doc, id } = cube();
    const constant = chamfer(doc, id, { distance: 2 });
    expect(constant.rejected, constant.summary).toBeUndefined();
    const variable = chamfer(doc, id, { distance: 2, distanceEnd: 2 });
    const [a, b] = [constant, variable].map((done) => ({
      removed: volume(doc, id) - volume(done.document, done.affected[0] as string),
      faces: faceCount(done.document, done.affected[0] as string),
    }));
    // OCCT's constant chamfer fills the corner with a patch of its own (10 faces, d^3 / 12 less material left); the variable path leaves the mitre of the three planes (9 faces)
    expect(a?.faces).toBe(10);
    expect(a?.removed).toBeCloseTo(114 + 8 / 12, 9);
    expect(b?.faces).toBe(9);
    expect(b?.removed).toBeCloseTo(114, 9);
  });

  it('legs large against the edge (L = 6, d = 2): the stations the mitre trims are over a quarter of them, so check_blends says the legs were not verified (status not_run with a BLD_CHECK_CHAMFER_UNVERIFIED warning, never a pass)', () => {
    const small = execute(createEmptyDocument(), 'add_box', { size: [6, 6, 6], position: [3, 3, 3] });
    const done = execute(small.document, 'chamfer_edge', {
      id: small.affected[0] as string,
      edgesNear: [
        [3, 0, 0],
        [0, 3, 0],
        [0, 0, 3],
      ],
      distance: 2,
      distanceEnd: 2,
    });
    expect(done.rejected, done.summary).toBeUndefined();
    const read = execute(done.document, 'check_blends', {});
    const data = read.data as { status: string; findings: Array<{ code: string; severity: string }> };
    expect(data.status).toBe('not_run');
    expect(data.findings.some((finding) => finding.code === 'BLD_CHECK_CHAMFER_UNVERIFIED' && finding.severity === 'warn')).toBe(true);
  });
});
