/**
 * 03 WRP M5 on the native OCCT kernel: emboss / deboss with walls along a pull direction and a draft (VC-WRP-25 / 26). VC-25: a 30 x 10 rectangle on r 20, pull +x, depths 0.5 / 1 / 2 add
 * 149.562188 / 298.308583 / 593.663229 mm3 (the circular-segment integral of docs/design/03-wrap-emboss/validation/data/pull_and_geodesic.json). Skipped when the llull-kernel
 * binary (with the `emboss` capability) is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { setFontProvider } from '@core/commands/fontPort';
import { createFontProvider } from '../src/fontProvider';
import { dataset } from './wrapSupport';

type Run = ReturnType<typeof execute>;
const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP walls' })('WRP pull walls and draft on the native OCCT kernel', () => {
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

  const base = (): CadDocument => ({ ...createEmptyDocument(), units: 'mm' });
  const must = (doc: CadDocument, name: string, params: Record<string, unknown>): Run => {
    const result = execute(doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    return result;
  };
  const volumeOf = (done: Run): number => (done.data as { volumeDelta: number }).volumeDelta;
  const cylinderRect = (width = 30, height = 10): { doc: CadDocument; id: string; sketch: string } => {
    const body = must(base(), 'add_cylinder', { radius: 20, height: 40 });
    const sketch = must(body.document, 'draw_rectangle', { width, height, position: [-width / 2, -height / 2, 0] });
    return { doc: sketch.document, id: body.affected[0] as string, sketch: sketch.affected[0] as string };
  };
  const placement = { anchor: { chart: [0, 0], on: [20, 0, 0] } };

  it('VC-WRP-25: pull +x on r 20, rectangle 30 x 10: 149.562 / 298.309 / 593.663 mm3 (normal walls add 151.875 / 307.5 / 630)', () => {
    const reference = dataset<{ pullDirectionEmboss: { cases: Array<{ depth: number; volume: number; normalWallVolume: number }> } }>(
      'pull_and_geodesic',
    ).pullDirectionEmboss.cases;
    for (const expected of reference) {
      const { doc, id, sketch } = cylinderRect();
      const pulled = must(doc, 'emboss_on_face', {
        id,
        face: { faceNear: [20, 0, 0] },
        profileIds: [sketch],
        mode: 'emboss',
        depth: expected.depth,
        walls: 'pull',
        pullDirection: [1, 0, 0],
        placement,
      });
      expect(relative(volumeOf(pulled), expected.volume), `depth ${expected.depth}`).toBeLessThan(1e-6);
      expect((pulled.data as { walls: string }).walls).toBe('pull');
      const normal = must(doc, 'emboss_on_face', {
        id,
        face: { faceNear: [20, 0, 0] },
        profileIds: [sketch],
        mode: 'emboss',
        depth: expected.depth,
        placement,
      });
      expect(relative(volumeOf(normal), expected.normalWallVolume)).toBeLessThan(1e-6);
    }
  });

  const topRect = (width: number, height: number): { doc: CadDocument; id: string; sketch: string } => {
    const body = must(base(), 'add_box', { size: [60, 40, 10] });
    const sketch = must(body.document, 'draw_rectangle', { width, height, position: [-width / 2, -height / 2, 5] });
    return { doc: sketch.document, id: body.affected[0] as string, sketch: sketch.affected[0] as string };
  };
  const onTop = { faceNear: [0, 0, 5] };
  const topPlacement = { anchor: { chart: [0, 0], on: [0, 0, 5] } };
  /** w l d - (w + l) t d^2 + 4/3 t^2 d^3: the rectangle w x l narrowed by t = tan(draft) per unit of height. */
  const taper = (w: number, l: number, d: number, degrees: number): number => {
    const t = Math.tan((degrees * Math.PI) / 180);
    return w * l * d - (w + l) * t * d * d + (4 / 3) * t * t * d ** 3;
  };

  it('VC-WRP-26: a 20 x 10 rectangle on a plane, depth 2, draft 10 degrees: w l d - (w + l) t d^2 + 4/3 t^2 d^3, the walls leaning inward with height', () => {
    for (const mode of ['emboss', 'deboss'] as const) {
      const { doc, id, sketch } = topRect(20, 10);
      const done = must(doc, 'emboss_on_face', {
        id,
        face: onTop,
        profileIds: [sketch],
        mode,
        depth: 2,
        walls: 'pull',
        pullDirection: [0, 0, 1],
        draftDeg: 10,
        placement: topPlacement,
      });
      const expected = taper(20, 10, 2, 10);
      expect(relative(Math.abs(volumeOf(done)), expected), mode).toBeLessThan(1e-6);
      expect((done.data as { draftedWalls: number; draftDeg: number }).draftedWalls).toBe(4);
    }
    const straight = must(topRect(20, 10).doc, 'emboss_on_face', {
      id: 'box-1.1',
      face: onTop,
      profileIds: ['rect-2.1'],
      mode: 'emboss',
      depth: 2,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      placement: topPlacement,
    });
    expect(relative(volumeOf(straight), 400)).toBeLessThan(1e-9);
  });

  /** Simpson's rule of f over [a, b]. */
  const simpson = (f: (x: number) => number, a: number, b: number, n = 20000): number => {
    const h = (b - a) / n;
    let sum = f(a) + f(b);
    for (let k = 1; k < n; k++) sum += f(a + k * h) * (k % 2 === 0 ? 2 : 4);
    return (sum * h) / 3;
  };

  it('a draft on the cylinder (pull +x, hinged on the plane x = 20 through the anchor): the volume is the integral of the narrowing relief, emboss and deboss', () => {
    const r = 20;
    const y0 = r * Math.sin(0.75);
    const t = Math.tan((5 * Math.PI) / 180);
    const d = 1;
    const embossReference = simpson(
      (y) => {
        const lo = Math.sqrt(r * r - y * y);
        const hi = Math.min(Math.sqrt((r + d) ** 2 - y * y), 20 + (y0 - Math.abs(y)) / t);
        const h = (x: number): number => 2 * (5 * (x - 20) - (t * (x - 20) ** 2) / 2);
        return hi > lo ? h(hi) - h(lo) : 0;
      },
      -y0 - 0.5,
      y0 + 0.5,
    );
    const debossReference = simpson(
      (y) => {
        const hi = Math.sqrt(r * r - y * y);
        const lo = Math.max(Math.sqrt((r - d) ** 2 - y * y), 20 - (y0 - Math.abs(y)) / t);
        const h = (x: number): number => 2 * (5 * (20 - x) - (t * (20 - x) ** 2) / 2);
        return hi > lo ? h(lo) - h(hi) : 0;
      },
      -y0 - 0.5,
      y0 + 0.5,
    );
    for (const [mode, reference] of [
      ['emboss', embossReference],
      ['deboss', debossReference],
    ] as const) {
      const { doc, id, sketch } = cylinderRect();
      const done = must(doc, 'emboss_on_face', {
        id,
        face: { faceNear: [20, 0, 0] },
        profileIds: [sketch],
        mode,
        depth: d,
        walls: 'pull',
        pullDirection: [1, 0, 0],
        draftDeg: 5,
        placement,
      });
      expect(relative(Math.abs(volumeOf(done)), reference), mode).toBeLessThan(1e-4);
    }
  });

  it('an oblique pull on a plane keeps the volume A d (the prism is sheared, the layer is the same), and a sphere with a pull along its axis follows the closed form of the cap', () => {
    const { doc, id, sketch } = topRect(20, 10);
    const oblique = must(doc, 'emboss_on_face', {
      id,
      face: onTop,
      profileIds: [sketch],
      mode: 'emboss',
      depth: 2,
      walls: 'pull',
      pullDirection: [1, 0, 1],
      placement: topPlacement,
    });
    expect(relative(volumeOf(oblique), 400)).toBeLessThan(1e-9);
    const ball = must(base(), 'add_sphere', { radius: 25 });
    const disc = must(ball.document, 'draw_arc', { radius: 5, center: [0, 0] });
    const R = 25;
    const rho0 = R * Math.sin(5 / R);
    const depth = 1;
    const cap = ((2 * Math.PI) / 3) * ((R + depth) ** 3 - ((R + depth) ** 2 - rho0 ** 2) ** 1.5 - R ** 3 + (R * R - rho0 ** 2) ** 1.5);
    const done = must(disc.document, 'emboss_on_face', {
      id: ball.affected[0],
      face: { faceNear: [0, 0, 25] },
      profileIds: [disc.affected[0]],
      mode: 'emboss',
      depth,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      placement: { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, 25] } },
    });
    expect(relative(volumeOf(done), cap)).toBeLessThan(1e-3);
  });

  it('a bore (material outside the face): pull +x on the wall of an r 10 hole adds the shell r - d .. r inside the prism, 6 x 10 region, closed form 2 h (F(r) - F(r - d))', () => {
    const block = must(base(), 'add_box', { size: [60, 60, 20] });
    const pin = must(block.document, 'add_cylinder', { radius: 10, height: 40 });
    const holed = must(pin.document, 'boolean', { op: 'subtract', a: block.affected[0], b: pin.affected[0] });
    const sketch = must(holed.document, 'draw_rectangle', { width: 10, height: 6, position: [-5, -3, 0] });
    const r = 10;
    const d = 1;
    const y0 = r * Math.sin(0.5);
    const F = (R: number): number => (y0 * Math.sqrt(R * R - y0 * y0) + R * R * Math.asin(y0 / R)) / 2;
    const expected = 2 * 6 * (F(r) - F(r - d));
    const done = must(sketch.document, 'emboss_on_face', {
      id: holed.affected[0],
      face: { faceNear: [10, 0, 0] },
      profileIds: [sketch.affected[0]],
      mode: 'emboss',
      depth: d,
      walls: 'pull',
      pullDirection: [1, 0, 0],
      placement: { anchor: { chart: [0, 0], on: [10, 0, 0] } },
    });
    expect(relative(volumeOf(done), expected)).toBeLessThan(2e-4);
    const cut = must(sketch.document, 'emboss_on_face', {
      id: holed.affected[0],
      face: { faceNear: [10, 0, 0] },
      profileIds: [sketch.affected[0]],
      mode: 'deboss',
      depth: d,
      walls: 'pull',
      pullDirection: [1, 0, 0],
      placement: { anchor: { chart: [0, 0], on: [10, 0, 0] } },
    });
    expect(relative(-volumeOf(cut), 2 * 6 * (F(r + d) - F(r)))).toBeLessThan(2e-4);
  });

  it('text with holes: the O of Fira Sans pulled along z on a plane adds A d (the prism of the outline minus the prism of its hole)', () => {
    const body = must(base(), 'add_box', { size: [60, 40, 10] });
    const text = must(body.document, 'add_text', { content: 'O', position: [0, 0, 5], height: 8, font: 'Fira Sans', anchor: 'center' });
    const done = must(text.document, 'emboss_on_face', {
      id: body.affected[0],
      face: onTop,
      profileIds: [text.affected[0]],
      mode: 'emboss',
      depth: 1,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      placement: topPlacement,
    });
    const info = done.data as {
      regionArea: number;
      volumeDelta: number;
      footprintSize: number;
      footprintDeviation: number;
      exact: boolean;
    };
    expect(info.footprintSize).toBeGreaterThan(10);
    expect(info.footprintDeviation).toBeGreaterThan(0);
    expect(info.footprintDeviation).toBeLessThanOrEqual(1e-4);
    expect(info.exact).toBe(false);
    expect(relative(info.volumeDelta, info.regionArea)).toBeLessThan(1e-3);
  });

  it('check_wrap counts a pull relief on the real kernel: the volume is skipped with a warning and the direction (emboss adds) is checked', () => {
    const body = must(base(), 'add_box', { size: [60, 40, 10] });
    const sketch = must(body.document, 'draw_rectangle', { width: 20, height: 10, position: [-10, -5, 5] });
    const done = must(sketch.document, 'emboss_on_face', {
      id: body.affected[0],
      face: onTop,
      profileIds: [sketch.affected[0]],
      mode: 'emboss',
      depth: 2,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      placement: topPlacement,
    });
    const report = must(done.document, 'check_wrap', {}).data as {
      status: string;
      checked: { ids: number; reliefsWithoutClosedForm: number };
      findings: Array<{ code: string }>;
    };
    expect(report.checked).toMatchObject({ ids: 1, reliefsWithoutClosedForm: 1 });
    expect(report.findings.map((finding) => finding.code)).toContain('WRP_CHECK_VOLUME_SKIPPED');
    expect(report.findings.map((finding) => finding.code)).not.toContain('WRP_CHECK_VOLUME_MISMATCH');
  });

  it('refuses by code: a pull along the face, a pull folding over the region, a draft that closes the profile, and invalid combinations', () => {
    const { doc, id, sketch } = cylinderRect();
    const params = {
      id,
      face: { faceNear: [20, 0, 0] },
      profileIds: [sketch],
      mode: 'emboss',
      depth: 1,
      walls: 'pull',
      pullDirection: [1, 0, 0],
      placement,
    };
    const codeOf = (extra: Record<string, unknown>): string | undefined =>
      execute(doc, 'emboss_on_face', { ...params, ...extra }).error?.code;
    expect(codeOf({ pullDirection: [0, 1, 0] })).toBe('WRP_PULL_PARALLEL');
    const wide = cylinderRect(70, 10);
    expect(execute(wide.doc, 'emboss_on_face', { ...params, id: wide.id, profileIds: [wide.sketch] }).error?.code).toBe(
      'WRP_PULL_PARALLEL',
    );
    const flat = topRect(20, 10);
    const closes = execute(flat.doc, 'emboss_on_face', {
      id: flat.id,
      face: onTop,
      profileIds: [flat.sketch],
      mode: 'emboss',
      depth: 20,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      draftDeg: 20,
      placement: topPlacement,
    });
    expect(closes.error?.code).toBe('WRP_DRAFT_CLOSES');
    expect(closes.summary).toContain('largest draft');
    expect(codeOf({ pullDirection: undefined })).toBe('WRP_PARAM_INVALID');
    expect(codeOf({ mode: 'scribe', depth: undefined })).toBe('WRP_PARAM_INVALID');
    expect(codeOf({ walls: undefined, draftDeg: 5 })).toBe('WRP_PARAM_INVALID');
    expect(codeOf({ draftDeg: 60 })).toBe('WRP_PARAM_INVALID');
    expect(execute(doc, 'emboss_on_face', { ...params, pullDirection: [0, 0, 0] }).error?.code).toBe('WRP_PARAM_INVALID');
  });

  it('replay_history rebuilds a pull relief to the same solid', () => {
    const { doc, id, sketch } = topRect(20, 10);
    const done = must(doc, 'emboss_on_face', {
      id,
      face: onTop,
      profileIds: [sketch],
      mode: 'emboss',
      depth: 2,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      draftDeg: 10,
      placement: topPlacement,
    });
    const replayed = must(done.document, 'replay_history', {});
    expect(JSON.stringify(replayed.document.entities)).toBe(JSON.stringify(done.document.entities));
  });
});
