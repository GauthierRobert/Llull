/**
 * 03 WRP M5 (VC-WRP-36) on the fake exact kernel with a stadium fixture (tests/helpers/fakeWrapKernel.ts `stadium`): multi-face emboss_on_face / wrap_to_face (`chain`) and
 * split_at_silhouette. The fake's emboss volume is the closed form, so these tests prove the commands' own logic (unfolding, clipping, recipes, data, every WRP_CHAIN_* code);
 * the exact geometry is proved on the native kernel in server/tests/nativeWrapChain.test.ts and nativeSilhouette.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { fakeWrapKernel, type FakeWrapOptions } from '../../helpers/fakeWrapKernel';
import type { CadDocument } from '@core/model/types';
import { expectRefusal } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';
import { emptyDoc, make, useFakeKernel } from './support';

const FRONT = { faceNear: [0, -10, 0] };
const END = { faceNear: [30, 0, 0] };
const BACK = { faceNear: [0, 10, 0] };
const TOP = { faceNear: [0, 0, 5] };
const placement = { anchor: { chart: [0, 0], on: [10, -10, 0] } };

const stadium = (): { doc: CadDocument; id: string } => make(emptyDoc(), 'add_box', { size: [40, 20, 10] });
const rectangle = (doc: CadDocument, width: number, height: number, x = -3): { doc: CadDocument; id: string } =>
  make(doc, 'draw_rectangle', { width, height, position: [x, 0, 0] });
const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;
const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);

describe('emboss_on_face with a chain of faces (fake stadium)', () => {
  useFakeKernel({ stadium: true });

  const emboss = (extra: Record<string, unknown>, length = 30, x = -3): ReturnType<typeof execute> => {
    const base = stadium();
    const sketch = rectangle(base.doc, 6, length, x);
    return execute(sketch.doc, 'emboss_on_face', {
      id: base.id,
      face: FRONT,
      profileIds: [sketch.id],
      mode: 'emboss',
      depth: 1,
      placement,
      ...extra,
    });
  };

  it('VC-WRP-36: a 30 long band over the plane and the tangent cylinder end: parts 60 + 120, volume 60 + 120 x 1.05 = 186, edge smooth 10 long, strain 0', () => {
    const done = emboss({ chain: [END] });
    expect(done.rejected, done.summary).toBeUndefined();
    const info = data(done);
    const faces = info['faces'] as Array<{ faceKind: string; area: number; face: number; regions: number }>;
    expect(faces.map((f) => [f.faceKind, f.face, f.regions])).toEqual([
      ['plane', 2, 1],
      ['cylinder', 1, 1],
    ]);
    expect(faces[0]?.area).toBeCloseTo(60, 9);
    expect(faces[1]?.area).toBeCloseTo(120, 9);
    expect(info['chainArea']).toBeCloseTo(180, 9);
    expect(relative(info['expectedVolumeDelta'] as number, 186)).toBeLessThan(1e-9);
    expect(relative(info['volumeDelta'] as number, 186)).toBeLessThan(1e-9);
    expect(info['chain']).toEqual([2, 1]);
    expect(info['edges']).toEqual([{ edge: 6, faces: [2, 1], length: 10, windowLength: 10, cutGap: 0, convexity: 'smooth', mismatch: 0 }]);
    expect((info['distortion'] as { maxLengthStrain: number }).maxLengthStrain).toBe(0);
    expect(done.affected).toHaveLength(1);
    expect(done.summary).toContain('across 2 faces');
  });

  it('three faces: plane, cylinder end, opposite plane (60 long): areas 60, 60 pi, 6 (50 - 10 pi); volume 369.4248', () => {
    const done = emboss({ chain: [END, BACK] }, 60);
    expect(done.rejected, done.summary).toBeUndefined();
    const areas = (data(done)['faces'] as Array<{ area: number }>).map((f) => f.area);
    expect(areas[0]).toBeCloseTo(60, 9);
    expect(areas[1]).toBeCloseTo(60 * Math.PI, 9);
    expect(areas[2]).toBeCloseTo(6 * (50 - 10 * Math.PI), 9);
    expect(relative(data(done)['expectedVolumeDelta'] as number, 60 + 60 * Math.PI * 1.05 + 6 * (50 - 10 * Math.PI))).toBeLessThan(1e-9);
    expect((data(done)['edges'] as unknown[]).length).toBe(2);
  });

  it('deboss across the faces (-174) and scribe across a sharp edge (no volume change) both work; a sketch that stays on the first face skips the others', () => {
    expect(relative(-(data(emboss({ chain: [END], mode: 'deboss' }))['volumeDelta'] as number), 174)).toBeLessThan(1e-9);
    const scribed = emboss({ chain: [TOP], mode: 'scribe', depth: undefined }, 8, 2);
    expect(scribed.rejected, scribed.summary).toBeUndefined();
    expect((data(scribed)['faces'] as unknown[]).length).toBe(2);
    expect(data(scribed)['expectedVolumeDelta']).toBe(0);
    const alone = emboss({ chain: [TOP] }, 8, -3);
    expect(alone.rejected, alone.summary).toBeUndefined();
    expect((data(alone)['faces'] as unknown[]).length).toBe(1);
  });

  it('is pure and the same call twice gives the same result', () => {
    const base = stadium();
    const sketch = rectangle(base.doc, 6, 30);
    const params = { id: base.id, face: FRONT, chain: [END], profileIds: [sketch.id], mode: 'emboss', depth: 1, placement };
    expectPure(sketch.doc, () => execute(sketch.doc, 'emboss_on_face', params));
  });

  it('refuses by code: a face with no edge to the chain, a circular edge, a duplicate face and a chain with engrave', () => {
    // a convex edge between two planes crossed at right angles is mitred (14.15): 8 x 6 = 48 plus the corner column 1 x 8
    const mitred = emboss({ chain: [TOP] }, 8, 2);
    expect(mitred.rejected, mitred.summary).toBeUndefined();
    expect(data(mitred)['expectedVolumeDelta']).toBeCloseTo(56, 9);
    expect(emboss({ chain: [BACK] }).error?.code).toBe('WRP_CHAIN_NOT_ADJACENT');
    expect(emboss({ chain: [FRONT] }).error?.code).toBe('WRP_PARAM_INVALID');
    expect(emboss({ chain: [END], mode: 'engrave', toolWidth: 1 }).error?.code).toBe('WRP_PARAM_INVALID');
    const base = stadium();
    const sketch = rectangle(base.doc, 6, 8);
    const round = expectRefusal(
      sketch.doc,
      'emboss_on_face',
      {
        id: base.id,
        face: END,
        chain: [TOP],
        profileIds: [sketch.id],
        mode: 'emboss',
        depth: 1,
        placement: { anchor: { chart: [0, 0], on: [30, 0, 0] } },
      },
      'WRP_CHAIN_EDGE_CURVED',
    );
    expect(round.summary).toContain('edge 0');
  });

  it('a face the sketch leaves is refused as WRP_OUTSIDE_FACE naming the face; a sketch that fits none of the chain refuses too', () => {
    const outside = emboss({ chain: [END] }, 60);
    expect(outside.error?.code).toBe('WRP_OUTSIDE_FACE');
    expect(outside.summary).toContain('face ');
  });
});

describe('chain refusals that need another fixture', () => {
  it('a cone face joined along an edge that does not develop to the same line is WRP_CHAIN_EDGE_CURVED (cones chain along rulings only)', () => {
    withFakeKernelOnce({ stadium: 'cone-end' }, () => {
      const base = stadium();
      const sketch = rectangle(base.doc, 6, 30);
      expectRefusal(
        sketch.doc,
        'emboss_on_face',
        { id: base.id, face: FRONT, chain: [{ faceIndex: 1 }], profileIds: [sketch.id], mode: 'emboss', depth: 1, placement },
        'WRP_CHAIN_EDGE_CURVED',
        'chain',
      );
    });
  });

  it('edges the kernel cannot classify (unknown convexity) are refused like sharp ones when the sketch crosses them, and pass when it does not', () => {
    withFakeKernelOnce({ stadium: 'unknown-edges' }, () => {
      const base = stadium();
      const crossing = rectangle(base.doc, 6, 30);
      const params = { id: base.id, face: FRONT, chain: [END], profileIds: [crossing.id], mode: 'emboss', depth: 1, placement };
      const refused = execute(crossing.doc, 'emboss_on_face', params);
      expect(refused.error?.code).toBe('WRP_CHAIN_EDGE_SHARP');
      expect(refused.summary).toContain('unknown edge');
      const short = rectangle(base.doc, 6, 8);
      expect(execute(short.doc, 'emboss_on_face', { ...params, profileIds: [short.id] }).rejected).toBeUndefined();
    });
  });

  it('a kernel that cannot say which side of an edge a face lies on is WRP_CHAIN_CLIP_FAILED', () => {
    withFakeKernelOnce({ stadium: true, sideBlind: true }, () => {
      const base = stadium();
      const sketch = rectangle(base.doc, 6, 30);
      expectRefusal(
        sketch.doc,
        'emboss_on_face',
        { id: base.id, face: FRONT, chain: [END], profileIds: [sketch.id], mode: 'emboss', depth: 1, placement },
        'WRP_CHAIN_CLIP_FAILED',
      );
    });
  });
});

describe('chain emboss when the kernel misbehaves', () => {
  const run = (options: FakeWrapOptions): ReturnType<typeof execute> => {
    let result!: ReturnType<typeof execute>;
    withFakeKernelOnce({ stadium: true, ...options }, () => {
      const base = stadium();
      const sketch = rectangle(base.doc, 6, 30);
      result = execute(sketch.doc, 'emboss_on_face', {
        id: base.id,
        face: FRONT,
        chain: [END],
        profileIds: [sketch.id],
        mode: 'emboss',
        depth: 1,
        placement,
      });
    });
    return result;
  };

  it('names the step the kernel cannot build, an invalid result and a volume change the wrong way; without mass properties the change is simply not measured', () => {
    const failed = run({ refuseEmboss: true });
    expect(failed.error?.code).toBe('WRP_KERNEL_BUILD_FAILED');
    expect(failed.summary).toContain('step 1 of 2');
    expect(run({ invalidResult: true }).error?.code).toBe('WRP_KERNEL_BUILD_FAILED');
    const wrong = run({ embossSkew: -1 });
    expect(wrong.error?.code).toBe('WRP_KERNEL_BUILD_FAILED');
    expect(wrong.summary).toContain('the wrong way');
    const unmeasured = run({ noMass: true });
    expect(unmeasured.rejected, unmeasured.summary).toBeUndefined();
    expect(data(unmeasured)['volumeDelta']).toBeNull();
    expect(unmeasured.summary).toContain('volume change not measured');
  });
});

describe('wrap_to_face with a chain of faces (fake stadium)', () => {
  useFakeKernel({ stadium: true });

  const line = (doc: CadDocument, points: number[][]): { doc: CadDocument; id: string } => make(doc, 'draw_polyline', { points });
  const curves = (result: ReturnType<typeof execute>): Array<{ face: number; length3d: number; role: string }> =>
    (data(result)['curves'] as Array<{ face: number; length3d: number; role: string }>).map((c) => ({
      face: c.face,
      length3d: c.length3d,
      role: c.role,
    }));

  it('a 40 long line over the plane and the cylinder end is 10 + 30 long in the two faces, each curve on its own face, strain 0', () => {
    const base = stadium();
    const path = line(base.doc, [
      [0, 0],
      [0, 40],
    ]);
    const done = execute(path.doc, 'wrap_to_face', { id: base.id, face: FRONT, chain: [END], entityIds: [path.id], placement });
    expect(done.rejected, done.summary).toBeUndefined();
    const found = curves(done);
    expect(found.map((c) => c.face)).toEqual([2, 1]);
    expect(found[0]?.length3d).toBeCloseTo(10, 9);
    expect(found[1]?.length3d).toBeCloseTo(30, 7);
    expect(done.affected).toHaveLength(2);
    const onFaces = done.affected.map((id) => (done.document.entities[id] as { onFace?: { faceIndex: number } }).onFace?.faceIndex);
    expect(onFaces).toEqual([2, 1]);
    expect(data(done)['chain']).toEqual([2, 1]);
  });

  it('crosses a sharp edge too: a chart line from z = 0 over the front and top planes is 5 + 3 long', () => {
    const base = stadium();
    const path = line(base.doc, [
      [0, 0],
      [8, 0],
    ]);
    const done = execute(path.doc, 'wrap_to_face', { id: base.id, face: FRONT, chain: [TOP], entityIds: [path.id], placement });
    expect(done.rejected, done.summary).toBeUndefined();
    expect(curves(done).map((c) => c.length3d.toFixed(9))).toEqual(['5.000000000', '3.000000000']);
    expect((data(done)['edges'] as Array<{ convexity: string }>)[0]?.convexity).toBe('convex');
  });

  it('a letter with a hole keeps the roles of its loops (outer, hole) and a loop cut by an edge becomes open pieces', () => {
    const base = stadium();
    const text = make(base.doc, 'add_text', { content: 'O', position: [0, 0, 0], height: 4, font: 'Fira Sans' });
    const whole = execute(text.doc, 'wrap_to_face', { id: base.id, face: FRONT, chain: [END], entityIds: [text.id], placement });
    expect(whole.rejected, whole.summary).toBeUndefined();
    expect(
      curves(whole)
        .map((c) => c.role)
        .sort(),
    ).toEqual(['hole', 'outer']);
    const cut = execute(text.doc, 'wrap_to_face', {
      id: base.id,
      face: FRONT,
      chain: [END],
      entityIds: [text.id],
      placement: { anchor: { chart: [0, 0], on: [19, -10, 0] } },
    });
    expect(cut.rejected, cut.summary).toBeUndefined();
    expect(curves(cut).every((c) => c.role === 'open' || c.role === 'outer' || c.role === 'hole')).toBe(true);
    expect(curves(cut).some((c) => c.role === 'open')).toBe(true);
  });

  it('refuses by code: a face without an edge to the chain, a circular edge, an unknown entity', () => {
    const base = stadium();
    const path = line(base.doc, [
      [0, 0],
      [0, 5],
    ]);
    const params = { id: base.id, entityIds: [path.id], placement };
    expect(execute(path.doc, 'wrap_to_face', { ...params, face: FRONT, chain: [BACK] }).error?.code).toBe('WRP_CHAIN_NOT_ADJACENT');
    expect(
      execute(path.doc, 'wrap_to_face', { ...params, face: END, chain: [TOP], placement: { anchor: { chart: [0, 0], on: [30, 0, 0] } } })
        .error?.code,
    ).toBe('WRP_CHAIN_EDGE_CURVED');
    expect(execute(path.doc, 'wrap_to_face', { ...params, face: FRONT, chain: [END], entityIds: ['missing'] }).error?.code).toBe(
      'WRP_ENTITY_NOT_FOUND',
    );
    const far = line(base.doc, [
      [0, 0],
      [0, 90],
    ]);
    expect(execute(far.doc, 'wrap_to_face', { id: base.id, entityIds: [far.id], placement, face: FRONT, chain: [END] }).rejected).toBe(
      true,
    );
  });
});

/** Runs `body` with a fake kernel of `options` installed (and removed after). */
function withFakeKernelOnce(options: FakeWrapOptions, body: () => void): void {
  setGeometryKernel(fakeWrapKernel(options));
  try {
    body();
  } finally {
    setGeometryKernel(null);
  }
}
