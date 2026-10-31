/**
 * DES-6c: the monotone radius law on the native OCCT kernel (docs/design/06-variable-blends 13.23): `interpolation: "monotone"` is a C1 cubic Hermite law
 * through the stations installed in the fillet spine (Law_BSpFunc pieces), exact and never below the smallest station. Radius read back from the contact line
 * on the top face against the closed form, the volume against `abc - (1 - pi/4) L integral r(t)^2 dt` by Simpson quadrature, the two-station law against
 * OCCT's own smooth transition, check_blends reading the law back, and the steepness the kernel carries. Skipped when the llull-kernel binary is not built.
 */

import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { lawNodes } from '@core/geometry/blend/law';
import { monotoneRadius } from '@core/geometry/blend/monotone';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
const Q = 1 - Math.PI / 4;
const LENGTH = 20;

const STATIONS = [
  { t: 0, size: 1 },
  { t: 0.3, size: 2 },
  { t: 0.7, size: 1.4 },
  { t: 1, size: 1.2 },
];
const LAW = {
  size: 1,
  sizeEnd: 1.2,
  sizes: [
    { t: 0.3, size: 2 },
    { t: 0.7, size: 1.4 },
  ],
  interpolation: 'monotone' as const,
};

/** Simpson integral of r(t)^2 over [0, 1] for the monotone curve through `stations`. */
function squareIntegral(stations: ReadonlyArray<{ t: number; size: number }>): number {
  const n = 40000;
  let sum = 0;
  for (let k = 0; k <= n; k++) {
    const r = monotoneRadius(stations, k / n);
    sum += (k === 0 || k === n ? 1 : k % 2 === 1 ? 4 : 2) * r * r;
  }
  return sum / (3 * n);
}

describeNative('BLD monotone radius laws (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const rows: string[] = [];
  afterAll(() => {
    const table = process.env['LLULL_BLEND_TABLE'];
    if (table !== undefined) appendFileSync(table, `${rows.join('\n')}\n`);
  });
  const made = (
    doc: Doc,
    command: string,
    params: Record<string, unknown>,
  ): { doc: Doc; id: string; result: ReturnType<typeof execute> } => {
    const result = execute(doc, command, params);
    return { doc: result.document, id: result.affected[0] as string, result };
  };
  const block = (): { doc: Doc; id: string } => made(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const topEdge = [0, 5, 2.5] as const;

  /** Radius along the top-face contact line of the blend of the block's y+ / z+ edge, oriented so that t = 0 is the start of the law. */
  const topRadii = (doc: Doc, id: string, source: string): Array<[number, number]> => {
    const shape = kernel.evaluate((doc.entities[id] as MeshSolidEntity).brep as never);
    const topology = kernel.topology(shape as never);
    const contact = topology?.edges.find((edge) => edge.name?.startsWith('e(blend') && edge.name.endsWith(`|${source}:z+)`));
    const samples = kernel.faceQuery?.edgeSamples(shape as never, contact?.index ?? -1, 1001) ?? [];
    const radii = samples.map((sample): [number, number] => [(sample.point[0] + 10) / 20, 5 - sample.point[1]]);
    return radii;
  };

  /** [t, r] samples with t counted from the end of the edge where the law starts (the edge direction decides which end that is). */
  const oriented = (radii: Array<[number, number]>, start: number): Array<[number, number]> => {
    const flip = Math.abs((radii[0] as [number, number])[1] - start) > Math.abs((radii[1000] as [number, number])[1] - start);
    return radii.map(([x, r]): [number, number] => [flip ? 1 - x : x, r]);
  };

  it('stations 1 / 2 / 1.4 / 1.2: r(t) is the closed-form monotone curve along the contact line, the volume is the closed form, no sample below the smallest station', () => {
    const { doc, id } = block();
    const started = performance.now();
    const done = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, ...LAW }] });
    const millis = performance.now() - started;
    expect(done.result.error, done.result.summary).toBeUndefined();
    const radii = oriented(topRadii(done.doc, done.id, id), 1);
    expect(radii).toHaveLength(1001);
    let worst = 0;
    let lowest = Infinity;
    for (const [t, r] of radii) {
      worst = Math.max(worst, Math.abs(r - monotoneRadius(STATIONS, t)));
      lowest = Math.min(lowest, r);
    }
    const expected = 1000 - Q * LENGTH * squareIntegral(STATIONS);
    const actual = volume(done.doc, done.id);
    const error = Math.abs(actual - expected) / expected;
    rows.push(
      `| monotone 1 / 2 / 1.4 / 1.2 | worst ${worst.toExponential(2)}, min r ${lowest.toFixed(9)}, V ${actual.toFixed(6)} (closed ${expected.toFixed(6)}, ${error.toExponential(2)}) | ${millis.toFixed(0)} ms |`,
    );
    expect(worst).toBeLessThan(1e-7);
    expect(lowest).toBeGreaterThanOrEqual(1 - 1e-7);
    expect(error).toBeLessThan(1e-7);
  });

  it("a start and an end alone: the monotone law is the exact smoothstep (volume to 1e-7 of the closed form); OCCT's own smooth transition differs from it by about 8e-5 of the volume", () => {
    const { doc, id } = block();
    const smooth = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, size: 1, sizeEnd: 2 }] });
    const monotone = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, size: 1, sizeEnd: 2, interpolation: 'monotone' }] });
    expect(smooth.result.error, smooth.result.summary).toBeUndefined();
    expect(monotone.result.error, monotone.result.summary).toBeUndefined();
    const pair = [
      { t: 0, size: 1 },
      { t: 1, size: 2 },
    ];
    const expected = 1000 - Q * LENGTH * squareIntegral(pair);
    const [monotoneV, smoothV] = [volume(monotone.doc, monotone.id), volume(smooth.doc, smooth.id)];
    rows.push(
      `| two stations 1 -> 2 | monotone V ${monotoneV.toFixed(6)} (closed ${expected.toFixed(6)}, ${(Math.abs(monotoneV - expected) / expected).toExponential(2)}), OCCT smooth V ${smoothV.toFixed(6)} (${(Math.abs(smoothV - expected) / expected).toExponential(2)}) |`,
    );
    expect(Math.abs(monotoneV - expected) / expected).toBeLessThan(1e-7);
    expect(Math.abs(smoothV - expected) / expected).toBeGreaterThan(1e-5);
    let worst = 0;
    for (const [t, r] of oriented(topRadii(monotone.doc, monotone.id, id), 1))
      worst = Math.max(worst, Math.abs(r - monotoneRadius(pair, t)));
    expect(worst).toBeLessThan(1e-7);
  });

  it('OCCT smooth interpolation through a plateau and a jump undershoots the plateau radius; the monotone law does not', () => {
    const plateau = {
      size: 1,
      sizeEnd: 3,
      sizes: [
        { t: 0.4, size: 1 },
        { t: 0.6, size: 3 },
      ],
    };
    const { doc, id } = block();
    const smooth = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, ...plateau }] });
    const monotone = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, ...plateau, interpolation: 'monotone' }] });
    expect(smooth.result.error, smooth.result.summary).toBeUndefined();
    expect(monotone.result.error, monotone.result.summary).toBeUndefined();
    const lowestOf = (done: { doc: Doc; id: string }): number =>
      Math.min(...oriented(topRadii(done.doc, done.id, id), 1).map(([, r]) => r));
    const [smoothLow, monotoneLow] = [lowestOf(smooth), lowestOf(monotone)];
    rows.push(`| plateau 1 / 1 / 3 / 3 | smooth min r ${smoothLow.toFixed(6)}, monotone min r ${monotoneLow.toFixed(9)} |`);
    expect(monotoneLow).toBeGreaterThanOrEqual(1 - 1e-7);
    expect(smoothLow).toBeLessThan(1 - 1e-3);
  });

  it('the OCP export of a monotone law (the nodes lawNodes sends, interpolated by the own spline of OCCT) reproduces the exact law within the measured volume gap', () => {
    const nodes = lawNodes(LAW, LENGTH) ?? [];
    const interior = nodes.slice(1, -1).map(([t, size]) => ({ t, size }));
    const { doc, id } = block();
    const exported = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, size: 1, sizeEnd: 1.2, sizes: interior }] });
    expect(exported.result.error, exported.result.summary).toBeUndefined();
    const expected = 1000 - Q * LENGTH * squareIntegral(STATIONS);
    const error = Math.abs(volume(exported.doc, exported.id) - expected) / expected;
    let worst = 0;
    for (const [t, r] of oriented(topRadii(exported.doc, exported.id, id), 1))
      worst = Math.max(worst, Math.abs(r - monotoneRadius(STATIONS, t)));
    rows.push(`| OCP export nodes (${nodes.length}) | V ${error.toExponential(2)}, radius ${worst.toExponential(2)} |`);
    expect(error).toBeLessThan(1e-5);
    expect(worst).toBeLessThan(3e-3);
  });

  it('check_blends reads the monotone law back everywhere: min / max of the realised radius, the control points, and no BLD_CHECK_RADIUS_LAW', () => {
    const { doc, id } = block();
    const done = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, ...LAW }] });
    const data = execute(done.doc, 'check_blends', {}).data as {
      blends: Array<{ radius?: { min: number; max: number; at: Array<{ t: number; value: number }> } }>;
      findings: Array<{ code: string }>;
    };
    const radius = data.blends[0]?.radius;
    expect(radius).toBeDefined();
    expect(radius?.min).toBeCloseTo(1, 4);
    expect(radius?.max).toBeCloseTo(monotoneRadiusMax(), 4);
    expect(radius?.at.find((sample) => Math.abs(sample.t - 0.3) < 1e-9)?.value).toBeCloseTo(2, 4);
    expect(radius?.at.find((sample) => Math.abs(sample.t - 0.7) < 1e-9)?.value).toBeCloseTo(1.4, 4);
    expect(data.findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_RADIUS_LAW');
    function monotoneRadiusMax(): number {
      let top = 0;
      for (let k = 0; k <= 10000; k++) top = Math.max(top, monotoneRadius(STATIONS, k / 10000));
      return top;
    }
  });

  /** A 400 x 400 x 5 block (faces far wider than any radius below), its vertical edge at (200, 200): the edge is 5 mm long. */
  it.each([0.5, 1.1, 1.5, 3, 12, 50])(
    'no kernel limit on the slope: r 1 -> 1 + %d * 5 on a 5 mm edge builds, the linear law to 5e-8 and the monotone one to 1e-7 of their closed forms',
    (slope) => {
      const wide = made(createEmptyDocument(), 'add_box', { size: [400, 400, 5] });
      const end = 1 + slope * 5;
      const [linear, monotone] = [
        made(wide.doc, 'fillet_edge', { id: wide.id, edges: [{ near: [200, 200, 0], size: 1, sizeEnd: end, interpolation: 'linear' }] }),
        made(wide.doc, 'fillet_edge', { id: wide.id, edges: [{ near: [200, 200, 0], size: 1, sizeEnd: end, interpolation: 'monotone' }] }),
      ];
      expect(linear.result.error, linear.result.summary).toBeUndefined();
      expect(monotone.result.error, monotone.result.summary).toBeUndefined();
      const block = 400 * 400 * 5;
      const [linearExpected, monotoneExpected] = [
        block - Q * 5 * ((1 + end + end * end) / 3),
        block -
          Q *
            5 *
            squareIntegral([
              { t: 0, size: 1 },
              { t: 1, size: end },
            ]),
      ];
      const [linearError, monotoneError] = [
        Math.abs(volume(linear.doc, linear.id) - linearExpected) / linearExpected,
        Math.abs(volume(monotone.doc, monotone.id) - monotoneExpected) / monotoneExpected,
      ];
      rows.push(
        `| slope ${slope} (r 1 -> ${end}) on 5 mm | linear V ${linearError.toExponential(2)}, monotone V ${monotoneError.toExponential(2)} |`,
      );
      expect(linearError).toBeLessThan(5e-8);
      expect(monotoneError).toBeLessThan(1e-7);
    },
  );

  it('a closed rim (the periodic seam of the law): stations 1 / 2 / 1 on a cylinder rim of radius 10 follow the closed-form curve to 1e-5 all round, and r(0) = r(1)', () => {
    const rim = made(createEmptyDocument(), 'add_cylinder', { radius: 10, height: 10 });
    const done = made(rim.doc, 'fillet_edge', {
      id: rim.id,
      edges: [{ near: [10, 0, 10], size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'monotone' }],
    });
    expect(done.result.error, done.result.summary).toBeUndefined();
    const shape = kernel.evaluate((done.doc.entities[done.id] as MeshSolidEntity).brep as never);
    const topology = kernel.topology(shape as never);
    const contact = topology?.edges.find((edge) => edge.name?.startsWith('e(blend') && edge.name.endsWith(`|${rim.id}:top)`));
    const samples = kernel.faceQuery?.edgeSamples(shape as never, contact?.index ?? -1, 1001) ?? [];
    expect(samples).toHaveLength(1001);
    const pair = [
      { t: 0, size: 1 },
      { t: 0.5, size: 2 },
      { t: 1, size: 1 },
    ];
    let worst = 0;
    samples.forEach((sample, k) => {
      const radius = 10 - Math.hypot(sample.point[0], sample.point[1]);
      worst = Math.max(worst, Math.abs(radius - monotoneRadius(pair, k / 1000)));
    });
    rows.push(`| closed rim 1 / 2 / 1 | worst ${worst.toExponential(2)} |`);
    expect(worst).toBeLessThan(1e-5);
  });

  it('a conic profile with a monotone law builds, follows the law (check_blends: no BLD_CHECK_RADIUS_LAW) and is a different solid from the circular blend of the same law', () => {
    const { doc, id } = block();
    const circular = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, ...LAW }] });
    const conic = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, ...LAW }], profile: { type: 'conic', rho: 0.4 } });
    expect(conic.result.error, conic.result.summary).toBeUndefined();
    const [circularV, conicV] = [volume(circular.doc, circular.id), volume(conic.doc, conic.id)];
    rows.push(`| conic rho 0.4 with the monotone law | V ${conicV.toFixed(6)} (circular ${circularV.toFixed(6)}) |`);
    expect(Math.abs(conicV - circularV)).toBeGreaterThan(1e-3);
    const data = execute(conic.doc, 'check_blends', {}).data as { findings: Array<{ code: string }> };
    expect(data.findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_RADIUS_LAW');
  });

  it('a chain that mixes kinds (the rim of a rounded block: the long edges monotone, the others OCCT smooth) builds and keeps the monotone volume of each long edge', () => {
    const slab = made(createEmptyDocument(), 'add_box', { size: [40, 20, 10], anchor: 'base-center' });
    const round = made(slab.doc, 'fillet_edge', {
      id: slab.id,
      edgesNear: [
        [20, 10, 5],
        [20, -10, 5],
        [-20, 10, 5],
        [-20, -10, 5],
      ],
      radius: 5,
    });
    const shape = kernel.evaluate((round.doc.entities[round.id] as MeshSolidEntity).brep as never);
    const rim = (kernel.topology(shape as never)?.edges ?? []).filter(
      (edge) => Math.abs(edge.start[2] - 10) < 1e-9 && Math.abs(edge.end[2] - 10) < 1e-9,
    );
    const mixed = made(round.doc, 'fillet_edge', {
      id: round.id,
      edges: rim.map((edge) =>
        edge.length > 20
          ? {
              index: edge.index,
              size: 1.5,
              sizeEnd: 1.5,
              sizes: [
                { t: 0.3, size: 1 },
                { t: 0.7, size: 2 },
              ],
              interpolation: 'monotone',
            }
          : { index: edge.index, size: 1.5, sizeEnd: 1.5 },
      ),
    });
    expect(mixed.result.error, mixed.result.summary).toBeUndefined();
    const allSmooth = made(round.doc, 'fillet_edge', { id: round.id, edges: rim.map((edge) => ({ index: edge.index, size: 1.5 })) });
    const difference = Math.abs(volume(mixed.doc, mixed.id) - volume(allSmooth.doc, allSmooth.id));
    rows.push(`| mixed monotone + smooth chain | builds, volume differs from the constant 1.5 rim by ${difference.toFixed(4)} |`);
    expect(difference).toBeGreaterThan(1e-3);
  });

  it('a tangent chain (the top rim of a rounded block: 8 edges, one spline): every edge follows ITS OWN monotone curve with zero slope at its ends, not a curve through the whole chain', () => {
    const slab = made(createEmptyDocument(), 'add_box', { size: [40, 20, 10], anchor: 'base-center' });
    const round = made(slab.doc, 'fillet_edge', {
      id: slab.id,
      edgesNear: [
        [20, 10, 5],
        [20, -10, 5],
        [-20, 10, 5],
        [-20, -10, 5],
      ],
      radius: 5,
    });
    expect(round.result.error, round.result.summary).toBeUndefined();
    const shape = kernel.evaluate((round.doc.entities[round.id] as MeshSolidEntity).brep as never);
    const rim = (kernel.topology(shape as never)?.edges ?? []).filter(
      (edge) => Math.abs(edge.start[2] - 10) < 1e-9 && Math.abs(edge.end[2] - 10) < 1e-9,
    );
    expect(rim.length).toBe(8);
    // equal radii at both ends and a decreasing run through the junction (2 -> 1.5 | 1.5 -> 1): the harmonic-mean slope of a run that crossed the edge boundary is not zero
    const stations = [
      { t: 0, size: 1.5 },
      { t: 0.3, size: 1 },
      { t: 0.7, size: 2 },
      { t: 1, size: 1.5 },
    ];
    const law = {
      size: 1.5,
      sizeEnd: 1.5,
      sizes: [
        { t: 0.3, size: 1 },
        { t: 0.7, size: 2 },
      ],
      interpolation: 'monotone' as const,
    };
    const chained = made(round.doc, 'fillet_edge', { id: round.id, edges: rim.map((edge) => ({ index: edge.index, ...law })) });
    expect(chained.result.error, chained.result.summary).toBeUndefined();
    const built = kernel.evaluate((chained.doc.entities[chained.id] as MeshSolidEntity).brep as never);
    const after = kernel.topology(built as never);
    const prefix = `e(blend(e(${slab.id}:y-|${slab.id}:z+))|${slab.id}:z+)`;
    const contact = (after?.edges ?? []).filter((edge) => edge.name?.startsWith(prefix)).sort((x, y) => y.length - x.length)[0];
    expect(contact?.length).toBeGreaterThan(28);
    const samples = kernel.faceQuery?.edgeSamples(built as never, contact?.index ?? -1, 1001) ?? [];
    expect(samples).toHaveLength(1001);
    const against = (reversed: boolean): number => {
      let worst = 0;
      samples.forEach((sample) => {
        // the position along the straight rim edge (x from -15 to 15) is the law parameter, up to the direction of the edge
        const along = (sample.point[0] + 15) / 30;
        const t = reversed ? 1 - along : along;
        // the first and last 8 % of the edge are trimmed by the corner patches, where the contact line is not at distance r from the edge
        if (t < 0.08 || t > 0.92) return;
        worst = Math.max(worst, Math.abs(10 + sample.point[1] - monotoneRadius(stations, t)));
      });
      return worst;
    };
    const worst = Math.min(against(false), against(true));
    rows.push(`| tangent chain, long edge | worst ${worst.toExponential(2)} |`);
    expect(worst).toBeLessThan(1.5e-2);
  });
});
