/**
 * BLD M0 on the native OCCT kernel (docs/design/06-variable-blends, validation pack): OCCT fillet diagnostics mapped to BLD_* codes, the native
 * edge queries behind check_blends, probe_fillet, and the measured construction of the existing radius laws (VC-BLD-02, 03, 05, 10, 13, 20, 21, 30).
 * Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
interface Face {
  readonly name?: string;
  readonly area: number;
}

describeNative('BLD M0: fillet diagnostics, probe_fillet, check_blends and the radius laws (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
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
  const cube = (): { doc: Doc; id: string } => made(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const faces = (doc: Doc, id: string): Face[] => (execute(doc, 'inspect_topology', { id }).data as { faces: Face[] }).faces;
  const areaOf = (list: Face[], suffix: string): number => list.find((face) => face.name?.endsWith(suffix))?.area ?? Number.NaN;
  const handleOf = (doc: Doc, id: string): ReturnType<IsolatedKernel['evaluate']> =>
    kernel.evaluate((doc.entities[id] as MeshSolidEntity).brep as never);

  it('VC-BLD-02: the linear law r 1 -> 2 keeps the planar contact areas exact (top 170, side 70) and records the construction volume', () => {
    const { doc, id } = block();
    const done = made(doc, 'fillet_edge', { id, edgesNear: [[0, 5, 2.5]], radius: 1, radiusEnd: 2 });
    const list = faces(done.doc, done.id);
    expect(areaOf(list, `${id}:z+`)).toBeCloseTo(170, 6);
    expect(areaOf(list, `${id}:y+`)).toBeCloseTo(70, 6);
    const measured = volume(done.doc, done.id);
    expect(measured).toBeCloseTo(989.896820782, 4);
    expect(Math.abs(measured / 989.985247625 - 1)).toBeLessThan(2e-4);
  });

  it('VC-BLD-30: r 1 -> 3 gives areas 160 / 60 exactly; OCCT builds neither the normal-section (981.401174) nor the envelope (981.462234) volume', () => {
    const { doc, id } = block();
    const done = made(doc, 'fillet_edge', { id, edgesNear: [[0, 5, 2.5]], radius: 1, radiusEnd: 3 });
    const list = faces(done.doc, done.id);
    expect(areaOf(list, `${id}:z+`)).toBeCloseTo(160, 6);
    expect(areaOf(list, `${id}:y+`)).toBeCloseTo(60, 6);
    const measured = volume(done.doc, done.id);
    expect(measured).toBeCloseTo(981.047466455, 4);
    expect(981.401174161 - measured).toBeGreaterThan(0.3);
    expect(981.4622344 - measured).toBeGreaterThan(0.3);
    expect(Math.abs(measured / 981.401174161 - 1)).toBeLessThan(5e-4);
  });

  it('VC-BLD-03 (smooth): the control point (0.5, 2) is met: the contact line on the top face is r = 2 from the edge at mid-span', () => {
    const { doc, id } = block();
    const done = made(doc, 'fillet_edge', { id, edges: [{ near: [0, 5, 2.5], size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }] }] });
    const shape = handleOf(done.doc, done.id);
    const topology = kernel.topology(shape as never);
    const contact = topology?.edges.find((edge) => edge.name?.endsWith(`|${id}:z+)`) && edge.name.startsWith('e(blend'));
    expect(contact).toBeDefined();
    const samples = kernel.faceQuery?.edgeSamples(shape as never, contact?.index ?? -1, 1001) ?? [];
    expect(samples).toHaveLength(1001);
    const at = samples.findIndex((sample) => sample.point[0] >= 0);
    const [before, after] = [samples[at - 1], samples[at]];
    const blend = (0 - (before?.point[0] ?? 0)) / ((after?.point[0] ?? 1) - (before?.point[0] ?? 0));
    const y = (before?.point[1] ?? 0) + blend * ((after?.point[1] ?? 0) - (before?.point[1] ?? 0));
    expect(5 - y).toBeCloseTo(2, 4);
    expect(samples[0]?.t).toBe(0);
    expect(samples[1000]?.t).toBe(1);
  });

  it('VC-BLD-05: chord 2 on a 60 degree edge (r = 1.154701) removes the analytic volume', () => {
    const prism = made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [0, 0],
        [10, 0],
        [5, 8.660254037844386],
      ],
      depth: 10,
    });
    const done = made(prism.doc, 'fillet_edge', { id: prism.id, edgesNear: [[0, 0, 5]], radius: 2, mode: 'chord' });
    expect(volume(done.doc, done.id)).toBeCloseTo(423.881325141, 6);
  });

  it('VC-BLD-10: a circular fillet is G1 and not G2 to its planes: contact g2Gap = 1/r, g2Rel 1, normals parallel', () => {
    const { doc, id } = cube();
    const done = made(doc, 'fillet_edge', { id, edgesNear: [[5, 5, 0]], radius: 1 });
    const result = execute(done.doc, 'check_blends', {});
    const data = result.data as {
      status: string;
      blends: Array<{ contacts: Array<{ g0Gap: number; g1AngleRad: number; g2Gap: number; g2Rel: number; order: string }> }>;
      findings: Array<{ code: string; severity: string }>;
    };
    expect(data.status).toBe('pass');
    expect(data.blends).toHaveLength(1);
    const contacts = data.blends[0]?.contacts ?? [];
    expect(contacts).toHaveLength(2);
    for (const contact of contacts) {
      expect(contact.g0Gap).toBeLessThan(1e-9);
      expect(contact.g1AngleRad).toBeLessThan(1e-6);
      expect(contact.g2Gap).toBeCloseTo(1, 6);
      expect(contact.g2Rel).toBeCloseTo(1, 6);
      expect(contact.order).toBe('G1');
    }
    expect(data.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['BLD_CHECK_G2_JUMP', 'info'],
      ['BLD_CHECK_G2_JUMP', 'info'],
    ]);
    const strict = execute(done.doc, 'check_blends', { require: 'G2' });
    expect((strict.data as { status: string }).status).toBe('fail');
  });

  it('native edge queries: a cylinder rim has curvature 1/R and torsion 0; a sharp box edge is a right angle with G0 closure', () => {
    const cyl = made(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 10 });
    const shape = handleOf(cyl.doc, cyl.id) ?? kernel.evaluate({ op: 'solid', entity: cyl.doc.entities[cyl.id] as never });
    const topology = kernel.topology(shape as never);
    const rim = topology?.edges.find((edge) => edge.curve === 'circle')?.index ?? -1;
    const samples = kernel.faceQuery?.edgeSamples(shape as never, rim, 9) ?? [];
    expect(samples).toHaveLength(9);
    expect(samples[4]?.curvature).toBeCloseTo(0.2, 9);
    expect(samples[4]?.torsion).toBeCloseTo(0, 9);
    expect(samples[8]?.s).toBeCloseTo(2 * Math.PI * 5, 6);
    const sharp = kernel.faceQuery?.edgeContinuity(shape as never, rim, 5) ?? [];
    expect(sharp[0]?.g1).toBeCloseTo(Math.PI / 2, 9);
    expect(sharp[0]?.normalCurvature[0]).toBeCloseTo(0, 9);
    expect(kernel.faceQuery?.edgeSamples(shape as never, 999, 5)).toBeNull();
    expect(kernel.faceQuery?.edgeContinuity(shape as never, rim, 1)).toBeNull();
  });

  it('VC-BLD-21: a radius too large is BLD_RADIUS_TOO_LARGE with the edge, the radius path and the largest radius that builds; the document is unchanged', () => {
    const { doc, id } = block();
    const refused = execute(doc, 'fillet_edge', { id, edgesNear: [[0, 5, 2.5]], radius: 6 });
    expect(refused.document).toBe(doc);
    expect(refused.affected).toEqual([]);
    expect(refused.error).toMatchObject({ code: 'BLD_RADIUS_TOO_LARGE', ids: [id], paths: ['radius'] });
    expect(refused.error?.remediation).toContain('probe_fillet');
    expect(refused.summary).toContain('StartsolFailure');
    expect(refused.summary).toContain(`e(${id}:y+|${id}:z+)`);
    const largest = Number(/largest that builds: ([\d.]+) mm/.exec(refused.summary)?.[1]);
    expect(largest).toBeGreaterThan(4.9);
    expect(largest).toBeLessThan(5);
    const built = execute(doc, 'fillet_edge', { id, edgesNear: [[0, 5, 2.5]], radius: largest });
    expect(built.affected).toHaveLength(1);
  });

  it('a corner OCCT cannot build is BLD_CORNER_FAILED with the vertex (rib 4 wide, two r = 2 round-overs)', () => {
    const rib = made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [-2, 0],
        [2, 0],
        [2, 10],
        [-2, 10],
      ],
      depth: 20,
    });
    const refused = execute(rib.doc, 'fillet_edge', {
      id: rib.id,
      edgesNear: [
        [-2, 10, 10],
        [2, 10, 10],
      ],
      radius: 2,
    });
    expect(refused.document).toBe(rib.doc);
    expect(refused.error).toMatchObject({ code: 'BLD_CORNER_FAILED', ids: [rib.id] });
    expect(refused.summary).toContain('corner at [');
  });

  it('VC-BLD-13: the 4-edge pyramid apex builds on OCCT 7.9.2 (valid solid, 11 faces, 23 edges), so no BLD_CORNER_UNSUPPORTED is raised', () => {
    const pyramid = made(createEmptyDocument(), 'add_pyramid', { baseWidth: 10, baseDepth: 10, height: 10 });
    const done = made(pyramid.doc, 'fillet_edge', {
      id: pyramid.id,
      edgesNear: [
        [2.5, 2.5, 5],
        [-2.5, 2.5, 5],
        [-2.5, -2.5, 5],
        [2.5, -2.5, 5],
      ],
      radius: 0.5,
    });
    expect(done.result.error).toBeUndefined();
    expect(done.result.affected).toHaveLength(1);
    const topology = execute(done.doc, 'inspect_topology', { id: done.id }).data as { faces: unknown[]; edges: unknown[] };
    expect([topology.faces.length, topology.edges.length]).toEqual([11, 23]);
    const report = kernel.blendReport?.((done.doc.entities[done.id] as MeshSolidEntity).brep as never);
    expect(report).toMatchObject({ stage: 'none', done: true, valid: true, vertices: [] });
    const apex = report?.unsupportedVertices.find((vertex) => Math.abs(vertex.point[2] - 10) < 1e-9);
    expect(apex).toMatchObject({ edgeCount: 4, selectedEdgeCount: 4 });
  });

  it('VC-BLD-20: probe_fillet on the block top edge gives maxRadius < 5; 0.99 x builds and 1.01 x is refused with BLD_RADIUS_TOO_LARGE', () => {
    const { doc, id } = block();
    const probe = execute(doc, 'probe_fillet', { id, edgesNear: [[0, 5, 2.5]] });
    expect(probe.document).toBe(doc);
    const data = probe.data as { edges: Array<{ maxRadius: number; upperBound: number; limitingCode: string; evaluations: number }> };
    const [edge] = data.edges;
    expect(edge?.upperBound).toBe(5);
    expect(edge?.maxRadius).toBeLessThan(5);
    expect(edge?.maxRadius).toBeGreaterThan(4.9);
    expect(edge?.limitingCode).toBe('BLD_RADIUS_TOO_LARGE');
    expect(edge?.evaluations).toBeLessThanOrEqual(12);
    const radius = edge?.maxRadius ?? 0;
    expect(execute(doc, 'fillet_edge', { id, edgesNear: [[0, 5, 2.5]], radius: 0.99 * radius }).affected).toHaveLength(1);
    expect(execute(doc, 'fillet_edge', { id, edgesNear: [[0, 5, 2.5]], radius: 1.01 * radius }).error?.code).toBe('BLD_RADIUS_TOO_LARGE');
  });

  it('probe_fillet grows past the mean-width guess: a cylinder rim R 10 H 50 accepts more than the guess 5', () => {
    const { doc, id } = made(createEmptyDocument(), 'add_cylinder', { radius: 10, height: 50 });
    const topology = kernel.topology(handleOf(doc, id) ?? (kernel.evaluate({ op: 'solid', entity: doc.entities[id] as never }) as never));
    const rim = topology?.edges.find((edge) => edge.curve === 'circle')?.index ?? -1;
    const probe = execute(doc, 'probe_fillet', { id, edgeIndices: [rim] });
    const [edge] = (probe.data as { edges: Array<{ maxRadius: number; upperBound: number; limitingCode: string | null }> }).edges;
    expect(edge?.upperBound).toBeCloseTo(5, 6);
    expect(edge?.maxRadius).toBeGreaterThan(7);
    expect(edge?.limitingCode).not.toBeNull();
    expect(execute(doc, 'fillet_edge', { id, edgeIndices: [rim], radius: 0.99 * (edge?.maxRadius ?? 0) }).affected).toHaveLength(1);
  });

  it('blendReport answers null for a recipe that is not a fillet and reports the contour of a failing one', () => {
    const { doc, id } = block();
    const done = made(doc, 'fillet_edge', { id, edgesNear: [[0, 5, 2.5]], radius: 1 });
    const brep = (done.doc.entities[done.id] as MeshSolidEntity).brep;
    expect(brep?.op).toBe('fillet');
    if (brep?.op !== 'fillet') return;
    expect(kernel.blendReport?.(brep.source)).toBeNull();
    const failing = kernel.blendReport?.({ ...brep, size: 6 });
    expect(failing).toMatchObject({ stage: 'contours', done: false, contours: [{ status: 'startsol_failure' }] });
    const building = kernel.blendReport?.(brep);
    expect(building).toMatchObject({ stage: 'none', done: true, valid: true });
  });
});
