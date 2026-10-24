/**
 * 03 WRP M4 on the native OCCT kernel: geodesic / parametric emboss on a sphere and a torus against the closed forms, the geodesic wrap of the pack (VC-WRP-08, 28),
 * create_curve_on_face (VC-WRP-37) and split_face_by_curves (VC-WRP-17). Skipped when the llull-kernel binary (with the `emboss` capability) is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { expected } from './wrapSupport';

type Doc = CadDocument;
type Row = Record<string, unknown>;

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP M4 native' })('WRP M4 on the native OCCT kernel', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const must = (doc: Doc, name: string, params: Row): { doc: Doc; id: string; data: Row } => {
    const result = execute(doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.affected.length, result.summary).toBeGreaterThan(0);
    return { doc: result.document, id: result.affected[0] as string, data: (result.data ?? {}) as Row };
  };
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);
  const sphere = (): { doc: Doc; id: string } => must(createEmptyDocument(), 'add_sphere', { radius: 25 });
  const torus = (): { doc: Doc; id: string } => must(createEmptyDocument(), 'add_torus', { ringRadius: 10, tubeRadius: 3 });
  const cylinder = (): { doc: Doc; id: string } => must(createEmptyDocument(), 'add_cylinder', { radius: 20, height: 40 });
  const pole = { faceNear: [0, 0, 25] };
  const geodesic = { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, 25] } };

  it('VC-WRP-08 / 28: the geodesic disk a 10 on R 25 has boundary 61.1696902, strain -0.0264541, area ratio 0.9867376', () => {
    const reference = expected('VC-WRP-08') as { length3d: number; maxLengthStrain: number; areaRatio: number };
    const ball = sphere();
    const disk = must(ball.doc, 'draw_arc', { center: [0, 0], radius: 10 });
    const wrapped = must(disk.doc, 'wrap_to_face', {
      id: ball.id,
      face: pole,
      entityIds: [disk.id],
      placement: geodesic,
      maxLengthStrain: 0.05,
    });
    const length = ((wrapped.data['curves'] as Row[])[0] as Row)['length3d'] as number;
    expect(relative(length, reference.length3d)).toBeLessThan(1e-6);
    const info = wrapped.data['distortion'] as Row;
    expect(Math.abs((info['maxLengthStrain'] as number) - reference.maxLengthStrain)).toBeLessThan(1e-6);
    expect(relative(info['areaRatio'] as number, reference.areaRatio)).toBeLessThan(1e-6);
    const check = execute(wrapped.doc, 'check_wrap', { ids: [wrapped.id], maxLengthStrain: 0.05 });
    expect((check.data as Row)['status']).toBe('pass');
  });

  it('emboss and deboss a geodesic disk a 4 on R 25: the exact volume change follows A (d +- d^2 / R + d^3 / 3R^2)', () => {
    const ball = sphere();
    const disk = must(ball.doc, 'draw_arc', { center: [0, 0], radius: 4 });
    const area = 2 * Math.PI * 25 * 25 * (1 - Math.cos(4 / 25));
    const before = volume(disk.doc, ball.id);
    const up = must(disk.doc, 'emboss_on_face', {
      id: ball.id,
      face: pole,
      profileIds: [disk.id],
      mode: 'emboss',
      depth: 1,
      placement: geodesic,
      fitTolerance: 1e-8,
    });
    const raised = volume(up.doc, up.id) - before;
    expect(relative(raised, area * (1 + 1 / 25 + 1 / (3 * 625)))).toBeLessThan(1e-6);
    expect(relative(raised, up.data['expectedVolumeDelta'] as number)).toBeLessThan(1e-6);
    const down = must(disk.doc, 'emboss_on_face', {
      id: ball.id,
      face: pole,
      profileIds: [disk.id],
      mode: 'deboss',
      depth: 1,
      placement: geodesic,
      fitTolerance: 1e-8,
    });
    const removed = before - volume(down.doc, down.id);
    expect(relative(removed, area * (1 - 1 / 25 + 1 / (3 * 625)))).toBeLessThan(1e-6);
    const check = execute(up.doc, 'check_wrap', { maxLengthStrain: 0.05 });
    expect((check.data as Row)['status']).toBe('pass');
  });

  it('emboss a parametric rectangle 4 x 2 on the outer equator of a torus R 10 r 3 with the tube-offset volume', () => {
    const ring = torus();
    const rect = must(ring.doc, 'draw_rectangle', { width: 4, height: 2, position: [-2, -1, 0] });
    const placement = { method: 'parametric', anchor: { chart: [0, 0], on: [13, 0, 0] } };
    const result = must(rect.doc, 'emboss_on_face', {
      id: ring.id,
      face: { faceNear: [13, 0, 0] },
      profileIds: [rect.id],
      mode: 'emboss',
      depth: 1,
      placement,
    });
    const [major, minor, d] = [10, 3, 1];
    const uv = (4 / 13) * (2 / minor);
    const cosIntegral = (4 / 13) * 2 * Math.sin(1 / minor);
    const exact = major * (minor * d + (d * d) / 2) * uv + (((minor + d) ** 3 - minor ** 3) / 3) * cosIntegral;
    expect(relative(volume(result.doc, result.id) - volume(rect.doc, ring.id), exact)).toBeLessThan(1e-6);
  });

  it('VC-WRP-37: geodesics on the cylinder r 20 have the lengths of the chart lines; a great circle on the sphere; a torus equator', () => {
    const reference = expected('VC-WRP-37') as Array<{ to: { thetaRad: number; z: number }; length: number }>;
    for (const row of reference) {
      const base = cylinder();
      const result = must(base.doc, 'create_curve_on_face', {
        id: base.id,
        face: { faceNear: [20, 0, 0] },
        mode: 'geodesic',
        from: [20, 0, 0],
        to: [20 * Math.cos(row.to.thetaRad), 20 * Math.sin(row.to.thetaRad), row.to.z],
      });
      expect(relative((result.data['curve'] as Row)['length3d'] as number, row.length), `theta ${row.to.thetaRad}`).toBeLessThan(1e-6);
    }
    const ball = sphere();
    const arc = must(ball.doc, 'create_curve_on_face', {
      id: ball.id,
      face: pole,
      mode: 'geodesic',
      from: [0, 0, 25],
      to: [25 * Math.sin(0.5), 0, 25 * Math.cos(0.5)],
    });
    expect(relative((arc.data['curve'] as Row)['length3d'] as number, 12.5)).toBeLessThan(1e-6);
    const ring = torus();
    const equator = must(ring.doc, 'create_curve_on_face', {
      id: ring.id,
      face: { faceNear: [13, 0, 0] },
      mode: 'geodesic',
      from: [13, 0, 0],
      to: [13 * Math.cos(0.3), 13 * Math.sin(0.3), 0],
    });
    expect(relative((equator.data['curve'] as Row)['length3d'] as number, 3.9)).toBeLessThan(1e-6);
  });

  it('isoparametric and uv curves are evaluated by the kernel and trimmed to the face', () => {
    const base = cylinder();
    const axial = must(base.doc, 'create_curve_on_face', {
      id: base.id,
      face: { faceNear: [20, 0, 0] },
      mode: 'isoparametric',
      through: [20, 0, 3],
      direction: 'v',
    });
    expect(relative((axial.data['curve'] as Row)['length3d'] as number, 40)).toBeLessThan(1e-6);
    const helix = must(base.doc, 'create_curve_on_face', {
      id: base.id,
      face: { faceNear: [20, 0, 0] },
      mode: 'uv',
      uv: [
        [0, 0],
        [1, 10],
      ],
    });
    expect(relative((helix.data['curve'] as Row)['length3d'] as number, Math.hypot(20, 10))).toBeLessThan(1e-4);
  });

  it('VC-WRP-17: a closed curve and a ring curve divide the cylinder side; the volume is unchanged and the faces gain', () => {
    const base = cylinder();
    const ring = must(base.doc, 'create_curve_on_face', {
      id: base.id,
      face: { faceNear: [20, 0, 0] },
      mode: 'isoparametric',
      through: [20, 0, 5],
      direction: 'u',
    });
    const circle = must(ring.doc, 'draw_arc', { center: [0, 0], radius: 4 });
    const loop = must(circle.doc, 'wrap_to_face', {
      id: base.id,
      face: { faceNear: [20, 0, 0] },
      entityIds: [circle.id],
      placement: { anchor: { chart: [0, -10], on: [20, 0, -8] } },
    });
    const before = volume(loop.doc, base.id);
    const split = must(loop.doc, 'split_face_by_curves', { id: base.id, curveIds: [loop.id] });
    expect(split.data['facesAfter'] as number).toBe((split.data['facesBefore'] as number) + 1);
    expect(relative(split.data['areaSumAfter'] as number, split.data['areaSumBefore'] as number)).toBeLessThan(1e-6);
    expect(relative(volume(split.doc, split.id), before)).toBeLessThan(1e-5);
    const faces = split.data['faces'] as Array<{ area: number }>;
    const patch = faces.map((f) => f.area).reduce((a, b) => Math.max(a, b), 0);
    expect(patch).toBeGreaterThan(0);
    const both = must(loop.doc, 'split_face_by_curves', { id: base.id, curveIds: [ring.id, loop.id] });
    expect((both.data['facesAfter'] as number) - (both.data['facesBefore'] as number)).toBeGreaterThanOrEqual(2);
    expect(relative(volume(both.doc, both.id), before)).toBeLessThan(1e-5);
  });

  it('VC-WRP-17: a closed sketch circle projected onto the cylinder (several runs) splits its face: faces + 1, areas add up', () => {
    const reference = expected('VC-WRP-17') as { faceCountDelta: number };
    const base = cylinder();
    const plane = must(base.doc, 'create_sketch_plane', { plane: 'yz', offset: 30 });
    const circle = must(plane.doc, 'draw_arc', { center: [0, 0], radius: 6 });
    const placed = must(circle.doc, 'place_on_sketch_plane', { ids: [circle.id], plane: plane.id });
    const projected = must(placed.doc, 'project_to_face', { id: base.id, entityIds: [circle.id], direction: [-1, 0, 0] });
    const curves = (projected.data['curves'] as Array<{ id: string }>).map((curve) => curve.id);
    const before = volume(projected.doc, base.id);
    const split = must(projected.doc, 'split_face_by_curves', { id: base.id, curveIds: curves });
    expect((split.data['facesAfter'] as number) - (split.data['facesBefore'] as number)).toBe(reference.faceCountDelta);
    expect(relative(split.data['areaSumAfter'] as number, split.data['areaSumBefore'] as number)).toBeLessThan(1e-6);
    expect(relative(volume(split.doc, split.id), before)).toBeLessThan(1e-5);
  });
  it('an open curve running edge to edge across a planar face divides it: faces + 1, areas and volume unchanged', () => {
    const block = must(createEmptyDocument(), 'add_box', { size: [60, 60, 40] });
    const line = must(block.doc, 'create_curve_on_face', {
      id: block.id,
      face: { faceNear: [0, 0, 20] },
      mode: 'geodesic',
      from: [-30, 5, 20],
      to: [30, 5, 20],
    });
    const before = volume(line.doc, block.id);
    const split = must(line.doc, 'split_face_by_curves', { id: block.id, curveIds: [line.id] });
    expect(split.data['facesAfter'] as number).toBe((split.data['facesBefore'] as number) + 1);
    expect(relative(split.data['areaSumAfter'] as number, split.data['areaSumBefore'] as number)).toBeLessThan(1e-9);
    expect(relative(volume(split.doc, split.id), before)).toBeLessThan(1e-9);
    const areas = (split.data['faces'] as Array<{ area: number }>).map((face) => face.area).sort((a, b) => a - b);
    expect(areas.length).toBeGreaterThanOrEqual(1);
    expect(relative(areas[0] as number, 60 * 25)).toBeLessThan(1e-6);
  });
});
