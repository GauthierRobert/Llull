/**
 * BLD M4 on the native OCCT kernel (TECHNICAL_SPEC 13.31, review round): fillet_faces between faces that do not meet is EXACT about where the contact
 * lies and which side is outward, and every reachable refusal is named. A contact line / circle is intersected with the faces of its set, so a groove
 * narrower than any sampling step, a slot in a plate and a 350 degree revolution are found; the arc of a taper is checked at both ends; the outward
 * side of a round set comes from a point ON its faces, not from the middle of the meridian (a groove there made both probes lie in air). Skipped when
 * the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
type Point = readonly [number, number];
type Params = Record<string, unknown>;

describeNative('BLD M4: fillet_faces exactness and refusals (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const made = (doc: Doc, command: string, params: Params): { doc: Doc; id: string; result: ReturnType<typeof execute> } => {
    const result = execute(doc, command, params);
    return { doc: result.document, id: result.affected[0] as string, result };
  };
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const revolve = (profile: Point[], extra: Params = {}): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'revolve_profile', { profile, axis: 'z', ...extra });
  const extrude = (profile: Point[]): { doc: Doc; id: string } => made(createEmptyDocument(), 'extrude_profile', { profile, depth: 10 });
  const box = (doc: Doc, size: number[], position: number[]): { doc: Doc; id: string } =>
    made(doc, 'add_box', { size, position, anchor: 'min' });
  const join = (doc: Doc, op: string, a: string, b: string): { doc: Doc; id: string } => made(doc, 'boolean', { op, a, b });
  const refusal = (
    doc: Doc,
    id: string,
    facesA: number[][],
    facesB: number[][],
    radius: number,
    extra: Params = {},
  ): ReturnType<typeof execute> =>
    execute(doc, 'fillet_faces', { id, facesA: { near: facesA }, facesB: { near: facesB }, radius, ...extra });

  // a 10 x 10 block (x, y in -5..5, depth 10) with a chamfer of leg 1 at the corner (5, 5)
  const block = (split = false): { doc: Doc; id: string } =>
    extrude([[-5, -5], [5, -5], ...(split ? ([[5, 0]] as Point[]) : []), [5, 4], [4, 5], [-5, 5]]);
  const removedBy = (r0: number, r1: number): number => (1 - Math.PI / 4) * 10 * ((r0 * r0 + r0 * r1 + r1 * r1) / 3) - 0.5 * 10;
  const wall = { near: [[5, -2, 5]] };
  const top = { near: [[0, 5, 5]] };

  it('a groove narrower than the old sampling step in a planar set is found: the blend would span air', () => {
    const { doc, id } = block();
    // 0.3 wide across the contact line (y = 3) of the wall, z from 4.6 to 4.9: between the stations z = 3.75 and z = 5 of nine along 10
    const groove = box(doc, [2, 2, 0.3], [4, 2, 4.6]);
    const grooved = join(groove.doc, 'subtract', id, groove.id);
    const refused = execute(grooved.doc, 'fillet_faces', { id: grooved.id, facesA: wall, facesB: top, radius: 2 });
    expect(refused.error?.code).toBe('BLD_FACE_FILLET_NO_SOLUTION');
    expect(refused.summary).toContain('contact lines leave them');
    expect(refused.document).toBe(grooved.doc);
    // the same groove clear of the contact line (y -4 to -2) does not stop the blend: only what is in the way is refused
    const clear = box(doc, [2, 2, 0.3], [4, -4, 4.6]);
    const apart = join(clear.doc, 'subtract', id, clear.id);
    const built = made(apart.doc, 'fillet_faces', { id: apart.id, facesA: wall, facesB: top, radius: 2 });
    expect(built.result.error).toBeUndefined();
    expect(volume(apart.doc, apart.id) - volume(built.doc, built.id)).toBeCloseTo(removedBy(2, 2), 6);
  });

  // a boss R 5 on a plate (top z 5) with a chamfer ring of leg 3 between them; the virtual corner is (5, 5)
  const bossProfile: Point[] = [
    [0, 0],
    [20, 0],
    [20, 5],
    [8, 5],
    [5, 8],
    [5, 15],
    [0, 15],
  ];
  const bossSets = { facesA: { near: [[15, 0, 5]] }, facesB: { near: [[5, 0, 12]] } };

  it('a 350 degree revolution is refused: the swept tool is always 360 degrees (a gap of 10 degrees is under the old 45 degree step)', () => {
    const part = revolve(bossProfile, { angle: (350 * Math.PI) / 180 });
    const refused = execute(part.doc, 'fillet_faces', {
      id: part.id,
      facesA: { near: [[0, 15, 5]] },
      facesB: { near: [[0, 5, 12]] },
      radius: 6,
    });
    expect(refused.error?.code).toBe('BLD_FACE_FILLET_NO_SOLUTION');
    expect(refused.summary).toContain('contact lines leave them');
  });

  it('a narrow slot cut into the plate across the contact circle is refused (2.6 degrees of the circle)', () => {
    const { doc, id } = revolve(bossProfile);
    const slot = box(doc, [4, 0.5, 2], [9, -0.25, 3.5]);
    const slotted = join(slot.doc, 'subtract', id, slot.id);
    const refused = execute(slotted.doc, 'fillet_faces', { id: slotted.id, ...bossSets, radius: 6 });
    expect(refused.error?.code).toBe('BLD_FACE_FILLET_NO_SOLUTION');
    expect(refused.summary).toContain('contact lines leave them');
  });

  it('a taper whose small end is in the wrong region is refused with startNear either way (the arc is checked at both ends, not only the middle)', () => {
    const { doc, id } = block(true);
    // legs 1.2 -> 4 against a chamfer of leg 1: the ball of radius 1.2 does not reach the chamfer (needs r >= 1.71), the middle (2.6) does
    const both = {
      near: [
        [5, -2, 5],
        [5, 2, 5],
      ],
    };
    for (const startNear of [undefined, [5, 5, 10]]) {
      const taper = execute(doc, 'fillet_faces', {
        id,
        facesA: both,
        facesB: top,
        radius: 1.2,
        radiusEnd: 4,
        ...(startNear === undefined ? {} : { startNear }),
      });
      expect(taper.error?.code).toBe('BLD_FACE_FILLET_NO_SOLUTION');
      expect(taper.summary).toContain('wrong region');
      expect(taper.summary).toContain('1.2');
      expect(taper.document).toBe(doc);
    }
    const fine = made(doc, 'fillet_faces', { id, facesA: both, facesB: top, radius: 2, radiusEnd: 4 });
    expect(fine.result.error).toBeUndefined();
  });

  it.each([1, -1])(
    'the outward side of a round set comes from its own faces: a plate with an annular groove in the plane set (z sign %d: one of the two has the axis pointing inward)',
    (sign) => {
      // the plate face has a groove (rho 13 to 15) where the middle of the meridian lies: the probes there both lie in air
      const flip = (points: Point[]): Point[] => points.map(([rho, z]) => [rho, z * sign]);
      const grooved = flip([
        [0, 0],
        [20, 0],
        [20, 5],
        [15, 5],
        [15, 4],
        [13, 4],
        [13, 5],
        [8, 5],
        [5, 8],
        [5, 15],
        [0, 15],
      ]);
      const { doc, id } = revolve(grooved);
      const done = made(doc, 'fillet_faces', {
        id,
        facesA: {
          near: [
            [10, 0, 5 * sign],
            [17, 0, 5 * sign],
          ],
        },
        facesB: { near: [[5, 0, 12 * sign]] },
        radius: 6,
      });
      expect(done.result.error).toBeUndefined();
      // the groove is clear of the blend: it adds what the plain boss (Pappus oracle in nativeBlendFaceGaps) adds
      const plain = revolve(bossProfile);
      const plainDone = made(plain.doc, 'fillet_faces', { id: plain.id, ...bossSets, radius: 6 });
      expect(volume(done.doc, done.id) - volume(doc, id)).toBeCloseTo(volume(plainDone.doc, plainDone.id) - volume(plain.doc, plain.id), 6);
    },
  );

  it('a taper recipe survives save and load (radiusEnd and startNear are in the recipe)', () => {
    const { doc, id } = block(true);
    const params = {
      id,
      facesA: {
        near: [
          [5, -2, 5],
          [5, 2, 5],
        ],
      },
      facesB: top,
      radius: 2,
      radiusEnd: 6,
      startNear: [5, 5, 10],
    };
    const done = made(doc, 'fillet_faces', params);
    expect(done.result.error).toBeUndefined();
    const again = deserializeDocument(serializeDocument(done.doc));
    expect(volume(again, done.id)).toBeCloseTo(volume(done.doc, done.id), 9);
    const centroidZ = (d: Doc): number =>
      (execute(d, 'mass_properties', { entityId: done.id }).data as { centroid: number[] }).centroid[2] as number;
    expect(centroidZ(again)).toBeCloseTo(centroidZ(done.doc), 9);
    // radius 2 at z = 10 and 6 at z = 0: more removed near z = 0, so the centroid is above the middle
    expect(centroidZ(again)).toBeGreaterThan(5);
  });

  it('refuses a sphere against a plane and against a cylinder by name (picked by name: a near point does not resolve on a sphere)', () => {
    const faceNamed = (doc: Doc, id: string, surface: string): string => {
      const faces = (execute(doc, 'inspect_topology', { id }).data as { faces: Array<{ name?: string; surface?: string; area: number }> })
        .faces;
      return faces.filter((face) => face.surface === surface).sort((a, b) => b.area - a.area)[0]?.name as string;
    };
    const cylinder = made(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 10, anchor: 'base-center' });
    const sphere = made(cylinder.doc, 'add_sphere', { radius: 5, position: [0, 0, 10] });
    const dome = join(sphere.doc, 'union', cylinder.id, sphere.id);
    const dish = { names: [faceNamed(dome.doc, dome.id, 'sphere')] };
    const planeVsSphere = execute(dome.doc, 'fillet_faces', { id: dome.id, facesA: dish, facesB: { near: [[1, 0, 0]] }, radius: 1 });
    expect(planeVsSphere.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(planeVsSphere.summary).toContain('sphere');
    const cylinderVsSphere = execute(dome.doc, 'fillet_faces', { id: dome.id, facesA: { near: [[5, 0, 5]] }, facesB: dish, radius: 1 });
    expect(cylinderVsSphere.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(cylinderVsSphere.summary).toContain('sphere');
  });

  it('refuses a plane not square to the axis and cylinders about different axes', () => {
    const plate = box(createEmptyDocument(), [60, 60, 5], [0, 0, 0]);
    const first = made(plate.doc, 'add_cylinder', { radius: 10, height: 15, position: [30, 30, 5], anchor: 'base-center' });
    const second = made(first.doc, 'add_cylinder', { radius: 5, height: 8, position: [10, 10, 5], anchor: 'base-center' });
    const one = join(second.doc, 'union', plate.id, first.id);
    const both = join(one.doc, 'union', one.id, second.id);
    const tilted = refusal(both.doc, both.id, [[40, 30, 12]], [[0, 30, 2]], 1);
    expect(tilted.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(tilted.summary).toContain('square to its axis');
    const apart = refusal(both.doc, both.id, [[40, 30, 12]], [[15, 10, 8]], 1);
    expect(apart.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(apart.summary).toContain('not about the same axis');
  });

  it('refuses a round set on two supports, a corner on the axis, faces past the virtual corner and a contact across the axis', () => {
    const stepped = revolve([
      [0, 0],
      [20, 0],
      [20, 5],
      [10, 5],
      [10, 10],
      [5, 10],
      [5, 15],
      [0, 15],
    ]);
    const mixed = refusal(
      stepped.doc,
      stepped.id,
      [
        [10, 0, 7],
        [5, 0, 12],
      ],
      [[3, 0, 0]],
      1,
    );
    expect(mixed.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(mixed.summary).toContain('not on one support surface');
    const tip = revolve([
      [0, 0],
      [3, 0],
      [3, 3],
      [6, 6],
      [6, 8],
      [0, 8],
    ]);
    const onAxis = refusal(tip.doc, tip.id, [[4.5, 0, 4.5]], [[1, 0, 0]], 1);
    expect(onAxis.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(onAxis.summary).toContain('lies on the axis');
    const bore = revolve([
      [3, 0],
      [20, 0],
      [20, 5],
      [10, 5],
      [10, 10],
      [3, 10],
    ]);
    const past = refusal(bore.doc, bore.id, [[3, 0, 2]], [[15, 0, 5]], 1);
    expect(past.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(past.summary).toContain('reach past the virtual corner');
    const cone = revolve([
      [0, 0],
      [10, 0],
      [6, 9],
      [5, 10],
      [0, 10],
    ]);
    const across = refusal(cone.doc, cone.id, [[2, 0, 10]], [[8, 0, 4.5]], 30);
    expect(across.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(across.summary).toContain('across the axis');
  });

  it('refuses planar faces that do not overlap along their common direction and a blend whose end is not square', () => {
    const low = box(createEmptyDocument(), [10, 5, 4], [0, 0, 0]);
    const core = box(low.doc, [5, 5, 10], [0, 0, 0]);
    const high = box(core.doc, [5, 10, 4], [0, 0, 6]);
    const joined = join(high.doc, 'union', low.id, core.id);
    const stairs = join(joined.doc, 'union', joined.id, high.id);
    const apart = refusal(stairs.doc, stairs.id, [[10, 2, 2]], [[2, 10, 8]], 1);
    expect(apart.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(apart.summary).toContain('do not overlap');
    // the bottom edge of the wall chamfered: the wall now starts at z = 1 where the top face still starts at z = 0, and nothing is square there
    const { doc, id } = block();
    const slanted = made(doc, 'chamfer_edge', { id, edgesNear: [[5, 0, 0]], distance: 1 });
    expect(slanted.result.error).toBeUndefined();
    const uncapped = execute(slanted.doc, 'fillet_faces', { id: slanted.id, facesA: wall, facesB: top, radius: 2 });
    expect(uncapped.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(uncapped.summary).toContain('flat faces square to it');
  });
});
