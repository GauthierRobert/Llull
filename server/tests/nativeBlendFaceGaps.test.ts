/**
 * BLD M4 on the native OCCT kernel (docs/design/06-variable-blends, TECHNICAL_SPEC 13.31): fillet_faces between faces that do not meet. Planar sets of
 * several coplanar faces, a straight taper between planes (a cone), and plane / cylinder / cone pairs about one axis (a revolved blend). The oracles
 * are closed forms: the section area times the length for a prism, Pappus about the axis (area x 2 pi x centroid distance) for a revolution, the
 * section taken from the corner, the two contact points and the ball arc. Skipped when the llull-kernel binary is not built.
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
interface Face {
  readonly name?: string;
  readonly area: number;
  readonly surface?: string;
}

/** Area and centroid distance from the axis (first coordinate) of a polygon in the meridian plane (shoelace). */
function polygon(points: readonly Point[]): { area: number; arm: number } {
  let area = 0;
  let moment = 0;
  for (let k = 0; k < points.length; k++) {
    const [x0, y0] = points[k] as Point;
    const [x1, y1] = points[(k + 1) % points.length] as Point;
    const cross = x0 * y1 - x1 * y0;
    area += cross / 2;
    moment += ((x0 + x1) * cross) / 6;
  }
  return { area: Math.abs(area), arm: moment / area };
}

const unit = (v: Point): Point => [v[0] / Math.hypot(...v), v[1] / Math.hypot(...v)];

/**
 * The blend of a ball of radius r between two lines through `corner` (running away from it along `towardA` and `towardB`), in the meridian plane
 * (rho, z): the spandrel between the corner, the two contact points and the ball arc (area and centroid distance from the axis), the arc length and
 * the area of the surface the arc sweeps once around the axis.
 */
function spandrel(
  corner: Point,
  towardA: Point,
  towardB: Point,
  r: number,
): { area: number; arm: number; arcLength: number; surface: number } {
  const [ta, tb] = [unit(towardA), unit(towardB)];
  const interior = Math.acos(ta[0] * tb[0] + ta[1] * tb[1]);
  const leg = r / Math.tan(interior / 2);
  const bisector = unit([ta[0] + tb[0], ta[1] + tb[1]]);
  const reach = r / Math.sin(interior / 2);
  const centre: Point = [corner[0] + bisector[0] * reach, corner[1] + bisector[1] * reach];
  const a: Point = [corner[0] + ta[0] * leg, corner[1] + ta[1] * leg];
  const b: Point = [corner[0] + tb[0] * leg, corner[1] + tb[1] * leg];
  const from = Math.atan2(a[1] - centre[1], a[0] - centre[0]);
  let sweep = Math.atan2(b[1] - centre[1], b[0] - centre[0]) - from;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const steps = 20000;
  const outline: Point[] = [corner, a];
  let surface = 0;
  for (let k = 1; k <= steps; k++)
    outline.push([centre[0] + r * Math.cos(from + (sweep * k) / steps), centre[1] + r * Math.sin(from + (sweep * k) / steps)]);
  outline.push(b);
  for (let k = 0; k < steps; k++) {
    const angle = from + (sweep * (k + 0.5)) / steps;
    surface += 2 * Math.PI * (centre[0] + r * Math.cos(angle)) * r * (Math.abs(sweep) / steps);
  }
  return { ...polygon(outline), arcLength: r * Math.abs(sweep), surface };
}

/** Volume of the revolution of a polygon of the meridian plane (Pappus). */
const revolved = (points: readonly Point[]): number => {
  const { area, arm } = polygon(points);
  return 2 * Math.PI * arm * area;
};

describeNative('BLD M4: fillet_faces between faces that do not meet (native OCCT kernel)', () => {
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
  const revolve = (profile: Point[]): { doc: Doc; id: string } => made(createEmptyDocument(), 'revolve_profile', { profile, axis: 'z' });
  const extrude = (profile: Point[]): { doc: Doc; id: string } => made(createEmptyDocument(), 'extrude_profile', { profile, depth: 10 });
  const blendFaces = (doc: Doc, id: string): Face[] => faces(doc, id).filter((face) => face.name?.startsWith('blend(') === true);
  const checked = (doc: Doc): { status: string; findings: Array<{ severity: string; code: string }> } =>
    execute(doc, 'check_blends', {}).data as { status: string; findings: Array<{ severity: string; code: string }> };

  // a boss R 5 on a plate (top z 5) with a chamfer ring of leg 3 between them; the virtual corner is (5, 5)
  const boss = (): { doc: Doc; id: string } =>
    revolve([
      [0, 0],
      [20, 0],
      [20, 5],
      [8, 5],
      [5, 8],
      [5, 15],
      [0, 15],
    ]);
  const bossSets = { facesA: { near: [[15, 0, 5]] }, facesB: { near: [[5, 0, 12]] } };

  it('a plate and a boss across a chamfer ring: the ball adds the revolved spandrel minus the chamfer wedge it covers (Pappus)', () => {
    const { doc, id } = boss();
    const done = made(doc, 'fillet_faces', { id, ...bossSets, radius: 6 });
    expect(done.result.error).toBeUndefined();
    const section = spandrel([5, 5], [1, 0], [0, 1], 6);
    const added =
      2 * Math.PI * section.arm * section.area -
      revolved([
        [5, 5],
        [8, 5],
        [5, 8],
      ]);
    expect(volume(done.doc, done.id) - volume(doc, id)).toBeCloseTo(added, 4);
    const blends = blendFaces(done.doc, done.id);
    expect(blends).toHaveLength(1);
    expect(blends[0]?.surface).toBe('torus');
    expect(blends[0]?.area).toBeCloseTo(section.surface, 4);
    const data = done.result.data as { consumedFaces: string[]; blends: Array<{ name: string }> };
    expect(data.consumedFaces).toHaveLength(1);
    expect(data.blends).toHaveLength(1);
    const check = checked(done.doc);
    expect(check.status).toBe('pass');
    expect(check.findings.every((finding) => finding.severity === 'info')).toBe(true);
  });

  it('a cylinder cap whose top edge is chamfered: the convex ball removes the revolved spandrel minus the chamfer wedge', () => {
    const { doc, id } = revolve([
      [0, 0],
      [10, 0],
      [10, 9],
      [9, 10],
      [0, 10],
    ]);
    const done = made(doc, 'fillet_faces', { id, facesA: { near: [[3, 0, 10]] }, facesB: { near: [[10, 0, 5]] }, radius: 2 });
    expect(done.result.error).toBeUndefined();
    const section = spandrel([10, 10], [-1, 0], [0, -1], 2);
    const removed =
      2 * Math.PI * section.arm * section.area -
      revolved([
        [10, 10],
        [10, 9],
        [9, 10],
      ]);
    expect(volume(doc, id) - volume(done.doc, done.id)).toBeCloseTo(removed, 4);
    expect(blendFaces(done.doc, done.id)[0]?.surface).toBe('torus');
    expect(checked(done.doc).status).toBe('pass');
  });

  it('a cone against a plane (fold 66 degrees): the oracle is the same section about the axis', () => {
    const { doc, id } = revolve([
      [0, 0],
      [10, 0],
      [6, 9],
      [5, 10],
      [0, 10],
    ]);
    const corner: Point = [10 - 40 / 9, 10];
    const done = made(doc, 'fillet_faces', { id, facesA: { near: [[2, 0, 10]] }, facesB: { near: [[8, 0, 4.5]] }, radius: 3 });
    expect(done.result.error).toBeUndefined();
    const section = spandrel(corner, [-1, 0], [4, -9], 3);
    const removed = 2 * Math.PI * section.arm * section.area - revolved([corner, [6, 9], [5, 10]]);
    expect(volume(doc, id) - volume(done.doc, done.id)).toBeCloseTo(removed, 4);
    expect(checked(done.doc).status).toBe('pass');
  });

  it('refuses by name with the measured reason: a radius that leaves the faces, one the chamfer material blocks, a taper about an axis', () => {
    const { doc, id } = boss();
    const big = execute(doc, 'fillet_faces', { id, ...bossSets, radius: 30 });
    expect(big.error?.code).toBe('BLD_FACE_FILLET_NO_SOLUTION');
    expect(big.document).toBe(doc);
    const small = execute(doc, 'fillet_faces', { id, ...bossSets, radius: 4 });
    expect(small.error?.code).toBe('BLD_FACE_FILLET_NO_SOLUTION');
    expect(small.summary).toContain('smallest radius');
    const taper = execute(doc, 'fillet_faces', { id, ...bossSets, radius: 6, radiusEnd: 8 });
    expect(taper.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(taper.summary).toContain('constant radius');
  });

  it('a half revolution is refused: the swept blend would need faces all the way round (the contact is checked at eight angles)', () => {
    const half = made(createEmptyDocument(), 'revolve_profile', {
      profile: [
        [0, 0],
        [20, 0],
        [20, 5],
        [8, 5],
        [5, 8],
        [5, 15],
        [0, 15],
      ],
      axis: 'z',
      angle: Math.PI,
    });
    const refused = execute(half.doc, 'fillet_faces', {
      id: half.id,
      facesA: { near: [[0, 15, 5]] },
      facesB: { near: [[0, 5, 12]] },
      radius: 6,
    });
    expect(refused.error?.code).toBe('BLD_FACE_FILLET_NO_SOLUTION');
    expect(refused.summary).toContain('contact lines leave them');
  });

  it('round trips through save and load to the same volume', () => {
    const { doc, id } = boss();
    const done = made(doc, 'fillet_faces', { id, ...bossSets, radius: 6 });
    const again = deserializeDocument(serializeDocument(done.doc));
    expect(volume(again, done.id)).toBeCloseTo(volume(done.doc, done.id), 9);
  });

  // a 10 x 10 block (x, y in -5..5, depth 10) with a chamfer of leg 1 at the corner (5, 5); the wall x = 5 is split at y = 0 by a collinear vertex
  const block = (split: boolean): { doc: Doc; id: string } =>
    extrude(
      split
        ? [
            [-5, -5],
            [5, -5],
            [5, 0],
            [5, 4],
            [4, 5],
            [-5, 5],
          ]
        : [
            [-5, -5],
            [5, -5],
            [5, 4],
            [4, 5],
            [-5, 5],
          ],
    );

  const wall = (y: number): { near: number[][] } => ({ near: [[5, y, 5]] });
  const both = {
    near: [
      [5, -2, 5],
      [5, 2, 5],
    ],
  };
  const top = { near: [[0, 5, 5]] };
  /** The removed volume of a circular blend of radius r(z) = r0 + (r1 - r0) z / 10 along z (depth 10) with the chamfer triangle (area 0.5) already gone. */
  const removedBy = (r0: number, r1: number): number => (1 - Math.PI / 4) * 10 * ((r0 * r0 + r0 * r1 + r1 * r1) / 3) - 0.5 * 10;

  it('several coplanar faces in a set: the wall in two faces blends like the whole wall (closed form (1 - pi/4) r^2 L minus the chamfer)', () => {
    const { doc, id } = block(true);
    const whole = block(false);
    const split = made(doc, 'fillet_faces', { id, facesA: both, facesB: top, radius: 2 });
    const one = made(whole.doc, 'fillet_faces', { id: whole.id, facesA: wall(0), facesB: top, radius: 2 });
    expect(split.result.error).toBeUndefined();
    expect(volume(doc, id) - volume(split.doc, split.id)).toBeCloseTo(removedBy(2, 2), 6);
    expect(volume(split.doc, split.id)).toBeCloseTo(volume(one.doc, one.id), 9);
    expect(blendFaces(split.doc, split.id)).toHaveLength(1);
    expect((split.result.data as { consumedFaces: string[] }).consumedFaces).toHaveLength(1);
  });

  it('a straight taper between planes is a cone: the contact line crosses from one wall face to the next, the volume is the closed form', () => {
    const { doc, id } = block(true);
    const done = made(doc, 'fillet_faces', { id, facesA: both, facesB: top, radius: 2, radiusEnd: 6 });
    expect(done.result.error).toBeUndefined();
    expect(volume(doc, id) - volume(done.doc, done.id)).toBeCloseTo(removedBy(2, 6), 5);
    const blend = blendFaces(done.doc, done.id);
    expect(blend).toHaveLength(1);
    // the ruled loft of two homothetic arcs is a cone, carried as a B-spline surface
    expect(blend[0]?.surface).toBe('bspline');
    const check = checked(done.doc);
    expect(check.status).toBe('pass');
    expect(check.findings.every((finding) => finding.severity === 'info')).toBe(true);
    // one wall face alone cannot carry the contact line (it runs from y = 3 to y = -1): refused with the faces named
    const single = execute(doc, 'fillet_faces', { id, facesA: wall(2), facesB: top, radius: 2, radiusEnd: 6 });
    expect(single.error?.code).toBe('BLD_FACE_FILLET_NO_SOLUTION');
    expect(single.summary).toContain('contact lines leave them');
  });

  it('startNear picks the end where radius applies: the reversed taper removes the same volume with the blend heavier at the other end', () => {
    const { doc, id } = block(true);
    const forward = made(doc, 'fillet_faces', { id, facesA: both, facesB: top, radius: 2, radiusEnd: 6 });
    const reverse = made(doc, 'fillet_faces', { id, facesA: both, facesB: top, radius: 2, radiusEnd: 6, startNear: [5, 5, 10] });
    expect(reverse.result.error).toBeUndefined();
    expect(volume(reverse.doc, reverse.id)).toBeCloseTo(volume(forward.doc, forward.id), 6);
    const centroidZ = (d: Doc, i: string): number =>
      (execute(d, 'mass_properties', { entityId: i }).data as { centroid: number[] }).centroid[2] as number;
    // forward: radius 2 at z = 0 and 6 at z = 10, more removed near z = 10, centroid below the middle; reverse: the other way
    expect(centroidZ(forward.doc, forward.id)).toBeLessThan(5);
    expect(centroidZ(reverse.doc, reverse.id)).toBeGreaterThan(5);
  });

  it('refuses by name: faces of a set on two planes, parallel faces, a law, a width, a conic taper', () => {
    const { doc, id } = block(true);
    const mixed = execute(doc, 'fillet_faces', {
      id,
      facesA: {
        near: [
          [5, 2, 5],
          [0, -5, 5],
        ],
      },
      facesB: top,
      radius: 2,
    });
    expect(mixed.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(mixed.summary).toContain('not on one plane');
    const opposite = execute(doc, 'fillet_faces', { id, facesA: both, facesB: { near: [[-5, 0, 5]] }, radius: 2 });
    expect(opposite.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(opposite.summary).toContain('parallel');
    const law = execute(doc, 'fillet_faces', { id, facesA: both, facesB: top, law: { expression: '2 + 4 * t' } });
    expect(law.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['facesA'] });
    const chord = execute(doc, 'fillet_faces', { id, facesA: both, facesB: top, width: 2 });
    expect(chord.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['facesA'] });
    const conic = execute(doc, 'fillet_faces', {
      id,
      facesA: both,
      facesB: top,
      radius: 2,
      radiusEnd: 6,
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(conic.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(conic.summary).toContain('circular section only');
    const stepped = revolve([
      [0, 0],
      [8, 0],
      [8, 5],
      [5, 5],
      [5, 10],
      [0, 10],
    ]);
    const coaxial = execute(stepped.doc, 'fillet_faces', {
      id: stepped.id,
      facesA: { near: [[8, 0, 2]] },
      facesB: { near: [[5, 0, 8]] },
      radius: 1,
    });
    expect(coaxial.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(coaxial.summary).toContain('parallel in section');
  });
});
