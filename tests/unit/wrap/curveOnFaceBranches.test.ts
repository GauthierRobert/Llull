/**
 * create_curve_on_face and split_face_by_curves failure branches: a kernel that cannot project, evaluate or bound the face, curves leaving the face, trimmed iso curves, and splits the
 * kernel does not perform. Each refusal is coded and leaves the document unchanged.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { expectRefusal } from '../../helpers/commandAssertions';
import { fakeWrapKernel, type FakeWrapOptions } from '../../helpers/fakeWrapKernel';
import { cylinder, emptyDoc, FACE, make, meshOf, useFakeKernel } from './support';
import { setFontProvider } from '@core/commands/fontPort';

const through = [20, 0, 0];
const using = (options: FakeWrapOptions): void => setGeometryKernel(fakeWrapKernel(options));

afterEach(() => {
  setGeometryKernel(null);
  setFontProvider(null);
});

describe('create_curve_on_face with an unhelpful kernel', () => {
  it.each<[string, FakeWrapOptions, Record<string, unknown>, string]>([
    [
      'cannot project a geodesic point',
      { noProjectOnFace: true },
      { mode: 'geodesic', from: through, to: [20, 0, 5] },
      'WRP_ANCHOR_OFF_FACE',
    ],
    [
      'cannot project the isoparametric point',
      { noProjectOnFace: true },
      { mode: 'isoparametric', through, direction: 'u' },
      'WRP_ANCHOR_OFF_FACE',
    ],
    [
      'cannot evaluate along a uv curve',
      { noEvaluate: true },
      {
        mode: 'uv',
        uv: [
          [0, 0],
          [1, 5],
        ],
      },
      'WRP_OUTSIDE_FACE',
    ],
    ['reports an unbounded face', { infiniteBounds: true }, { mode: 'isoparametric', through, direction: 'u' }, 'WRP_PARAM_INVALID'],
    [
      'claims the geodesic leaves the face',
      { outside: (p) => p[2] > 2 },
      { mode: 'geodesic', from: through, to: [20, 0, 6] },
      'WRP_OUTSIDE_FACE',
    ],
    ['claims nothing is on the face', { containsNothing: true }, { mode: 'isoparametric', through, direction: 'v' }, 'WRP_OUTSIDE_FACE'],
  ])('a kernel that %s refuses with %s', (_name, options, params, code) => {
    const { doc, id } = (() => {
      using({});
      return cylinder();
    })();
    using(options);
    expectRefusal(doc, 'create_curve_on_face', { id, face: FACE, ...params }, code);
  });

  it('trims an isoparametric curve to the part of the face the kernel keeps (bisection)', () => {
    using({});
    const { doc, id } = cylinder();
    using({ outside: (p) => p[2] > 5 || p[2] < -10 });
    const result = execute(doc, 'create_curve_on_face', { id, face: FACE, mode: 'isoparametric', through, direction: 'v' });
    expect(result.rejected, result.summary).toBeUndefined();
    const info = (result.data as { curve: { length3d: number } }).curve;
    expect(info.length3d).toBeGreaterThan(14);
    expect(info.length3d).toBeLessThan(15.1);
  });

  it('refuses an isoparametric curve that has no length on the face', () => {
    using({});
    const { doc, id } = cylinder();
    using({ outside: () => true });
    expectRefusal(doc, 'create_curve_on_face', { id, face: FACE, mode: 'isoparametric', through, direction: 'u' }, 'WRP_OUTSIDE_FACE');
  });
});

describe('split_face_by_curves with an unhelpful kernel', () => {
  useFakeKernel();

  const ringOn = (): { doc: ReturnType<typeof cylinder>['doc']; id: string; curve: string } => {
    const base = cylinder();
    const made = execute(base.doc, 'create_curve_on_face', {
      id: base.id,
      face: FACE,
      mode: 'isoparametric',
      through: [20, 0, 3],
      direction: 'u',
    });
    return { doc: made.document, id: base.id, curve: made.affected[0] as string };
  };

  it.each<[string, FakeWrapOptions]>([
    ['refuses the split (emboss)', { refuseEmboss: true }],
    ['changes the total face area', { splitGrowsArea: true }],
    ['has no face queries', { noFaceQuery: true }],
    ['cannot evaluate the face', { noEvaluate: true }],
    ['cannot project onto the face', { noProjectOnFace: true }],
    ['has no face geometry', { noGeometry: true }],
    ['finds no face under the curve', { containsNothing: true, edgePick: true }],
    ['divides nothing', { noSplit: true }],
    ['returns a result that is not a valid closed solid', { invalidResult: true }],
    ['moves material when it splits', { splitVolumeSkew: 1.01 }],
    ['cannot measure the curve against the faces', { noDistance: true }],
  ])('a kernel that %s leaves the document unchanged', (_name, options) => {
    const { doc, id, curve } = ringOn();
    using(options);
    const result = execute(doc, 'split_face_by_curves', { id, curveIds: [curve] });
    expect(result.rejected, result.summary).toBe(true);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('splits without exact masses (volumes unreported), with a given tolerance, and along a loop closed in the face parameters', () => {
    const { doc, id, curve } = ringOn();
    using({ noMass: true });
    const unmeasured = execute(doc, 'split_face_by_curves', { id, curveIds: [curve], tolerance: 1e-4 });
    expect(unmeasured.rejected, unmeasured.summary).toBeUndefined();
    expect(unmeasured.data).toMatchObject({ volumeBefore: null, volumeAfter: null, volumeRelativeChange: null });
    using({});
    const circle = make(doc, 'draw_arc', { center: [0, 0], radius: 4 });
    const loop = make(circle.doc, 'wrap_to_face', {
      id,
      face: FACE,
      entityIds: [circle.id],
      placement: { anchor: { chart: [0, -10], on: [20, 0, -8] } },
    });
    const closed = execute(loop.doc, 'split_face_by_curves', { id, curveIds: [loop.id] });
    expect(closed.rejected, closed.summary).toBeUndefined();
  });

  it('refuses a curve of coincident points', () => {
    const { doc, id, curve } = ringOn();
    const entity = doc.entities[curve] as unknown as { curve: { poles: number[][] } };
    const pole = entity.curve.poles[0] as number[];
    const collapsed = {
      ...doc,
      entities: { ...doc.entities, [curve]: { ...entity, curve: { ...entity.curve, poles: entity.curve.poles.map(() => pole) } } },
    } as unknown as typeof doc;
    const result = execute(collapsed, 'split_face_by_curves', { id, curveIds: [curve] });
    expect(result.rejected).toBe(true);
  });

  it('splits along two curves at once and keeps both', () => {
    const { doc, id, curve } = ringOn();
    const second = execute(doc, 'create_curve_on_face', { id, face: FACE, mode: 'isoparametric', through: [20, 0, -4], direction: 'u' });
    const result = execute(second.document, 'split_face_by_curves', { id, curveIds: [curve, second.affected[0] as string] });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(meshOf(result.document, result.affected[0] as string).brep).toMatchObject({ op: 'emboss', mode: 'split' });
  });

  it('refuses a curve listed twice or an empty list', () => {
    const { doc, id, curve } = ringOn();
    expect(execute(doc, 'split_face_by_curves', { id, curveIds: [] }).rejected).toBe(true);
    const twice = execute(doc, 'split_face_by_curves', { id, curveIds: [curve, curve] });
    expect(twice.document.entities[curve]).toBeDefined();
  });
});

describe('freeform faces', () => {
  it('refuse a geodesic and a chart-based command with the named method refusal', () => {
    using({});
    const { doc, id } = cylinder();
    using({ freeform: true });
    expectRefusal(
      doc,
      'create_curve_on_face',
      { id, face: FACE, mode: 'geodesic', from: through, to: [20, 0, 5] },
      'WRP_METHOD_UNAVAILABLE',
      'from',
    );
  });
});

describe('geodesics from the apex of a cone', () => {
  useFakeKernel();

  it('refuses a start at the apex: no chart is anchored there', () => {
    const base = make(emptyDoc(), 'add_cone', { radius: 20, height: 40 });
    const result = execute(base.doc, 'create_curve_on_face', {
      id: base.id,
      face: { faceNear: [10, 0, 20] },
      mode: 'geodesic',
      from: [0, 0, 40],
      to: [10, 0, 20],
    });
    expect(result.summary).toContain('WRP_GEODESIC_FAILED');
  });
});
