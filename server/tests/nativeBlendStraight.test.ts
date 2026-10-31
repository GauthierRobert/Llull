/**
 * BLD true straight radius laws on the native OCCT kernel (docs/design/06-variable-blends 13.15): `interpolation: "linear"` is the exact piecewise
 * straight law (Law_Linear pieces installed in the fillet spine), not a graded-node spline. Radius read back from the contact line on the top face,
 * and the volume against the closed form, at 1 / 10 / 100 / 1000 mm. Skipped when the llull-kernel binary is not built.
 */

import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import type { ShapeEdge } from '@core/geometry/kernel';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
const SIZES = [1, 10, 100, 1000] as const;
const Q = 1 - Math.PI / 4;

describeNative('BLD straight radius laws (native OCCT kernel)', () => {
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
  const block = (s: number): { doc: Doc; id: string } => made(createEmptyDocument(), 'add_box', { size: [20 * s, 10 * s, 5 * s] });
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;

  /** Radius along the top-face contact line of the blend of the block's y+ / z+ edge, as [position along the edge from its lowest-x end, radius]. */
  const topRadii = (doc: Doc, id: string, source: string, s: number): Array<[number, number]> => {
    const shape = kernel.evaluate((doc.entities[id] as MeshSolidEntity).brep as never);
    const topology = kernel.topology(shape as never);
    const contact = topology?.edges.find((edge) => edge.name?.startsWith('e(blend') && edge.name.endsWith(`|${source}:z+)`));
    const samples = kernel.faceQuery?.edgeSamples(shape as never, contact?.index ?? -1, 1001) ?? [];
    return samples.map((sample): [number, number] => [(sample.point[0] + 10 * s) / (20 * s), 5 * s - sample.point[1]]);
  };
  const edge = { near: [0, 5, 2.5] as const };

  it.each(SIZES)('1 -> 2 straight law at %d mm: r(t) is 1 + t to 1e-12 relative, r(0.1) = 1.1, r(0.25) = 1.25', (s) => {
    const { doc, id } = block(s);
    const started = performance.now();
    const done = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: edge.near.map((v) => v * s), size: 1 * s, sizeEnd: 2 * s, interpolation: 'linear' }],
    });
    const millis = performance.now() - started;
    expect(done.result.error).toBeUndefined();
    const radii = topRadii(done.doc, done.id, id, s);
    expect(radii).toHaveLength(1001);
    const first = radii[0] as [number, number];
    const last = radii[1000] as [number, number];
    // which end carries which radius depends on the edge direction: orient t so that r(0) = 1
    const flip = first[1] > last[1];
    const at = (t: number): number => {
      const target = flip ? 1 - t : t;
      return (radii.find(([x]) => x >= target - 5e-4)?.[1] ?? Number.NaN) / s;
    };
    let worst = 0;
    for (const [x, r] of radii) worst = Math.max(worst, Math.abs(r / s - (1 + (flip ? 1 - x : x))));
    const e10 = Math.abs(at(0.1) - 1.1) / 1.1;
    const e25 = Math.abs(at(0.25) - 1.25) / 1.25;
    const expected = 1000 * s ** 3 - Q * 20 * s ** 3 * (7 / 3);
    const error = Math.abs(volume(done.doc, done.id) - expected) / expected;
    rows.push(
      `| straight 1 -> 2 | ${s} | worst ${worst.toExponential(2)}, r(.1) ${e10.toExponential(2)}, r(.25) ${e25.toExponential(2)} | V ${error.toExponential(2)} | ${millis.toFixed(0)} ms |`,
    );
    // the graded-node spline of DES-6b missed these by 1e-7 .. 1e-9: only the exact line passes
    expect(worst).toBeLessThan(1e-12);
    expect(e10).toBeLessThan(1e-12);
    expect(e25).toBeLessThan(1e-12);
    expect(error).toBeLessThan(2e-9);
  });

  /** Contact line of the blend with the top face of `source`, sampled uniformly along the edge. */
  const contactSamples = (doc: Doc, id: string, source: string, face: string, count: number): Array<readonly [number, number, number]> => {
    const shape = kernel.evaluate((doc.entities[id] as MeshSolidEntity).brep as never);
    const topology = kernel.topology(shape as never);
    const contact = topology?.edges.find((edge) => edge.name?.startsWith('e(blend') && edge.name.endsWith(`|${source}:${face})`));
    return (kernel.faceQuery?.edgeSamples(shape as never, contact?.index ?? -1, count) ?? []).map((sample) => sample.point);
  };

  it('a kinked straight law 1 -> 2 -> 1 follows its polyline to 1e-9 mm, kink included', () => {
    const { doc, id } = block(1);
    const done = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: [0, 5, 2.5], size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' }],
    });
    expect(done.result.error).toBeUndefined();
    const points = contactSamples(done.doc, done.id, id, 'z+', 1001);
    expect(points).toHaveLength(1001);
    let worst = 0;
    for (const point of points) worst = Math.max(worst, Math.abs(5 - point[1] - (2 - Math.abs(point[0]) / 10)));
    rows.push(`| kinked 1 -> 2 -> 1 | 1 | worst ${worst.toExponential(2)} |`);
    expect(worst).toBeLessThan(1e-9);
  });

  it('a closed rim with a straight law 1 -> 2 -> 1 (periodic polyline) is two straight pieces in the station along the rim', () => {
    const rim = made(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 10 });
    const done = made(rim.doc, 'fillet_edge', {
      id: rim.id,
      edges: [{ near: [5, 0, 5], size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' }],
    });
    expect(done.result.error).toBeUndefined();
    const points = contactSamples(done.doc, done.id, rim.id, 'top', 361);
    expect(points).toHaveLength(361);
    // the contact point of a ball whose radius changes is slightly ahead of its station (the sample position is the curve parameter), so the
    // station is read from the sample index: the radius is the tent 2 - |2 t - 1| there to the parameterisation of the contact curve (5e-6 mm)
    let worst = 0;
    points.forEach((point, k) => {
      worst = Math.max(worst, Math.abs(5 - Math.hypot(point[0], point[1]) - (2 - Math.abs((2 * k) / 360 - 1))));
    });
    rows.push(`| closed rim 1 -> 2 -> 1 | 1 | worst ${worst.toExponential(2)} |`);
    expect(worst).toBeLessThan(2e-5);
  });

  const areaOf = (doc: Doc, id: string, suffix: string): number => {
    const list = (execute(doc, 'inspect_topology', { id }).data as { faces: Array<{ name?: string; area: number }> }).faces;
    return list.find((face) => face.name?.endsWith(suffix))?.area ?? Number.NaN;
  };

  it.each(SIZES)(
    'an off-centre kink 1 -> 2 -> 1.5 -> 1 (t 0.3 / 0.7) at %d mm: volume and face areas are the closed forms (adaptive reading)',
    (s) => {
      const { doc, id } = block(s);
      const started = performance.now();
      const done = made(doc, 'fillet_edge', {
        id,
        edges: [
          {
            near: edge.near.map((v) => v * s),
            size: 1 * s,
            sizeEnd: 1 * s,
            sizes: [
              { t: 0.3, size: 2 * s },
              { t: 0.7, size: 1.5 * s },
            ],
            interpolation: 'linear',
          },
        ],
      });
      const millis = performance.now() - started;
      expect(done.result.error).toBeUndefined();
      // closed forms: integral of r ds = 20 * 1.525, of r^2 ds = 48.1667 (pieces L (a^2 + ab + b^2) / 3); the fixed Gauss rule read 989.8033 / 169.7588
      const expectedVolume = (1000 - Q * (6 * (7 / 3) + 8 * (9.25 / 3) + 6 * (4.75 / 3))) * s ** 3;
      const volumeError = Math.abs(volume(done.doc, done.id) - expectedVolume) / expectedVolume;
      const top = areaOf(done.doc, done.id, `${id}:z+`);
      const side = areaOf(done.doc, done.id, `${id}:y+`);
      const topError = Math.abs(top - 169.5 * s * s) / (169.5 * s * s);
      const sideError = Math.abs(side - 69.5 * s * s) / (69.5 * s * s);
      rows.push(
        `| off-centre kink | ${s} | V ${volumeError.toExponential(2)}, top ${topError.toExponential(2)}, side ${sideError.toExponential(2)} | ${millis.toFixed(0)} ms |`,
      );
      expect(volumeError).toBeLessThan(1e-8);
      expect(topError).toBeLessThan(1e-8);
      expect(sideError).toBeLessThan(1e-8);
    },
  );

  it('a refined shape without a freeform face (the kinked blend cut away by an intersection) reads its faces with the rule of its totals: the face areas sum to the mass_properties area', () => {
    const { doc, id } = block(1);
    const kinked = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: [0, 5, 2.5], size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' }],
    });
    const inner = made(kinked.doc, 'add_box', { size: [10, 4, 4] });
    const cut = made(inner.doc, 'boolean', { op: 'intersect', a: kinked.id, b: inner.id });
    expect(cut.result.error).toBeUndefined();
    const faceList = (execute(cut.doc, 'inspect_topology', { id: cut.id }).data as { faces: Array<{ surface: string; area: number }> })
      .faces;
    expect(faceList.every((face) => face.surface === 'plane')).toBe(true);
    const total = (execute(cut.doc, 'mass_properties', { entityId: cut.id }).data as { area: number }).area;
    expect(Math.abs(faceList.reduce((sum, face) => sum + face.area, 0) - total) / total).toBeLessThan(1e-12);
    // no freeform face is left: the totals use the fixed rule too (no adaptive estimate)
    expect(execute(cut.doc, 'mass_properties', { entityId: cut.id }).data).not.toHaveProperty('relErrorEstimate');
  });

  it('the same intersection with a box that keeps the blend face (30 mm cube) is read with the adaptive rule: estimate present, V = 989.985247625 to 1e-9', () => {
    const { doc, id } = block(1);
    const kinked = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: [0, 5, 2.5], size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' }],
    });
    const outer = made(kinked.doc, 'add_box', { size: [30, 30, 30] });
    const kept = made(outer.doc, 'boolean', { op: 'intersect', a: kinked.id, b: outer.id });
    expect(kept.result.error).toBeUndefined();
    const data = execute(kept.doc, 'mass_properties', { entityId: kept.id }).data as { volume: number; relErrorEstimate?: number };
    expect(data.relErrorEstimate).toBeDefined();
    expect(Math.abs(data.volume - 989.985247625) / 989.985247625).toBeLessThan(1e-9);
  });

  interface Row {
    readonly radius?: { readonly at: ReadonlyArray<{ readonly t: number; readonly value: number }> };
    readonly lawChecked?: boolean;
    readonly contacts: ReadonlyArray<{ readonly edge: number; readonly name: string }>;
  }
  /** The rows of the 7 rim blends that have a radius readback (the 8th, a corner arc, has none), with the topology of the shape they are in. */
  const chainRows = (doc: Doc, id: string): { rows: Row[]; edges: readonly ShapeEdge[] } => {
    const rows = (execute(doc, 'check_blends', { ids: [id] }).data as { blends: Row[] }).blends.filter(
      (row) => (row.radius?.at[0]?.value ?? 5) < 4,
    );
    const shape = kernel.evaluate((doc.entities[id] as MeshSolidEntity).brep as never);
    return { rows, edges: kernel.topology(shape as never)?.edges ?? [] };
  };
  const roundedSlab = (): { doc: Doc; id: string } => {
    const slab = made(createEmptyDocument(), 'add_box', { size: [40, 30, 6], anchor: 'min' });
    return made(slab.doc, 'fillet_edge', {
      id: slab.id,
      edgesNear: [
        [0, 0, 3],
        [40, 0, 3],
        [0, 30, 3],
        [40, 30, 3],
      ],
      radius: 5,
    });
  };
  /**
   * Junctions of the rim chain: two rows whose contact lines on the top face share an end point (to 1e-6 mm). The two blends must carry the same
   * radius there (to the 1e-6 readback of the section circle): one of the two ends of the first row equals one of the two ends of the second.
   * 7 of the 8 blends are read, so 6 junctions are seen.
   */
  const expectContinuousChain = (
    { rows: chain, edges }: { rows: Row[]; edges: readonly ShapeEdge[] },
    rowCount = 7,
    junctionCount = 6,
  ): void => {
    expect(chain).toHaveLength(rowCount);
    const top = chain.map((row) => edges[row.contacts.find((contact) => /:z\+\)(#\d+)?$/.test(contact.name))?.edge ?? -1]);
    expect(top.every((edge) => edge !== undefined)).toBe(true);
    const near = (a: readonly number[] | undefined, b: readonly number[] | undefined): boolean =>
      a !== undefined &&
      b !== undefined &&
      Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0)) < 1e-6;
    /**
     * The radius of `row` at the end of its top contact line that sits at `point`: the readback runs from t = 0 at the start of the blend's
     * contact line to t = 1 at its end, so the end at `point` is at[0] when `point` is the start of the contact edge, else at[10]. A reversed
     * direction would pair unequal radii and fail the junction check below.
     */
    const radiusAt = (row: Row, edge: ShapeEdge, point: readonly number[]): number => {
      const first = edge.start;
      const startEnd = near(point, first);
      return (startEnd ? row.radius?.at[0]?.value : row.radius?.at[10]?.value) ?? Number.NaN;
    };
    let junctions = 0;
    for (let a = 0; a < chain.length; a++)
      for (let b = a + 1; b < chain.length; b++) {
        const first = top[a];
        const second = top[b];
        if (first === undefined || second === undefined) continue;
        const shared = [first.start, first.end].find((p) => near(p, second.start) || near(p, second.end));
        if (shared === undefined) continue;
        junctions++;
        const gap = Math.abs(radiusAt(chain[a] as Row, first, shared) - radiusAt(chain[b] as Row, second, shared));
        expect(gap, `junction of rows ${a} and ${b}`).toBeLessThan(1e-5);
      }
    expect(junctions).toBe(junctionCount);
  };
  const secondDifference = (row: Row): number => {
    const at = row.radius?.at ?? [];
    return Math.abs((at[0]?.value ?? 0) - 2 * (at[1]?.value ?? 0) + (at[2]?.value ?? 0));
  };

  it('a straight law on one edge of a tangent-chained rim: that edge is the exact line, the chain is continuous, nothing else is a law', () => {
    const { doc, id } = roundedSlab();
    const done = made(doc, 'fillet_edge', { id, edges: [{ near: [20, 30, 6], size: 1, sizeEnd: 2, interpolation: 'linear' }] });
    expect(done.result.error).toBeUndefined();
    const chain = chainRows(done.doc, done.id);
    expectContinuousChain(chain);
    const lines = chain.rows.filter((row) => row.lawChecked === true);
    expect(lines).toHaveLength(1);
    for (const point of lines[0]?.radius?.at ?? []) expect(Math.abs(point.value - (1 + point.t))).toBeLessThan(2e-5);
    // an edge pulled into the chain by tangency, with no law of its own, keeps OCCT's curved transition: its radius is not a line
    expect(chain.rows.filter((row) => row.lawChecked === false && secondDifference(row) > 1e-4).length).toBeGreaterThan(0);
  });

  it("a mixed chain (a straight law and a smooth one on the same rim): the straight edge is exact, the smooth one is OCCT's own S shape (zero slope at both ends), radius continuous", () => {
    const { doc, id } = roundedSlab();
    const smoothLaw = { near: [20, 0, 6], size: 1, sizeEnd: 2 };
    const mixed = made(doc, 'fillet_edge', { id, edges: [{ near: [20, 30, 6], size: 1, sizeEnd: 2, interpolation: 'linear' }, smoothLaw] });
    expect(mixed.result.error).toBeUndefined();
    const chain = chainRows(mixed.doc, mixed.id);
    // with two laws on the rim every one of the 8 rim blends has a radius readback (the laws are read along the edges, 13.27) and the loop has 8 junctions
    expectContinuousChain(chain, 8, 8);
    const straight = chain.rows.filter((row) => (row.radius?.at[1]?.value ?? 0) > 1.0999 && (row.radius?.at[1]?.value ?? 0) < 1.1001);
    expect(straight).toHaveLength(1);
    for (const point of straight[0]?.radius?.at ?? []) expect(Math.abs(point.value - (1 + point.t))).toBeLessThan(2e-5);
    // the smooth edge: OCCT's cubic with zero slope at the ends (1.04 at t = 0.1 against 1.1 on a line)
    // (a row's readback runs along its contact line, which may run against its edge: the smooth edge reads 2 -> 1 here, with 1.972 at t = 0.1 where a line has 1.9)
    const isSmooth = (row: Row): boolean =>
      row.lawChecked === true &&
      Math.abs((row.radius?.at[0]?.value ?? 0) - (row.radius?.at[10]?.value ?? 0)) > 0.5 &&
      !straight.includes(row);
    const smooth = chain.rows.filter(isSmooth);
    expect(smooth).toHaveLength(1);
    // the smooth stretch is OCCT's spline through the nodes of the whole contour, so its shape depends on the neighbouring law (it is no longer the all-smooth shape row for row, 13.27): an S with zero slope at both ends and the two radii at its ends
    const values = (smooth[0]?.radius?.at ?? []).map((point) => point.value);
    expect(values).toHaveLength(11);
    expect(Math.abs((values[0] ?? 0) - (values[10] ?? 0))).toBeCloseTo(1, 6);
    expect(Math.abs((values[0] ?? 0) - (values[1] ?? 0))).toBeLessThan(0.05);
    expect(Math.abs((values[10] ?? 0) - (values[9] ?? 0))).toBeLessThan(0.05);
    expect(Math.abs((values[5] ?? 0) - 1.5)).toBeLessThan(1e-3);
  });
});
