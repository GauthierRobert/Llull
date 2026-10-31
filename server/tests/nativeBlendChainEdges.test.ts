/**
 * DES-6c chain follow-ups (docs/design/06-variable-blends 13.27) on the native OCCT kernel.
 *  - Arc-length abscissa: a straight law given on an edge is read at the edge's ARC fraction, not its parameter fraction. OCCT reads the relative position of a law node as a fraction of the edge PARAMETER range, so the kernel places the nodes at the arc fractions (law_fillet.cxx parameter_nodes). The top rim of a prism over an ellipse 12 x 3 is 4 tangent B-spline
 *    edges of very uneven speed (4 : 1); every edge carries a straight law between the values at its two vertices, and the radius read back on the wall (the contact line lies r below the top of a right-angle edge) at each point of the rim is compared with
 *    the value of the law at that point's arc fraction on its edge.
 *  - Closed edge: the direction of a closed edge (start = end) is decided from the tangent, not the end points: an asymmetric periodic law on a cylinder rim lands at the same place as the law reads along the edge.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { common, createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
type Point = readonly number[];
type Brep = Parameters<IsolatedKernel['evaluate']>[0];

interface TopEdge {
  index: number;
  curve: string;
  start: Point;
  end: Point;
  length: number;
}

describeNative('fillet_edge laws: arc-length abscissa and the direction of a closed edge (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const edgesOf = (doc: Doc, id: string): TopEdge[] => (execute(doc, 'inspect_topology', { id }).data as { edges: TopEdge[] }).edges;
  const shapeOf = (doc: Doc, id: string, source = false): NonNullable<ReturnType<IsolatedKernel['evaluate']>> => {
    const entity = doc.entities[id] as { brep?: Brep };
    const recipe = source ? (entity.brep as unknown as { source: Brep }).source : (entity.brep as Brep);
    const shape = kernel.evaluate(recipe);
    expect(shape).not.toBeNull();
    return shape as NonNullable<typeof shape>;
  };

  /** Every point sampled on the edges of the result that border a blend and a wall face named by `wall`, below the top plane (the contact lines of the new blends on the walls). */
  const contactPoints = (doc: Doc, id: string, wall: RegExp, top: number): Point[] => {
    const handle = shapeOf(doc, id);
    const query = kernel.faceQuery as NonNullable<typeof kernel.faceQuery>;
    const topology = kernel.topology(handle) as NonNullable<ReturnType<typeof kernel.topology>>;
    const graph = query.faceGraph(handle) as NonNullable<ReturnType<typeof query.faceGraph>>;
    const out: Point[] = [];
    topology.edges.forEach((_edge, index) => {
      const names = (graph.edgeFaces[index] ?? []).map((face) => topology.faces[face]?.name ?? '');
      if (!names.some((name) => name.startsWith('blend(')) || !names.some((name) => wall.test(name))) return;
      for (const sample of query.edgeSamples(handle, index, 33) ?? []) if ((sample.point[2] as number) < top - 0.25) out.push(sample.point);
    });
    return out;
  };

  interface Dense {
    point: Point;
    s: number;
    t: number;
  }
  /** The edge `index` of the SOURCE shape, densely sampled: points with their arc length. */
  const dense = (doc: Doc, id: string, index: number): Dense[] =>
    (kernel.faceQuery?.edgeSamples(shapeOf(doc, id, true), index, 1001) ?? []).map((sample) => ({
      point: sample.point,
      s: sample.s,
      t: sample.t,
    }));

  /** Arc length along the sampled edge of the point nearest to `point` in xy (projected on the segments), and the distance to it. */
  const arcOf = (samples: Dense[], point: Point): { s: number; gap: number } => {
    let best = { s: 0, gap: Infinity };
    for (let k = 0; k + 1 < samples.length; k++) {
      const [a, b] = [samples[k], samples[k + 1]] as [Dense, Dense];
      const [dx, dy] = [(b.point[0] as number) - (a.point[0] as number), (b.point[1] as number) - (a.point[1] as number)];
      const [px, py] = [(point[0] as number) - (a.point[0] as number), (point[1] as number) - (a.point[1] as number)];
      const along = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
      const gap = Math.hypot(along * dx - px, along * dy - py);
      if (gap < best.gap) best = { s: a.s + along * (b.s - a.s), gap };
    }
    return best;
  };

  it('a straight law on the 4 uneven B-spline edges of an elliptic rim is read at the ARC fraction of each edge: the radius on the wall follows the law within 4e-3', () => {
    const sketch = {
      id: 's',
      kind: 'ellipse',
      center: [0, 0],
      radiusX: 12,
      radiusY: 3,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      ...common,
    } as unknown as Entity;
    const base: Doc = { ...createEmptyDocument(), entities: { s: sketch }, order: ['s'] };
    const prism = execute(base, 'extrude_profile', { id: 's', depth: 5 });
    expect(prism.rejected, prism.summary).toBeUndefined();
    const id = prism.affected[0] as string;
    const rim = edgesOf(prism.document, id).filter((edge) => (edge.start[2] as number) > 4.999 && (edge.end[2] as number) > 4.999);
    expect(rim).toHaveLength(4);
    // a value at every vertex of the rim: the law of an edge is the straight line between the values at its two vertices
    const valueAt = (point: Point): number => (Math.abs(point[0] as number) > 1 ? 0.3 : 0.6);
    const built = execute(prism.document, 'fillet_edge', {
      id,
      edges: rim.map((edge) => ({ index: edge.index, size: valueAt(edge.start), sizeEnd: valueAt(edge.end), interpolation: 'linear' })),
    });
    expect(built.rejected, built.summary).toBeUndefined();
    const edgeSamples = rim.map((edge) => dense(built.document, built.affected[0] as string, edge.index));
    const points = contactPoints(built.document, built.affected[0] as string, /side\./, 5);
    expect(points.length).toBeGreaterThan(100);
    let worst = 0;
    let read = 0;
    // how far the law would be read from if the abscissa were the PARAMETER fraction: the speed of the edges is uneven
    let parameterMiss = 0;
    for (const point of points) {
      const found = edgeSamples.map((samples, k) => ({ k, ...arcOf(samples, point) })).sort((a, b) => a.gap - b.gap)[0] as {
        k: number;
        s: number;
        gap: number;
      };
      const edge = rim[found.k] as TopEdge;
      // the blends close at the joints of the rim (the profile is not exactly G1 there): read the interior of each edge
      if (found.s < 0.5 || found.s > edge.length - 0.5) continue;
      expect(found.gap).toBeLessThan(0.06);
      read++;
      const from = valueAt(edge.start);
      const to = valueAt(edge.end);
      worst = Math.max(worst, Math.abs(5 - (point[2] as number) - (from + (to - from) * (found.s / edge.length))));
      const samples = edgeSamples[found.k] as Dense[];
      const byIndex = samples[samples.findIndex((sample) => sample.s >= found.s)]?.t ?? 0;
      parameterMiss = Math.max(parameterMiss, Math.abs((to - from) * (byIndex - found.s / edge.length)));
    }
    expect(read).toBeGreaterThan(100);
    expect(worst, 'worst').toBeLessThan(4e-3);
    // the sampling is uniform in the parameter: the two fractions differ by more than the tolerance, so the test tells the abscissas apart
    expect(parameterMiss).toBeGreaterThan(1e-2);
  });

  it('a closed rim carrying an asymmetric periodic law (peak at the quarter) lands the peak where the law reads along the edge: the direction of a closed edge is its tangent, not the tied end points', () => {
    const solid = execute(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 10 });
    const id = solid.affected[0] as string;
    const rim = edgesOf(solid.document, id).find((edge) => edge.curve === 'circle' && (edge.start[2] as number) > 4.999);
    expect(rim).toBeDefined();
    const built = execute(solid.document, 'fillet_edge', {
      id,
      edges: [{ index: (rim as TopEdge).index, law: { expression: '1 + 0.5*sin(2*pi*t)', samples: 65 }, interpolation: 'linear' }],
    });
    expect(built.rejected, built.summary).toBeUndefined();
    const samples = dense(built.document, built.affected[0] as string, (rim as TopEdge).index);
    const points = contactPoints(built.document, built.affected[0] as string, /./, 5).filter(
      (point) => Math.abs(Math.hypot(point[0] as number, point[1] as number) - 5) < 1e-4,
    );
    expect(points.length).toBeGreaterThan(30);
    let worst = 0;
    for (const point of points) {
      const t = arcOf(samples, point).s / (rim as TopEdge).length;
      worst = Math.max(worst, Math.abs(5 - (point[2] as number) - (1 + 0.5 * Math.sin(2 * Math.PI * t))));
    }
    expect(worst).toBeLessThan(2e-2);
  });
});
