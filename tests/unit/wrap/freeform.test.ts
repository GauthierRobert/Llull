/**
 * 03 WRP freeform (B-spline) faces through the commands (spec §14.10, VC-WRP-27): wrap_to_face and emboss_on_face with the geodesic and parametric charts on a fake
 * kernel whose one face is a B-spline patch (a cylinder or a sphere patch, so the closed forms are known), the measured distortion, and every named refusal.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { buildFreeformChart, surfaceOfPort } from '@core/geometry/freeformChart';
import { buildFreeformRecipe, isFreeformFailure } from '@core/commands/wrap/embossFreeform';
import { newEntity } from '@core/commands/entity/newEntity';
import { evaluateSurface } from '@core/lib/nurbs/surface';
import type { CadDocument, MeshSolidEntity, NurbsCurveEntity, Vec2, Vec3 } from '@core/model/types';
import { fakeFreeformKernel, type FakeFreeformOptions } from '../../helpers/fakeFreeformKernel';
import { cylinderPatch, saddlePatch, spherePatch, type PortSurface } from '../../helpers/freeformSurfaces';
import { emptyDoc, make } from './support';

type Row = Record<string, unknown>;

const cylinderFace = cylinderPatch(20, -Math.PI / 4, Math.PI / 4, 40);
const wide = (89 * Math.PI) / 180;
const sphereFace = spherePatch(10, -wide, wide, -0.3, 0.3);
const centre = (patch: PortSurface): Vec3 => evaluateSurface(surfaceOfPort(patch), 0.5, 0.5);
const leftEnd = evaluateSurface(surfaceOfPort(sphereFace), 0.001, 0.5);

afterEach(() => setGeometryKernel(null));

function scene(patch: PortSurface, options: FakeFreeformOptions = {}): { doc: CadDocument; id: string } {
  setGeometryKernel(fakeFreeformKernel(patch, options));
  const body = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
  return { doc: body.doc, id: body.id };
}
const circle = (doc: CadDocument, radius: number): { doc: CadDocument; id: string } => make(doc, 'draw_arc', { center: [0, 0], radius });
const rectangle = (doc: CadDocument, x0: number, x1: number, height: number): { doc: CadDocument; id: string } =>
  make(doc, 'draw_rectangle', { width: x1 - x0, height, position: [x0, -height / 2, 0] });
const placement = (method: string, on: Vec3): Row => ({ method, anchor: { chart: [0, 0], on } });
const codeOf = (result: ReturnType<typeof execute>): string => result.error?.code ?? '';

describe('wrap_to_face on a freeform face', () => {
  it('geodesic: the chart circle of a cylinder patch keeps its length 2 pi a, reports zero stretch, and the curve records its native pcurve', () => {
    const { doc, id } = scene(cylinderFace);
    const disk = circle(doc, 5);
    const result = execute(disk.doc, 'wrap_to_face', {
      id,
      face: { faceNear: centre(cylinderFace) },
      entityIds: [disk.id],
      placement: placement('geodesic', centre(cylinderFace)),
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const data = result.data as Row;
    expect(data['faceKind']).toBe('other');
    const length = ((data['curves'] as Row[])[0] as Row)['length3d'] as number;
    expect(Math.abs(length / (2 * Math.PI * 5) - 1)).toBeLessThan(1e-5);
    expect((data['distortion'] as Row)['maxAbsLengthStrain'] as number).toBeLessThan(1e-5);
    const curve = result.document.entities[result.affected[0] as string] as NurbsCurveEntity;
    expect(curve.onFace?.frame).toBe('native');
    expect(curve.onFace?.faceIndex).toBe(0);
  });

  it('parametric: the stretch of the (u, v) rates of a sphere patch is measured, and a limit under it refuses with WRP_DISTORTION_EXCEEDED', () => {
    const { doc, id } = scene(sphereFace);
    const disk = circle(doc, 3);
    const on = evaluateSurface(surfaceOfPort(sphereFace), 0.5, 0.5);
    const base = { id, face: { faceNear: on }, entityIds: [disk.id], placement: placement('parametric', on) };
    const done = execute(disk.doc, 'wrap_to_face', { ...base, maxLengthStrain: 0.5 });
    expect(done.rejected, done.summary).toBeUndefined();
    const info = (done.data as Row)['distortion'] as Row;
    expect(info['method']).toBe('parametric');
    expect(info['maxAbsLengthStrain'] as number).toBeGreaterThan(1e-4);
    const tight = execute(disk.doc, 'wrap_to_face', { ...base, maxLengthStrain: (info['maxAbsLengthStrain'] as number) / 4 });
    expect(codeOf(tight)).toBe('WRP_DISTORTION_EXCEEDED');
    expect(tight.document).toBe(disk.doc);
  });
});

describe('emboss_on_face on a freeform face', () => {
  const cases = [
    { mode: 'emboss', sign: 1 },
    { mode: 'deboss', sign: -1 },
  ] as const;
  for (const { mode, sign } of cases)
    it(`${mode}: a circle on the cylinder patch builds the offset-layer relief and reports the pull, the footprint fit and exact false`, () => {
      const { doc, id } = scene(cylinderFace, { area: 1000 });
      const disk = circle(doc, 5);
      const result = execute(disk.doc, 'emboss_on_face', {
        id,
        face: { faceNear: centre(cylinderFace) },
        profileIds: [disk.id],
        mode,
        depth: 0.5,
        placement: placement('geodesic', centre(cylinderFace)),
      });
      expect(result.rejected, result.summary).toBeUndefined();
      const data = result.data as Row;
      expect(data['exact']).toBe(false);
      expect(data['faceKind']).toBe('other');
      expect(sign * (data['volumeDelta'] as number)).toBeGreaterThan(0);
      const freeform = data['freeform'] as Row;
      expect(freeform['walls']).toBe('pull');
      expect(data['walls']).toBe('pull');
      const pull = freeform['pullDirection'] as Vec3;
      expect(pull[0]).toBeCloseTo(1, 9);
      expect(freeform['footprintDeviation'] as number).toBeLessThan(1e-3);
      expect(freeform['footprintSegments'] as number).toBeGreaterThan(3);
      expect(freeform['footprintSegments'] as number).toBeLessThan(200);
      expect(Math.abs((data['regionArea'] as number) / (Math.PI * 25) - 1)).toBeLessThan(1e-5);
    });

  it('parametric chart (affine, straight (u, v) lines): the area on the face of a rectangle is the independent area of its (u, v) image (not the sketch area)', () => {
    const { doc, id } = scene(cylinderFace);
    const box = rectangle(doc, -4, 4, 4);
    const on = centre(cylinderFace);
    const result = execute(box.doc, 'emboss_on_face', {
      id,
      face: { faceNear: on },
      profileIds: [box.id],
      mode: 'emboss',
      depth: 0.5,
      maxLengthStrain: 0.5,
      placement: placement('parametric', on),
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const data = result.data as Row;
    // independent area: the rectangle is [u0 -+ 4 / |Su|] x [v0 -+ 2 / |Sv|] in (u, v); on the cylinder R 20 that is R x (azimuth span) x 4 (|Sv| = 40 per unit v)
    const surface = surfaceOfPort(cylinderFace);
    const h = 1e-6;
    const [lo, hi] = [evaluateSurface(surface, 0.5 - h, 0.5), evaluateSurface(surface, 0.5 + h, 0.5)];
    const speed = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / (2 * h);
    const azimuth = (u: number): number => Math.atan2(evaluateSurface(surface, u, 0.5)[1], evaluateSurface(surface, u, 0.5)[0]);
    const expected = 20 * (azimuth(0.5 + 4 / speed) - azimuth(0.5 - 4 / speed)) * 4;
    expect(Math.abs((data['regionArea'] as number) / expected - 1)).toBeLessThan(1e-6);
    expect(Math.abs((data['regionArea'] as number) / 32 - 1)).toBeGreaterThan(1e-6);
  });

  it('a hole in the profile is a second prism subtracted from the first', () => {
    const { doc, id } = scene(cylinderFace);
    const ring = make(doc, 'draw_polyline', {
      points: [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
      closed: true,
    });
    const hole = make(ring.doc, 'draw_polyline', {
      points: [
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, 2],
      ],
      closed: true,
    });
    const result = execute(hole.doc, 'emboss_on_face', {
      id,
      face: { faceNear: centre(cylinderFace) },
      profileIds: [ring.id, hole.id],
      mode: 'emboss',
      depth: 0.5,
      placement: placement('geodesic', centre(cylinderFace)),
    });
    expect(result.rejected, result.summary).toBeUndefined();
    expect((result.data as Row)['regions']).toBeGreaterThanOrEqual(1);
  });

  it('refuses scribe, an unbuildable relief, an invalid result and a face the kernel cannot give a B-spline for, by name, leaving the document unchanged', () => {
    const { doc, id } = scene(cylinderFace);
    const disk = circle(doc, 5);
    const base = {
      id,
      face: { faceNear: centre(cylinderFace) },
      profileIds: [disk.id],
      mode: 'emboss',
      depth: 0.5,
      placement: placement('geodesic', centre(cylinderFace)),
    };
    const scribe = execute(disk.doc, 'emboss_on_face', { ...base, mode: 'scribe', depth: undefined });
    expect(codeOf(scribe)).toBe('WRP_METHOD_UNAVAILABLE');
    expect(scribe.document).toBe(disk.doc);
    setGeometryKernel(fakeFreeformKernel(cylinderFace, { refuseBoolean: true }));
    expect(codeOf(execute(disk.doc, 'emboss_on_face', base))).toBe('WRP_KERNEL_BUILD_FAILED');
    setGeometryKernel(fakeFreeformKernel(cylinderFace, { invalidResult: true }));
    expect(codeOf(execute(disk.doc, 'emboss_on_face', base))).toBe('WRP_KERNEL_BUILD_FAILED');
    setGeometryKernel(fakeFreeformKernel(cylinderFace, { noBspline: true }));
    const none = execute(disk.doc, 'emboss_on_face', base);
    expect(codeOf(none)).toBe('WRP_METHOD_UNAVAILABLE');
    expect(none.summary).toContain('no B-spline');
    setGeometryKernel(fakeFreeformKernel(cylinderFace, { foreignParameters: true }));
    const off = centre(cylinderFace);
    const elsewhere = evaluateSurface(surfaceOfPort(cylinderFace), 0.2, 0.5);
    const foreign = execute(disk.doc, 'emboss_on_face', {
      ...base,
      face: { faceNear: elsewhere },
      placement: placement('geodesic', elsewhere),
    });
    expect(codeOf(foreign)).toBe('WRP_METHOD_UNAVAILABLE');
    expect(foreign.summary).toContain('own (u, v)');
    expect(off).toBeDefined();
  });

  it('refuses develop (WRP_FACE_NOT_DEVELOPABLE), a region that leaves the face (WRP_OUTSIDE_FACE) and a trimmed-away region', () => {
    const { doc, id } = scene(cylinderFace);
    const disk = circle(doc, 5);
    const on = centre(cylinderFace);
    const develop = execute(disk.doc, 'emboss_on_face', { id, face: { faceNear: on }, profileIds: [disk.id], mode: 'emboss', depth: 0.5 });
    expect(codeOf(develop)).toBe('WRP_FACE_NOT_DEVELOPABLE');
    const huge = circle(doc, 60);
    const outside = execute(huge.doc, 'emboss_on_face', {
      id,
      face: { faceNear: on },
      profileIds: [huge.id],
      mode: 'emboss',
      depth: 0.5,
      placement: placement('parametric', on),
    });
    expect(codeOf(outside)).toBe('WRP_OUTSIDE_FACE');
    setGeometryKernel(fakeFreeformKernel(cylinderFace, { containsNothing: true }));
    const trimmed = execute(disk.doc, 'emboss_on_face', {
      id,
      face: { faceIndex: 0 },
      profileIds: [disk.id],
      mode: 'emboss',
      depth: 0.5,
      placement: placement('geodesic', on),
    });
    expect(codeOf(trimmed)).toBe('WRP_OUTSIDE_FACE');
  });
});

describe('the exponential map of a freeform face: named refusals', () => {
  const longStrip = (x1: number): { doc: CadDocument; id: string; strip: string } => {
    const { doc, id } = scene(sphereFace);
    const strip = rectangle(doc, 0, x1, 2);
    return { doc: strip.doc, id, strip: strip.id };
  };

  it('a sketch that reaches the antipode of the anchor folds the geodesic chart: WRP_CHART_FOLD from wrap_to_face and emboss_on_face', () => {
    const { doc, id, strip } = longStrip(30.5);
    const base = { id, face: { faceNear: leftEnd }, placement: placement('geodesic', leftEnd) };
    const wrap = execute(doc, 'wrap_to_face', { ...base, entityIds: [strip], maxLengthStrain: 10 });
    expect(codeOf(wrap)).toBe('WRP_CHART_FOLD');
    expect(wrap.document).toBe(doc);
    const emboss = execute(doc, 'emboss_on_face', { ...base, profileIds: [strip], mode: 'emboss', depth: 0.2, maxLengthStrain: 10 });
    expect(codeOf(emboss)).toBe('WRP_CHART_FOLD');
  });

  it('a strip past the end of the surface is outside (WRP_OUTSIDE_FACE), a strip the pull sees edge-on or from both sides is WRP_FACE_TOO_STEEP', () => {
    const wrapOf = (x1: number, x0 = 0, height = 2): ReturnType<typeof execute> => {
      const { doc, id } = scene(sphereFace);
      const strip = rectangle(doc, x0, x1, height);
      return execute(strip.doc, 'emboss_on_face', {
        id,
        face: { faceNear: leftEnd },
        profileIds: [strip.id],
        mode: 'emboss',
        depth: 0.2,
        maxLengthStrain: 10,
        placement: placement('geodesic', leftEnd),
      });
    };
    expect(codeOf(wrapOf(2, 0.1, 8))).toBe('WRP_OUTSIDE_FACE');
    const both = wrapOf(25);
    expect(codeOf(both)).toBe('WRP_FACE_TOO_STEEP');
    expect(both.summary).toContain('folds over the region');
    const edgeOn = wrapOf(15.7, 15.5);
    expect(codeOf(edgeOn)).toBe('WRP_FACE_TOO_STEEP');
    expect(edgeOn.summary).toContain('degrees from the pull');
  });

  it('a footprint of more than 2000 segments is refused with WRP_PARAM_INVALID', () => {
    const chart = buildFreeformChart(
      cylinderFace,
      [0.5, 0.5],
      { anchorChart: [0, 0], anchorOn: centre(cylinderFace), angleDeg: 0, mirror: false },
      'geodesic',
    );
    if ('error' in chart) throw new Error(chart.error);
    const ring = Array.from(
      { length: 2100 },
      (_, k): Vec2 => [0.5 + 0.02 * Math.cos((k * 2 * Math.PI) / 2100), 0.5 + 0.02 * Math.sin((k * 2 * Math.PI) / 2100)],
    );
    const pieces = ring.map((from, k) => ({ kind: 'line' as const, from, to: ring[(k + 1) % ring.length] as Vec2 }));
    const built = buildFreeformRecipe({
      source: { op: 'solid', entity: newEntity('box', 'b', { size: [1, 1, 1] }, [0, 0, 0], '#fff') },
      face: 0,
      diagonal: 100,
      chart,
      orientation: 1,
      outward: [1, 0, 0],
      holesPerRegion: [0],
      pieces: [pieces],
      mode: 'emboss',
      depth: 0.5,
      tolerance: 1e-9,
    });
    expect(isFreeformFailure(built) ? built.code : 'built').toBe('WRP_PARAM_INVALID');
  });
});

describe('freeform faces: the side of the sketch, the prism window, several regions and the other modes', () => {
  const upright = (doc: CadDocument, id: string, patch: PortSurface): { end: Vec3 } => {
    const line = make(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [0, 4],
      ],
    });
    const on = centre(patch);
    const done = execute(line.doc, 'wrap_to_face', {
      id,
      face: { faceNear: on },
      entityIds: [line.id],
      placement: placement('geodesic', on),
    });
    expect(done.rejected, done.summary).toBeUndefined();
    const curve = done.document.entities[done.affected[0] as string] as NurbsCurveEntity;
    const poles = curve.curve.poles;
    return { end: poles[poles.length - 1] as Vec3 };
  };

  it('the sketch is seen from OUTSIDE the solid: north = outward x east, so a face whose solid lies on the Su x Sv side lands the sketch mirrored in z (reversed faces)', () => {
    const upwards = scene(cylinderFace);
    const normal = upright(upwards.doc, upwards.id, cylinderFace);
    expect(normal.end[2]).toBeCloseTo(24, 6);
    const bore = scene(cylinderFace, { reversed: true });
    const mirrored = upright(bore.doc, bore.id, cylinderFace);
    expect(mirrored.end[2]).toBeCloseTo(16, 6);
  });

  it('the prism window holds the relief: along the pull it spans the heights of the region (R cos(a / R) .. R) plus the depth, without reaching far beyond', () => {
    const { doc, id } = scene(cylinderFace);
    const disk = circle(doc, 5);
    const done = execute(disk.doc, 'emboss_on_face', {
      id,
      face: { faceNear: centre(cylinderFace) },
      profileIds: [disk.id],
      mode: 'emboss',
      depth: 0.5,
      placement: placement('geodesic', centre(cylinderFace)),
    });
    expect(done.rejected, done.summary).toBeUndefined();
    const prisms: Array<{ low: number; high: number }> = [];
    const walk = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      const entity = (record['source'] as { entity?: { kind?: string; depth?: number } } | undefined)?.entity;
      if (record['op'] === 'place' && entity?.kind === 'extrusion') {
        const low = (record['position'] as Vec3)[0];
        prisms.push({ low, high: low + (entity.depth as number) });
      }
      Object.values(record).forEach(walk);
    };
    walk((done.document.entities[done.affected[0] as string] as MeshSolidEntity).brep);
    expect(prisms).toHaveLength(1);
    const [prism] = prisms as [{ low: number; high: number }];
    expect(prism.low).toBeLessThanOrEqual(20 * Math.cos(5 / 20));
    expect(prism.high).toBeGreaterThanOrEqual(20.5);
    expect(prism.low).toBeGreaterThan(17);
    expect(prism.high).toBeLessThan(23.5);
  });

  it('two separate regions are united (one prism each), a clockwise outline is reversed to counter-clockwise, and a patch facing +z (other helper axis) works', () => {
    const { doc, id } = scene(cylinderFace);
    const left = make(doc, 'draw_arc', { center: [-8, 0], radius: 3 });
    const right = make(left.doc, 'draw_arc', { center: [8, 0], radius: 3 });
    const two = execute(right.doc, 'emboss_on_face', {
      id,
      face: { faceNear: centre(cylinderFace) },
      profileIds: [left.id, right.id],
      mode: 'emboss',
      depth: 0.5,
      placement: placement('geodesic', centre(cylinderFace)),
    });
    expect(two.rejected, two.summary).toBeUndefined();
    expect((two.data as Row)['regions']).toBe(2);
    const clockwise = make(doc, 'draw_polyline', {
      points: [
        [-3, -3],
        [-3, 3],
        [3, 3],
        [3, -3],
      ],
      closed: true,
    });
    const cw = execute(clockwise.doc, 'emboss_on_face', {
      id,
      face: { faceNear: centre(cylinderFace) },
      profileIds: [clockwise.id],
      mode: 'emboss',
      depth: 0.5,
      placement: placement('geodesic', centre(cylinderFace)),
    });
    expect(cw.rejected, cw.summary).toBeUndefined();
    const flat = saddlePatch(0.01, 20);
    const top = scene(flat);
    const disk = circle(top.doc, 4);
    const onTop = execute(disk.doc, 'emboss_on_face', {
      id: top.id,
      face: { faceNear: centre(flat) },
      profileIds: [disk.id],
      mode: 'emboss',
      depth: 0.5,
      placement: placement('geodesic', centre(flat)),
    });
    expect(onTop.rejected, onTop.summary).toBeUndefined();
    expect(((onTop.data as Row)['freeform'] as Row)['pullDirection']).toEqual([0, 0, 1]);
  });

  it('engrave cuts a groove along an open line on a freeform face, and a deboss deeper than the material refuses with the depth it reaches (WRP_DEPTH_EXCEEDS_SOLID)', () => {
    const { doc, id } = scene(cylinderFace);
    const line = make(doc, 'draw_polyline', {
      points: [
        [-6, 0],
        [6, 0],
      ],
    });
    const engraved = execute(line.doc, 'emboss_on_face', {
      id,
      face: { faceNear: centre(cylinderFace) },
      profileIds: [line.id],
      mode: 'engrave',
      toolWidth: 1,
      depth: 0.3,
      placement: placement('geodesic', centre(cylinderFace)),
    });
    expect(engraved.rejected, engraved.summary).toBeUndefined();
    expect((engraved.data as Row)['mode']).toBe('engrave');
    const thin = scene(cylinderFace, { thickness: 0.3 });
    const disk = circle(thin.doc, 4);
    const through = execute(disk.doc, 'emboss_on_face', {
      id: thin.id,
      face: { faceNear: centre(cylinderFace) },
      profileIds: [disk.id],
      mode: 'deboss',
      depth: 0.5,
      placement: placement('geodesic', centre(cylinderFace)),
    });
    expect(codeOf(through)).toBe('WRP_DEPTH_EXCEEDS_SOLID');
    expect(((through.data as Row)['maxDepth'] as number) / 0.3).toBeCloseTo(1, 5);
    expect(through.document).toBe(disk.doc);
    const shallow = execute(disk.doc, 'emboss_on_face', {
      id: thin.id,
      face: { faceNear: centre(cylinderFace) },
      profileIds: [disk.id],
      mode: 'deboss',
      depth: 0.2,
      placement: placement('geodesic', centre(cylinderFace)),
    });
    expect(shallow.rejected, shallow.summary).toBeUndefined();
  });
});
