/**
 * DES-6c M4 left (docs/design/06-variable-blends 13.27): ONE size law over a tangent chain of several edges on fillet_faces. The top face against the three walls of a block corner rounded by a vertical round of radius 4 shares a chain
 * of three edges (a line, a quarter circle, a line) of arc length S = 32 + 2 pi. A straight law radius -> radiusEnd (or the expression 1 + 2 t) runs along S: the contact line of the blend on the walls is at the depth r below the top
 * (a right-angle edge), so the realised radius at any point of the chain is read from the contact lines (10 - z) and compared with the law at that point's arc length; the removed volume of a linear law is compared with the numeric integral of
 * A(r) = (1 - pi / 4) r^2 along the chain (Pappus on the arc: the removed spandrel's centroid lies 0.2239 r inside the wall). Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
const R = 4;
const LINE = 16;
const ARC = (Math.PI * R) / 2;
const S = 2 * LINE + ARC;
const SPANDREL = 1 - Math.PI / 4;
const CENTROID = (5 / 6 - Math.PI / 4) / SPANDREL;

describeNative('fillet_faces: one size law over a tangent chain of edges (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;

  /** A block 20 x 20 x 10 (top z = 10) whose vertical edge at corner (cx, cy) is rounded with radius 4. */
  const scene = (cx: number, cy: number): { doc: Doc; id: string; sets: Record<string, unknown>; ends: [number[], number[]] } => {
    const block = execute(createEmptyDocument(), 'add_box', { size: [20, 20, 10], position: [10, 10, 5] });
    const rounded = execute(block.document, 'fillet_edge', { id: block.affected[0], edgesNear: [[cx, cy, 5]], radius: R });
    expect(rounded.rejected, rounded.summary).toBeUndefined();
    const [sx, sy] = [cx === 0 ? 1 : -1, cy === 0 ? 1 : -1];
    const mid = (a: number, b: number): number => (a + b) / 2;
    return {
      doc: rounded.document,
      id: rounded.affected[0] as string,
      sets: {
        facesA: { near: [[10, 10, 10]] },
        facesB: {
          near: [
            [cx, mid(cy + 4 * sy, cy + 20 * sy), 5],
            [mid(cx + 4 * sx, cx + 20 * sx), cy, 5],
            [cx + 4 * sx - 4 * Math.SQRT1_2 * sx, cy + 4 * sy - 4 * Math.SQRT1_2 * sy, 5],
          ],
        },
      },
      // the far ends of the two lines
      ends: [
        [cx + 20 * sx, cy, 10],
        [cx, cy + 20 * sy, 10],
      ],
    };
  };

  /** Arc length from the end `from` of the chain (the far end of the line along y = cy, or of the line along x = cx) to a point of the chain; the chain is symmetric about the corner. */
  const arcLength = (point: number[], cx: number, cy: number, fromX: boolean): number => {
    const [sx, sy] = [cx === 0 ? 1 : -1, cy === 0 ? 1 : -1];
    const alongX = Math.abs((point[1] as number) - cy) < 1e-6 && (point[0] as number) * sx >= cx * sx + 4 - 1e-6;
    const alongY = Math.abs((point[0] as number) - cx) < 1e-6 && (point[1] as number) * sy >= cy * sy + 4 - 1e-6;
    const fromXStart = fromX ? 0 : S;
    const sign = fromX ? 1 : -1;
    if (alongX) return fromXStart + sign * Math.abs(cx + 20 * sx - (point[0] as number));
    if (alongY) return fromXStart + sign * (S - Math.abs(cy + 20 * sy - (point[1] as number)));
    const angle = Math.atan2((cy + 4 * sy - (point[1] as number)) * sy, (cx + 4 * sx - (point[0] as number)) * sx);
    // angle 0 on the x = cx line side, pi / 2 on the y = cy line side
    const along = LINE + R * (Math.PI / 2 - angle);
    return fromX ? along : S - along;
  };

  /** (arc length from the start, radius) at every sample of every contact line of the new blends on the walls (the radius is the depth below the top). */
  const realised = (doc: Doc, id: string, cx: number, cy: number, fromX: boolean): Array<[number, number]> => {
    const entity = doc.entities[id] as { brep?: Parameters<typeof kernel.evaluate>[0] };
    const handle = kernel.evaluate(entity.brep as Parameters<typeof kernel.evaluate>[0]);
    expect(handle).not.toBeNull();
    const shape = handle as NonNullable<typeof handle>;
    const query = kernel.faceQuery as NonNullable<typeof kernel.faceQuery>;
    const topology = kernel.topology(shape) as NonNullable<ReturnType<typeof kernel.topology>>;
    const graph = query.faceGraph(shape) as NonNullable<ReturnType<typeof query.faceGraph>>;
    const out: Array<[number, number]> = [];
    topology.edges.forEach((_edge, index) => {
      const names = (graph.edgeFaces[index] ?? []).map((face) => topology.faces[face]?.name ?? '');
      const far = [cx === 0 ? 'x+' : 'x-', cy === 0 ? 'y+' : 'y-'];
      const onWall = names.some(
        (name) =>
          (name.startsWith('box-') && /:[xy][+-]$/.test(name)) ||
          (name.startsWith('blend(e(box-') && name.includes(':x') && name.includes(':y') && !name.includes(':z')),
      );
      const isNewBlend = names.some((name) => name.startsWith('blend(e(') && name.includes(':z+)'));
      // the end curves of the blend on the far walls are not contact lines of the chain
      if (!onWall || !isNewBlend || names.some((name) => far.some((tag) => name.endsWith(':' + tag)))) return;
      for (const sample of query.edgeSamples(shape, index, 9) ?? []) {
        const p = sample.point as number[];
        if ((p[2] as number) > 9.999) continue;
        out.push([arcLength(p, cx, cy, fromX), 10 - (p[2] as number)]);
      }
    });
    return out;
  };

  it.each([
    [0, 0],
    [20, 0],
    [0, 20],
    [20, 20],
  ])(
    'a straight law 1 -> 3 over the chain of the corner (%s, %s): the realised radius follows it along the whole arc length from either end (startNear), within 1e-3',
    (cx, cy) => {
      const { doc, id, sets, ends } = scene(cx, cy);
      for (const [k, start] of ends.entries()) {
        const built = execute(doc, 'fillet_faces', { id, ...sets, radius: 1, radiusEnd: 3, startNear: start });
        expect(built.rejected, built.summary).toBeUndefined();
        const data = built.data as { blendEdges: Array<{ index: number }> };
        expect(data.blendEdges).toHaveLength(3);
        const rows = realised(built.document, built.affected[0] as string, cx, cy, k === 0);
        expect(rows.length).toBeGreaterThan(15);
        let worst = 0;
        for (const [s, r] of rows) worst = Math.max(worst, Math.abs(r - (1 + (2 * s) / S)));
        expect(worst, `from end ${k}`).toBeLessThan(1e-3);
      }
    },
  );

  /** The numeric integral of the removed volume of a straight law 1 -> 3 over the chain: A(r) = (1 - pi / 4) r^2 along the lines, A(r) (R - 0.2239 r) / R on the arc (Pappus). */
  const expectedVolume = (): number => {
    const radius = (s: number): number => 1 + (2 * s) / S;
    const steps = 20000;
    let total = 0;
    for (let k = 0; k < steps; k++) {
      const s = ((k + 0.5) / steps) * S;
      const r = radius(s);
      const onArc = s > LINE && s < LINE + ARC;
      total += SPANDREL * r * r * (onArc ? (R - CENTROID * r) / R : 1) * (S / steps);
    }
    return total;
  };

  it('the removed volume of the straight law 1 -> 3 over the chain matches the numeric integral of the spandrel area along it (arc by Pappus) within 3e-3; check_blends reads every blend on its sub-law (status pass, no radius-law finding)', () => {
    const { doc, id, sets } = scene(0, 0);
    const built = execute(doc, 'fillet_faces', { id, ...sets, radius: 1, radiusEnd: 3, startNear: [20, 0, 10] });
    expect(built.rejected, built.summary).toBeUndefined();
    const out = built.affected[0] as string;
    const removed = volume(doc, id) - volume(built.document, out);
    const expected = expectedVolume();
    expect(Math.abs(removed - expected) / expected).toBeLessThan(3e-3);
    const read = execute(built.document, 'check_blends', { ids: [out] }).data as {
      status: string;
      findings: Array<{ code: string; severity: string }>;
    };
    expect(read.findings.filter((finding) => finding.code === 'BLD_CHECK_RADIUS_LAW')).toEqual([]);
    expect(read.status).toBe('pass');
  });

  it('the law expression 1 + 2 t runs over the chain as the straight law does (stations 33 per edge, straight pieces): realised radius within 1e-3 of 1 + 2 s / S', () => {
    const { doc, id, sets } = scene(0, 0);
    const built = execute(doc, 'fillet_faces', { id, ...sets, law: { expression: '1 + 2*t' }, startNear: [20, 0, 10] });
    expect(built.rejected, built.summary).toBeUndefined();
    let worst = 0;
    for (const [s, r] of realised(built.document, built.affected[0] as string, 0, 0, true))
      worst = Math.max(worst, Math.abs(r - (1 + (2 * s) / S)));
    expect(worst).toBeLessThan(1e-3);
  });

  it('refused by name: sets whose shared edges are not one tangent chain (a bend of 90 degrees, two separate edges), a loop with a law that does not close, startNear on a loop, a law that is not > 0', () => {
    const cube = execute(createEmptyDocument(), 'add_box', { size: [20, 20, 10], position: [10, 10, 5] });
    const id = cube.affected[0] as string;
    const run = (sets: Record<string, unknown>, extra: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(cube.document, 'fillet_faces', { id, ...sets, ...extra });
    const top = { near: [[10, 10, 10]] };
    // the front and the right walls: the top edges along them meet at a corner of 90 degrees
    const bend = run(
      {
        facesA: top,
        facesB: {
          near: [
            [10, 0, 5],
            [20, 10, 5],
          ],
        },
      },
      { radius: 1, radiusEnd: 2 },
    );
    expect(bend.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(bend.error?.paths).toEqual(['radiusEnd']);
    expect(bend.summary).toContain('not one tangent chain');
    // the front and the back walls: two edges that do not meet
    const apart = run(
      {
        facesA: top,
        facesB: {
          near: [
            [10, 0, 5],
            [10, 20, 5],
          ],
        },
      },
      { radius: 1, radiusEnd: 2 },
    );
    expect(apart.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(apart.summary).toContain('2 separate pieces');
    const bad = run(
      {
        facesA: top,
        facesB: {
          near: [
            [10, 0, 5],
            [20, 10, 5],
          ],
        },
      },
      { law: { expression: '1 + 2*t' } },
    );
    expect(bad.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    // a closed loop: every vertical edge rounded, then the top rim (4 lines, 4 arcs) against every wall and round
    const rounded = execute(cube.document, 'fillet_edge', {
      id,
      edgesNear: [
        [0, 0, 5],
        [20, 0, 5],
        [0, 20, 5],
        [20, 20, 5],
      ],
      radius: 4,
    });
    expect(rounded.rejected, rounded.summary).toBeUndefined();
    const rid = rounded.affected[0] as string;
    const walls = (
      execute(rounded.document, 'inspect_topology', { id: rid }).data as {
        faces: Array<{ index: number; surface: string; normal?: number[] }>;
      }
    ).faces;
    expect(walls.length).toBeGreaterThan(8);
    const loopSets = {
      facesA: top,
      facesB: {
        near: [
          [10, 0, 5],
          [20, 10, 5],
          [10, 20, 5],
          [0, 10, 5],
          [4 - 4 * Math.SQRT1_2, 4 - 4 * Math.SQRT1_2, 5],
          [16 + 4 * Math.SQRT1_2, 4 - 4 * Math.SQRT1_2, 5],
          [4 - 4 * Math.SQRT1_2, 16 + 4 * Math.SQRT1_2, 5],
          [16 + 4 * Math.SQRT1_2, 16 + 4 * Math.SQRT1_2, 5],
        ],
      },
    };
    const open = execute(rounded.document, 'fillet_faces', { id: rid, ...loopSets, radius: 1, radiusEnd: 2 });
    expect(open.error?.code).toBe('BLD_LAW_NOT_PERIODIC');
    expect(open.error?.paths).toEqual(['radiusEnd']);
    const lone = execute(rounded.document, 'fillet_faces', { id: rid, ...loopSets, radius: 1, radiusEnd: 1, startNear: [10, 0, 10] });
    expect(lone.error?.paths).toEqual(['startNear']);
    const periodic = execute(rounded.document, 'fillet_faces', { id: rid, ...loopSets, law: { expression: '1 + 0.5*cos(2*pi*t)' } });
    expect(periodic.rejected, periodic.summary).toBeUndefined();
    expect((periodic.data as { blendEdges: unknown[] }).blendEdges).toHaveLength(8);
    const negative = execute(rounded.document, 'fillet_faces', { id: rid, ...loopSets, law: { expression: '0.5 - cos(2*pi*t)' } });
    expect(negative.error?.code).toBe('BLD_LAW_INVALID');
  });

  it('fillet_edge edges[] on the same chain: each edge law is read along the EDGE, whichever way the kernel contour walks it (the line along x = 0 is walked backwards): continuous own-direction laws give the one straight law', () => {
    const { doc, id } = scene(0, 0);
    const listed = (
      execute(doc, 'inspect_topology', { id }).data as { edges: Array<{ index: number; curve: string; start: number[]; end: number[] }> }
    ).edges;
    const topEdges = listed.filter(
      (edge) => edge.curve !== 'line' || [edge.start, edge.end].every((p) => Math.abs((p[2] as number) - 10) < 1e-9),
    );
    const onTop = topEdges.filter((edge) => [edge.start, edge.end].every((p) => Math.abs((p[2] as number) - 10) < 1e-9));
    // the chain edges: the line along y = 0 (from 4 to 20), the quarter circle and the line along x = 0 (from 4 to 20)
    const along = (edge: { start: number[]; end: number[] }, axis: number): boolean =>
      [edge.start, edge.end].every((p) => Math.abs((p[axis] as number) - 0) < 1e-9);
    const lineY = onTop.find(
      (edge) => edge.curve === 'line' && along(edge, 1) && Math.abs((edge.end[0] as number) - (edge.start[0] as number)) > 10,
    );
    const arc = onTop.find((edge) => edge.curve === 'circle');
    const lineX = onTop.find(
      (edge) => edge.curve === 'line' && along(edge, 0) && Math.abs((edge.end[1] as number) - (edge.start[1] as number)) > 10,
    );
    expect([lineY, arc, lineX].every((edge) => edge !== undefined)).toBe(true);
    const law = (
      edge: { start: number[]; end: number[] },
      axis: 'x' | 'y' | 'arc',
    ): { size: number; sizeEnd: number; interpolation: string; axis: string } => {
      // the law of the chain from (20, 0) at the own start and own end of the edge
      const sOf = (p: number[]): number => arcLength(p, 0, 0, true);
      const value = (p: number[]): number => 1 + (2 * sOf(p)) / S;
      return { size: value(edge.start), sizeEnd: value(edge.end), interpolation: 'linear', axis };
    };
    const entries = [
      { index: (lineY as { index: number }).index, ...law(lineY as never, 'x') },
      { index: (arc as { index: number }).index, ...law(arc as never, 'arc') },
      { index: (lineX as { index: number }).index, ...law(lineX as never, 'y') },
    ].map(({ axis: _axis, ...entry }) => entry);
    const built = execute(doc, 'fillet_edge', { id, edges: entries });
    expect(built.rejected, built.summary).toBeUndefined();
    let worst = 0;
    for (const [s, r] of realised(built.document, built.affected[0] as string, 0, 0, true))
      worst = Math.max(worst, Math.abs(r - (1 + (2 * s) / S)));
    expect(worst).toBeLessThan(5e-4);
  });
});
