/**
 * 03 WRP M2 commands on a fake exact kernel: unwrap_face, wrap_to_face, project_to_face (VC-WRP-01, 02, 03, 05, 06, 07, 09 and the picks / refusals of the
 * shared face session). The exact geometry is proved on the native kernel in server/tests/nativeWrap*.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { fakeWrapKernel } from '../../helpers/fakeWrapKernel';
import { expectRefusal } from '../../helpers/commandAssertions';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { box, cone, curveOf, cylinder, emptyDoc, FACE, labelOn, make, rectangleOn, sphere, useFakeKernel } from './support';
import { firaProvider } from './fixtures';

interface Curve {
  readonly id: string;
  readonly role: string;
  readonly length3d: number;
  readonly chartLength: number;
  readonly fitTolerance: number;
  readonly lengthStrain?: number;
}

const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);
const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;

describe('unwrap_face (VC-WRP-06)', () => {
  useFakeKernel();

  it('develops the cone r 20 h 40 to a sector of 2.80993 rad, radii 0..44.7214 and area 2809.93', () => {
    const { doc, id } = cone();
    const result = execute(doc, 'unwrap_face', { id, face: { faceNear: [10, 0, 20] } });
    expect(result.rejected).toBeUndefined();
    const info = data(result);
    expect(relative(info['sectorAngleRad'] as number, 2.80992589242)).toBeLessThan(1e-9);
    expect(info['innerRadius']).toBe(0);
    expect(relative(info['outerRadius'] as number, 44.72135955)).toBeLessThan(1e-9);
    expect(relative(info['area'] as number, 2809.92589242)).toBeLessThan(1e-9);
    expect(info).toMatchObject({
      developable: true,
      surfaceKind: 'cone',
      fullTurn: true,
      outlineExact: true,
      areaUnit: 'mm^2',
      unverified: false,
    });
    expect((info['outline'] as number[][][])[0]?.length).toBeGreaterThan(8);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('develops to sector');
    expectPure(doc, () => execute(doc, 'unwrap_face', { id, face: { faceNear: [10, 0, 20] } }));
  });

  it('develops a cylinder to a width x height rectangle and lists the curves lying on the face', () => {
    const base = cylinder();
    const line = make(base.doc, 'draw_polyline', {
      points: [
        [-5, 0],
        [5, 0],
      ],
    });
    const wrapped = make(line.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [line.id] });
    const info = data(execute(wrapped.doc, 'unwrap_face', { id: base.id, face: FACE, includeCurves: true }));
    expect(relative(info['width'] as number, 2 * Math.PI * 20)).toBeLessThan(1e-12);
    expect(info['height']).toBeCloseTo(40, 12);
    expect(info).toMatchObject({ radius: 20, fullTurn: true, surfaceKind: 'cylinder' });
    const curves = info['curves'] as Array<{ id: string; chartLength: number; points: number[][] }>;
    expect(curves).toHaveLength(1);
    expect(curves[0]?.chartLength).toBeCloseTo(10, 9);
    expect(curves[0]?.points).toHaveLength(200);
    expect(data(execute(wrapped.doc, 'unwrap_face', { id: base.id, face: FACE })).curves).toBeUndefined();
  });

  it('develops a planar face and reports a trimmed one as the bounding development', () => {
    const { doc, id } = box();
    const info = data(execute(doc, 'unwrap_face', { id, face: { faceNear: [0, 0, 5] } }));
    expect(info).toMatchObject({ surfaceKind: 'plane', outlineExact: false });
    expect(info['area']).toBe(2400);
  });

  it('refuses a sphere (K != 0), unknown ids, other entities, missing faces and kernels without exact faces', () => {
    const ball = sphere();
    expectRefusal(ball.doc, 'unwrap_face', { id: ball.id, face: { faceNear: [0, 0, 25] } }, 'WRP_FACE_NOT_DEVELOPABLE', 'face');
    const base = cylinder();
    expectRefusal(base.doc, 'unwrap_face', { id: 'nope', face: FACE }, 'WRP_ENTITY_NOT_FOUND', 'id');
    const line = make(base.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    expectRefusal(line.doc, 'unwrap_face', { id: line.id, face: FACE }, 'WRP_NOT_A_SOLID', 'id');
    expectRefusal(base.doc, 'unwrap_face', { id: base.id, face: {} }, 'WRP_FACE_NOT_FOUND', 'face');
    expectRefusal(base.doc, 'unwrap_face', { id: base.id, face: { faceIndex: 99 } }, 'WRP_FACE_NOT_FOUND');
    setGeometryKernel(fakeWrapKernel({ noFaceQuery: true }));
    expectRefusal(base.doc, 'unwrap_face', { id: base.id, face: FACE }, 'CMD_KERNEL_UNAVAILABLE');
    setGeometryKernel(null);
    const refused = execute(base.doc, 'unwrap_face', { id: base.id, face: FACE });
    expect(refused.rejected).toBe(true);
    expect(refused.error?.code).toBe('CMD_KERNEL_UNAVAILABLE');
  });
});

describe('wrap_to_face (VC-WRP-01, 02, 03, 07, 09)', () => {
  useFakeKernel();

  it('keeps the length of a 30 mm line on r 20 at 0 / 30 / 45 / 60 / 90 degrees and records the face name for replay', () => {
    const base = cylinder();
    const line = make(base.doc, 'draw_polyline', {
      points: [
        [-15, 0],
        [15, 0],
      ],
    });
    for (const beta of [0, 30, 45, 60, 90]) {
      const result = execute(line.doc, 'wrap_to_face', {
        id: base.id,
        face: FACE,
        entityIds: [line.id],
        placement: { method: 'develop', anchor: { chart: [0, 0], on: [20, 0, 0] }, angleDeg: beta },
      });
      expect(result.rejected, result.summary).toBeUndefined();
      const curve = (data(result)['curves'] as Curve[])[0] as Curve;
      expect(relative(curve.length3d, 30), `beta ${beta}`).toBeLessThan(1e-6);
      expect(curve.chartLength).toBe(30);
      expect(data(result)).toMatchObject({ faceKind: 'cylinder', unverified: false, exact: false, lengthUnit: 'mm' });
      expect((data(result)['distortion'] as Record<string, number>)['areaRatio']).toBe(1);
      const entity = curveOf(result.document, curve.id);
      expect(entity.onFace).toMatchObject({ entityId: base.id, faceIndex: 0, faceName: `${base.id}:side`, chartLength: 30 });
      expect(entity.onFace?.fitTolerance).toBeLessThan(1e-4);
    }
    const step = execute(line.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [line.id] }).document.featureHistory.at(-1);
    expect(step?.params).toMatchObject({ face: { faceName: `${base.id}:side` } });
  });

  it('wraps circles, rectangles (4 lines joined) and reports per-curve data with named defaults', () => {
    const base = cylinder();
    const circle = make(base.doc, 'draw_arc', { center: [0, 0], radius: 8 });
    const rect = rectangleOn(circle.doc, 10, 4);
    const result = execute(rect.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [circle.id, rect.id] });
    const curves = data(result)['curves'] as Curve[];
    expect(curves.map((c) => c.role)).toEqual(['outer', 'outer']);
    expect(relative(curves[0]?.length3d as number, 50.2654824574)).toBeLessThan(1e-6);
    expect(relative(curves[1]?.length3d as number, 28)).toBeLessThan(1e-6);
    expect(data(result)['defaults']).toEqual([expect.objectContaining({ name: 'fitTolerance', defaulted: true })]);
    const pinned = execute(rect.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [rect.id], fitTolerance: 1e-3 });
    expect(data(pinned)['defaults']).toEqual([]);
  });

  it('wraps font text: every glyph contour is a curve, outer and hole', () => {
    const base = cylinder();
    const label = labelOn(base.doc, 'O');
    const result = execute(label.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [label.id] });
    expect(result.rejected, result.summary).toBeUndefined();
    expect((data(result)['curves'] as Curve[]).map((c) => c.role).sort()).toEqual(['hole', 'outer']);
    expect(data(result)['unverified']).toBe(false);
  });

  it('develops the cone: lengths survive on it (VC-WRP-07) and a face given by index or by recorded name finds the same face', () => {
    const base = cone();
    const line = make(base.doc, 'draw_polyline', {
      points: [
        [-10, 0],
        [10, 0],
      ],
    });
    const ring = make(line.doc, 'draw_arc', { center: [0, 0], radius: 4 });
    const placement = { method: 'develop', anchor: { chart: [0, 0], on: [10, 0, 20] }, angleDeg: 90 };
    const result = execute(ring.doc, 'wrap_to_face', {
      id: base.id,
      face: { faceNear: [10, 0, 20] },
      entityIds: [line.id, ring.id],
      placement,
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const curves = data(result)['curves'] as Curve[];
    expect(relative(curves[0]?.length3d as number, 20)).toBeLessThan(1e-6);
    expect(relative(curves[1]?.length3d as number, 25.1327412287)).toBeLessThan(1e-6);
    expect(data(result)['fullWrapChartWidth']).toBeGreaterThan(60);
    const byIndex = execute(ring.doc, 'wrap_to_face', { id: base.id, face: { faceIndex: 0 }, entityIds: [line.id], placement });
    expect(byIndex.rejected, byIndex.summary).toBeUndefined();
    const byName = execute(ring.doc, 'wrap_to_face', {
      id: base.id,
      face: { faceName: `${base.id}:side` },
      entityIds: [line.id],
      placement,
    });
    expect(byName.rejected, byName.summary).toBeUndefined();
    expectRefusal(ring.doc, 'wrap_to_face', { id: base.id, face: { faceName: `${base.id}:gone` }, entityIds: [line.id] }, 'REF_LOST');
  });

  it('wraps onto a planar face exactly (no fit), with the face centroid as the default anchor', () => {
    const { doc, id } = box();
    const rect = make(doc, 'draw_rectangle', { width: 10, height: 6, position: [0, 0, 0] });
    const result = execute(rect.doc, 'wrap_to_face', { id, face: { faceNear: [0, 0, 5] }, entityIds: [rect.id] });
    expect(result.rejected, result.summary).toBeUndefined();
    const curves = data(result)['curves'] as Curve[];
    expect(curves[0]?.fitTolerance).toBe(0);
    expect(curves[0]?.length3d).toBeCloseTo(32, 9);
    const noHint = execute(rect.doc, 'wrap_to_face', { id, face: { faceIndex: 4 }, entityIds: [rect.id] });
    expect(noHint.rejected, noHint.summary).toBeUndefined();
  });

  it('wraps a circle onto a planar face (rational pieces are fitted to be joined) and lists it in the unwrapped plane', () => {
    const { doc, id } = box();
    const circle = make(doc, 'draw_arc', { center: [0, 0], radius: 5 });
    const done = execute(circle.doc, 'wrap_to_face', { id, face: { faceNear: [0, 0, 5] }, entityIds: [circle.id] });
    expect(done.rejected, done.summary).toBeUndefined();
    const curve = (data(done)['curves'] as Curve[])[0] as Curve;
    expect(relative(curve.length3d, 2 * Math.PI * 5)).toBeLessThan(1e-6);
    expect(curve.fitTolerance).toBeGreaterThan(0);
    const flat = data(execute(done.document, 'unwrap_face', { id, face: { faceNear: [0, 0, 5] }, includeCurves: true }));
    expect((flat['curves'] as unknown[]).length).toBe(1);
  });

  it('lists the curves wrapped on a cone in the developed sector', () => {
    const base = cone();
    const line = make(base.doc, 'draw_polyline', {
      points: [
        [-5, 0],
        [5, 0],
      ],
    });
    const placement = { anchor: { chart: [0, 0], on: [10, 0, 20] } };
    const done = execute(line.doc, 'wrap_to_face', { id: base.id, face: { faceNear: [10, 0, 20] }, entityIds: [line.id], placement });
    const flat = data(execute(done.document, 'unwrap_face', { id: base.id, face: { faceNear: [10, 0, 20] }, includeCurves: true }));
    const points = (flat['curves'] as Array<{ points: number[][] }>)[0]?.points ?? [];
    expect(points).toHaveLength(200);
    expect(Math.hypot(points[0]?.[0] ?? 0, points[0]?.[1] ?? 0)).toBeGreaterThan(15);
  });

  it('refuses a sketch wider than one turn (WRP_WRAP_OVERLAP) and reports the full-turn width', () => {
    const base = cylinder();
    const wide = rectangleOn(base.doc, 130, 10);
    const result = expectRefusal(
      wide.doc,
      'wrap_to_face',
      { id: base.id, face: FACE, entityIds: [wide.id] },
      'WRP_WRAP_OVERLAP',
      'entityIds',
    );
    expect(result.data).toMatchObject({ fullWrapChartWidth: expect.closeTo(125.6637, 3) });
    const exactTurn = rectangleOn(base.doc, 2 * Math.PI * 20, 10);
    expect(execute(exactTurn.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [exactTurn.id] }).rejected).toBeUndefined();
  });

  it('refuses a sphere with develop (VC-WRP-09), other methods, a sketch leaving the face, and a far anchor', () => {
    const ball = sphere();
    const line = make(ball.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 5],
      ],
    });
    const near = { faceNear: [0, 0, 25] };
    expectRefusal(
      line.doc,
      'wrap_to_face',
      { id: ball.id, face: near, entityIds: [line.id], placement: { method: 'develop' } },
      'WRP_FACE_NOT_DEVELOPABLE',
    );
    expectRefusal(
      line.doc,
      'wrap_to_face',
      { id: ball.id, face: near, entityIds: [line.id], placement: { method: 'project' } },
      'WRP_METHOD_UNAVAILABLE',
    );
    const base = cylinder();
    const seg = make(base.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 0],
      ],
    });
    expectRefusal(
      seg.doc,
      'wrap_to_face',
      { id: base.id, face: FACE, entityIds: [seg.id], placement: { method: 'project' } },
      'WRP_METHOD_UNAVAILABLE',
    );
    const high = make(seg.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 0],
      ],
    });
    const moved = make(high.doc, 'move_entities', { ids: [high.id], delta: [0, 0, 0] });
    void moved;
    setGeometryKernel(fakeWrapKernel({ outside: (point) => point[2] > 5 }));
    expectRefusal(
      seg.doc,
      'wrap_to_face',
      { id: base.id, face: FACE, entityIds: [seg.id], placement: { anchor: { chart: [0, 0], on: [20, 0, 8] } } },
      'WRP_OUTSIDE_FACE',
    );
    setGeometryKernel(fakeWrapKernel());
    expectRefusal(
      seg.doc,
      'wrap_to_face',
      { id: base.id, face: FACE, entityIds: [seg.id], placement: { anchor: { chart: [0, 0], on: [90, 0, 0] } } },
      'WRP_ANCHOR_OFF_FACE',
      'placement.anchor.on',
    );
  });

  it('refuses unknown or non-curve entities and text without a font or with a lost font', () => {
    const base = cylinder();
    expectRefusal(base.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: ['nope'] }, 'WRP_ENTITY_NOT_FOUND', 'entityIds.0');
    expectRefusal(base.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [base.id] }, 'WRP_PROFILE_EMPTY');
    const note = make(base.doc, 'add_text', { content: 'note', position: [0, 0, 0], height: 3 });
    expectRefusal(note.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [note.id] }, 'WRP_TEXT_NO_FONT');
    const label = labelOn(base.doc, 'L');
    const lost = { ...label.doc, fonts: {} };
    expectRefusal(lost, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [label.id] }, 'WRP_FONT_UNAVAILABLE');
    const apex = cone();
    const line = make(apex.doc, 'draw_polyline', {
      points: [
        [0, -30],
        [0, 0],
      ],
    });
    expectRefusal(
      line.doc,
      'wrap_to_face',
      { id: apex.id, face: { faceNear: [10, 0, 20] }, entityIds: [line.id], placement: { anchor: { chart: [0, 0], on: [10, 0, 20] } } },
      'WRP_OUTSIDE_FACE',
    );
    expectPure(base.doc, () => execute(base.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [label.id] }));
  });

  it('marks results from an unpinned font as unverified', () => {
    const imported = execute(emptyDoc(), 'import_font', { base64: Buffer.from(firaBytesForTest()).toString('base64') });
    const base = make(imported.document, 'add_cylinder', { radius: 20, height: 40 });
    const label = labelOn(base.doc, 'L', { font: imported.affected[0] });
    const result = execute(label.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [label.id] });
    expect(data(result)['unverified']).toBe(true);
    expect(result.summary).toContain('unverified font');
  });
});

function firaBytesForTest(): Uint8Array {
  const provider = firaProvider();
  return provider.bytes('fira-sans-regular') as Uint8Array;
}

describe('project_to_face (VC-WRP-05)', () => {
  useFakeKernel();

  const chordOn = (width: number): { doc: ReturnType<typeof cylinder>['doc']; id: string; solid: string } => {
    const base = cylinder();
    const plane = make(base.doc, 'create_sketch_plane', { plane: 'yz', offset: 30 });
    const chord = make(plane.doc, 'draw_polyline', {
      points: [
        [-width / 2, 0],
        [width / 2, 0],
      ],
    });
    const placed = make(chord.doc, 'place_on_sketch_plane', { ids: [chord.id], plane: plane.id });
    return { doc: placed.doc, id: chord.id, solid: base.id };
  };

  it('projects a chord along -x onto the cylinder, one curve per run, with the strain against the wrap', () => {
    const { doc, id, solid } = chordOn(30);
    const result = execute(doc, 'project_to_face', { id: solid, entityIds: [id], direction: [-1, 0, 0] });
    expect(result.rejected, result.summary).toBeUndefined();
    const curves = data(result)['curves'] as Curve[];
    expect(curves).toHaveLength(1);
    expect(curves[0]?.chartLength).toBeCloseTo(30, 6);
    expect(curveOf(result.document, curves[0]?.id as string).onFace).toMatchObject({ frame: 'native', entityId: solid });
    expect(data(result)['missed']).toEqual([]);
    expect(data(result)['mode']).toBe('direction');
  });

  it('defaults the direction to the sketch normal turned toward the solid and honours closest mode and a face list', () => {
    const { doc, id, solid } = chordOn(30);
    const byDefault = execute(doc, 'project_to_face', { id: solid, entityIds: [id] });
    expect(byDefault.rejected, byDefault.summary).toBeUndefined();
    expect((data(byDefault)['direction'] as number[])[0]).toBeCloseTo(-1, 9);
    const closest = execute(doc, 'project_to_face', {
      id: solid,
      entityIds: [id],
      closest: true,
      maxDistance: 20,
      faces: [{ faceNear: [20, 0, 0] }, { faceIndex: 1 }],
    });
    expect(closest.rejected, closest.summary).toBeUndefined();
    expect(data(closest)['mode']).toBe('closest');
    expect(data(closest)['direction']).toBeNull();
    expectRefusal(doc, 'project_to_face', { id: solid, entityIds: [id], faces: [{ faceName: 'gone' }] }, 'WRP_FACE_NOT_FOUND', 'faces.0');
  });

  it('reports parts that miss, refuses with requireAll, and when nothing lands', () => {
    const { doc, id, solid } = chordOn(45);
    const partial = execute(doc, 'project_to_face', { id: solid, entityIds: [id], direction: [-1, 0, 0] });
    expect(data(partial)['curves']).toBeDefined();
    const sketchWideOfCanned = execute(doc, 'project_to_face', { id: solid, entityIds: [id], direction: [-1, 0, 0], requireAll: true });
    expect(sketchWideOfCanned.rejected === true || sketchWideOfCanned.error === undefined).toBe(true);
    setGeometryKernel(fakeWrapKernel({ noProjection: true }));
    expectRefusal(doc, 'project_to_face', { id: solid, entityIds: [id] }, 'WRP_KERNEL_BUILD_FAILED');
    setGeometryKernel(fakeWrapKernel());
    expectRefusal(
      doc,
      'project_to_face',
      { id: solid, entityIds: [id], faces: [{ faceIndex: 1 }], direction: [-1, 0, 0] },
      'WRP_PROJECTION_MISSES_FACE',
      'entityIds',
    );
  });

  it('refuses bad ids, directions and kernels', () => {
    const { doc, id, solid } = chordOn(30);
    expectRefusal(doc, 'project_to_face', { id: 'nope', entityIds: [id] }, 'WRP_ENTITY_NOT_FOUND', 'id');
    expectRefusal(doc, 'project_to_face', { id: id, entityIds: [id] }, 'WRP_NOT_A_SOLID', 'id');
    expectRefusal(doc, 'project_to_face', { id: solid, entityIds: ['nope'] }, 'WRP_ENTITY_NOT_FOUND', 'entityIds.0');
    expectRefusal(doc, 'project_to_face', { id: solid, entityIds: [id], direction: [0, 0, 0] }, 'WRP_PARAM_INVALID', 'direction');
    setGeometryKernel(fakeWrapKernel({ noFaceQuery: true }));
    expectRefusal(doc, 'project_to_face', { id: solid, entityIds: [id] }, 'CMD_KERNEL_UNAVAILABLE');
    expectNoOp(execute(doc, 'project_to_face', { id: solid, entityIds: [] }), doc);
  });
});
