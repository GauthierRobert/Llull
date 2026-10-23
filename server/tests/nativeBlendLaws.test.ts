/**
 * BLD M1 on the native OCCT kernel (docs/design/06-variable-blends, validation pack): radius laws (linear interpolation, expression, periodic),
 * chord sizing on a curved face pair, sided chamfers, the blend face section readback behind check_blends (VC-BLD-03, 04, 06, 18, 20-22).
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

describeNative('BLD M1: radius laws, chord on curved faces, chamfer variants and the blend readback (native OCCT kernel)', () => {
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
  const rimSolid = (): { doc: Doc; id: string } => made(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 10 });
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const faces = (doc: Doc, id: string): Face[] => (execute(doc, 'inspect_topology', { id }).data as { faces: Face[] }).faces;
  const areaOf = (list: Face[], suffix: string): number => list.find((face) => face.name?.endsWith(suffix))?.area ?? Number.NaN;
  const topEdge = [0, 5, 2.5] as const;

  it('VC-BLD-03 (linear): control points 1 / 2 / 1 joined by straight pieces put the contact line on the polyline (within 1e-5) and the planar face area 200 - integral of r at 170 to 1e-6', () => {
    const { doc, id } = block();
    const done = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: topEdge, size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' }],
    });
    expect(done.result.error).toBeUndefined();
    const shape = kernel.evaluate((done.doc.entities[done.id] as MeshSolidEntity).brep as never);
    const topology = kernel.topology(shape as never);
    const contact = topology?.edges.find((edge) => edge.name?.startsWith('e(blend') && edge.name.endsWith(`|${id}:z+)`));
    const samples = kernel.faceQuery?.edgeSamples(shape as never, contact?.index ?? -1, 1001) ?? [];
    expect(samples).toHaveLength(1001);
    let worst = 0;
    let integral = 0;
    samples.forEach((sample, k) => {
      const radius = 5 - sample.point[1];
      worst = Math.max(worst, Math.abs(radius - (2 - Math.abs(sample.point[0]) / 10)));
      const next = samples[k + 1];
      if (next) integral += ((radius + (5 - next.point[1])) / 2) * (next.point[0] - sample.point[0]);
    });
    expect(worst).toBeLessThan(2e-6);
    // the exact planar area is 200 - integral(r ds): 170 to the 1e-6 gate (a temporary eps 1e-9 build of BRepGProp read the face 170.00000046)
    expect(Math.abs(200 - integral - 170)).toBeLessThan(1e-6);
    const list = faces(done.doc, done.id);
    // the default (non-adaptive) face-area quadrature reads 170.00435 on this B-spline boundary: an artefact of the quadrature, not of the law
    expect(Math.abs(areaOf(list, `${id}:z+`) - 170)).toBeLessThan(0.01);
    expect(Math.abs(areaOf(list, `${id}:y+`) - 70)).toBeLessThan(0.01);
  });

  it('VC-BLD-03 (smooth): the default interpolation passes through the control point but is not the straight-piece area', () => {
    const { doc, id } = block();
    const done = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }] }] });
    const top = areaOf(faces(done.doc, done.id), `${id}:z+`);
    expect(Math.abs(top - 170)).toBeGreaterThan(1e-3);
    expect(Math.abs(top - 170)).toBeLessThan(2);
  });

  it('an expression law is sampled and built: r = 1 + 0.5 t on the 20 mm edge leaves 200 - 20 * 1.25 = 175 on the top face', () => {
    const { doc, id } = block();
    const done = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, law: { expression: '1 + 0.5*t', samples: 17 } }] });
    expect(done.result.error).toBeUndefined();
    expect(areaOf(faces(done.doc, done.id), `${id}:z+`)).toBeCloseTo(175, 3);
  });

  it('VC-BLD-04: the periodic rim law 1 + 0.5 cos(2 pi t) on a cylinder R 5 h 10 removes the generalised-Pappus volume', () => {
    const { doc, id } = rimSolid();
    const done = made(doc, 'fillet_edge', { id, edges: [{ near: [5, 0, 5], law: { expression: '1 + 0.5*cos(2*pi*t)', samples: 33 } }] });
    expect(done.result.error).toBeUndefined();
    expect(volume(done.doc, done.id)).toBeCloseTo(778.227638561, 1);
    expect(Math.abs(volume(done.doc, done.id) - 778.227638561)).toBeLessThan(0.01);
  });

  it('VC-BLD-21: a start-to-end law on a closed rim is BLD_LAW_NOT_PERIODIC, the document unchanged', () => {
    const { doc, id } = rimSolid();
    const refused = execute(doc, 'fillet_edge', { id, edges: [{ near: [5, 0, 5], size: 1, sizeEnd: 2 }] });
    expect(refused.document).toBe(doc);
    expect(refused.error).toMatchObject({ code: 'BLD_LAW_NOT_PERIODIC', ids: [id], paths: ['edges[0].sizeEnd'] });
    expect(refused.error?.remediation).toContain('equal the start');
  });

  it('VC-BLD-06: chord sqrt 2 on the cylinder rim (plane against cylinder) is a radius-1 round: the Pappus volume of oracle 87', () => {
    const { doc, id } = rimSolid();
    const done = made(doc, 'fillet_edge', { id, edgesNear: [[5, 0, 5]], radius: Math.SQRT2, mode: 'chord' });
    expect(done.result.error).toBeUndefined();
    expect(Math.abs(volume(done.doc, done.id) - 778.95743342)).toBeLessThan(1e-3);
  });

  it('VC-BLD-18: chamfer 1 x 2 on a 10-cube edge removes the triangle d1 d2 / 2 * L (V 990) whichever face is side 1', () => {
    for (const side1Near of [
      [5, 0, 0],
      [0, 5, 0],
    ] as const) {
      const { doc, id } = cube();
      const done = made(doc, 'chamfer_edge', { id, edgesNear: [[5, 5, 0]], distance: 1, distance2: 2, side1Near });
      expect(done.result.error).toBeUndefined();
      expect(volume(done.doc, done.id)).toBeCloseTo(990, 6);
      // side 1 carries `distance` (1): its face loses a strip 1 wide, the other face a strip 2 wide
      const list = faces(done.doc, done.id);
      const [first, other] = side1Near[0] === 5 ? ['x+', 'y+'] : ['y+', 'x+'];
      expect(areaOf(list, `${id}:${first}`)).toBeCloseTo(100 - 10 * 1, 6);
      expect(areaOf(list, `${id}:${other}`)).toBeCloseTo(100 - 10 * 2, 6);
    }
    const asymmetric = (side1Near: readonly [number, number, number]): number => {
      const { doc, id } = cube();
      const done = made(doc, 'chamfer_edge', { id, edgesNear: [[5, 5, 0]], distance: 1, distance2: 2, side1Near });
      const list = faces(done.doc, done.id);
      return list.filter((face) => face.name?.startsWith('chamfer')).reduce((total, face) => total + face.area, 0);
    };
    expect(asymmetric([5, 0, 0])).toBeCloseTo(Math.hypot(1, 2) * 10, 6);
  });

  it('VC-BLD-18: chamfer 1 at 30 degrees on side 1 removes d * d tan(30) / 2 * L = 2.8868 (V 997.113249)', () => {
    const { doc, id } = cube();
    const done = made(doc, 'chamfer_edge', { id, edgesNear: [[5, 5, 0]], distance: 1, angleDeg: 30, side1Near: [5, 0, 0] });
    expect(done.result.error).toBeUndefined();
    expect(Math.abs(volume(done.doc, done.id) - 997.113248654)).toBeLessThan(1e-3);
    const list = faces(done.doc, done.id);
    expect(areaOf(list, `${id}:x+`)).toBeCloseTo(100 - 10 * 1, 6);
    expect(areaOf(list, `${id}:y+`)).toBeCloseTo(100 - 10 * Math.tan(Math.PI / 6), 6);
  });

  it('chamfer_edge by face name picks the same side as the point, and a point equally near both faces is BLD_ASYMMETRIC_SIDE_MISSING', () => {
    const { doc, id } = cube();
    const byName = made(doc, 'chamfer_edge', { id, edgesNear: [[5, 5, 0]], distance: 1, distance2: 2, side1Name: `${id}:x+` });
    expect(byName.result.error).toBeUndefined();
    const tie = execute(doc, 'chamfer_edge', { id, edgesNear: [[5, 5, 0]], distance: 1, distance2: 2, side1Near: [5, 5, 5] });
    expect(tie.error?.code).toBe('BLD_ASYMMETRIC_SIDE_MISSING');
    expect(tie.document).toBe(doc);
  });

  it('check_blends reads the realised radius back: r(0.5) = 2 at the control point of the linear law, min 1 and max 2', () => {
    const { doc, id } = block();
    const done = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: topEdge, size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' }],
    });
    const result = execute(done.doc, 'check_blends', {});
    const data = result.data as {
      status: string;
      blends: Array<{ radius?: { min: number; max: number; at: Array<{ t: number; value: number }> } }>;
      findings: Array<{ code: string }>;
    };
    const radius = data.blends[0]?.radius;
    expect(radius).toBeDefined();
    expect(radius?.at.find((sample) => Math.abs(sample.t - 0.5) < 1e-9)?.value).toBeCloseTo(2, 4);
    expect(radius?.min).toBeCloseTo(1, 4);
    expect(radius?.max).toBeCloseTo(2, 4);
    expect(data.findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_RADIUS_LAW');
  });

  it('the recipe of a law fillet is exactly what the document stores (replay)', () => {
    const { doc, id } = block();
    const done = made(doc, 'fillet_edge', { id, edges: [{ near: topEdge, size: 1, sizeEnd: 2, interpolation: 'linear' }] });
    const brep = (done.doc.entities[done.id] as MeshSolidEntity).brep;
    expect(brep).toMatchObject({ op: 'fillet', size: 0, radii: [{ size: 1, sizeEnd: 2, interpolation: 'linear' }] });
  });
});

describeNative('BLD M1: what OCCT builds for radius laws (measured)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  /** Radius along the top contact line of a block top-edge fillet, at `t` of the 20 mm edge. */
  const contactRadii = (params: Record<string, unknown>, ts: readonly number[]): number[] => {
    const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const id = made.affected[0] as string;
    const done = execute(made.document, 'fillet_edge', { id, ...params });
    const shape = kernel.evaluate((done.document.entities[done.affected[0] as string] as MeshSolidEntity).brep as never);
    const contact = kernel
      .topology(shape as never)
      ?.edges.find((edge) => edge.name?.startsWith('e(blend') && edge.name.endsWith(`|${id}:z+)`));
    const samples = kernel.faceQuery?.edgeSamples(shape as never, contact?.index ?? -1, 1001) ?? [];
    return ts.map((t) => 5 - (samples[Math.round(t * 1000)]?.point[1] ?? Number.NaN));
  };

  it('Add(r1, r2, E) is NOT a straight transition: the ends are flattened (measured r(0.1) 1.0589, r(0.25) 1.1964 where a straight law gives 1.1 and 1.25)', () => {
    const ts = [0, 0.1, 0.25, 0.5, 0.75, 1];
    const measured = contactRadii({ edgesNear: [[0, 5, 2.5]], radius: 1, radiusEnd: 2 }, ts);
    const expected = [1, 1.05886, 1.19643, 1.5, 1.80357, 2];
    ts.forEach((_t, k) => expect(Math.abs((measured[k] ?? Number.NaN) - (expected[k] ?? 0))).toBeLessThan(2e-4));
    expect(1.25 - (measured[2] ?? 0)).toBeGreaterThan(0.05);
  });

  it('interpolation "linear" on the same two values is a straight transition: r(0.25) = 1.25 within 1e-4', () => {
    const measured = contactRadii(
      { edges: [{ near: [0, 5, 2.5], size: 1, sizeEnd: 2, interpolation: 'linear' }] },
      [0, 0.1, 0.25, 0.5, 0.75, 1],
    );
    [0, 0.1, 0.25, 0.5, 0.75, 1].forEach((t, k) => expect(Math.abs((measured[k] ?? Number.NaN) - (1 + t))).toBeLessThan(1e-4));
  });
});

describeNative('BLD M1: parametric integrity of blends (VC-BLD-22, 25)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const volumeOf = (doc: CadDocument, id: string): number =>
    (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;

  it('VC-BLD-22: resizing the block upstream re-runs the same law on the same edge by its persistent name', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const id = box.affected[0] as string;
    const done = execute(box.document, 'fillet_edge', {
      id,
      edges: [{ near: [0, 5, 2.5], size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' }],
    });
    const filletStep = done.document.featureHistory[1];
    expect(filletStep?.params).toHaveProperty('edgeNames');
    const boxStep = done.document.featureHistory[0];
    const edited = execute(done.document, 'edit_step_params', { stepId: boxStep?.id, params: { size: [30, 10, 5] } });
    expect(edited.rejected).not.toBe(true);
    const result = edited.document.order[0] as string;
    // 30 mm edge: removed = (1 - pi/4) int r^2 ds = (1 - pi/4) 30 (7/3); the same edge is rounded with the same law
    expect(volumeOf(edited.document, result)).toBeCloseTo(1500 - (1 - Math.PI / 4) * 30 * (7 / 3), 1);
  });

  it('VC-BLD-22: an edge name that is gone is REF_LOST with the re-pick remediation, the document unchanged', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const id = box.affected[0] as string;
    const rounded = execute(box.document, 'fillet_edge', { id, edgesNear: [[0, 5, 2.5]], radius: 1 });
    const gone = `e(${id}:y+|${id}:z+)`;
    const refused = execute(rounded.document, 'fillet_edge', {
      id: rounded.affected[0],
      edges: [{ index: 0, size: 0.5 }],
      edgeNames: [gone],
    });
    expect(refused.document).toBe(rounded.document);
    expect(refused.error?.code).toBe('REF_LOST');
    expect(refused.error?.remediation).toContain('edit_step_params');
  });

  it('VC-BLD-25: a law fillet replays to the identical document (same ids, same recipe)', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const id = box.affected[0] as string;
    const done = execute(box.document, 'fillet_edge', { id, edges: [{ near: [0, 5, 2.5], law: { expression: '1 + 0.5*t', samples: 9 } }] });
    const replayed = execute(done.document, 'replay_history', {});
    expect(replayed.rejected).not.toBe(true);
    expect(Object.keys(replayed.document.entities)).toEqual(Object.keys(done.document.entities));
    const recipe = (doc: CadDocument): unknown => (doc.entities[doc.order[0] as string] as MeshSolidEntity).brep;
    expect(JSON.stringify(recipe(replayed.document))).toBe(JSON.stringify(recipe(done.document)));
  });
});
