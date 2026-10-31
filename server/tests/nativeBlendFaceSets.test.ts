/**
 * BLD M4 remainder on the native OCCT kernel (docs/design/06-variable-blends 13.13): fillet_faces over sets of several faces, curved faces and
 * radiusEnd / law / width, at 1 / 10 / 100 / 1000 mm. Every shape is checked against its analytic volume and by check_blends. Skipped when
 * the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
type Vec = [number, number, number];
interface Contact {
  readonly g0Gap: number;
  readonly g1AngleRad: number;
}
interface Check {
  readonly status: string;
  readonly blends: Array<{ contacts: Contact[] }>;
  readonly tolerances: { readonly g0: { readonly value: number } };
}

const SIZES = [1, 10, 100, 1000] as const;
const CORNER = 1 - Math.PI / 4;

/**
 * Volume (Pappus) a rim fillet of radius r removes where the base disc of a cone (radius R, height H) meets its slanted wall: the spandrel
 * of the kite (vertex, two tangent points, ball centre) less the sector of the ball, revolved about the axis.
 */
function coneRimRemoved(R: number, H: number, r: number): number {
  const alpha = Math.atan2(H, R);
  const tangent = r / Math.tan(alpha / 2);
  const toward = [-1, 0] as const;
  const wall = [-R / Math.hypot(R, H), H / Math.hypot(R, H)] as const;
  const bisector = [toward[0] + wall[0], toward[1] + wall[1]];
  const length = Math.hypot(bisector[0] ?? 0, bisector[1] ?? 0);
  const m = [(bisector[0] ?? 0) / length, (bisector[1] ?? 0) / length] as const;
  const centreRho = R + m[0] * (r / Math.sin(alpha / 2));
  const arcAngle = Math.PI - alpha;
  const kiteArea = r * tangent;
  const kiteRho = (2 * R + (R + toward[0] * tangent) + (R + wall[0] * tangent) + 2 * centreRho) / 6;
  const sectorArea = (r * r * arcAngle) / 2;
  const sectorRho = centreRho - m[0] * ((4 * r * Math.sin(arcAngle / 2)) / (3 * arcAngle));
  return 2 * Math.PI * (kiteArea * kiteRho - sectorArea * sectorRho);
}

/** Volume (numeric Pappus integral) a rim fillet of radius r removes where the plane z = cut meets a sphere of radius R about the origin (material below, inside). */
function sphereRimRemoved(R: number, cut: number, r: number): number {
  const centreZ = cut - r;
  const centreRho = Math.sqrt((R - r) ** 2 - centreZ ** 2);
  const reach = (R * centreRho) / (R - r);
  const steps = 4_000_000;
  const h = (reach - centreRho) / steps;
  let sum = 0;
  for (let k = 0; k < steps; k++) {
    const rho = centreRho + (k + 0.5) * h;
    const original = Math.min(cut, Math.sqrt(Math.max(0, R * R - rho * rho)));
    const arc = centreZ + Math.sqrt(Math.max(0, r * r - (rho - centreRho) ** 2));
    sum += rho * (original - arc) * h;
  }
  return 2 * Math.PI * sum;
}

describeNative('BLD M4 remainder: fillet_faces over face sets, curved faces and laws (native OCCT kernel)', () => {
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
  const check = (doc: Doc, id: string): Check => {
    const data = execute(doc, 'check_blends', { ids: [id] }).data as Check;
    expect(worst(data).g0).toBeLessThan(data.tolerances.g0.value);
    return data;
  };
  const relative = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);
  const worst = (data: Check): { g0: number; g1: number } => {
    const contacts = data.blends.flatMap((blend) => blend.contacts);
    return { g0: Math.max(0, ...contacts.map((c) => c.g0Gap)), g1: Math.max(0, ...contacts.map((c) => c.g1AngleRad)) };
  };
  const rows: string[] = [];
  const record = (label: string, size: number, error: number, data: Check, millis: number): void => {
    const { g0, g1 } = worst(data);
    rows.push(
      `| ${label} | ${size} | ${g0.toExponential(2)} | ${g1.toExponential(2)} | ${error.toExponential(2)} | ${millis.toFixed(0)} |`,
    );
  };
  afterAll(() => {
    if (process.env['LLULL_BLEND_TABLE'] !== undefined) console.warn(`\n${rows.join('\n')}`);
  });

  const lPrism = (s: number): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [0, 0],
        [10 * s, 0],
        [10 * s, 5 * s],
        [5 * s, 5 * s],
        [5 * s, 10 * s],
        [0, 10 * s],
      ],
      depth: 10 * s,
    });

  it.each(SIZES)('two faces on one side: top cap against TWO side walls, %d mm: analytic volume, G1 on every contact', (s) => {
    const { doc, id } = lPrism(s);
    const r = 0.5 * s;
    const started = performance.now();
    const done = made(doc, 'fillet_faces', {
      id,
      facesA: { near: [[2 * s, 2 * s, 10 * s]] },
      facesB: {
        near: [
          [5 * s, 0, 5 * s],
          [2.5 * s, 10 * s, 5 * s],
        ],
      },
      radius: r,
    });
    const millis = performance.now() - started;
    expect(done.result.error).toBeUndefined();
    expect((done.result.data as { blendEdges: number[] }).blendEdges).toHaveLength(2);
    const expected = volume(doc, id) - CORNER * r * r * (10 * s + 5 * s);
    const error = Math.abs(volume(done.doc, done.id) - expected) / expected;
    expect(error).toBeLessThan(1e-6);
    const data = check(done.doc, done.id);
    expect(data.status).toBe('pass');
    expect(data.blends).toHaveLength(2);
    record('two walls', s, error, data, millis);
  });

  it.each(SIZES)('a cylinder rim, cap against the curved wall, %d mm: Pappus volume, G1', (s) => {
    const R = 5 * s;
    const r = 0.8 * s;
    const cylinder = made(createEmptyDocument(), 'add_cylinder', { radius: R, height: 10 * s, anchor: 'base-center' });
    const started = performance.now();
    const done = made(cylinder.doc, 'fillet_faces', {
      id: cylinder.id,
      facesA: { near: [[R / 2, 0, 10 * s]] },
      facesB: { near: [[R, 0, 5 * s]] },
      radius: r,
    });
    const millis = performance.now() - started;
    expect(done.result.error).toBeUndefined();
    const removed = 2 * Math.PI * ((R - r) * CORNER * r * r + (r * r * r) / 6);
    const expected = volume(cylinder.doc, cylinder.id) - removed;
    const error = Math.abs(volume(done.doc, done.id) - expected) / expected;
    expect(error).toBeLessThan(1e-4);
    const data = check(done.doc, done.id);
    expect(data.status).toBe('pass');
    record('cylinder rim', s, error, data, millis);
  });

  it.each(SIZES)(
    'the concave ring of a boss, plate top against the cylinder wall, %d mm: material added (Pappus), G1',
    (s) => {
      const R = 10 * s;
      const r = 2 * s;
      const plate = made(createEmptyDocument(), 'add_box', { size: [60 * s, 60 * s, 5 * s], anchor: 'min' });
      const boss = made(plate.doc, 'add_cylinder', { radius: R, height: 15 * s, position: [30 * s, 30 * s, 5 * s], anchor: 'base-center' });
      const fused = made(boss.doc, 'boolean', { op: 'union', a: plate.id, b: boss.id });
      const started = performance.now();
      const done = made(fused.doc, 'fillet_faces', {
        id: fused.id,
        facesA: { near: [[5 * s, 5 * s, 5 * s]] },
        facesB: { near: [[40 * s, 30 * s, 10 * s]] },
        radius: r,
      });
      const millis = performance.now() - started;
      expect(done.result.error).toBeUndefined();
      const added = 2 * Math.PI * ((R + r) * CORNER * r * r - (r * r * r) / 6);
      const expected = volume(fused.doc, fused.id) + added;
      const error = Math.abs(volume(done.doc, done.id) - expected) / expected;
      expect(error).toBeLessThan(1e-4);
      const data = check(done.doc, done.id);
      expect(data.status).toBe('pass');
      record('boss ring', s, error, data, millis);
    },
    60_000,
  );

  const block = (s: number): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'add_box', { size: [20 * s, 10 * s, 10 * s], anchor: 'min' });
  const topAndFront = (s: number): Record<string, unknown> => ({
    facesA: { near: [[10 * s, 5 * s, 10 * s]] },
    facesB: { near: [[10 * s, 10 * s, 5 * s]] },
  });

  it.each(SIZES)('radiusEnd on a single planar pair, %d mm: section area (1 - pi/4) r(s)^2, linear-quadratic volume', (s) => {
    const { doc, id } = block(s);
    const started = performance.now();
    const done = made(doc, 'fillet_faces', { id, ...topAndFront(s), radius: 1 * s, radiusEnd: 2 * s });
    const millis = performance.now() - started;
    expect(done.result.error).toBeUndefined();
    const data = check(done.doc, done.id);
    expect(data.status).toBe('pass');
    const same = made(doc, 'fillet_edge', { id, edges: [{ near: [10 * s, 10 * s, 10 * s], size: 1 * s, sizeEnd: 2 * s }] });
    const error = relative(volume(done.doc, done.id), volume(same.doc, same.id));
    expect(error).toBeLessThan(1e-12);
    record('radiusEnd', s, error, data, millis);
  });

  it.each(SIZES)('a straight expression law r = 1 + t on a planar pair, %d mm: volume (1 - pi/4) L (r0^2 + r0 r1 + r1^2) / 3', (s) => {
    const { doc, id } = block(s);
    const started = performance.now();
    const done = made(doc, 'fillet_faces', { id, ...topAndFront(s), law: { expression: `${s} * (1 + t)`, samples: 33 } });
    const millis = performance.now() - started;
    expect(done.result.error).toBeUndefined();
    const expected = volume(doc, id) - (CORNER * 20 * s * (1 + 2 + 4) * s * s) / 3;
    const error = Math.abs(volume(done.doc, done.id) - expected) / expected;
    expect(error).toBeLessThan(2e-5);
    const same = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: [10 * s, 10 * s, 10 * s], law: { expression: `${s} * (1 + t)`, samples: 33 } }],
    });
    expect(relative(volume(done.doc, done.id), volume(same.doc, same.id))).toBeLessThan(1e-12);
    const data = check(done.doc, done.id);
    expect(data.status).toBe('pass');
    record('law', s, error, data, millis);
  });

  it.each(SIZES)('width (chord) 1.4142 x size on a right angle is the radius 1 x size, %d mm', (s) => {
    const { doc, id } = block(s);
    const started = performance.now();
    const done = made(doc, 'fillet_faces', { id, ...topAndFront(s), width: Math.SQRT2 * s });
    const millis = performance.now() - started;
    expect(done.result.error).toBeUndefined();
    const expected = volume(doc, id) - CORNER * s * s * 20 * s;
    const error = Math.abs(volume(done.doc, done.id) - expected) / expected;
    expect(error).toBeLessThan(1e-6);
    const data = check(done.doc, done.id);
    expect(data.status).toBe('pass');
    record('width', s, error, data, millis);
  });

  it('a conic profile rides along on a multi-face blend', () => {
    const { doc, id } = lPrism(10);
    const done = made(doc, 'fillet_faces', {
      id,
      facesA: { near: [[20, 20, 100]] },
      facesB: {
        near: [
          [50, 0, 50],
          [25, 100, 50],
        ],
      },
      radius: 5,
      profile: { type: 'conic', rho: 0.4 },
    });
    expect(done.result.error).toBeUndefined();
    expect(check(done.doc, done.id).status).toBe('pass');
  });

  it('refusals are named: no shared edge, a varying size over several edges, widthEnd without width, curved faces that do not meet', () => {
    const l = lPrism(10);
    const two = {
      facesA: { near: [[20, 20, 100]] as Vec[] },
      facesB: {
        near: [
          [50, 0, 50],
          [25, 100, 50],
        ] as Vec[],
      },
    };
    const varying = execute(l.doc, 'fillet_faces', { id: l.id, ...two, radius: 2, radiusEnd: 3 });
    expect(varying.document).toBe(l.doc);
    expect(varying.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['radiusEnd'] });
    expect(varying.summary).toMatch(/not one tangent chain|separate pieces/);
    const plate = made(createEmptyDocument(), 'add_box', { size: [60, 60, 5], anchor: 'min' });
    const boss = made(plate.doc, 'add_cylinder', { radius: 10, height: 15, position: [30, 30, 5], anchor: 'base-center' });
    const fused = made(boss.doc, 'boolean', { op: 'union', a: plate.id, b: boss.id });
    const apart = execute(fused.doc, 'fillet_faces', {
      id: fused.id,
      facesA: { near: [[5, 5, 0]] },
      facesB: { near: [[40, 30, 10]] },
      radius: 1,
    });
    expect(apart.document).toBe(fused.doc);
    // the plate underside and the boss wall: a ball tangent to both has its contact off the boss face (13.31): refused with the measured reason
    expect(apart.error).toMatchObject({ code: 'BLD_FACE_FILLET_NO_SOLUTION', paths: ['radius'] });
    expect(apart.summary).toContain('contact lines leave them');
    const noEdge = execute(l.doc, 'fillet_faces', {
      id: l.id,
      facesA: { near: [[75, 50, 50]] },
      facesB: {
        near: [
          [0, 50, 50],
          [25, 100, 50],
        ],
      },
      radius: 2,
    });
    expect(noEdge.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(noEdge.summary).toContain('not on one plane (face 1 is tilted');
    const orphan = execute(l.doc, 'fillet_faces', { id: l.id, ...two, radius: 2, widthEnd: 3 });
    expect(orphan.error).toMatchObject({ code: 'BLD_BLEND_PARAMS', paths: ['widthEnd'] });
    const cylinder = made(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 10, anchor: 'base-center' });
    const bottomAndWall = { facesA: { near: [[2, 0, 0]] }, facesB: { near: [[5, 0, 5]] } };
    const lawOnRim = execute(cylinder.doc, 'fillet_faces', { id: cylinder.id, ...bottomAndWall, law: { expression: '1 + t', samples: 9 } });
    expect(lawOnRim.error?.code).toBe('BLD_LAW_NOT_PERIODIC');
    expect(lawOnRim.document).toBe(cylinder.doc);
  });

  it('replay re-picks the faces from the recorded names: the same blend, the same ids', () => {
    const { doc, id } = lPrism(10);
    const done = made(doc, 'fillet_faces', {
      id,
      facesA: { near: [[20, 20, 100]] },
      facesB: {
        near: [
          [50, 0, 50],
          [25, 100, 50],
        ],
      },
      radius: 5,
    });
    const replayed = execute(done.doc, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    const brepOf = (doc: Doc, id: string): string => JSON.stringify((doc.entities[id] as MeshSolidEntity).brep);
    expect(Object.keys(replayed.document.entities)).toEqual(Object.keys(done.doc.entities));
    expect(volume(replayed.document, done.id)).toBe(volume(done.doc, done.id));
    expect(brepOf(replayed.document, done.id)).toBe(brepOf(done.doc, done.id));
  });

  const roundedCorner = (): { doc: Doc; id: string } => {
    const cube = made(createEmptyDocument(), 'add_box', { size: [100, 100, 100], anchor: 'min' });
    return made(cube.doc, 'fillet_edge', { id: cube.id, edgesNear: [[100, 100, 50]], radius: 20 });
  };
  const topAndBack = { facesA: { near: [[50, 50, 100]] }, facesB: { near: [[50, 100, 50]] } };

  it('the tangent chain of a shared edge is rounded with it: a chain that leaves the sets is refused naming the edges and faces, never rounded', () => {
    const { doc, id } = roundedCorner();
    for (const sizes of [{ radius: 5 }, { radius: 5, radiusEnd: 8 }, { width: 5 }, { law: { expression: '5 + 3 * t' } }]) {
      const refused = execute(doc, 'fillet_faces', { id, ...topAndBack, ...sizes });
      expect(refused.document).toBe(doc);
      expect(refused.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['facesA'] });
      expect(refused.summary).toContain('outside facesA and facesB');
      expect(refused.summary).toMatch(/edge \d+ \(bounds /);
    }
  });

  it('a hold line is checked like any other shared edge: on the rounded corner the chain would round the x+ face, so it is refused', () => {
    const { doc, id } = roundedCorner();
    const line = made(doc, 'draw_polyline', {
      points: [
        [-5, 90],
        [85, 92],
      ],
      position: [0, 0, 100],
    });
    const refused = execute(line.doc, 'fillet_faces', { id, ...topAndBack, holdLine: { id: line.id, onFaces: 'A' } });
    expect(refused.document).toBe(line.doc);
    expect(refused.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED' });
    expect(refused.summary).toContain('outside facesA and facesB');
  });

  /** A regular N-gon prism (R 50, depth 20): the kernel chains the side edges of the top face when the turn between sides is small enough. */
  const prism = (sides: number): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'extrude_profile', {
      profile: Array.from({ length: sides }, (_, k) => [
        50 * Math.cos((2 * Math.PI * k) / sides),
        50 * Math.sin((2 * Math.PI * k) / sides),
      ]),
      depth: 20,
    });
  const oneSide = (sides: number): Record<string, unknown> => {
    const turn = (2 * Math.PI) / sides;
    return { facesA: { near: [[0, 0, 20]] }, facesB: { near: [[(50 + 50 * Math.cos(turn)) / 2, (50 * Math.sin(turn)) / 2, 10]] } };
  };

  it.each([48, 64, 100, 120])(
    'a %d-sided prism: the kernel chain of the top edge decides, not a geometric rule (top against ONE side face)',
    (sides) => {
      const { doc, id } = prism(sides);
      const done = execute(doc, 'fillet_faces', { id, ...oneSide(sides), radius: 1 });
      const varying = execute(doc, 'fillet_faces', { id, ...oneSide(sides), radius: 1, radiusEnd: 1.5 });
      if (done.error === undefined) {
        // not chained: one blend edge, and a varying size is fine
        expect((done.data as { blendEdges: unknown[] }).blendEdges).toHaveLength(1);
        expect(check(done.document, done.affected[0] as string).status).toBe('pass');
        expect(varying.error).toBeUndefined();
        expect(sides).toBeLessThanOrEqual(56);
      } else {
        expect(done.document).toBe(doc);
        expect(done.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['facesA'] });
        expect(done.summary).toContain('outside facesA and facesB');
        expect(varying.document).toBe(doc);
        expect(sides).toBeGreaterThanOrEqual(64);
      }
    },
  );

  it('a chain that stays inside the sets is blended whole, as fillet_edge blends it: 3 edges reported, same volume to 1e-12', () => {
    const { doc, id } = roundedCorner();
    const done = made(doc, 'fillet_faces', {
      id,
      facesA: { near: [[50, 50, 100]] },
      facesB: {
        near: [
          [50, 100, 50],
          [94.142, 94.142, 50],
          [100, 50, 50],
        ],
      },
      radius: 5,
    });
    expect(done.result.error).toBeUndefined();
    const data = done.result.data as { blendEdges: Array<{ index: number }>; blends: unknown[] };
    expect(data.blendEdges).toHaveLength(3);
    // the corner blend that was already there, and the three new ones
    expect(data.blends).toHaveLength(4);
    const same = made(doc, 'fillet_edge', {
      id,
      edgesNear: [
        [40, 100, 100],
        [94.142, 94.142, 100],
        [100, 40, 100],
      ],
      radius: 5,
    });
    expect(relative(volume(done.doc, done.id), volume(same.doc, same.id))).toBeLessThan(1e-12);
    expect(check(done.doc, done.id).status).toBe('pass');
  });

  it('startNear picks the t = 0 end: the larger radius lies at the far end, in both directions', () => {
    const { doc, id } = block(1);
    const centroidX = (end: number): number => {
      const done = made(doc, 'fillet_faces', { id, ...topAndFront(1), radius: 1, radiusEnd: 2, startNear: [end, 10, 10] });
      expect(done.result.error).toBeUndefined();
      const edges = (done.result.data as { blendEdges: Array<{ start: number[] }> }).blendEdges;
      expect(edges[0]?.start[0]).toBeCloseTo(end, 6);
      return (execute(done.doc, 'mass_properties', { entityId: done.id }).data as { centroid: number[] }).centroid[0] ?? 0;
    };
    const small0 = centroidX(0);
    const small20 = centroidX(20);
    expect(small0).toBeLessThan(10);
    expect(small20).toBeGreaterThan(10);
    expect(small0 + small20).toBeCloseTo(20, 9);
  });
  it.each(SIZES)(
    'a cone base against its slanted wall, %d mm: blend tangent to both, material removed, check_blends pass',
    (s) => {
      const cone = made(createEmptyDocument(), 'add_cone', { radius: 5 * s, height: 10 * s, anchor: 'base-center' });
      const started = performance.now();
      const done = made(cone.doc, 'fillet_faces', {
        id: cone.id,
        facesA: { near: [[2 * s, 0, 0]] },
        facesB: { near: [[2.5 * s, 0, 5 * s]] },
        radius: 1 * s,
      });
      const millis = performance.now() - started;
      expect(done.result.error).toBeUndefined();
      const removed = volume(cone.doc, cone.id) - volume(done.doc, done.id);
      const error = relative(removed, coneRimRemoved(5, 10, 1) * s ** 3);
      expect(error).toBeLessThan(1e-6);
      const data = check(done.doc, done.id);
      expect(data.status).toBe('pass');
      record('cone base', s, error, data, millis);
    },
    60_000,
  );

  it.each(SIZES)(
    'a sphere cut flat, the planar cut against the spherical face, %d mm: check_blends pass',
    (s) => {
      const sphere = made(createEmptyDocument(), 'add_sphere', { radius: 10 * s });
      const slab = made(sphere.doc, 'add_box', { size: [40 * s, 40 * s, 12 * s] });
      const cut = made(slab.doc, 'boolean', { op: 'intersect', a: sphere.id, b: slab.id });
      expect(cut.result.error).toBeUndefined();
      const started = performance.now();
      const done = made(cut.doc, 'fillet_faces', {
        id: cut.id,
        facesA: { near: [[1 * s, 1 * s, 6 * s]] },
        facesB: { near: [[0, 8.7727 * s, 4.8 * s]] },
        radius: 1 * s,
      });
      const millis = performance.now() - started;
      expect(done.result.error).toBeUndefined();
      const error = relative(volume(cut.doc, cut.id) - volume(done.doc, done.id), sphereRimRemoved(10, 6, 1) * s ** 3);
      expect(error).toBeLessThan(1e-5);
      const data = check(done.doc, done.id);
      expect(data.status).toBe('pass');
      record('sphere cut', s, error, data, millis);
    },
    180_000,
  );

  it.each([5, 257])('a law with %d samples builds and passes check_blends (the default samples are not special)', (samples) => {
    const { doc, id } = block(10);
    const done = made(doc, 'fillet_faces', { id, ...topAndFront(10), law: { expression: '10 * (1 + 0.5 * sin(pi * t))', samples } });
    expect(done.result.error).toBeUndefined();
    expect(check(done.doc, done.id).status).toBe('pass');
  });
});
