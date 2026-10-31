/**
 * BLD M5 on the native OCCT kernel (docs/design/06-variable-blends 13.24): the variable chamfer with asymmetric legs on a straight edge and on a curved edge (an arc between a plane and a cylinder),
 * against closed forms: removed volume 1/2 integral d1(s) d2(s) ds on a right-angle straight edge, and by Pappus 1/2 integral d1 d2 (R - d1 / 3) d(theta) on the rim arc of a half cylinder; the legs measured on
 * the faces are the areas the two faces lose, integral d1 ds and integral (R d1 - d1^2 / 2) d(theta) on the top, integral R d2 d(theta) on the cylinder. Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
type Run = ReturnType<typeof execute>;
interface Face {
  readonly index: number;
  readonly surface: string;
  readonly area: number;
}
interface Edge {
  readonly index: number;
  readonly curve: string;
  readonly start: number[];
  readonly end: number[];
  readonly length: number;
}
const RADIUS = 20;

/** Integral of f over [0, 1] by Gauss-Legendre of 16 points (the integrands are smooth). */
function integrate(f: (t: number) => number): number {
  const nodes = [0.0950125098, 0.2816035508, 0.4580167777, 0.6178762444, 0.7554044084, 0.8656312024, 0.9445750231, 0.989400935];
  const weights = [0.1894506105, 0.182603415, 0.1691565194, 0.1495959888, 0.1246289713, 0.0951585117, 0.0622535239, 0.0271524594];
  return nodes.reduce((sum, x, k) => sum + (weights[k] as number) * (f(0.5 - 0.5 * x) + f(0.5 + 0.5 * x)), 0) * 0.5;
}

describeNative('BLD M5: variable chamfer, asymmetric legs and curved edges (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const must = (doc: Doc, name: string, params: Record<string, unknown>): { doc: Doc; id: string; result: Run } => {
    const result = execute(doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    return { doc: result.document, id: result.affected[0] as string, result };
  };
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const faces = (doc: Doc, id: string): Face[] => (execute(doc, 'inspect_topology', { id }).data as { faces: Face[] }).faces;
  const edges = (doc: Doc, id: string): Edge[] => (execute(doc, 'inspect_topology', { id }).data as { edges: Edge[] }).edges;
  const areaOf = (list: Face[], surface: string, near: (face: Face) => boolean = () => true): number =>
    list.filter((face) => face.surface === surface && near(face)).reduce((sum, face) => sum + face.area, 0);

  /** A box 20 x 10 x 5 about the origin: the top face z = 2.5, the edge along x at (y, z) = (5, 2.5) is 20 long. */
  const block = (): { doc: Doc; id: string } => must(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });

  it('asymmetric variable legs on a straight edge: the top leg 1 -> 2 and the side leg 2 -> 4 remove 1/2 integral d1 d2 = 7 L / 3, the top loses integral d1 = 1.5 L', () => {
    const { doc, id } = block();
    const before = volume(doc, id);
    const done = must(doc, 'chamfer_edge', {
      id,
      edgesNear: [[0, 5, 2.5]],
      distance: 1,
      distanceEnd: 2,
      distance2: 2,
      distance2End: 4,
      side1Near: [0, 0, 2.5],
    });
    const L = 20;
    expect(Math.abs(before - volume(done.doc, done.id) - (7 * L) / 3) / ((7 * L) / 3)).toBeLessThan(1e-8);
    // the legs are measured on the faces: the top (200) loses the strip of the top leg, the side (100) the strip of the side leg
    const after = faces(done.doc, done.id);
    const planeAreas = after
      .filter((f) => f.surface === 'plane')
      .map((f) => f.area)
      .sort((a, b) => a - b);
    expect(planeAreas.some((area) => Math.abs(area - (200 - 1.5 * L)) < 1e-6)).toBe(true);
    expect(planeAreas.some((area) => Math.abs(area - (100 - 3 * L)) < 1e-6)).toBe(true);
    // naming the other face as side 1 swaps the legs: the top now loses integral d2 = 3 L
    const swapped = must(doc, 'chamfer_edge', {
      id,
      edgesNear: [[0, 5, 2.5]],
      distance: 1,
      distanceEnd: 2,
      distance2: 2,
      distance2End: 4,
      side1Near: [0, 5, 0],
    });
    const swappedAreas = faces(swapped.doc, swapped.id)
      .filter((f) => f.surface === 'plane')
      .map((f) => f.area);
    expect(swappedAreas.some((area) => Math.abs(area - (200 - 3 * L)) < 1e-6)).toBe(true);
    expect(swappedAreas.some((area) => Math.abs(area - (100 - 1.5 * L)) < 1e-6)).toBe(true);
  });

  /** A half cylinder R 20, height 10 (the part of the cylinder with y >= 0): the top rim is a half circle between the top plane and the cylinder. */
  const half = (): { doc: Doc; id: string; arc: Edge; atPositiveX: boolean } => {
    const cylinder = must(createEmptyDocument(), 'add_cylinder', { radius: RADIUS, height: 10 });
    const cutter = must(cylinder.doc, 'add_box', { size: [60, 30, 30], position: [0, -15, 0] });
    const done = must(cutter.doc, 'boolean', { op: 'subtract', a: cylinder.id, b: cutter.id });
    const arc = edges(done.doc, done.id).find(
      (edge) => edge.curve === 'circle' && edge.start[2] === edge.end[2] && (edge.start[2] as number) > 0,
    ) as Edge;
    expect(arc).toBeDefined();
    return { doc: done.doc, id: done.id, arc, atPositiveX: (arc.start[0] as number) > 0 };
  };
  const arcNear = (arc: Edge): number[] => [0, RADIUS, arc.start[2] as number];

  it('a constant asymmetric chamfer on the arc (legs 1 on the top, 2 down the cylinder) removes pi/2 d1 d2 (R - d1/3) by Pappus', () => {
    const { doc, id, arc } = half();
    const before = volume(doc, id);
    const done = must(doc, 'chamfer_edge', {
      id,
      edgesNear: [arcNear(arc)],
      distance: 1,
      distanceEnd: 1,
      distance2: 2,
      distance2End: 2,
      side1Near: [0, 5, arc.start[2]],
    });
    const expected = (Math.PI / 2) * 1 * 2 * (RADIUS - 1 / 3);
    expect(Math.abs(before - volume(done.doc, done.id) - expected) / expected).toBeLessThan(1e-4);
  });

  it('a variable chamfer on the arc, legs d1 1 -> 2 on the top and d2 2 -> 3 on the cylinder, matches the Pappus integral, and the faces lose the integrals of the legs', () => {
    const { doc, id, arc, atPositiveX } = half();
    const before = volume(doc, id);
    const beforeFaces = faces(doc, id);
    const done = must(doc, 'chamfer_edge', {
      id,
      edgesNear: [arcNear(arc)],
      distance: 1,
      distanceEnd: 2,
      distance2: 2,
      distance2End: 3,
      side1Near: [0, 5, arc.start[2]],
    });
    // the arc runs from its start to its end over a half turn: d(s) is linear in s = theta / pi from the start
    const d1 = (t: number): number => 1 + t;
    const d2 = (t: number): number => 2 + t;
    const expected = Math.PI * integrate((t) => 0.5 * d1(t) * d2(t) * (RADIUS - d1(t) / 3));
    const measured = before - volume(done.doc, done.id);
    expect(Math.abs(measured - expected) / expected, `start at ${atPositiveX ? '+' : '-'}x`).toBeLessThan(1e-4);
    const afterFaces = faces(done.doc, done.id);
    // the top (a half disc) loses integral (R d1 - d1^2 / 2) d(theta); the cylinder integral R d2 d(theta)
    const topLoss = Math.PI * integrate((t) => RADIUS * d1(t) - (d1(t) * d1(t)) / 2);
    const sideLoss = Math.PI * RADIUS * integrate((t) => d2(t));
    const planes = (list: Face[]): number => areaOf(list, 'plane', (face) => face.area > 500);
    expect(Math.abs(planes(beforeFaces) - planes(afterFaces) - topLoss)).toBeLessThan(1e-3 * topLoss);
    expect(Math.abs(areaOf(beforeFaces, 'cylinder') - areaOf(afterFaces, 'cylinder') - sideLoss)).toBeLessThan(1e-3 * sideLoss);
  });

  it('a symmetric variable chamfer 1 -> 2 on the arc removes the integral of 1/2 d^2 (R - d/3), and the mirrored law 2 -> 1 removes the same', () => {
    const { doc, id, arc } = half();
    const before = volume(doc, id);
    const forward = must(doc, 'chamfer_edge', { id, edgesNear: [arcNear(arc)], distance: 1, distanceEnd: 2 });
    const backward = must(doc, 'chamfer_edge', { id, edgesNear: [arcNear(arc)], distance: 2, distanceEnd: 1 });
    const law =
      (rise: boolean) =>
      (t: number): number =>
        rise ? 1 + t : 2 - t;
    const closed = (d: (t: number) => number): number => Math.PI * integrate((t) => 0.5 * d(t) * d(t) * (RADIUS - d(t) / 3));
    const removedForward = before - volume(forward.doc, forward.id);
    const removedBackward = before - volume(backward.doc, backward.id);
    expect(Math.abs(removedForward - closed(law(true))) / closed(law(true))).toBeLessThan(1e-4);
    expect(Math.abs(removedBackward - closed(law(false))) / closed(law(false))).toBeLessThan(1e-4);
    // the half circle is symmetric about its middle: the mirrored law removes the same volume
    expect(Math.abs(removedForward - removedBackward) / removedForward).toBeLessThan(1e-4);
  });

  it('a concave straight edge (the foot of a step) gains 1/2 integral d1 d2 with asymmetric variable legs (the tool is fused)', () => {
    const low = must(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const wall = must(low.doc, 'add_box', { size: [20, 4, 5], position: [0, 3, 5] });
    const step = must(wall.doc, 'boolean', { op: 'union', a: low.id, b: wall.id });
    const before = volume(step.doc, step.id);
    // the foot of the wall: along x at (y, z) = (1, 2.5), 20 long; the floor leg 1 -> 2, the wall leg 2 -> 3
    const foot = edges(step.doc, step.id).find(
      (edge) => edge.curve === 'line' && Math.abs((edge.start[1] as number) - 1) < 1e-9 && Math.abs((edge.start[2] as number) - 2.5) < 1e-9,
    );
    expect(foot).toBeDefined();
    const done = must(step.doc, 'chamfer_edge', {
      id: step.id,
      edgesNear: [[0, 1, 2.5]],
      distance: 1,
      distanceEnd: 2,
      distance2: 2,
      distance2End: 3,
      side1Near: [0, -2, 2.5],
    });
    const gained = volume(done.doc, done.id) - before;
    const expected = 20 * integrate((t) => 0.5 * (1 + t) * (2 + t));
    expect(Math.abs(gained - expected) / expected).toBeLessThan(1e-8);
  });

  it('check_blends reads the legs back: stations along the edge, each leg against its law, on the straight edge and on the arc, and a pass', () => {
    const { doc, id } = block();
    const straight = must(doc, 'chamfer_edge', {
      id,
      edgesNear: [[0, 5, 2.5]],
      distance: 1,
      distanceEnd: 2,
      distance2: 2,
      distance2End: 4,
      side1Near: [0, 0, 2.5],
    });
    const read = execute(straight.doc, 'check_blends', {});
    const rows = (
      read.data as {
        chamfers: Array<{
          legs: Array<{ s: number; first: number; second: number; expectedFirst: number; expectedSecond: number }>;
          maxDeviation: number;
        }>;
        status: string;
      }
    ).chamfers;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.legs.length).toBeGreaterThanOrEqual(5);
    expect(rows[0]?.maxDeviation).toBeLessThan(1e-8);
    expect((read.data as { status: string }).status).toBe('pass');
    // the first leg runs 1 -> 2 and the second 2 -> 4 along the edge
    const last = rows[0]?.legs.at(-1);
    expect(Math.abs((last?.first ?? 0) - (last?.expectedFirst ?? 1))).toBeLessThan(1e-8);
    expect(Math.abs((rows[0]?.legs[0]?.second ?? 0) - 2)).toBeLessThan(1e-8);
    const { doc: halfDoc, id: halfId, arc } = half();
    const curved = must(halfDoc, 'chamfer_edge', {
      id: halfId,
      edgesNear: [arcNear(arc)],
      distance: 1,
      distanceEnd: 2,
      distance2: 2,
      distance2End: 3,
      side1Near: [0, 5, arc.start[2]],
    });
    const arcRead = execute(curved.doc, 'check_blends', { ids: [curved.id] });
    const arcRows = (arcRead.data as { chamfers: Array<{ maxDeviation: number; legs: unknown[] }> }).chamfers;
    expect(arcRows).toHaveLength(1);
    expect(arcRows[0]?.legs.length).toBeGreaterThanOrEqual(5);
    expect(arcRows[0]?.maxDeviation).toBeLessThan(1e-3);
    expect((arcRead.data as { status: string }).status).toBe('pass');
  });

  it('a distance-angle chamfer is read back with its own law: on a right angle the second leg is d tan(a) = 0.5774, on a 116.57 degree dihedral d sin(a) / sin(phi + a) = 0.9075 (never the first leg)', () => {
    const { doc, id } = block();
    const right = must(doc, 'chamfer_edge', { id, edgesNear: [[0, 5, 2.5]], distance: 1, angleDeg: 30, side1Near: [0, 0, 2.5] });
    const rows = (
      execute(right.doc, 'check_blends', {}).data as {
        chamfers?: Array<{ maxDeviation: number | null; legs: Array<{ expectedSecond: number | null }>; note?: string }>;
        status: string;
      }
    ).chamfers;
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.note).toBeUndefined();
    expect(rows?.[0]?.legs[0]?.expectedSecond).toBeCloseTo(Math.tan(Math.PI / 6), 6);
    expect(rows?.[0]?.maxDeviation).toBeLessThan(1e-6);
    const profile = must(createEmptyDocument(), 'draw_polyline', {
      points: [
        [0, 0],
        [20, 0],
        [15, 10],
        [5, 10],
      ],
      closed: true,
    });
    const prism = must(profile.doc, 'extrude_profile', { id: profile.id, depth: 8 });
    const corner = edges(prism.doc, prism.id).find(
      (edge) => Math.abs((edge.start[0] as number) - 5) < 1e-9 && Math.abs((edge.start[1] as number) - 10) < 1e-9 && edge.curve === 'line',
    ) as Edge;
    expect(corner).toBeDefined();
    const mid = (corner.start[2] as number) / 2 + (corner.end[2] as number) / 2;
    const done = must(prism.doc, 'chamfer_edge', {
      id: prism.id,
      edgesNear: [[5, 10, mid]],
      distance: 1,
      angleDeg: 30,
      side1Near: [10, 10, mid],
    });
    const beforeVolume = volume(prism.doc, prism.id);
    const phi = Math.acos(-1 / Math.sqrt(5));
    const second = Math.sin(Math.PI / 6) / Math.sin(phi + Math.PI / 6);
    const expected = 0.5 * 1 * second * Math.sin(phi) * 8;
    expect(Math.abs(beforeVolume - volume(done.doc, done.id) - expected) / expected).toBeLessThan(1e-6);
    const read = execute(done.doc, 'check_blends', {}).data as {
      chamfers?: Array<{ maxDeviation: number | null; legs: Array<{ expectedSecond: number | null }>; note?: string }>;
    };
    const row = read.chamfers?.[0];
    expect(row).toBeDefined();
    expect(row?.note).toBeUndefined();
    expect(row?.legs[0]?.expectedSecond).toBeCloseTo(second, 6);
    expect(row?.maxDeviation).toBeLessThan(1e-6);
  });

  /** A quarter ball R 10 (the sphere in the box [0, 10]^3): the rim arc between the base plane z = 0 and the sphere is a quarter circle ending on the flat faces x = 0 and y = 0. */
  const octant = (): { doc: Doc; id: string } => {
    const ball = must(createEmptyDocument(), 'add_sphere', { radius: 10 });
    const corner = must(ball.doc, 'add_box', { size: [10, 10, 10], position: [5, 5, 5] });
    const done = must(corner.doc, 'boolean', { op: 'intersect', a: ball.id, b: corner.id });
    return { doc: done.doc, id: done.id };
  };

  it('on a sphere R 10 the leg is the chord in the plane of the section: legs 1 on the base and 2 on the sphere remove (pi/2) integral 1/2 (rho_s^2 - rho_line^2) dz, and check_blends reads the chord 2 back', () => {
    const { doc, id } = octant();
    const before = volume(doc, id);
    const done = must(doc, 'chamfer_edge', {
      id,
      edgesNear: [[10 * Math.SQRT1_2, 10 * Math.SQRT1_2, 0]],
      distance: 1,
      distanceEnd: 1,
      distance2: 2,
      distance2End: 2,
      side1Near: [3, 3, 0],
    });
    const radius = 10;
    const beta = 2 * Math.asin(2 / (2 * radius));
    const [rhoB, zB] = [radius * Math.cos(beta), radius * Math.sin(beta)];
    const line = (z: number): number => radius - 1 + (z * (rhoB - (radius - 1))) / zB;
    const expected = (Math.PI / 2) * zB * integrate((t) => 0.5 * (radius * radius - (t * zB) ** 2 - line(t * zB) ** 2));
    expect(Math.abs(before - volume(done.doc, done.id) - expected) / expected).toBeLessThan(1e-4);
    const read = execute(done.doc, 'check_blends', {});
    const rows = (
      read.data as { chamfers: Array<{ maxDeviation: number | null; legs: Array<{ first: number; second: number }> }>; status: string }
    ).chamfers;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.maxDeviation).toBeLessThan(1e-3);
    expect(rows[0]?.legs[3]?.second).toBeCloseTo(2, 3);
    expect(rows[0]?.legs[3]?.first).toBeCloseTo(1, 3);
    expect((read.data as { status: string }).status).toBe('pass');
  });

  /** A half-round pocket R 2 in a block (the half cylinder x >= 0 removed from the floor z = 0 up through the top): a concave arc between the floor and the cylindrical wall, ending on the flat wall x = 0. */
  const pocket = (): { doc: Doc; id: string } => {
    const block = must(createEmptyDocument(), 'add_box', { size: [20, 20, 10] });
    const round = must(block.doc, 'add_cylinder', { radius: 2, height: 6, position: [0, 0, 3] });
    const half = must(round.doc, 'add_box', { size: [10, 10, 10], position: [5, 0, 3] });
    const cutter = must(half.doc, 'boolean', { op: 'intersect', a: round.id, b: half.id });
    const done = must(cutter.doc, 'boolean', { op: 'subtract', a: block.id, b: cutter.id });
    return { doc: done.doc, id: done.id };
  };

  it('a concave arc in a half-round pocket R 2: legs 1 on the floor and 4 up the wall (the opposite wall is 4 away, so a tool reaching along the normals by the largest leg would cut it) gain pi/2 d1 d2 (R - d1/3)', () => {
    const { doc, id } = pocket();
    const before = volume(doc, id);
    const done = must(doc, 'chamfer_edge', {
      id,
      edgesNear: [[2, 0, 0]],
      distance: 1,
      distanceEnd: 1,
      distance2: 4,
      distance2End: 4,
      side1Near: [1, 0, 0],
    });
    const expected = (Math.PI / 2) * 1 * 4 * (2 - 1 / 3);
    expect(Math.abs(volume(done.doc, done.id) - before - expected) / expected).toBeLessThan(1e-4);
  });

  it('refuses by name: a closed edge, edges sharing a vertex, a leg past its face, and a law that does not fit', () => {
    const rim = must(createEmptyDocument(), 'add_cylinder', { radius: RADIUS, height: 10 });
    const circle = edges(rim.doc, rim.id).find((edge) => edge.curve === 'circle') as Edge;
    const closedEdge = execute(rim.doc, 'chamfer_edge', {
      id: rim.id,
      edgesNear: [[0, RADIUS, circle.start[2] as number]],
      distance: 1,
      distanceEnd: 2,
    });
    expect(closedEdge.error?.code).toBe('BLD_CHAMFER_FAILED');
    expect(closedEdge.summary).toContain('closed edge');
    const { doc, id, arc } = half();
    const tooBig = execute(doc, 'chamfer_edge', { id, edgesNear: [arcNear(arc)], distance: 1, distanceEnd: 30 });
    expect(tooBig.error?.code).toBe('BLD_CHAMFER_FAILED');
    expect(tooBig.summary).toContain('reaches past the faces');
    const sided = execute(doc, 'chamfer_edge', { id, edgesNear: [arcNear(arc)], distance: 1, distanceEnd: 2, distance2: 2 });
    expect(sided.error?.code).toBe('BLD_CHAMFER_VARIABLE_PARAMS');
    const angle = execute(doc, 'chamfer_edge', {
      id,
      edgesNear: [arcNear(arc)],
      distance: 1,
      distanceEnd: 2,
      angleDeg: 30,
      side1Near: [0, 5, arc.start[2]],
    });
    expect(angle.error?.code).toBe('BLD_CHAMFER_VARIABLE_PARAMS');
    const orphan = execute(doc, 'chamfer_edge', { id, edgesNear: [arcNear(arc)], distance: 1, distance2End: 2 });
    expect(orphan.error?.code).toBe('BLD_CHAMFER_VARIABLE_PARAMS');
    const { doc: boxDoc, id: boxId } = block();
    const shared = execute(boxDoc, 'chamfer_edge', {
      id: boxId,
      edgesNear: [
        [0, 5, 2.5],
        [10, 0, 2.5],
      ],
      distance: 1,
      distanceEnd: 2,
    });
    expect(shared.error?.code).toBe('BLD_CHAMFER_FAILED');
    expect(shared.summary).toContain('meet at a vertex');
  });
});
