/**
 * BLD M4 on the native OCCT kernel (docs/design/06-variable-blends, validation pack): fillet_faces across a chamfer (VC-BLD-14, 15), with a hold
 * line (VC-BLD-17) and fillet_full_round (VC-BLD-16). Skipped when the llull-kernel binary is not built.
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
  readonly surface?: string;
}

describeNative('BLD M4: fillet_faces, hold lines and fillet_full_round (native OCCT kernel)', () => {
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
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const faces = (doc: Doc, id: string): Face[] => (execute(doc, 'inspect_topology', { id }).data as { faces: Face[] }).faces;
  const chamfered = (): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [-5, -5],
        [5, -5],
        [5, 4],
        [4, 5],
        [-5, 5],
      ],
      depth: 10,
    });
  const rib = (): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [-2, 0],
        [2, 0],
        [2, 10],
        [-2, 10],
      ],
      depth: 20,
    });
  const sets = { facesA: { near: [[5, 0, 5]] }, facesB: { near: [[0, 5, 5]] } };

  it('VC-BLD-14: r 2 across the c = 1 chamfer removes (1 - pi/4) r^2 L = 8.584 (V 991.415927) and the chamfer face is consumed', () => {
    const { doc, id } = chamfered();
    const before = faces(doc, id);
    const done = made(doc, 'fillet_faces', { id, ...sets, radius: 2 });
    expect(done.result.error).toBeUndefined();
    expect(Math.abs(volume(done.doc, done.id) - 991.415926536)).toBeLessThan(1e-3);
    const data = done.result.data as { id: string; blends: Array<{ name: string }>; consumedFaces: string[]; unit: string };
    expect(data.unit).toBe('mm');
    expect(data.blends).toHaveLength(1);
    expect(data.blends[0]?.name).toMatch(/^blend\(e\(.*\|.*\)\)$/);
    expect(data.consumedFaces).toHaveLength(1);
    expect(before.some((face) => face.name === data.consumedFaces[0])).toBe(true);
    const after = faces(done.doc, done.id);
    expect(after).toHaveLength(before.length);
    const blend = after.find((face) => face.name === data.blends[0]?.name);
    expect(blend?.surface).toBe('cylinder');
    expect(blend?.area).toBeCloseTo((Math.PI / 2) * 2 * 10, 6);
    const brep = (done.doc.entities[done.id] as MeshSolidEntity).brep;
    expect(brep).toMatchObject({ op: 'faceBlend', radius: 2 });
  });

  it('VC-BLD-14: the blend is tangent to both walls (check_blends G1, radius 2)', () => {
    const { doc, id } = chamfered();
    const done = made(doc, 'fillet_faces', { id, ...sets, radius: 2 });
    const check = execute(done.doc, 'check_blends', {});
    const data = check.data as {
      status: string;
      blends: Array<{ contacts: Array<{ order: string; g1AngleRad: number }>; radius?: { min: number; max: number } }>;
    };
    expect(data.status).toBe('pass');
    expect(data.blends).toHaveLength(1);
    expect(data.blends[0]?.contacts.map((contact) => contact.order)).toEqual(['G1', 'G1']);
    expect(data.blends[0]?.radius?.min).toBeCloseTo(2, 6);
    expect(data.blends[0]?.radius?.max).toBeCloseTo(2, 6);
  });

  it('VC-BLD-15: r 1.5 is BLD_FACE_FILLET_NO_SOLUTION with the smallest radius c / (2 - sqrt 2) = 1.70711; the document is unchanged', () => {
    const { doc, id } = chamfered();
    const refused = execute(doc, 'fillet_faces', { id, ...sets, radius: 1.5 });
    expect(refused.document).toBe(doc);
    expect(refused.error).toMatchObject({ code: 'BLD_FACE_FILLET_NO_SOLUTION', ids: [id], paths: ['radius'] });
    const minimum = Number(/about ([\d.]+)/.exec(refused.summary)?.[1]);
    expect(minimum).toBeCloseTo(1 / (2 - Math.SQRT2), 4);
    expect(execute(doc, 'fillet_faces', { id, ...sets, radius: minimum * 1.001 }).affected).toHaveLength(1);
  });

  it('BLD_FACESET_EMPTY, BLD_FACESETS_OVERLAP, BLD_BLEND_PARAMS and an unsupported pair are refused with their codes', () => {
    const { doc, id } = chamfered();
    expect(execute(doc, 'fillet_faces', { id, facesA: {}, facesB: sets.facesB, radius: 2 }).error).toMatchObject({
      code: 'BLD_FACESET_EMPTY',
      paths: ['facesA'],
    });
    expect(execute(doc, 'fillet_faces', { id, facesA: sets.facesA, facesB: sets.facesA, radius: 2 }).error).toMatchObject({
      code: 'BLD_FACESETS_OVERLAP',
    });
    expect(execute(doc, 'fillet_faces', { id, ...sets }).error?.code).toBe('BLD_BLEND_PARAMS');
    expect(execute(doc, 'fillet_faces', { id, ...sets, radius: -1 }).error?.code).toBe('BLD_LAW_INVALID');
    expect(execute(doc, 'fillet_faces', { id, ...sets, radius: 2, profile: { type: 'conic', rho: 3 } }).error?.code).toBe('BLD_RHO_RANGE');
    const parallel = execute(doc, 'fillet_faces', { id, facesA: { near: [[5, 0, 5]] }, facesB: { near: [[-5, 0, 5]] }, radius: 1 });
    expect(parallel.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED' });
    expect(parallel.summary).toContain('fillet_full_round');
    const offSolid = execute(doc, 'fillet_faces', { id, facesA: { near: [[50, 50, 50]] }, facesB: sets.facesB, radius: 1 });
    expect(offSolid.error?.code).toBe('BLD_FACESET_EMPTY');
  });

  it('a conic profile works across the chamfer too, and recorded face names re-pick the faces on regeneration (REF_LOST when gone)', () => {
    const { doc, id } = chamfered();
    const done = made(doc, 'fillet_faces', { id, ...sets, radius: 2, profile: { type: 'conic', rho: 0.5 } });
    expect(done.result.error).toBeUndefined();
    const step = done.doc.featureHistory[done.doc.featureHistory.length - 1];
    expect(step?.params).toMatchObject({
      facesA: { near: [[5, 0, 5]], names: [expect.any(String)] },
      facesB: { names: [expect.any(String)] },
    });
    const gone = execute(done.doc, 'fillet_faces', { id: done.id, facesA: { names: ['nothing'] }, facesB: sets.facesB, radius: 1 });
    expect(gone.error?.code).toBe('REF_LOST');
  });

  it('VC-BLD-17: a hold line from 1 to 2 mm off the top edge gives the linear radius law 1 -> 2: faces 170 / 70 mm2', () => {
    const block = made(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const hold = made(block.doc, 'draw_polyline', {
      points: [
        [-10, 4],
        [10, 3],
      ],
      position: [0, 0, 2.5],
    });
    const done = made(hold.doc, 'fillet_faces', {
      id: block.id,
      facesA: { near: [[0, 0, 2.5]] },
      facesB: { near: [[0, 5, 0]] },
      holdLine: { id: hold.id, onFaces: 'A' },
    });
    expect(done.result.error).toBeUndefined();
    expect(done.result.summary).toContain('fillet_faces');
    const list = faces(done.doc, done.id);
    const top = list.find((face) => face.name === `${block.id}:z+`)?.area ?? Number.NaN;
    const side = list.find((face) => face.name === `${block.id}:y+`)?.area ?? Number.NaN;
    expect(top).toBeCloseTo(170, 6);
    expect(side).toBeCloseTo(70, 6);
    const brep = (done.doc.entities[done.id] as MeshSolidEntity).brep;
    expect(brep).toMatchObject({ op: 'fillet', radii: [{ interpolation: 'linear' }] });
    const law = (brep as unknown as { radii: Array<{ size: number; sizeEnd: number }> }).radii[0];
    expect(law?.size).toBeCloseTo(1, 9);
    expect(law?.sizeEnd).toBeCloseTo(2, 9);
  });

  it('BLD_HOLD_LINE_NOT_ON_FACE: a curve off the face plane, one that does not cross the face, or an entity that is not a curve', () => {
    const block = made(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const raised = made(block.doc, 'draw_polyline', {
      points: [
        [-10, 4],
        [10, 3],
      ],
      position: [0, 0, 3],
    });
    const base = { id: block.id, facesA: { near: [[0, 0, 2.5]] }, facesB: { near: [[0, 5, 0]] } };
    expect(execute(raised.doc, 'fillet_faces', { ...base, holdLine: { id: raised.id, onFaces: 'A' } }).error?.code).toBe(
      'BLD_HOLD_LINE_NOT_ON_FACE',
    );
    const short = made(block.doc, 'draw_polyline', {
      points: [
        [-2, 4],
        [2, 3],
      ],
      position: [0, 0, 2.5],
    });
    expect(execute(short.doc, 'fillet_faces', { ...base, holdLine: { id: short.id, onFaces: 'A' } }).error?.code).toBe(
      'BLD_HOLD_LINE_NOT_ON_FACE',
    );
    expect(execute(block.doc, 'fillet_faces', { ...base, holdLine: { id: block.id, onFaces: 'A' } }).error?.code).toBe(
      'BLD_HOLD_LINE_NOT_ON_FACE',
    );
  });

  it('VC-BLD-16: the full round of a 4-wide rib top is a half-cylinder r 2: V 765.663706, cylinder area 125.663706', () => {
    const { doc, id } = rib();
    const done = made(doc, 'fillet_full_round', {
      id,
      side1: { near: [[-2, 5, 10]] },
      center: { near: [[0, 10, 10]] },
      side2: { near: [[2, 5, 10]] },
    });
    expect(done.result.error).toBeUndefined();
    expect(Math.abs(volume(done.doc, done.id) - 765.663706144)).toBeLessThan(1e-3);
    const list = faces(done.doc, done.id);
    const cylinder = list.find((face) => face.surface === 'cylinder');
    expect(cylinder?.area).toBeCloseTo(125.663706144, 5);
    const data = done.result.data as { consumedFaces: string[]; blends: Array<{ name: string }> };
    expect(data.consumedFaces).toHaveLength(1);
    expect(data.blends).toHaveLength(1);
    const check = execute(done.doc, 'check_blends', {});
    const checked = check.data as { status: string; blends: Array<{ radius?: { min: number; max: number } }> };
    expect(checked.status).toBe('pass');
    expect(checked.blends[0]?.radius?.min).toBeCloseTo(2, 6);
  });

  it('fillet_full_round refusals: sides that do not face away, a center that is not as wide, overlapping sets', () => {
    const { doc, id } = rib();
    const sides = { side1: { near: [[-2, 5, 10]] }, side2: { near: [[2, 5, 10]] } };
    const center = { near: [[0, 10, 10]] };
    expect(execute(doc, 'fillet_full_round', { id, side1: sides.side1, center: sides.side2, side2: center }).error?.code).toBe(
      'BLD_FULL_ROUND_NOT_OPPOSED',
    );
    expect(execute(doc, 'fillet_full_round', { id, side1: sides.side1, center: sides.side1, side2: sides.side2 }).error?.code).toBe(
      'BLD_FACESETS_OVERLAP',
    );
    expect(execute(doc, 'fillet_full_round', { id, side1: sides.side1, center: {}, side2: sides.side2 }).error?.code).toBe(
      'BLD_FACESET_EMPTY',
    );
    const narrow = made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [-2, 0],
        [2, 0],
        [2, 9],
        [1, 10],
        [-1, 10],
        [-2, 9],
      ],
      depth: 20,
    });
    const refused = execute(narrow.doc, 'fillet_full_round', {
      id: narrow.id,
      side1: sides.side1,
      center: { near: [[0, 10, 10]] },
      side2: sides.side2,
    });
    expect(refused.error?.code).toBe('BLD_FULL_ROUND_NO_SOLUTION');
    expect(refused.document).toBe(narrow.doc);
  });

  it('a hold line at a 45 degree fold: the contact lands ON the line (radius = h / tan(fold / 2), not h tan(fold / 2))', () => {
    const block = made(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const slanted = made(block.doc, 'chamfer_edge', { id: block.id, edgesNear: [[0, 5, 2.5]], distance: 2 });
    const hold = made(slanted.doc, 'draw_polyline', {
      points: [
        [-10, 2],
        [10, 2],
      ],
      position: [0, 0, 2.5],
    });
    const done = made(hold.doc, 'fillet_faces', {
      id: slanted.id,
      facesA: { near: [[0, 0, 2.5]] },
      facesB: { near: [[0, 4, 1.5]] },
      holdLine: { id: hold.id, onFaces: 'A' },
    });
    expect(done.result.error).toBeUndefined();
    const brep = (done.doc.entities[done.id] as MeshSolidEntity).brep as unknown as { size: number };
    expect(brep.size).toBeCloseTo(1 / Math.tan(Math.PI / 8), 9);
    const top = faces(done.doc, done.id).find((face) => face.name === `${block.id}:z+`);
    // the chamfer edge is at y = 3: a contact 1 mm from it leaves the top 20 x 7 = 140 wide
    expect(top?.area).toBeCloseTo(140, 4);
  });

  it('a hold line with a conic profile keeps the profile: a constant and a sloped hold line build it', () => {
    const block = made(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const flat = made(block.doc, 'draw_polyline', {
      points: [
        [-10, 4],
        [10, 4],
      ],
      position: [0, 0, 2.5],
    });
    const base = { id: block.id, facesA: { near: [[0, 0, 2.5]] }, facesB: { near: [[0, 5, 0]] } };
    const conic = made(flat.doc, 'fillet_faces', {
      ...base,
      holdLine: { id: flat.id, onFaces: 'A' },
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(conic.result.error).toBeUndefined();
    expect((conic.doc.entities[conic.id] as MeshSolidEntity).brep).toMatchObject({ profile: { type: 'conic', rho: 0.5 } });
    expect(Math.abs(volume(conic.doc, conic.id) - (1000 - 20 * 0.5 * (1 - 2 / 3)))).toBeLessThan(1e-3);
    const sloped = made(block.doc, 'draw_polyline', {
      points: [
        [-10, 4],
        [10, 3],
      ],
      position: [0, 0, 2.5],
    });
    // a sloped line is a straight law 1 -> 2: the profile follows it (DES-6c step 2); the parabolic section removes (1/6) integral of leg^2 = 7.7778 mm3
    const varying = made(sloped.doc, 'fillet_faces', {
      ...base,
      id: block.id,
      holdLine: { id: sloped.id, onFaces: 'A' },
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(varying.result.error).toBeUndefined();
    const removed = (20 / 6) * (7 / 3);
    expect(Math.abs(volume(varying.doc, varying.id) - (1000 - removed))).toBeLessThan(1e-6 * removed);
    const checked = execute(varying.doc, 'check_blends', { ids: [varying.id] }).data as {
      status: string;
      findings: Array<{ severity: string }>;
    };
    expect(checked.status).toBe('pass');
    expect(checked.findings.filter((finding) => finding.severity === 'fail')).toEqual([]);
    // the contact on the top face lies on the drawn polyline y = 4 - (x + 10) / 20 within 1e-6 x the diagonal, at several t
    const brep = (varying.doc.entities[varying.id] as MeshSolidEntity).brep;
    const shape = kernel.evaluate(brep as never);
    const topology = kernel.topology(shape as never);
    const contact = topology?.edges.find((edge) => edge.name?.includes('blend(') && edge.name.endsWith(`|${block.id}:z+)`));
    expect(contact).toBeDefined();
    const points = kernel.faceQuery?.edgeSamples(shape as never, contact?.index ?? 0, 9) ?? [];
    expect(points).toHaveLength(9);
    const diagonal = Math.hypot(20, 10, 5);
    for (const sample of points) {
      expect(Math.abs(sample.point[2] - 2.5)).toBeLessThan(1e-6 * diagonal);
      expect(Math.abs(sample.point[1] - (4 - (sample.point[0] + 10) / 20))).toBeLessThan(1e-6 * diagonal);
    }
  });

  it('a concave blend whose arc would lie in the material is BLD_FACE_FILLET_NO_SOLUTION; with room it adds material', () => {
    const profile = [
      [0, 0],
      [10, 0],
      [10, 4],
      [5, 4],
      [4, 5],
      [4, 10],
      [0, 10],
    ];
    const filled = made(createEmptyDocument(), 'extrude_profile', { profile, depth: 10 });
    const sets = { facesA: { near: [[7.5, 4, 5]] }, facesB: { near: [[4, 7.5, 5]] } };
    const refused = execute(filled.doc, 'fillet_faces', { id: filled.id, ...sets, radius: 1.2 });
    expect(refused.error?.code).toBe('BLD_FACE_FILLET_NO_SOLUTION');
    const built = made(filled.doc, 'fillet_faces', { id: filled.id, ...sets, radius: 2 });
    expect(built.result.error).toBeUndefined();
    expect(volume(built.doc, built.id)).toBeGreaterThan(volume(filled.doc, filled.id));
  });

  it('BLD_FULL_ROUND_NO_SOLUTION when the rib is lower than half its width (the sides stop short of the axis)', () => {
    const low = made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [-2, 0],
        [2, 0],
        [2, 1],
        [-2, 1],
      ],
      depth: 20,
    });
    const refused = execute(low.doc, 'fillet_full_round', {
      id: low.id,
      side1: { near: [[-2, 0.5, 10]] },
      center: { near: [[0, 1, 10]] },
      side2: { near: [[2, 0.5, 10]] },
    });
    expect(refused.error).toMatchObject({ code: 'BLD_FULL_ROUND_NO_SOLUTION', ids: [low.id], paths: ['center'] });
    expect(refused.summary).toContain('reach down');
    expect(refused.document).toBe(low.doc);
  });
});
