/**
 * 03 WRP M5 (FR-WRP-32): modeled diagonal and diamond knurl, helical V-grooves. Pure closed forms (groove area against dense quadrature of its polar section, land and depth, the diamond union),
 * and add_knurl model 'geometry' on the fake exact kernel (the recipe it builds: one screw sweep per tooth and hand; every refusal by code). The exact volumes are proved on the native kernel in
 * server/tests/nativeKnurlHelix.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { MeshSolidEntity } from '@core/model/types';
import {
  helicalDepthForLand,
  helicalGrooveArea,
  helicalKnurlRecipe,
  helicalLand,
  helicalRemovedVolume,
  estimatedKernelSeconds,
  grooveSpan,
  leadOf,
  MAX_KERNEL_SECONDS,
  type HelicalKnurl,
} from '@core/commands/wrap/knurlHelix';
import { fakeWrapKernel } from '../../helpers/fakeWrapKernel';
import { expectRefusal } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';
import { emptyDoc, make, type Made } from './support';

const rod = (): Made => make(emptyDoc(), 'add_cylinder', { radius: 20, height: 40 });
const FACE20 = { faceNear: [20, 0, 0] };
/** d 40: the pitch that closes 8 teeth, and 4. */
const PITCH8 = (Math.PI * 40) / 8;
const PITCH4 = (Math.PI * 40) / 4;
const shapeOf = (patch: Partial<HelicalKnurl> = {}): HelicalKnurl => ({
  teeth: 8,
  radius: 20,
  depth: 1.5,
  toothAngleDeg: 90,
  helixDeg: 30,
  hands: 1,
  left: false,
  ...patch,
});

afterEach(() => setGeometryKernel(null));

describe('helical groove closed forms', () => {
  it('the transverse area of a groove is the polar integral of the V swept by the screw (dense quadrature), and tends to the triangle h^2 tan(gamma) / cos(beta) for a shallow groove', () => {
    const quadrature = (shape: HelicalKnurl): number => {
      const k = Math.tan((shape.toothAngleDeg * Math.PI) / 360) / Math.sin((shape.helixDeg * Math.PI) / 180);
      const lead = leadOf(shape);
      const base = shape.radius - shape.depth;
      const steps = 200000;
      let area = 0;
      for (let s = 0; s < steps; s++) {
        const rho = base + ((s + 0.5) / steps) * shape.depth;
        const halfAxial = k * (rho - base);
        area += rho * ((2 * Math.PI * 2 * halfAxial) / lead) * (shape.depth / steps);
      }
      return area;
    };
    for (const shape of [
      shapeOf(),
      shapeOf({ radius: 10, depth: 0.9, toothAngleDeg: 60, helixDeg: 45 }),
      shapeOf({ radius: 4, depth: 0.5, toothAngleDeg: 120, helixDeg: 70 }),
    ])
      expect(Math.abs(helicalGrooveArea(shape) / quadrature(shape) - 1), JSON.stringify(shape)).toBeLessThan(1e-6);
    const shallow = shapeOf({ depth: 1e-3 });
    expect(helicalGrooveArea(shallow) / ((1e-3 ** 2 * 1) / Math.cos(Math.PI / 6))).toBeCloseTo(1, 3);
  });

  it('the lead, the land and the depth for a land are consistent', () => {
    expect(leadOf(shapeOf())).toBeCloseTo((2 * Math.PI * 20) / Math.tan(Math.PI / 6), 9);
    const depth = helicalDepthForLand(1, 90, 30, 0.1);
    expect(helicalLand(1, { depth, toothAngleDeg: 90, helixDeg: 30 })).toBeCloseTo(0.1, 12);
    expect(helicalLand(1, { depth: 2, toothAngleDeg: 90, helixDeg: 30 })).toBeLessThan(0);
  });

  it('a diagonal removes teeth x length x A_t; a diamond removes the union of the two hands, less than twice and more than one', () => {
    const one = shapeOf();
    expect(helicalRemovedVolume(one, 40)).toBeCloseTo(8 * 40 * helicalGrooveArea(one), 9);
    const two = shapeOf({ hands: 2 });
    const union = helicalRemovedVolume(two, 40);
    expect(union).toBeGreaterThan(helicalRemovedVolume(one, 40));
    expect(union).toBeLessThan(2 * helicalRemovedVolume(one, 40));
    const shallow = shapeOf({ hands: 2, depth: 0.05 });
    expect(helicalRemovedVolume(shallow, 40) / (2 * 8 * 40 * helicalGrooveArea(shallow))).toBeGreaterThan(0.98);
  });
});

describe('helicalKnurlRecipe', () => {
  const cutFor = (shape: HelicalKnurl, axis: [number, number, number] = [0, 0, 1]): Parameters<typeof helicalKnurlRecipe>[2] => ({
    origin: [0, 0, 0],
    axis,
    span: grooveSpan(shape, -20, 20),
  });
  const source = (): { op: 'solid'; entity: never } => ({ op: 'solid', entity: rod().doc.entities['cyl-1.1'] as never });

  it('builds one screw sweep per tooth and hand, starting at equally spaced angles, in one boolean subtract', () => {
    const four = shapeOf({ hands: 2, teeth: 4 });
    const diamond = helicalKnurlRecipe(source(), four, cutFor(four), 'k', '#fff');
    expect(typeof diamond).not.toBe('string');
    const text = JSON.stringify(diamond);
    expect(text.match(/"kind":"sweep"/g)).toHaveLength(8);
    expect(text.match(/"handedness":"left"/g)).toHaveLength(4);
    expect(text.match(/"handedness":"right"/g)).toHaveLength(4);
    expect(text).toContain('"mode":"axis_plane"');
    expect(diamond).toMatchObject({ op: 'boolean', boolean: 'subtract' });
    const angles = [...text.matchAll(/"startAngle":([-0-9.e]+)/g)].map((m) => Number(m[1]));
    expect(angles.slice(0, 4).map((a) => a.toFixed(6))).toEqual([0, 1, 2, 3].map((i) => ((2 * Math.PI * i) / 4).toFixed(6)));
  });

  it('refuses a zero axis by reason', () => {
    expect(helicalKnurlRecipe(source(), shapeOf(), cutFor(shapeOf(), [0, 0, 0]), 'k', '#fff')).toContain('axis');
  });

  it('the kernel-time model reproduces the measured runs (6 grooves at 30 degrees 12.6 s, 12 at 30 degrees 30 s, 8 at 45 degrees 45 s, 8 at 60 degrees over 120 s) and grows with the turns', () => {
    const turnsAt = (helixDeg: number): number => 40 / leadOf(shapeOf({ helixDeg, radius: 20, teeth: 8 }));
    expect(estimatedKernelSeconds(6, turnsAt(30)) / 12.6).toBeGreaterThan(0.7);
    expect(estimatedKernelSeconds(6, turnsAt(30)) / 12.6).toBeLessThan(1.3);
    expect(estimatedKernelSeconds(12, turnsAt(30)) / 30).toBeGreaterThan(0.7);
    expect(estimatedKernelSeconds(12, turnsAt(30)) / 30).toBeLessThan(1.3);
    expect(estimatedKernelSeconds(8, turnsAt(45)) / 45).toBeGreaterThan(0.7);
    expect(estimatedKernelSeconds(8, turnsAt(45)) / 45).toBeLessThan(1.3);
    expect(estimatedKernelSeconds(8, turnsAt(60))).toBeGreaterThan(MAX_KERNEL_SECONDS);
    expect(estimatedKernelSeconds(8, turnsAt(45))).toBeLessThanOrEqual(MAX_KERNEL_SECONDS);
    expect(estimatedKernelSeconds(1, turnsAt(80))).toBeGreaterThan(estimatedKernelSeconds(1, turnsAt(50)));
  });
});

describe('add_knurl model geometry, diagonal and diamond (fake kernel)', () => {
  const knurlShape = (patch: Partial<HelicalKnurl>): HelicalKnurl => {
    const teeth = 8;
    const pitch = (Math.PI * 40) / teeth;
    const depth = helicalDepthForLand(pitch, 90, 30, 0.1);
    return { teeth, radius: 20, depth, toothAngleDeg: 90, helixDeg: 30, hands: 1, left: false, ...patch };
  };
  const useKernel = (options: Parameters<typeof fakeWrapKernel>[0]): void => setGeometryKernel(fakeWrapKernel(options));
  const recipeOf = (doc: ReturnType<typeof execute>['document'], id: string): string =>
    JSON.stringify((doc.entities[id] as MeshSolidEntity).brep);

  it('a diagonal knurl on d 20: 8 helical grooves of lead 2 pi r / tan(helix), the closed-form volume N x L x A_t, a land of 10 % of the pitch, the solid replaced', () => {
    const shape = knurlShape({});
    useKernel({ grooveVolume: 40 * helicalGrooveArea(shape) });
    const { doc, id } = rod();
    const params = { id, face: FACE20, pattern: 'diagonal', pitch: PITCH8, model: 'geometry' };
    const done = execute(doc, 'add_knurl', params);
    expect(done.rejected, done.summary).toBeUndefined();
    const info = done.data as Record<string, unknown>;
    expect(info).toMatchObject({
      model: 'geometry',
      pattern: 'diagonal',
      teeth: 8,
      grooves: 8,
      hands: ['right'],
      helixAngleDeg: 30,
      toothAngleDeg: 90,
    });
    expect(info['expectedVolumeDelta']).toBeCloseTo(-8 * 40 * helicalGrooveArea(shape), 9);
    // an independent number (dense quadrature of the polar integral, see the closed-form suite), so a wrong radius or lead in the command cannot hide behind its own formula
    expect(info['expectedVolumeDelta']).toBeCloseTo(-12433.9481, 3);
    expect(info['volumeDelta']).toBeCloseTo(info['expectedVolumeDelta'] as number, 9);
    expect(info['lead']).toBeCloseTo(leadOf(shape), 9);
    expect(info['land']).toBeCloseTo(0.1 * PITCH8, 9);
    expect((info['defaults'] as Array<{ name: string }>).map((d) => d.name).sort()).toEqual([
      'helixAngleDeg',
      'landRatio',
      'toothAngleDeg',
    ]);
    expect(done.document.entities[id]).toBeUndefined();
    expect(recipeOf(done.document, done.affected[0] as string).match(/"kind":"sweep"/g)).toHaveLength(8);
    expect(done.summary).toContain('8 helical V-grooves');
    expectPure(doc, () => execute(doc, 'add_knurl', params));
  });

  it('hand left builds left-handed grooves; helixAngleDeg is honoured; a diamond (4 teeth, 8 grooves) removes the numeric union of both hands', () => {
    const union = knurlShape({ teeth: 4, hands: 2, helixDeg: 45, depth: 0.4 });
    const single = knurlShape({ teeth: 4, helixDeg: 45, depth: 0.4 });
    useKernel({ grooveVolume: 40 * helicalGrooveArea(single) });
    const { doc, id } = rod();
    const left = execute(doc, 'add_knurl', {
      id,
      face: FACE20,
      pattern: 'diagonal',
      pitch: PITCH4,
      model: 'geometry',
      hand: 'left',
      helixAngleDeg: 45,
      depth: 0.4,
    });
    expect(left.rejected, left.summary).toBeUndefined();
    expect(recipeOf(left.document, left.affected[0] as string)).toContain('"handedness":"left"');
    expect(recipeOf(left.document, left.affected[0] as string)).not.toContain('"handedness":"right"');
    expect((left.data as Record<string, unknown>)['defaults']).not.toContainEqual(expect.objectContaining({ name: 'helixAngleDeg' }));
    useKernel({ grooveVolume: helicalRemovedVolume(union, 40) / 8 });
    const diamond = execute(doc, 'add_knurl', {
      id,
      face: FACE20,
      pattern: 'diamond',
      pitch: PITCH4,
      model: 'geometry',
      helixAngleDeg: 45,
      depth: 0.4,
    });
    expect(diamond.rejected, diamond.summary).toBeUndefined();
    const info = diamond.data as Record<string, unknown>;
    expect(info).toMatchObject({ pattern: 'diamond', teeth: 4, grooves: 8, hands: ['right', 'left'] });
    expect(String(info['expectedMethod'])).toContain('numeric union');
    expect(info['expectedVolumeDelta']).toBeCloseTo(-helicalRemovedVolume(union, 40), 9);
    expect(helicalRemovedVolume(union, 40)).toBeCloseTo(71.2501, 3);
  });

  it('check_wrap counts a helical knurl (no emboss node): the volume is skipped with a warning, the removal is checked', () => {
    const shape = knurlShape({});
    useKernel({ grooveVolume: 40 * helicalGrooveArea(shape) });
    const { doc, id } = rod();
    const done = execute(doc, 'add_knurl', { id, face: FACE20, pattern: 'diagonal', pitch: PITCH8, model: 'geometry' });
    expect(done.rejected, done.summary).toBeUndefined();
    const knurled = done.affected[0] as string;
    const checked = execute(done.document, 'check_wrap', {});
    const report = checked.data as {
      status: string;
      checked: { ids: number; reliefsWithoutClosedForm: number };
      findings: Array<{ code: string; ids: string[] }>;
    };
    expect(report.checked).toMatchObject({ ids: 1, reliefsWithoutClosedForm: 1 });
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'WRP_CHECK_VOLUME_SKIPPED', ids: [knurled] }));
    expect(report.status).toBe('warn');
  });

  it('refuses by code: a cut over the kernel-time envelope (many grooves, many turns), grooves that meet, too deep, a hand on a diamond, a bad angle, a shoulder end, a kernel that cannot sweep, a volume that disagrees', () => {
    const shape = knurlShape({});
    useKernel({ grooveVolume: 40 * helicalGrooveArea(shape) });
    const { doc, id } = rod();
    const base = { id, face: FACE20, model: 'geometry' };
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diamond', pitch: (Math.PI * 40) / 30 }, 'WRP_KNURL_TOO_MANY_GROOVES', 'pitch');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: 1 }, 'WRP_KNURL_TOO_MANY_GROOVES', 'pitch');
    const steep = expectRefusal(
      doc,
      'add_knurl',
      { ...base, pattern: 'diagonal', pitch: PITCH8, helixAngleDeg: 89.99 },
      'WRP_KNURL_TOO_MANY_GROOVES',
      'pitch',
    );
    expect(steep.summary).toContain('turns along the face each would take the exact kernel');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: PITCH8, depth: 8 }, 'WRP_KNURL_DEPTH_INVALID', 'depth');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: 40, depth: 11 }, 'WRP_DEPTH_EXCEEDS_SOLID', 'depth');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diamond', pitch: PITCH4, hand: 'left' }, 'WRP_PARAM_INVALID', 'hand');
    expectRefusal(
      doc,
      'add_knurl',
      { ...base, pattern: 'diagonal', pitch: PITCH8, toothAngleDeg: 180 },
      'WRP_PARAM_INVALID',
      'toothAngleDeg',
    );
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: PITCH8, depth: -1 }, 'WRP_PARAM_INVALID', 'depth');
    useKernel({});
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: PITCH8 }, 'WRP_KERNEL_BUILD_FAILED', 'face');
    useKernel({ grooveVolume: 1 });
    const off = expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: PITCH8 }, 'WRP_KERNEL_BUILD_FAILED', 'face');
    expect(off.summary).toContain('helical grooves remove');
    useKernel({ grooveVolume: 0 });
    const none = expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: PITCH8 }, 'WRP_KERNEL_BUILD_FAILED', 'face');
    expect(none.summary).toContain('removed no material');
    useKernel({ grooveVolume: 40 * helicalGrooveArea(shape), invalidResult: true });
    const broken = expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: PITCH8 }, 'WRP_KERNEL_BUILD_FAILED', 'face');
    expect(broken.summary).toContain('not valid and closed');
    useKernel({ grooveVolume: 40 * helicalGrooveArea(shape), flatBounds: true });
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: PITCH8 }, 'WRP_FACE_NOT_FOUND', 'face');
    useKernel({ bore: true });
    const bore = expectRefusal(doc, 'add_knurl', { ...base, pattern: 'diagonal', pitch: PITCH8 }, 'WRP_KNURL_FACE_NOT_CYLINDER', 'face');
    expect(bore.summary).toContain('bore');
    expectRefusal(doc, 'add_knurl', { ...base, pattern: 'straight', pitch: PITCH8, hand: 'left' }, 'WRP_PARAM_INVALID', 'hand');
    expectRefusal(doc, 'add_knurl', { id, face: FACE20, pattern: 'diagonal', pitch: PITCH8, hand: 'left' }, 'WRP_PARAM_INVALID', 'hand');
    useKernel({ stadium: true });
    const ends = make(emptyDoc(), 'add_box', { size: [40, 20, 10] });
    expectRefusal(
      ends.doc,
      'add_knurl',
      { ...base, id: ends.id, face: { faceNear: [30, 0, 0] }, pattern: 'diagonal', pitch: (Math.PI * 20) / 8 },
      'WRP_KNURL_GEOMETRY_UNSUPPORTED',
      'face',
    );
  });
});
