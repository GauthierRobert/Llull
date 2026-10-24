/**
 * 03 WRP M4: add_knurl, the cosmetic knurl note (VC-WRP-24): the teeth close round the circumference, the pitch used differs from the request and says so.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { pmiText } from '@core/geometry/pmiText';
import { pmiItems } from '@core/commands/pmi/pmiOps';
import { depthForLand, freeEnds, grooveArea, knurlRecipe, landFor } from '@core/commands/wrap/knurlGeometry';
import type { FaceGraph } from '@core/geometry/kernelPorts';
import { fakeWrapKernel } from '../../helpers/fakeWrapKernel';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { expectRefusal } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';
import { box, emptyDoc, make, sphere, useFakeKernel, type Made } from './support';

interface KnurlData {
  readonly knurlId: string;
  readonly teeth: number;
  readonly pitch: number;
  readonly requestedPitch: number;
  readonly diameter: number;
  readonly helixAngleDeg?: number;
  readonly pitchAdjusted: boolean;
  readonly warnings: Array<{ code: string }>;
  readonly reviewRequired: boolean;
  readonly defaults: Array<{ name: string }>;
}

const rod = (): Made => make(emptyDoc(), 'add_cylinder', { radius: 10, height: 40 });
const FACE10 = { faceNear: [10, 0, 0] };

describe('add_knurl (VC-WRP-24)', () => {
  useFakeKernel();

  it('d 20, pitch 1.0 straight: 63 teeth, pitch 0.99733100114, warning WRP_KNURL_PITCH_ADJUSTED, review-required PMI', () => {
    const { doc, id } = rod();
    const result = execute(doc, 'add_knurl', { id, face: FACE10, pattern: 'straight', pitch: 1 });
    expect(result.rejected, result.summary).toBeUndefined();
    const info = result.data as unknown as KnurlData;
    expect(info.teeth).toBe(63);
    expect(Math.abs(info.pitch / 0.99733100114 - 1)).toBeLessThan(1e-9);
    expect(info).toMatchObject({ requestedPitch: 1, diameter: 20, pitchAdjusted: true, reviewRequired: true });
    expect(info.warnings.map((w) => w.code)).toEqual(['WRP_KNURL_PITCH_ADJUSTED']);
    expect(info.helixAngleDeg).toBeUndefined();
    const item = pmiItems(result.document)[0];
    expect(item).toMatchObject({ kind: 'knurl', teeth: 63, pattern: 'straight', review: { required: true } });
    expect(item && pmiText(item)).toContain('KNURL STRAIGHT');
    expect(result.summary).toContain('WRP_KNURL_PITCH_ADJUSTED');
    const reloaded = deserializeDocument(serializeDocument(result.document));
    expect('error' in reloaded).toBe(false);
    expectPure(doc, () => execute(doc, 'add_knurl', { id, face: FACE10, pattern: 'straight', pitch: 1 }));
  });

  it('a pitch that divides the circumference exactly is not adjusted; diagonal and diamond take the helix angle (default 30, named)', () => {
    const { doc, id } = rod();
    const exact = execute(doc, 'add_knurl', { id, face: FACE10, pattern: 'straight', pitch: (Math.PI * 20) / 60 });
    const info = exact.data as unknown as KnurlData;
    expect(info.teeth).toBe(60);
    expect(info.pitchAdjusted).toBe(false);
    expect(info.warnings).toEqual([]);
    const diagonal = execute(doc, 'add_knurl', { id, face: FACE10, pattern: 'diagonal', pitch: 2 });
    expect((diagonal.data as unknown as KnurlData).helixAngleDeg).toBe(30);
    expect((diagonal.data as unknown as KnurlData).defaults.map((d) => d.name)).toContain('helixAngleDeg');
    const diamond = execute(doc, 'add_knurl', { id, face: FACE10, pattern: 'diamond', pitch: 2, helixAngleDeg: 45 });
    expect((diamond.data as unknown as KnurlData).helixAngleDeg).toBe(45);
    expect(pmiItems(diamond.document)[0] && pmiText(pmiItems(diamond.document)[0] as never)).toContain('45° HELIX');
    expect(pmiItems(diamond.document)[0] && pmiText(pmiItems(diamond.document)[0] as never, true)).toContain('45 deg HELIX');
  });

  it('refuses a face that is not a cylinder, bad pitch / helix, a pitch too coarse, a missing solid and a missing kernel', () => {
    const { doc, id } = rod();
    const plate = box();
    expectRefusal(
      plate.doc,
      'add_knurl',
      { id: plate.id, face: { faceIndex: 0 }, pattern: 'straight', pitch: 1 },
      'WRP_KNURL_FACE_NOT_CYLINDER',
      'face',
    );
    const ball = sphere();
    expectRefusal(
      ball.doc,
      'add_knurl',
      { id: ball.id, face: { faceIndex: 0 }, pattern: 'straight', pitch: 1 },
      'WRP_KNURL_FACE_NOT_CYLINDER',
    );
    expectRefusal(doc, 'add_knurl', { id, face: FACE10, pattern: 'straight', pitch: 0 }, 'WRP_PARAM_INVALID', 'pitch');
    expectRefusal(doc, 'add_knurl', { id, face: FACE10, pattern: 'straight', pitch: 100 }, 'WRP_PARAM_INVALID', 'pitch');
    expectRefusal(
      doc,
      'add_knurl',
      { id, face: FACE10, pattern: 'diagonal', pitch: 1, helixAngleDeg: 90 },
      'WRP_PARAM_INVALID',
      'helixAngleDeg',
    );
    expectRefusal(doc, 'add_knurl', { id: 'nope', face: FACE10, pattern: 'straight', pitch: 1 }, 'WRP_ENTITY_NOT_FOUND');
    setGeometryKernel(null);
    expectRefusal(doc, 'add_knurl', { id, face: FACE10, pattern: 'straight', pitch: 1 }, 'CMD_KERNEL_UNAVAILABLE');
  });
});

describe('add_knurl model geometry (straight V-grooves)', () => {
  useFakeKernel();

  it('grooveArea is the area of the V below the cylinder surface (closed form against dense quadrature)', () => {
    const quadrature = (radius: number, depth: number, angleDeg: number): number => {
      const slope = 1 / Math.tan((angleDeg * Math.PI) / 360);
      const base = radius - depth;
      const steps = 200000;
      let area = 0;
      for (let k = 0; k < steps; k++) {
        const x = ((k + 0.5) / steps) * 2 * radius - radius;
        const height = Math.sqrt(Math.max(0, radius * radius - x * x)) - base - slope * Math.abs(x);
        if (height > 0) area += (height * 2 * radius) / steps;
      }
      return area;
    };
    for (const [radius, depth, angle] of [
      [10, 0.4488, 90],
      [10, 0.9, 60],
      [25, 1.2, 120],
      [4, 0.5, 90],
    ] as const) {
      expect(
        Math.abs(grooveArea({ teeth: 3, radius, depth, toothAngleDeg: angle }) / quadrature(radius, depth, angle) - 1),
        `${radius} ${depth} ${angle}`,
      ).toBeLessThan(1e-4);
    }
    expect(depthForLand(1, 90, 0.1)).toBeCloseTo(0.45, 12);
    expect(landFor(1, 90, 0.45)).toBeCloseTo(0.1, 12);
    expect(landFor(1, 90, 0.6)).toBeLessThan(0);
  });

  it('cuts 63 grooves on d 20 with the land of 10 % of the pitch, reports the closed-form volume and replaces the solid', () => {
    const { doc, id } = rod();
    const result = execute(doc, 'add_knurl', { id, face: FACE10, pattern: 'straight', pitch: 1, model: 'geometry' });
    expect(result.rejected, result.summary).toBeUndefined();
    const info = result.data as unknown as KnurlData & {
      depth: number;
      land: number;
      expectedVolumeDelta: number;
      toothAngleDeg: number;
      length: number;
    };
    const pitch = (Math.PI * 20) / 63;
    expect(info).toMatchObject({ teeth: 63, toothAngleDeg: 90, model: 'geometry' });
    expect(info.depth).toBeCloseTo(0.45 * pitch, 12);
    expect(info.land).toBeCloseTo(0.1 * pitch, 12);
    expect(info.length).toBeCloseTo(40, 9);
    expect(info.expectedVolumeDelta).toBeCloseTo(-63 * 40 * grooveArea({ teeth: 63, radius: 10, depth: info.depth, toothAngleDeg: 90 }), 9);
    expect(info.defaults.map((d) => d.name).sort()).toEqual(['landRatio', 'toothAngleDeg']);
    expect(result.document.entities[id]).toBeUndefined();
    expect(pmiItems(result.document)).toHaveLength(0);
    expect(result.summary).toContain('63 V-grooves');
    expectPure(doc, () => execute(doc, 'add_knurl', { id, face: FACE10, pattern: 'straight', pitch: 1, model: 'geometry' }));
    const deep = execute(doc, 'add_knurl', {
      id,
      face: FACE10,
      pattern: 'straight',
      pitch: 2,
      model: 'geometry',
      depth: 0.8,
      toothAngleDeg: 60,
    });
    expect(deep.rejected, deep.summary).toBeUndefined();
    expect(deep.data).toMatchObject({ depth: 0.8, toothAngleDeg: 60 });
  });

  it('refuses helical geometry, grooves that meet or reach too deep, a bad angle, and a kernel that cannot cut', () => {
    const { doc, id } = rod();
    const base = { id, face: FACE10, model: 'geometry' };
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: 1 }, 'WRP_KNURL_GEOMETRY_UNSUPPORTED', 'pattern');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diamond', pitch: 1 }, 'WRP_KNURL_GEOMETRY_UNSUPPORTED');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'straight', pitch: 1, depth: 0.6 }, 'WRP_KNURL_DEPTH_INVALID', 'depth');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'straight', pitch: 20, depth: 6 }, 'WRP_DEPTH_EXCEEDS_SOLID', 'depth');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'straight', pitch: 1, toothAngleDeg: 180 }, 'WRP_PARAM_INVALID', 'toothAngleDeg');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'straight', pitch: 1, depth: -1 }, 'WRP_PARAM_INVALID', 'depth');
    setGeometryKernel(fakeWrapKernel({ subtractSkew: 1.01 }));
    const reaching = expectRefusal(doc, 'add_knurl', { ...base, pattern: 'straight', pitch: 1 }, 'WRP_KERNEL_BUILD_FAILED', 'face');
    expect(reaching.summary).toContain('beyond the face');
    setGeometryKernel(fakeWrapKernel({ refuseBoolean: true }));
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'straight', pitch: 1 }, 'WRP_KERNEL_BUILD_FAILED', 'face');
  });
});

describe('add_knurl bounds and the load guard of its note', () => {
  useFakeKernel();

  it('refuses more than 2000 teeth, a pitch with no finite tooth count, and a helix angle on a straight pattern', () => {
    const { doc, id } = rod();
    const base = { id, face: FACE10 };
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'straight', pitch: 0.01 }, 'WRP_PARAM_INVALID', 'pitch');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'straight', pitch: 1e-310 }, 'WRP_PARAM_INVALID', 'pitch');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'straight', pitch: 0.01, model: 'geometry' }, 'WRP_PARAM_INVALID', 'pitch');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'straight', pitch: 1, helixAngleDeg: 30 }, 'WRP_PARAM_INVALID', 'helixAngleDeg');
    expect(execute(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: 1, helixAngleDeg: 45 }).rejected).toBeUndefined();
  });

  it('refuses a knurl note whose fields disagree when a file is loaded', () => {
    const { doc, id } = rod();
    const made = execute(doc, 'add_knurl', { id, face: FACE10, pattern: 'straight', pitch: 1 }).document;
    const helical = execute(doc, 'add_knurl', { id, face: FACE10, pattern: 'diagonal', pitch: 1 }).document;
    const patched = (source: typeof made, patch: Record<string, unknown>): boolean => {
      const item = pmiItems(source)[0] as unknown as Record<string, unknown>;
      const broken = {
        ...source,
        pmi: { ...source.pmi, items: { ...source.pmi?.items, [item['id'] as string]: { ...item, ...patch } } },
      } as unknown as typeof made;
      return execute(emptyDoc(), 'load_document', { json: serializeDocument(broken) }).affected.length > 0;
    };
    expect(patched(made, {})).toBe(true);
    expect(patched(made, { pitch: 2 })).toBe(false);
    expect(patched(made, { helixAngleDeg: 30 })).toBe(false);
    expect(patched(made, { teeth: 5000, pitch: (Math.PI * 20) / 5000 })).toBe(false);
    expect(patched(helical, {})).toBe(true);
    expect(patched(helical, { helixAngleDeg: 120 })).toBe(false);
    expect(patched(helical, { helixAngleDeg: undefined })).toBe(false);
  });
});

describe('freeEnds: which ends of a cylinder face are free end caps', () => {
  const plane = (index: number, z: number, loops: number): FaceGraph['faces'][number] => ({
    index,
    surface: { type: 'plane', origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] },
    reversed: false,
    area: 1,
    loops: Array.from({ length: loops }, (_, k) => [k]),
    uvBounds: [0, 1, 0, 1],
  });
  const side: FaceGraph['faces'][number] = {
    index: 0,
    surface: { type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: 10 },
    reversed: false,
    area: 1,
    loops: [[0], [1]],
    uvBounds: [0, 6, 0, 40],
  };
  const axis = { origin: [0, 0, 0] as [number, number, number], dir: [0, 0, 1] as [number, number, number] };
  const graph = (faces: FaceGraph['faces'][number][]): FaceGraph => ({
    faces,
    edgeFaces: [
      [0, 1],
      [0, 2],
    ],
    edgeConvexity: ['convex', 'convex'],
  });

  it('is both ends without a graph, a cap at an end with a one-loop plane, flush at a shoulder, a chamfer or an unknown face', () => {
    expect(freeEnds(null, 0, axis, [0, 40], 1e-6)).toEqual([true, true]);
    expect(freeEnds(graph([side, plane(1, 0, 1), plane(2, 40, 1)]), 0, axis, [0, 40], 1e-6)).toEqual([true, true]);
    expect(freeEnds(graph([side, plane(1, 0, 1), plane(2, 40, 2)]), 0, axis, [0, 40], 1e-6)).toEqual([true, false]);
    expect(freeEnds(graph([side, plane(1, 0, 1)]), 0, axis, [0, 40], 1e-6)).toEqual([true, false]);
    expect(freeEnds(graph([side, plane(1, 5, 1), plane(2, 40, 1)]), 0, axis, [0, 40], 1e-6)).toEqual([false, true]);
    expect(freeEnds(graph([side]), 9, axis, [0, 40], 1e-6)).toEqual([false, false]);
  });
});

describe('add_knurl geometry with limited kernels, and the groove tool', () => {
  const geometry = { pattern: 'straight', model: 'geometry' };

  it('refuses an invalid result and a face with no probe, reports no volume without exact masses, and does not warn when the pitch closes', () => {
    setGeometryKernel(fakeWrapKernel());
    const { doc, id } = rod();
    const base = { id, face: FACE10, ...geometry, pitch: 1 };
    setGeometryKernel(fakeWrapKernel({ invalidResult: true }));
    expectRefusal(doc, 'add_knurl', base, 'WRP_KERNEL_BUILD_FAILED', 'face');
    setGeometryKernel(fakeWrapKernel({ noProjectOnFace: true }));
    expectRefusal(doc, 'add_knurl', base, 'WRP_KNURL_FACE_NOT_CYLINDER', 'face');
    setGeometryKernel(fakeWrapKernel({ noMass: true }));
    const unmeasured = execute(doc, 'add_knurl', base);
    expect(unmeasured.rejected, unmeasured.summary).toBeUndefined();
    expect((unmeasured.data as { volumeDelta: unknown }).volumeDelta).toBeNull();
    setGeometryKernel(fakeWrapKernel());
    const exact = execute(doc, 'add_knurl', { ...base, pitch: (Math.PI * 20) / 60 });
    expect(exact.rejected, exact.summary).toBeUndefined();
    expect((exact.data as { warnings: unknown[]; pitchAdjusted: boolean }).warnings).toEqual([]);
  });

  it('knurlRecipe: the tool runs past a free end cap only, and a zero axis gives no recipe', () => {
    const source = {
      op: 'solid',
      entity: { id: 's', kind: 'cylinder', position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'l', color: '#888', radius: 10, height: 40 },
    } as never;
    const shape = { teeth: 5, radius: 10, depth: 1, toothAngleDeg: 90 };
    const cut = { origin: [0, 0, 0] as [number, number, number], axis: [0, 0, 1] as [number, number, number], from: 0, to: 20 };
    const depthOf = (recipe: unknown): number[] => {
      const found: number[] = [];
      const walk = (node: unknown): void => {
        if (typeof node !== 'object' || node === null) return;
        const record = node as Record<string, unknown>;
        const entity = record['entity'] as { kind?: string; depth?: number } | undefined;
        if (entity?.kind === 'extrusion') found.push(entity.depth as number);
        Object.values(record).forEach(walk);
      };
      walk(recipe);
      return found;
    };
    const both = knurlRecipe(source, shape, { ...cut, pastFrom: true, pastTo: true }, 'm', '#fff');
    const none = knurlRecipe(source, shape, { ...cut, pastFrom: false, pastTo: false }, 'm', '#fff');
    expect(depthOf(both)[0]).toBeCloseTo(20 + 2 * 0.5, 9);
    expect(depthOf(none)[0]).toBeCloseTo(20, 9);
    expect(knurlRecipe(source, shape, { ...cut, axis: [0, 0, 0], pastFrom: true, pastTo: true }, 'm', '#fff')).toBeNull();
  });
});
