/** 09 VIS-M8c: render_walkthrough `path: 'smooth'` (Catmull-Rom eye through the keys) next to the default linear glide. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { ViewpointCamera } from '@core/model/review';
import { interpolateViewpointCamera, interpolateViewpointCameraSmooth } from '@core/geometry/viewpointCamera';
import { apply, expectRefusal } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';

const camera = (eye: [number, number, number]): ViewpointCamera => ({
  projection: 'perspective',
  eye,
  direction: [0, 1, 0],
  up: [0, 0, 1],
  fovDeg: 50,
});

/** Three keys on an L-shaped route (the middle key is a corner), 1 s apart. */
function routed(): CadDocument {
  let doc = apply(createEmptyDocument(), 'add_box', { size: [20, 10, 8], color: '#d04020' });
  for (const [name, eye] of [
    ['start', [-60, -60, 20]],
    ['corner', [60, -60, 20]],
    ['end', [60, 60, 20]],
  ] as const)
    doc = apply(doc, 'save_viewpoint', { name, camera: { projection: 'perspective', eye, direction: [0, 1, -0.2], fovDeg: 50 } });
  const keys = ['vp-1', 'vp-2', 'vp-3'].map((viewpointId) => ({ viewpointId, seconds: 1 }));
  return apply(doc, 'create_walkthrough', { name: 'L', keys });
}

interface Frames {
  frames: number;
  path: string;
  frameSha256: string[];
}
const render = (doc: CadDocument, extra: Record<string, unknown> = {}): Frames => {
  const result = execute(doc, 'render_walkthrough', { id: 'wt-4', fps: 2, width: 64, height: 48, ...extra });
  expect(result.error, result.summary).toBeUndefined();
  return result.data as Frames;
};

describe('interpolateViewpointCameraSmooth', () => {
  const [a, b, c, d] = [camera([0, 10, 0]), camera([10, 0, 0]), camera([10, 10, 0]), camera([20, 10, 0])];

  it('starts at a, ends at b and bends toward the neighbours', () => {
    expect(interpolateViewpointCameraSmooth(undefined, b, c, d, 0).eye).toEqual([10, 0, 0]);
    const end = interpolateViewpointCameraSmooth(undefined, a, b, c, 1).eye;
    expect(end[0]).toBeCloseTo(10, 9);
    expect(end[1]).toBeCloseTo(0, 9);
    const mid = interpolateViewpointCameraSmooth(a, b, c, d, 0.5).eye;
    expect(mid[0]).toBeCloseTo(10, 9);
    expect(mid[1]).toBeCloseTo(4.375, 9);
    expect(mid).not.toEqual(interpolateViewpointCamera(b, c, 0.5).eye);
  });

  it('equals the linear glide for evenly spaced collinear keys and keeps direction / fov linear', () => {
    const [p, q, r, s] = [camera([0, 0, 0]), camera([1, 0, 0]), camera([2, 0, 0]), camera([3, 0, 0])];
    const smooth = interpolateViewpointCameraSmooth(p, q, r, s, 0.25);
    const linear = interpolateViewpointCamera(q, r, 0.25);
    smooth.eye.forEach((value, i) => expect(value).toBeCloseTo(linear.eye[i] ?? NaN, 12));
    expect({ ...smooth, eye: linear.eye }).toEqual(linear);
  });
});

describe('render_walkthrough path', () => {
  it('defaults to linear, reports the path, and smooth bends the middle frames only', () => {
    const doc = routed();
    const linear = render(doc);
    expect(linear).toMatchObject({ frames: 5, path: 'linear' });
    expect(render(doc, { path: 'linear' }).frameSha256).toEqual(linear.frameSha256);
    const smooth = render(doc, { path: 'smooth' });
    expect(smooth).toMatchObject({ frames: 5, path: 'smooth' });
    expect(smooth.frameSha256[0]).toBe(linear.frameSha256[0]);
    expect(smooth.frameSha256[1]).not.toBe(linear.frameSha256[1]);
    expect(smooth.frameSha256.slice(1)).not.toEqual(linear.frameSha256.slice(1));
    expect(render(doc, { path: 'smooth' }).frameSha256).toEqual(smooth.frameSha256);
  });

  it('keeps the frame count, budget and native refusals, rejects an unknown path, and is pure', () => {
    const doc = routed();
    const code = (extra: Record<string, unknown>): string | undefined =>
      execute(doc, 'render_walkthrough', { id: 'wt-4', ...extra }).error?.code;
    expect(code({ path: 'smooth', fps: 30, maxFrames: 10 })).toBe('VIS_WALKTHROUGH_INVALID');
    expect(code({ path: 'smooth', fps: 30, width: 2000, height: 2000 })).toBe('VIS_RENDER_BUDGET');
    expect(code({ path: 'smooth', renderer: 'native' })).toBe('NATIVE_TOOL_MISSING');
    expectRefusal(doc, 'render_walkthrough', { id: 'wt-4', path: 'spline' }, 'CMD_INVALID_PARAMS');
    expectPure(doc, () => execute(doc, 'render_walkthrough', { id: 'wt-4', path: 'smooth', width: 64, height: 48 }));
  });
});

describe('render_walkthrough material class shading (VIS-M8h)', () => {
  it('draws the Blinn-Phong highlight of an assigned class on the reference raster (a class with no colour still changes the frames)', () => {
    const doc = routed();
    const shiny = apply(
      apply(doc, 'define_material_class', { id: 'sheen', colour: null, metalness: 1, roughness: 1 }),
      'assign_material_class',
      { entityIds: [doc.order[0] as string], classId: 'sheen' },
    );
    expect(render(shiny).frameSha256).not.toEqual(render(doc).frameSha256);
    expect(render(shiny).frameSha256).toEqual(render(shiny).frameSha256);
  });
});
