/**
 * DES-6c: the monotone radius law on the native OCCT kernel (docs/design/06-variable-blends 13.19): `interpolation: "monotone"` is a C1 cubic Hermite law
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

  it('the steepest law the kernel builds: slope 0.96 on the 5 mm edge builds, so the refusal at 1 is not tighter than OCCT', () => {
    const { doc, id } = block();
    const steep = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: [10, 5, 0], size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2.6 }], interpolation: 'monotone' }],
    });
    rows.push(`| steep monotone 1 / 2.6 / 1 on 5 mm | ${steep.result.error?.code ?? 'built'} |`);
    expect(steep.result.error?.code).not.toBe('BLD_LAW_TOO_STEEP');
  });
});
