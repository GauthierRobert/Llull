/**
 * 03 WRP M0-M3 on the native OCCT kernel (docs/design/03-wrap-emboss validation pack): wrap lengths, projection vs wrap, cone development, emboss / deboss /
 * scribe volumes against the closed forms, text on a cylinder, the pack's bad-input codes and the replay of an emboss. Skipped when the llull-kernel binary
 * (with the `emboss` capability) is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setFontProvider } from '@core/commands/fontPort';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type NurbsCurveEntity } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { createFontProvider } from '../src/fontProvider';
import { expected } from './wrapSupport';

type Doc = CadDocument;
interface Curve {
  readonly id: string;
  readonly length3d: number;
  readonly chartLength: number;
  readonly sourceId: string;
}

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP native' })('WRP M0-M3 on the native OCCT kernel', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
    setFontProvider(createFontProvider());
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    setFontProvider(null);
    kernel.dispose();
  });

  const run = (doc: Doc, name: string, params: Record<string, unknown>): ReturnType<typeof execute> => execute(doc, name, params);
  const must = (doc: Doc, name: string, params: Record<string, unknown>): { doc: Doc; id: string; data: Record<string, unknown> } => {
    const result = run(doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.affected.length, result.summary).toBeGreaterThan(0);
    return { doc: result.document, id: result.affected[0] as string, data: (result.data ?? {}) as Record<string, unknown> };
  };
  const volume = (doc: Doc, id: string): number => (run(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);
  const cylinder = (position: number[] = [0, 0, 0]): { doc: Doc; id: string } =>
    must(createEmptyDocument(), 'add_cylinder', { radius: 20, height: 40, position });
  const rectangle = (doc: Doc, width: number, height: number): { doc: Doc; id: string } =>
    must(doc, 'draw_rectangle', { width, height, position: [-width / 2, -height / 2, 0] });
  const face = { faceNear: [20, 0, 0] };

  it('VC-WRP-01 / 37: a chart line of 30 mm keeps its length on r 20 at every angle; the helix pitch follows 2 pi r tan(beta)', () => {
    const reference = expected('VC-WRP-01') as Array<{
      betaDeg: number;
      length3d: number;
      angularSpanRad: number;
      helixPitchPerTurn: number | null;
    }>;
    const base = cylinder();
    const line = must(base.doc, 'draw_polyline', {
      points: [
        [-15, 0],
        [15, 0],
      ],
    });
    const doc = line.doc;
    for (const row of reference) {
      const wrapped = must(doc, 'wrap_to_face', {
        id: base.id,
        face,
        entityIds: [line.id],
        placement: { method: 'develop', anchor: { chart: [0, 0], on: [20, 0, 0] }, angleDeg: row.betaDeg },
      });
      const curves = wrapped.data['curves'] as Curve[];
      expect(relative(curves[0]?.length3d as number, row.length3d), `beta ${row.betaDeg}`).toBeLessThan(1e-6);
      const curve = (wrapped.doc.entities[curves[0]?.id as string] as NurbsCurveEntity).curve;
      const start = curve.poles[0] as [number, number, number];
      const end = curve.poles[curve.poles.length - 1] as [number, number, number];
      const span = Math.abs(Math.atan2(end[1], end[0]) - Math.atan2(start[1], start[0]));
      expect(Math.abs(span - row.angularSpanRad), `span beta ${row.betaDeg}`).toBeLessThan(1e-6);
      if (row.helixPitchPerTurn !== null) {
        const pitch = (Math.abs(end[2] - start[2]) / span) * 2 * Math.PI;
        expect(relative(pitch, row.helixPitchPerTurn), `pitch beta ${row.betaDeg}`).toBeLessThan(1e-5);
      }
    }
  });

  it('VC-WRP-02: chart circles a 4 / 8 / 15 keep their circumference 2 pi a on the cylinder', () => {
    const reference = expected('VC-WRP-02') as Array<{ chartRadius: number; length3d: number }>;
    for (const row of reference) {
      const base = cylinder();
      const circle = must(base.doc, 'draw_arc', { center: [0, 0], radius: row.chartRadius });
      const wrapped = must(circle.doc, 'wrap_to_face', { id: base.id, face, entityIds: [circle.id], placement: { method: 'develop' } });
      expect(relative((wrapped.data['curves'] as Curve[])[0]?.length3d as number, row.length3d), `a=${row.chartRadius}`).toBeLessThan(1e-6);
    }
  });

  it('VC-WRP-05: a 30 mm chord projected along -x lands on a 33.9225 mm arc, the wrap keeps 30; a 45 mm chord only partly lands (requireAll refuses)', () => {
    const reference = expected('VC-WRP-05') as { projectedLength: number; wrappedLength: number; missCode: string };
    const base = cylinder();
    const plane = must(base.doc, 'create_sketch_plane', { plane: 'yz', offset: 30 });
    const chord = must(plane.doc, 'draw_polyline', {
      points: [
        [-15, 0],
        [15, 0],
      ],
    });
    const placed = must(chord.doc, 'place_on_sketch_plane', { ids: [chord.id], plane: plane.id });
    const projected = must(placed.doc, 'project_to_face', { id: base.id, entityIds: [chord.id], direction: [-1, 0, 0] });
    const curve = (projected.data['curves'] as Curve[])[0] as Curve;
    expect(relative(curve.length3d, reference.projectedLength)).toBeLessThan(1e-6);
    expect(projected.data['missed']).toEqual([]);
    const wrapped = must(placed.doc, 'wrap_to_face', {
      id: base.id,
      face,
      entityIds: [chord.id],
      placement: { anchor: { chart: [0, 0], on: [20, 0, 0] } },
    });
    expect(relative((wrapped.data['curves'] as Curve[])[0]?.length3d as number, reference.wrappedLength)).toBeLessThan(1e-6);
    const wide = must(placed.doc, 'draw_polyline', {
      points: [
        [-22.5, 0],
        [22.5, 0],
      ],
    });
    const widePlaced = must(wide.doc, 'place_on_sketch_plane', { ids: [wide.id], plane: plane.id });
    const partial = must(widePlaced.doc, 'project_to_face', { id: base.id, entityIds: [wide.id], direction: [-1, 0, 0] });
    expect((partial.data['missed'] as Array<{ fraction: number }>)[0]?.fraction).toBeCloseTo(40 / 45, 2);
    const refused = run(widePlaced.doc, 'project_to_face', { id: base.id, entityIds: [wide.id], direction: [-1, 0, 0], requireAll: true });
    expect(refused.error?.code).toBe(reference.missCode);
    const nothing = must(widePlaced.doc, 'draw_polyline', {
      points: [
        [30, 0],
        [40, 0],
      ],
    });
    const away = must(nothing.doc, 'place_on_sketch_plane', { ids: [nothing.id], plane: plane.id });
    expect(run(away.doc, 'project_to_face', { id: base.id, entityIds: [nothing.id], direction: [-1, 0, 0] }).error?.code).toBe(
      'WRP_PROJECTION_MISSES_FACE',
    );
  });

  it('closest-point projection lands every point of a line next to the solid on the cylinder', () => {
    const base = cylinder();
    const line = must(base.doc, 'draw_polyline', {
      points: [
        [0, -10],
        [0, 10],
      ],
      position: [30, 0, 0],
    });
    const done = must(line.doc, 'project_to_face', {
      id: base.id,
      entityIds: [line.id],
      closest: true,
      maxDistance: 30,
      faces: [{ faceNear: [20, 0, 0] }],
    });
    expect((done.data['curves'] as Curve[]).length).toBeGreaterThan(0);
    expect(done.data['mode']).toBe('closest');
  });

  it('VC-WRP-06 / 07 / 16: the cone r 20 h 40 develops to a 2.80993 rad sector, lengths survive on it, a scribed ring adds exactly one face', () => {
    const reference = expected('VC-WRP-06') as { sectorAngleRad: number; outerRadius: number; area: number };
    const cone = must(createEmptyDocument(), 'add_cone', { radius: 20, height: 40 });
    const unwrapped = run(cone.doc, 'unwrap_face', { id: cone.id, face: { faceNear: [10, 0, 20] } });
    const info = unwrapped.data as Record<string, number>;
    expect(relative(info['sectorAngleRad'] as number, reference.sectorAngleRad)).toBeLessThan(1e-9);
    expect(relative(info['outerRadius'] as number, reference.outerRadius)).toBeLessThan(1e-9);
    expect(relative(info['area'] as number, reference.area)).toBeLessThan(1e-9);
    const segment = must(cone.doc, 'draw_polyline', {
      points: [
        [-10, 0],
        [10, 0],
      ],
    });
    const ring = must(segment.doc, 'draw_arc', { center: [0, 0], radius: 4 });
    const placement = { method: 'develop', anchor: { chart: [0, 0], on: [10, 0, 20] }, angleDeg: 90 };
    const wrapped = must(ring.doc, 'wrap_to_face', {
      id: cone.id,
      face: { faceNear: [10, 0, 20] },
      entityIds: [segment.id, ring.id],
      placement,
    });
    const lengths = wrapped.data['curves'] as Curve[];
    expect(relative(lengths[0]?.length3d as number, 20)).toBeLessThan(1e-6);
    expect(relative(lengths[1]?.length3d as number, 25.1327412287)).toBeLessThan(1e-6);
    const faceCount = (doc: Doc, id: string): number =>
      (run(doc, 'inspect_faces', { entityId: id }).data as { faces: unknown[] }).faces.length;
    const before = faceCount(cone.doc, cone.id);
    const scribed = must(ring.doc, 'emboss_on_face', {
      id: cone.id,
      face: { faceNear: [10, 0, 20] },
      profileIds: [ring.id],
      mode: 'scribe',
      placement: { anchor: { chart: [0, 0], on: [10, 0, 20] } },
    });
    expect(faceCount(scribed.doc, scribed.id)).toBe(before + 1);
    expect(Math.abs(volume(scribed.doc, scribed.id) / volume(cone.doc, cone.id) - 1)).toBeLessThan(1e-7);
    expect(scribed.data['volumeDelta'] as number).toBeCloseTo(0, 2);
  });

  it('VC-WRP-10: a 30 x 10 rectangle embossed / debossed 1 mm on r 20 adds 307.5 / removes 292.5 mm3 (A d (1 +- d / 2r)); VC-WRP-11 planar A d', () => {
    const reference = expected('VC-WRP-10') as { embossDelta: number; debossDelta: number };
    const raised = cylinder();
    const rect = rectangle(raised.doc, 30, 10);
    const up = must(rect.doc, 'emboss_on_face', {
      id: raised.id,
      face,
      profileIds: [rect.id],
      mode: 'emboss',
      depth: 1,
      placement: { method: 'develop' },
    });
    expect(relative(up.data['volumeDelta'] as number, reference.embossDelta)).toBeLessThan(1e-6);
    expect(relative(up.data['expectedVolumeDelta'] as number, reference.embossDelta)).toBeLessThan(1e-12);
    expect(relative(volume(up.doc, up.id) - volume(rect.doc, raised.id), reference.embossDelta)).toBeLessThan(1e-6);
    const down = must(rect.doc, 'emboss_on_face', { id: raised.id, face, profileIds: [rect.id], mode: 'deboss', depth: 1 });
    expect(relative(down.data['volumeDelta'] as number, reference.debossDelta)).toBeLessThan(1e-6);
    const plate = must(createEmptyDocument(), 'add_box', { size: [60, 40, 10], anchor: 'min', position: [100, 0, 0] });
    const patch = must(plate.doc, 'draw_rectangle', { width: 30, height: 10, position: [115, 15, 10] });
    const flat = must(patch.doc, 'emboss_on_face', {
      id: plate.id,
      face: { faceNear: [130, 20, 10] },
      profileIds: [patch.id],
      mode: 'emboss',
      depth: 1,
      placement: { anchor: { chart: [130, 20], on: [130, 20, 10] } },
    });
    expect(relative(volume(flat.doc, flat.id), expected('VC-WRP-11') as number)).toBeLessThan(1e-9);
    expect(relative(flat.data['volumeDelta'] as number, 300)).toBeLessThan(1e-9);
  });

  it('VC-WRP-12 / 14 closed form on the cone: a polygonal sector of 0.5 rad, slant 15..35 embossed 1 mm adds A d + (d2 / 2) cot(alpha) Phi (s2 - s1)', () => {
    const reference = expected('VC-WRP-12') as { sector: number };
    const cone = must(createEmptyDocument(), 'add_cone', { radius: 20, height: 40 });
    const rho0 = 25;
    const steps = 160;
    const points: Array<[number, number]> = [];
    const at = (rho: number, psi: number): [number, number] => [rho * Math.sin(psi), rho * Math.cos(psi) - rho0];
    for (let k = 0; k <= steps; k++) points.push(at(35, -0.25 + (0.5 * k) / steps));
    for (let k = steps; k >= 0; k--) points.push(at(15, -0.25 + (0.5 * k) / steps));
    const sector = must(cone.doc, 'draw_polyline', { points, closed: true });
    const on = [rho0 * Math.sin(Math.atan2(20, 40)) * 0 + 25 * Math.sin(Math.atan2(20, 40)), 0, 40 - 25 * Math.cos(Math.atan2(20, 40))];
    const done = must(sector.doc, 'emboss_on_face', {
      id: cone.id,
      face: { faceNear: on },
      profileIds: [sector.id],
      mode: 'emboss',
      depth: 1,
      placement: { anchor: { chart: [0, 0], on } },
    });
    expect(relative(done.data['volumeDelta'] as number, reference.sector)).toBeLessThan(2e-6);
    expect(relative(done.data['expectedVolumeDelta'] as number, reference.sector)).toBeLessThan(2e-6);
  });

  it('VC-WRP-13 / 14 / 35: LLULL cap 10 mm in Fira Sans: area 104.8862209, embossed 1 mm on r 20 delta 107.5083764, deboss -102.2640654', () => {
    const reference = expected('VC-WRP-14') as { embossDelta: number; debossDelta: number };
    const base = cylinder();
    const label = must(base.doc, 'add_text', { content: 'LLULL', position: [0, 0, 0], height: 10, anchor: 'center', font: 'Fira Sans' });
    const outline = run(label.doc, 'text_outline', { id: label.id }).data as { area: number; loops: number };
    expect(outline.loops).toBe(5);
    expect(relative(outline.area, (expected('VC-WRP-13') as { areaMm2: number }).areaMm2)).toBeLessThan(1e-9);
    const up = must(label.doc, 'emboss_on_face', {
      id: base.id,
      face,
      profileIds: [label.id],
      mode: 'emboss',
      depth: 1,
      placement: { anchor: { chart: [0, 0], on: [20, 0, 0] } },
    });
    expect(relative(up.data['volumeDelta'] as number, reference.embossDelta)).toBeLessThan(1e-5);
    expect(relative(volume(up.doc, up.id) - 16000 * Math.PI, reference.embossDelta)).toBeLessThan(1e-5);
    const down = must(label.doc, 'emboss_on_face', {
      id: base.id,
      face,
      profileIds: [label.id],
      mode: 'deboss',
      depth: 1,
      placement: { anchor: { chart: [0, 0], on: [20, 0, 0] } },
    });
    expect(relative(down.data['volumeDelta'] as number, reference.debossDelta)).toBeLessThan(1e-5);
    const checked = run(up.doc, 'check_wrap', { ids: [up.id] }).data as { status: string; findings: Array<{ code: string }> };
    expect(checked.findings.map((f) => f.code)).not.toContain('WRP_CHECK_VOLUME_MISMATCH');
    const extruded = must(label.doc, 'extrude_profile', { id: label.id, depth: 2 });
    expect(relative(volume(extruded.doc, extruded.id), expected('VC-WRP-35') as number)).toBeLessThan(1e-6);
  });

  it('VC-WRP-18: editing "LLULL" to "WRAP" re-evaluates the emboss to delta 140.8783659; replaying the history gives the identical document', () => {
    const base = cylinder();
    const label = must(base.doc, 'add_text', { content: 'LLULL', position: [0, 0, 0], height: 10, anchor: 'center', font: 'Fira Sans' });
    const done = must(label.doc, 'emboss_on_face', {
      id: base.id,
      face,
      profileIds: [label.id],
      mode: 'emboss',
      depth: 1,
      placement: { anchor: { chart: [0, 0], on: [20, 0, 0] } },
    });
    const step = done.doc.featureHistory.find((s) => s.name === 'add_text');
    const edited = run(done.doc, 'edit_step_params', {
      stepId: step?.id,
      params: { content: 'WRAP', position: [0, 0, 0], height: 10, anchor: 'center', font: 'Fira Sans' },
    });
    expect(edited.rejected, edited.summary).toBeUndefined();
    const mesh = edited.document.order.find((id) => edited.document.entities[id]?.kind === 'mesh') as string;
    const delta = volume(edited.document, mesh) - 16000 * Math.PI;
    expect(relative(delta, (expected('VC-WRP-18') as { wrapEmbossDelta: number }).wrapEmbossDelta)).toBeLessThan(1e-5);
    const replayed = run(done.doc, 'replay_history', {});
    expect(replayed.rejected, replayed.summary).toBeUndefined();
    expect(JSON.stringify(replayed.document.entities)).toBe(JSON.stringify(done.doc.entities));
  });

  it('the pack error codes: overlap, open profile, sphere with develop, deboss as deep as the radius, a damaged font', () => {
    const body = cylinder();
    const ball = must(body.doc, 'add_sphere', { radius: 25, position: [100, 0, 0] });
    const wide = rectangle(ball.doc, 130, 10);
    const open = must(wide.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 5],
      ],
    });
    const small = rectangle(open.doc, 4, 4);
    const doc = small.doc;
    const emboss = (profile: string, extra: Record<string, unknown>): ReturnType<typeof execute> =>
      run(doc, 'emboss_on_face', {
        id: body.id,
        face,
        profileIds: [profile],
        mode: 'emboss',
        depth: 1,
        placement: { method: 'develop' },
        ...extra,
      });
    expect(emboss(wide.id, {}).error?.code).toBe('WRP_WRAP_OVERLAP');
    expect(emboss(open.id, {}).error?.code).toBe('WRP_PROFILE_OPEN');
    expect(
      run(doc, 'wrap_to_face', { id: ball.id, face: { faceNear: [100, 0, 25] }, entityIds: [open.id], placement: { method: 'develop' } })
        .error?.code,
    ).toBe('WRP_FACE_NOT_DEVELOPABLE');
    expect(emboss(small.id, { mode: 'deboss', depth: 25 }).error?.code).toBe('WRP_DEPTH_EXCEEDS_SOLID');
    expect(emboss(small.id, { depth: 0 }).error?.code).toBe('WRP_DEPTH_INVALID');
    expect(emboss(small.id, { placement: { method: 'geodesic' } }).error?.code).toBe('WRP_METHOD_UNAVAILABLE');
    const wrongFace = run(doc, 'emboss_on_face', {
      id: body.id,
      face: { faceIndex: 99 },
      profileIds: [small.id],
      mode: 'emboss',
      depth: 1,
    });
    expect(wrongFace.error?.code).toBe('WRP_FACE_NOT_FOUND');
    expect(
      run(doc, 'import_font', { path: 'not-a-font.txt', base64: Buffer.from('this is not a font').toString('base64') }).error?.code,
    ).toBe('WRP_FONT_PARSE');
  });
});
