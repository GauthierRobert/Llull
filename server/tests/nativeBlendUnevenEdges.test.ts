/**
 * DES-6c review follow-ups (docs/design/06-variable-blends 13.27) on an edge that does not run at a steady speed: an ELLIPSE rim (a cylinder of radius 6 cut by a plane tilted 60 degrees: a = 12, b = 6, a 2 : 1 speed ratio).
 * OCCT reads the relative position of a law node as a fraction of the edge PARAMETER range, so the kernel places the nodes at the arc fractions and lays the law of every stretch (straight, monotone, smooth) on its arc-length
 * curve (law_fillet.cxx parameter_nodes). The radius realised at each section (the circle through its three points) is compared with the law at the ARC fraction of the section's spine point, found as the nearest point of the
 * source edge (the section plane is normal to the spine). check_blends reads the same way (checkBlendRadius.ts spineFractions): the arc fraction along a contact edge is NOT the spine's (the contact edge is the spine offset by
 * about the radius: 3% ahead here).
 *  - a single closed ellipse rim: the unevenness probe of a closed symmetric edge reads zero at the quarter points, so the probe samples off-symmetric fractions;
 *  - an open, isolated elliptic arc (the rim cut by a plane x = 2): a straight law and its reverse, check_blends without a radius finding, and a deliberately wrong record still reported;
 *  - monotone (3 nodes, read between the nodes) and smooth (2 nodes: smoothstep; 3 nodes: the clamped cubic spline of the nodes) laws.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { blendFaceContacts, blendSectionsOf } from '@core/geometry/blend/blendInfo';
import { radiusAt } from '@core/geometry/blend/law';
import { lawIndex, checkRadius } from '@core/commands/brep/checkBlendRadius';
import { createEmptyDocument, type CadDocument, type EdgeRadius } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
type Brep = Parameters<IsolatedKernel['evaluate']>[0];
type Shape = NonNullable<ReturnType<IsolatedKernel['evaluate']>>;
interface TopoEdge {
  index: number;
  curve: string;
}
interface Row {
  u: number;
  radius: number;
}
const TILT = Math.PI / 3;

describeNative('fillet_edge laws on an ellipse rim: arc-length abscissa for every law kind (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  /** A cylinder (radius 6, height 40) cut by the plane through the origin tilted 60 degrees; `open` also cuts it at x = 2 (an elliptic arc between two corners instead of the closed ellipse). */
  const scene = (open: boolean): { doc: Doc; id: string; edge: number } => {
    const cylinder = execute(createEmptyDocument(), 'add_cylinder', { radius: 6, height: 40 });
    const tool = execute(cylinder.document, 'add_box', {
      size: [80, 80, 40],
      position: [20 * Math.sin(TILT), 0, 20 * Math.cos(TILT)],
      rotation: [0, TILT, 0],
    });
    let cut = execute(tool.document, 'boolean', { op: 'subtract', a: cylinder.affected[0], b: tool.affected[0] });
    if (open) {
      const second = execute(cut.document, 'add_box', { size: [20, 40, 60], position: [12, 0, 0] });
      cut = execute(second.document, 'boolean', { op: 'subtract', a: cut.affected[0], b: second.affected[0] });
    }
    expect(cut.rejected, cut.summary).toBeUndefined();
    const id = cut.affected[0] as string;
    const edges = (execute(cut.document, 'inspect_topology', { id }).data as { edges: TopoEdge[] }).edges;
    const rim = edges.find((edge) => edge.curve === 'ellipse');
    expect(rim).toBeDefined();
    return { doc: cut.document, id, edge: (rim as TopoEdge).index };
  };

  const recipeOf = (doc: Doc, id: string): Brep => (doc.entities[id] as unknown as { brep: Brep }).brep;

  const blendsOf = (shape: Shape): ReturnType<typeof blendFaceContacts> => {
    const query = kernel.faceQuery as NonNullable<typeof kernel.faceQuery>;
    const topology = kernel.topology(shape) as NonNullable<ReturnType<typeof kernel.topology>>;
    return blendFaceContacts(topology, query.faceGraph(shape) as NonNullable<ReturnType<typeof query.faceGraph>>);
  };

  /** (u, radius) of every section of every blend face of the result, u = arc fraction along the SOURCE edge of the nearest edge point to the section's mid point. */
  const realised = (doc: Doc, id: string, edge: number): Row[] => {
    const brep = recipeOf(doc, id);
    const shape = kernel.evaluate(brep) as Shape;
    const source = kernel.evaluate((brep as unknown as { source: Brep }).source) as Shape;
    const dense = (kernel.faceQuery as NonNullable<typeof kernel.faceQuery>).edgeSamples(source, edge, 1001) ?? [];
    const total = dense[dense.length - 1]?.s ?? 1;
    const out: Row[] = [];
    for (const blend of blendsOf(shape))
      for (const section of blendSectionsOf(kernel, shape, blend, 101) ?? []) {
        if (section.radius === null) continue;
        let best = { gap: Infinity, s: 0 };
        for (let k = 0; k + 1 < dense.length; k++) {
          const [from, to] = [dense[k], dense[k + 1]] as [(typeof dense)[number], (typeof dense)[number]];
          const along = [0, 1, 2].map((axis) => (to.point[axis] as number) - (from.point[axis] as number));
          const toward = [0, 1, 2].map((axis) => (section.mid[axis] as number) - (from.point[axis] as number));
          const dot = along.reduce((sum, v, axis) => sum + v * (toward[axis] as number), 0);
          const share = Math.min(1, Math.max(0, dot / along.reduce((sum, v) => sum + v * v, 0)));
          const gap = Math.hypot(...along.map((v, axis) => share * v - (toward[axis] as number)));
          if (gap < best.gap) best = { gap, s: from.s + share * (to.s - from.s) };
        }
        out.push({ u: best.s / total, radius: section.radius });
      }
    return out;
  };

  const worstAgainst = (rows: Row[], law: (u: number) => number, from = 0.03, to = 0.97): number =>
    rows.filter((row) => row.u >= from && row.u <= to).reduce((worst, row) => Math.max(worst, Math.abs(row.radius - law(row.u))), 0);

  const lawFindings = (doc: Doc, id: string): unknown[] =>
    (execute(doc, 'check_blends', { ids: [id] }).data as { findings: Array<{ code: string }> }).findings.filter(
      (finding) => finding.code === 'BLD_CHECK_RADIUS_LAW',
    );

  it('a SINGLE closed ellipse rim carrying an asymmetric periodic law 0.7 + 0.2 sin(2 pi t): the radius follows the arc-length law within 4e-3', () => {
    const { doc, id, edge } = scene(false);
    const built = execute(doc, 'fillet_edge', {
      id,
      edges: [{ index: edge, law: { expression: '0.7 + 0.2*sin(2*pi*t)', samples: 65 }, interpolation: 'linear' }],
    });
    expect(built.rejected, built.summary).toBeUndefined();
    const out = built.affected[0] as string;
    const rows = realised(built.document, out, edge);
    expect(rows.length).toBeGreaterThan(50);
    expect(worstAgainst(rows, (u) => 0.7 + 0.2 * Math.sin(2 * Math.PI * u), 0, 1)).toBeLessThan(4e-3);
  });

  it('an open elliptic arc with the straight law 0.3 -> 0.6 (and 0.6 -> 0.3): realised radius within 4e-3 of the arc-length law, check_blends reads no BLD_CHECK_RADIUS_LAW; a record whose law the kernel did not build IS reported', () => {
    const { doc, id, edge } = scene(true);
    for (const [from, to] of [
      [0.3, 0.6],
      [0.6, 0.3],
    ] as const) {
      const built = execute(doc, 'fillet_edge', { id, edges: [{ index: edge, size: from, sizeEnd: to, interpolation: 'linear' }] });
      expect(built.rejected, built.summary).toBeUndefined();
      const out = built.affected[0] as string;
      expect(worstAgainst(realised(built.document, out, edge), (u) => from + (to - from) * u)).toBeLessThan(4e-3);
      expect(lawFindings(built.document, out)).toEqual([]);
    }
    // the record of a build 0.3 -> 0.6 given another law (0.3 -> 0.9): the readback must still see the miss
    const built = execute(doc, 'fillet_edge', { id, edges: [{ index: edge, size: 0.3, sizeEnd: 0.6, interpolation: 'linear' }] });
    const brep = recipeOf(built.document, built.affected[0] as string);
    const shape = kernel.evaluate(brep) as Shape;
    const [blend] = blendsOf(shape);
    const [record] = [...lawIndex(kernel, brep).values()];
    expect(blend).toBeDefined();
    expect(record).toBeDefined();
    const honest = checkRadius(kernel, shape, blend as NonNullable<typeof blend>, record, 5);
    expect(honest.lawChecked).toBe(true);
    expect(honest.deviations).toEqual([]);
    const wrong = checkRadius(
      kernel,
      shape,
      blend as NonNullable<typeof blend>,
      { ...(record as NonNullable<typeof record>), law: { size: 0.3, sizeEnd: 0.9, interpolation: 'linear' } },
      5,
    );
    expect(wrong.lawChecked).toBe(true);
    expect(wrong.deviations.length).toBeGreaterThan(5);
  });

  it('a monotone law with 3 nodes (0.3, 0.6 at 0.35, 0.45) follows its C1 cubic in the arc length BETWEEN the nodes too (read from 0.03 to 0.97), within 4e-3', () => {
    const { doc, id, edge } = scene(true);
    const law: EdgeRadius = { size: 0.3, sizeEnd: 0.45, sizes: [{ t: 0.35, size: 0.6 }], interpolation: 'monotone' };
    const built = execute(doc, 'fillet_edge', { id, edges: [{ index: edge, ...law }] });
    expect(built.rejected, built.summary).toBeUndefined();
    const rows = realised(built.document, built.affected[0] as string, edge);
    expect(rows.length).toBeGreaterThan(50);
    expect(worstAgainst(rows, (u) => radiusAt(law, u))).toBeLessThan(4e-3);
  });

  it('a smooth law with a start and an end (the radiusEnd shorthand) is the zero-end-slope cubic 3u^2 - 2u^3 in the arc length, and with 3 nodes the clamped cubic spline through them, within 6e-3', () => {
    const { doc, id, edge } = scene(true);
    const two = execute(doc, 'fillet_edge', { id, edgeIndices: [edge], radius: 0.3, radiusEnd: 0.6 });
    expect(two.rejected, two.summary).toBeUndefined();
    const smoothstep = (u: number): number => 0.3 + 0.3 * (3 * u * u - 2 * u * u * u);
    expect(worstAgainst(realised(two.document, two.affected[0] as string, edge), smoothstep)).toBeLessThan(6e-3);
    // nodes (0, 0.3), (0.5, 0.8), (1, 0.4), zero slope at both ends: the slope at the middle node is 3 (y2 - y0) / (4 h) with h = 0.5
    const slope = (3 * (0.4 - 0.3)) / (4 * 0.5);
    const hermite = (r0: number, m0: number, r1: number, m1: number, x: number): number => {
      const [h, u] = [0.5, x / 0.5];
      return (
        (2 * u ** 3 - 3 * u ** 2 + 1) * r0 +
        (u ** 3 - 2 * u ** 2 + u) * h * m0 +
        (-2 * u ** 3 + 3 * u ** 2) * r1 +
        (u ** 3 - u ** 2) * h * m1
      );
    };
    const spline = (u: number): number => (u <= 0.5 ? hermite(0.3, 0, 0.8, slope, u) : hermite(0.8, slope, 0.4, 0, u - 0.5));
    const three = execute(doc, 'fillet_edge', { id, edges: [{ index: edge, size: 0.3, sizeEnd: 0.4, sizes: [{ t: 0.5, size: 0.8 }] }] });
    expect(three.rejected, three.summary).toBeUndefined();
    expect(worstAgainst(realised(three.document, three.affected[0] as string, edge), spline)).toBeLessThan(6e-3);
  });
});
