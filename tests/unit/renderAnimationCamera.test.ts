/**
 * render_animation camera paths (PHY-22 MOV-M3): saved viewpoint, walkthrough, orbit, the still source. Hand calculations are independent of the code under
 * test: orbit radius and angle per frame, walkthrough interpolation, look-at continuity, and the equality with render_walkthrough (VC-MOV-23).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { setFontProvider } from '@core/commands/fontPort';
import { execute } from '@core/commands/registry';
import { computeSceneSnapshot } from '@core/commands/inspect/scene';
import { makeProjector } from '@core/commands/render/camera';
import { viewProjection, viewProjector } from '@core/commands/render/animation/viewProjector';
import { viewpointView } from '@core/commands/render/viewSetup';
import { boundsCenter, boundsCorners } from '@core/geometry/bounds';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { ViewpointCamera } from '@core/model/review';
import { firaProvider } from './wrap/fixtures';
import { decodePng, fileBytes, pixelAt, planDocument, type AnimationData } from './renderAnimationFixtures';

type V3 = [number, number, number];

const SOUTH = { projection: 'perspective', eye: [0, -50, 10], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 60 } as const;
const EAST = { projection: 'perspective', eye: [50, 0, 10], direction: [-1, 0, 0], up: [0, 0, 1], fovDeg: 40 } as const;
const NORTH = { projection: 'perspective', eye: [0, 80, 10], direction: [0, -1, 0], up: [0, 0, 1], fovDeg: 60 } as const;
const TOP = { projection: 'orthographic', eye: [0, 0, 100], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 40 } as const;

const asCamera = (camera: unknown): ViewpointCamera => camera as ViewpointCamera;

/** `doc` with the cameras saved as viewpoints; the ids come back in order. */
function withViewpoints(
  doc: CadDocument,
  cameras: readonly (typeof SOUTH | typeof EAST | typeof NORTH | typeof TOP)[],
): { doc: CadDocument; ids: string[] } {
  const ids: string[] = [];
  let next = doc;
  for (const camera of cameras) {
    const saved = execute(next, 'save_viewpoint', { name: `view ${ids.length}`, camera });
    ids.push(saved.affected[0] ?? '');
    next = saved.document;
  }
  return { doc: next, ids };
}

/** A static 100 × 20 × 10 box centred at the origin, viewpoints south / east / north and walkthrough [south 2 s, east 1 s] (2 s long). */
function stage(): { doc: CadDocument; ids: string[]; wt: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [100, 20, 10], anchor: 'center' }).document;
  const { doc, ids } = withViewpoints(box, [SOUTH, EAST, NORTH]);
  const walked = execute(doc, 'create_walkthrough', {
    name: 'tour',
    keys: [
      { viewpointId: ids[0], seconds: 2 },
      { viewpointId: ids[1], seconds: 1 },
    ],
  });
  return { doc: walked.document, ids, wt: walked.affected[0] ?? '' };
}

const run = (doc: CadDocument, params: Record<string, unknown>): { data: AnimationData; summary: string } => {
  const result = execute(doc, 'render_animation', { format: 'frames', width: 160, height: 90, fps: 10, ...params });
  return { data: result.data as AnimationData, summary: result.summary };
};

const refused = (doc: CadDocument, params: Record<string, unknown>): string | undefined =>
  execute(doc, 'render_animation', { format: 'frames', width: 160, height: 90, ...params }).error?.code;

const sub = (a: readonly number[], b: readonly number[]): V3 => [
  (a[0] ?? 0) - (b[0] ?? 0),
  (a[1] ?? 0) - (b[1] ?? 0),
  (a[2] ?? 0) - (b[2] ?? 0),
];
const norm = (a: readonly number[]): number => Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
const dotp = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const cameraOf = (data: AnimationData, k: number): AnimationData['camera'] => data.timeline[k]?.camera ?? data.camera;
const still = (duration: number): { kind: 'still'; duration: number } => ({ kind: 'still', duration });

beforeAll(() => setFontProvider(firaProvider()));

describe('walkthrough camera (VC-MOV-23)', () => {
  it('gives at frame k the render_walkthrough camera at t = k / fps: eye, direction and fov by hand', () => {
    const { doc, wt } = stage();
    const { data } = run(doc, { source: still(2), camera: { walkthroughId: wt } });
    expect(data.frames).toBe(21);
    expect(data.cameraMode).toBe('walkthrough');
    for (let k = 0; k <= 20; k += 1) {
      const u = k / 20;
      const camera = cameraOf(data, k);
      const expectedEye = [50 * u, -50 + 50 * u, 10];
      const angle = (u * Math.PI) / 2;
      const expectedDirection = [-Math.sin(angle), Math.cos(angle), 0];
      camera.eye.forEach((c, i) => expect(Math.abs(c - (expectedEye[i] ?? 0))).toBeLessThan(1e-12));
      camera.direction.forEach((c, i) => expect(Math.abs(c - (expectedDirection[i] ?? 0))).toBeLessThan(1e-12));
      expect(Math.abs((camera.fovDeg ?? 0) - (60 - 20 * u))).toBeLessThan(1e-12);
      expect(norm(camera.direction)).toBeCloseTo(1, 12);
    }
    expect(data.camera).toEqual(cameraOf(data, 0));
  });

  it('draws the same pictures as render_walkthrough for the same document, size and fps (frame digests equal, linear and smooth)', () => {
    const { doc, wt } = stage();
    const walked = execute(doc, 'render_walkthrough', { id: wt, fps: 10, width: 160, height: 90 }).data as {
      frameSha256: string[];
      frames: number;
    };
    const { data } = run(doc, { source: still(2), camera: { walkthroughId: wt } });
    expect(data.frames).toBe(walked.frames);
    expect(data.frameSha256).toEqual(walked.frameSha256);
    const smoothWalked = execute(doc, 'render_walkthrough', { id: wt, fps: 10, width: 160, height: 90, path: 'smooth' }).data as {
      frameSha256: string[];
    };
    const smooth = run(doc, { source: still(2), camera: { walkthroughId: wt, path: 'smooth' } });
    expect(smooth.data.frameSha256).toEqual(smoothWalked.frameSha256);
  });

  it('follows the walkthrough in video time while clips move the parts', () => {
    const { document } = planDocument('mov_clip_spin.plan.json');
    const { doc, ids } = withViewpoints(document, [SOUTH, EAST]);
    const walked = execute(doc, 'create_walkthrough', {
      name: 'tour',
      keys: [
        { viewpointId: ids[0], seconds: 2 },
        { viewpointId: ids[1], seconds: 1 },
      ],
    });
    const { data } = run(walked.document, { source: { kind: 'clips', duration: 2 }, camera: { walkthroughId: walked.affected[0] } });
    expect(data.moving.length).toBeGreaterThan(0);
    const mid = cameraOf(data, 10);
    expect(Math.abs((mid.eye[0] ?? 0) - 25)).toBeLessThan(1e-12);
    expect(Math.abs((mid.eye[1] ?? 0) + 25)).toBeLessThan(1e-12);
    expect(data.timeline.every((entry) => entry.camera !== undefined)).toBe(true);
  });

  it('passes through the key eyes of a smooth path at the key times, holds on the last key and warns when the lengths differ', () => {
    const { doc: base, ids } = stage();
    const three = execute(base, 'create_walkthrough', { name: 'three', keys: ids.map((viewpointId) => ({ viewpointId, seconds: 1 })) });
    const id = three.affected[0] ?? '';
    const { data } = run(three.document, { source: still(2), camera: { walkthroughId: id, path: 'smooth' } });
    cameraOf(data, 10).eye.forEach((c, i) => expect(c).toBeCloseTo(EAST.eye[i] ?? 0, 9));
    cameraOf(data, 20).eye.forEach((c, i) => expect(c).toBeCloseTo(NORTH.eye[i] ?? 0, 9));
    expect(data.warnings).toEqual([]);
    const longer = run(three.document, { source: still(3), camera: { walkthroughId: id } });
    expect(longer.data.warnings.map((w) => w.code)).toEqual(['MOV_CAMERA_PATH_DURATION']);
    expect(longer.data.warnings[0]?.message).toContain('holds on the last key');
    expect(cameraOf(longer.data, 30).eye).toEqual(NORTH.eye);
    expect(cameraOf(longer.data, 25).eye).toEqual(NORTH.eye);
    const shorter = run(three.document, { source: still(1), camera: { walkthroughId: id } });
    expect(shorter.data.warnings[0]?.message).toContain('ends before');
  });
});

describe('orbit camera', () => {
  const centre: V3 = [0, 0, 0];
  const sphere = Math.sqrt(100 ** 2 + 20 ** 2 + 10 ** 2) / 2;

  it('keeps the eye at a constant radius and height, turning 2π · turns · k / (frames − 1) about Z (iso, 13 frames)', () => {
    const { data } = run(stage().doc, { source: still(1.2), camera: { orbit: { turns: 1 } } });
    expect(data.frames).toBe(13);
    expect(data.cameraMode).toBe('orbit');
    const iso = [1, -1.4, 1];
    const distance = 2.5 * sphere;
    const horizontal = (distance * Math.hypot(iso[0] ?? 0, iso[1] ?? 0)) / norm(iso);
    const eye0 = cameraOf(data, 0).eye;
    const azimuth0 = Math.atan2(eye0[1] ?? 0, eye0[0] ?? 0);
    expect(Math.atan2(iso[1] ?? 0, iso[0] ?? 0)).toBeCloseTo(azimuth0, 12);
    for (let k = 0; k <= 12; k += 1) {
      const camera = cameraOf(data, k);
      const offset = sub(camera.eye, centre);
      expect(Math.hypot(offset[0], offset[1])).toBeCloseTo(horizontal, 9);
      expect(offset[2]).toBeCloseTo((distance * (iso[2] ?? 0)) / norm(iso), 9);
      const turned = Math.atan2(offset[1], offset[0]) - azimuth0;
      const expected = (2 * Math.PI * k) / 12;
      expect(Math.cos(turned - expected)).toBeCloseTo(1, 9);
      expect(Math.sin(turned - expected)).toBeCloseTo(0, 9);
      expect(camera.viewHeight).toBe(cameraOf(data, 0).viewHeight);
      expect(dotp(camera.direction, camera.up)).toBeCloseTo(0, 12);
    }
    const first = cameraOf(data, 0);
    const last = cameraOf(data, 12);
    first.eye.forEach((c, i) => expect(c).toBeCloseTo(last.eye[i] ?? 0, 9));
    first.direction.forEach((c, i) => expect(c).toBeCloseTo(last.direction[i] ?? 0, 9));
    expect(first.viewHeight).toBeCloseTo(90 / ((0.9 * 90) / (2 * sphere)), 9);
  });

  it('keeps looking at the scene centre (look-at continuity) and every bounds corner inside the image, in every frame', () => {
    const { doc } = stage();
    const { data } = run(doc, { source: still(1.2), camera: { orbit: { turns: 1.5, axis: [0, 0, 1] } } });
    const bounds = computeSceneSnapshot(doc).bounds ?? { min: [0, 0, 0] as V3, max: [0, 0, 0] as V3 };
    const target = boundsCenter(bounds);
    let previous: number[] | null = null;
    let step: number | null = null;
    for (let k = 0; k < data.frames; k += 1) {
      const camera = cameraOf(data, k);
      const toCentre = sub(target, camera.eye);
      expect(dotp(toCentre, camera.direction) / norm(toCentre)).toBeCloseTo(1, 12);
      const view = viewpointView(asCamera(camera), data.width, data.height, target);
      const project = makeProjector(view.camera, view.orthoHalf, data.width, data.height);
      const [cx, cy] = project(target);
      expect(cx).toBeCloseTo(data.width / 2, 6);
      expect(cy).toBeCloseTo(data.height / 2, 6);
      for (const corner of boundsCorners(bounds)) {
        const [x, y] = project(corner);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(data.width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(data.height);
      }
      if (previous !== null) {
        const angle = Math.acos(Math.min(1, dotp(previous, camera.direction)));
        step ??= angle;
        expect(angle).toBeCloseTo(step, 9);
      }
      previous = camera.direction;
    }
    const vertical = 1 / norm([1, -1.4, 1]);
    const turn = (2 * Math.PI * 1.5) / 12;
    expect(step).toBeCloseTo(Math.acos(vertical ** 2 + (1 - vertical ** 2) * Math.cos(turn)), 9);
  });

  it('turns about a given axis (X: front view, quarter turn puts the eye below), backwards for negative turns, and a single frame is not turned', () => {
    const { doc } = stage();
    const x = run(doc, { source: still(1), camera: { view: 'front', orbit: { turns: 0.25, axis: [2, 0, 0] } } });
    const first = cameraOf(x.data, 0);
    const last = cameraOf(x.data, x.data.frames - 1);
    expect(first.eye[1]).toBeCloseTo(-2.5 * sphere, 9);
    expect(last.eye[0]).toBeCloseTo(0, 9);
    expect(last.eye[1]).toBeCloseTo(0, 9);
    expect(last.eye[2]).toBeCloseTo(-2.5 * sphere, 9);
    expect(last.direction[2]).toBeCloseTo(1, 9);
    const back = run(doc, { source: still(1.2), camera: { orbit: { turns: -1 } } });
    const quarter = cameraOf(back.data, 3).eye;
    const start = cameraOf(back.data, 0).eye;
    expect(Math.sin(Math.atan2(quarter[1] ?? 0, quarter[0] ?? 0) - Math.atan2(start[1] ?? 0, start[0] ?? 0))).toBeCloseTo(-1, 9);
    const single = run(doc, { source: still(0.05), camera: { orbit: { turns: 3 } } });
    expect(single.data.frames).toBe(1);
    expect(cameraOf(single.data, 0).eye.every(Number.isFinite)).toBe(true);
  });

  it('with loop turns by 2π · turns · k / frames: the last frame stops one step short of the first and the step is uniform across the wrap', () => {
    const { doc } = stage();
    const { data } = run(doc, { source: still(1.2), camera: { orbit: { turns: 1, loop: true } } });
    expect(data.frames).toBe(13);
    const azimuth = (k: number): number => Math.atan2(cameraOf(data, k).eye[1] ?? 0, cameraOf(data, k).eye[0] ?? 0);
    const step = (2 * Math.PI) / 13;
    for (let k = 0; k < 13; k += 1) {
      const turned = azimuth(k) - azimuth(0);
      expect(Math.cos(turned - step * k)).toBeCloseTo(1, 9);
      expect(Math.sin(turned - step * k)).toBeCloseTo(0, 9);
    }
    const last = cameraOf(data, 12).eye;
    const first = cameraOf(data, 0).eye;
    expect(Math.hypot(...sub(last, first))).toBeGreaterThan(1);
    const wrap = azimuth(0) - azimuth(12);
    expect(Math.cos(wrap - step)).toBeCloseTo(1, 9);
    expect(Math.sin(wrap - step)).toBeCloseTo(0, 9);
    const plain = run(doc, { source: still(1.2), camera: { orbit: { turns: 1 } } });
    expect(cameraOf(plain.data, 12).eye[0]).toBeCloseTo(cameraOf(plain.data, 0).eye[0] ?? 0, 9);
  });

  it('orbits a saved viewpoint about the scene centre, keeping its projection and distance', () => {
    const { doc, ids } = stage();
    const { data } = run(doc, { source: still(1), camera: { viewpointId: ids[0], orbit: { turns: 1 } } });
    for (let k = 0; k < data.frames; k += 1) {
      const camera = cameraOf(data, k);
      expect(camera.fovDeg).toBe(60);
      expect(norm(sub(camera.eye, centre))).toBeCloseTo(norm(SOUTH.eye), 9);
    }
    expect(cameraOf(data, 0).eye).toEqual([0, -50, 10]);
  });

  it('draws the trace dot where the camera of its own frame projects the traced point, and a sheet (moving camera + clips)', () => {
    const { document } = planDocument('mov_clip_spin.plan.json');
    const box = document.order[0] ?? '';
    const { data } = run(document, {
      source: { kind: 'clips', duration: 2 },
      width: 320,
      height: 240,
      camera: { orbit: { turns: 0.5 } },
      overlays: { trace: [box], time: true },
      sheet: { every: 5 },
    });
    expect(data.sheet?.frames).toEqual([0, 5, 10, 15, 20]);
    const trace = Object.values(data.traces ?? {})[0];
    for (const k of [0, 6, 13, 20]) {
      const view = viewpointView(asCamera(cameraOf(data, k)), 320, 240, [0, 0, 0]);
      const [px, py] = makeProjector(view.camera, view.orthoHalf, 320, 240)(trace?.at[k] as V3);
      const image = decodePng(fileBytes(data, `frame-${String(k + 1).padStart(4, '0')}.png`));
      expect(pixelAt(image, px, py).slice(0, 3)).toEqual([255, 210, 74]);
    }
    expect(fileBytes(data, 'sheet.png').length).toBeGreaterThan(0);
  });
});

describe('viewpoint camera', () => {
  it('draws a moving mechanism through the saved orthographic camera, exactly as saved in every frame', () => {
    const { document } = planDocument('mov_clip_spin.plan.json');
    const { doc, ids } = withViewpoints(document, [TOP]);
    const { data } = run(doc, { source: { kind: 'clips', duration: 1 }, camera: { viewpointId: ids[0] } });
    expect(data.cameraMode).toBe('viewpoint');
    expect(data.camera).toEqual({ projection: 'orthographic', eye: [0, 0, 100], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 40 });
    expect(data.timeline.every((entry) => entry.camera === undefined)).toBe(true);
  });

  it('draws the trace dot of a perspective viewpoint at the pinhole projection (focal = h / 2 / tan(fov / 2))', () => {
    const { document } = planDocument('mov_clip_spin.plan.json');
    const box = document.order[0] ?? '';
    const above = { projection: 'perspective', eye: [0, 0, 400], direction: [0, 0, -1], up: [0, 1, 0], fovDeg: 60 } as const;
    const saved = execute(document, 'save_viewpoint', { name: 'above', camera: above });
    const { data } = run(saved.document, {
      source: { kind: 'clips', duration: 2 },
      width: 320,
      height: 240,
      camera: { viewpointId: saved.affected[0] },
      overlays: { trace: [box] },
    });
    const at = Object.values(data.traces ?? {})[0]?.at[5] as V3;
    const focal = 240 / 2 / Math.tan(Math.PI / 6);
    const depth = 400 - at[2];
    const x = 160 + (at[0] * focal) / depth;
    const y = 120 - (at[1] * focal) / depth;
    const image = decodePng(fileBytes(data, 'frame-0006.png'));
    expect(pixelAt(image, x, y).slice(0, 3)).toEqual([255, 210, 74]);
  });
});

describe('viewProjection (perspective near plane)', () => {
  const persp = viewpointView(asCamera(SOUTH), 200, 100, [0, 0, 0]);

  it('splits a path that crosses the eye plane into runs of finite pixels and hides the points behind the eye', () => {
    const { runs, visible } = viewProjection(persp, 200, 100);
    const front: V3 = [0, 0, 10];
    const behind: V3 = [0, -100, 10];
    expect(visible(front)).toBe(true);
    expect(visible(behind)).toBe(false);
    const crossing = runs([front, behind, front, front]);
    expect(crossing).toHaveLength(2);
    expect(crossing.map((run) => run.length)).toEqual([2, 3]);
    for (const [x, y] of crossing.flat()) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(Math.abs(x - 100)).toBeLessThan(1e-6);
    }
    expect(runs([behind, behind])).toEqual([]);
    const off = runs([
      [10, 0, 10],
      [10, -100, 10],
    ]);
    expect(off).toHaveLength(1);
    for (const [x, y] of off.flat()) {
      expect(x).toBeGreaterThanOrEqual(-8 - 1e-9);
      expect(x).toBeLessThanOrEqual(208 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-8 - 1e-9);
      expect(y).toBeLessThanOrEqual(108 + 1e-9);
    }
    expect(runs([front, front])).toHaveLength(1);
    const ortho = viewProjection(viewpointView(asCamera(TOP), 200, 100, [0, 0, 0]), 200, 100);
    expect(ortho.runs([front, behind])).toHaveLength(1);
    expect(ortho.visible(behind)).toBe(true);
  });

  it('draws a trace that crosses the eye plane without a segment across the frame (render_animation, camera beside the trace circle, looking across it)', () => {
    const { document } = planDocument('mov_clip_spin.plan.json');
    const box = document.order[0] ?? '';
    const inside = { projection: 'perspective', eye: [0, -130, 0], direction: [1, 0, 0], up: [0, 0, 1], fovDeg: 60 } as const;
    const saved = execute(document, 'save_viewpoint', { name: 'inside', camera: inside });
    const result = execute(saved.document, 'render_animation', {
      source: { kind: 'clips', duration: 2 },
      fps: 10,
      width: 160,
      height: 90,
      format: 'frames',
      camera: { viewpointId: saved.affected[0] },
      overlays: { trace: [box] },
    });
    expect(result.error).toBeUndefined();
    const data = result.data as AnimationData;
    const at = Object.values(data.traces ?? {})[0]?.at ?? [];
    expect(at.some((point) => (point[0] ?? 0) < 0)).toBe(true);
    expect(at.some((point) => (point[0] ?? 0) > 0)).toBe(true);
    const frame = (k: number): ReturnType<typeof decodePng> => decodePng(fileBytes(data, `frame-${String(k + 1).padStart(4, '0')}.png`));
    const yellow = (image: ReturnType<typeof decodePng>): number => {
      let count = 0;
      for (let i = 0; i < image.rgba.length; i += 4)
        if (image.rgba[i] === 255 && image.rgba[i + 1] === 210 && image.rgba[i + 2] === 74) count += 1;
      return count;
    };
    const behindFrame = at.findIndex((point) => (point[0] ?? 0) < -25);
    expect(behindFrame).toBeGreaterThanOrEqual(0);
    expect(yellow(frame(behindFrame))).toBeLessThan(160 * 90 * 0.05);
  });
});

describe('viewProjector', () => {
  it('equals makeProjector for an orthographic view and the pinhole formula for a perspective one; behind the eye is pinned, not mirrored', () => {
    const ortho = viewpointView(asCamera(TOP), 200, 100, [0, 0, 0]);
    const point: V3 = [3, 4, 5];
    expect(viewProjector(ortho, 200, 100)(point)).toEqual(makeProjector(ortho.camera, ortho.orthoHalf, 200, 100)(point));
    const persp = viewpointView(asCamera(SOUTH), 200, 100, [0, 0, 0]);
    const focal = 50 / Math.tan(Math.PI / 6);
    const [x, y] = viewProjector(persp, 200, 100)([10, 0, 10]);
    expect(x).toBeCloseTo(100 + (10 * focal) / 50, 9);
    expect(y).toBeCloseTo(50, 9);
    const [behind] = viewProjector(persp, 200, 100)([10, -100, 10]);
    expect(Number.isFinite(behind)).toBe(true);
    expect(behind).toBeGreaterThan(100);
  });
});

describe('still source and refusals', () => {
  it('refuses a still source with a fixed camera, with overlays that name quantities, or an empty document (MOV_NO_MOTION / MOV_UNKNOWN_ID)', () => {
    const { doc } = stage();
    expect(refused(doc, { source: still(1) })).toBe('MOV_NO_MOTION');
    expect(refused(doc, { source: still(1), camera: { view: 'top' } })).toBe('MOV_NO_MOTION');
    expect(refused(doc, { source: still(1), camera: { orbit: { turns: 1 } }, overlays: { trace: ['box-1'] } })).toBe('MOV_UNKNOWN_ID');
    expect(refused(doc, { source: still(1), camera: { orbit: { turns: 1 } }, overlays: { readouts: ['x'] } })).toBe('MOV_UNKNOWN_ID');
    expect(refused(createEmptyDocument(), { source: still(1), camera: { orbit: { turns: 1 } } })).toBe('MOV_NO_MOTION');
  });

  it('refuses a saved viewpoint camera on a still source (nothing changes between frames)', () => {
    const { doc, ids } = stage();
    expect(refused(doc, { source: still(1), camera: { viewpointId: ids[0] } })).toBe('MOV_NO_MOTION');
  });

  it('refuses illegal camera combinations and bad values with MOV_CAMERA_INVALID, leaving the document unchanged', () => {
    const { doc, wt, ids } = stage();
    const bad = (camera: Record<string, unknown>): string | undefined => refused(doc, { source: still(1), camera });
    const vp = ids[0];
    expect(bad({ viewpointId: vp, view: 'top', orbit: { turns: 1 } })).toBe('MOV_CAMERA_INVALID');
    expect(bad({ viewpointId: vp, direction: [0, 0, 1], orbit: { turns: 1 } })).toBe('MOV_CAMERA_INVALID');
    expect(bad({ walkthroughId: wt, viewpointId: vp })).toBe('MOV_CAMERA_INVALID');
    expect(bad({ walkthroughId: wt, view: 'top' })).toBe('MOV_CAMERA_INVALID');
    expect(bad({ walkthroughId: wt, orbit: { turns: 1 } })).toBe('MOV_CAMERA_INVALID');
    expect(bad({ path: 'smooth', orbit: { turns: 1 } })).toBe('MOV_CAMERA_INVALID');
    expect(bad({ orbit: { turns: 0 } })).toBe('MOV_CAMERA_INVALID');
    expect(bad({ orbit: { turns: 101 } })).toBe('MOV_CAMERA_INVALID');
    expect(bad({ orbit: { turns: 1, axis: [0, 0, 0] } })).toBe('MOV_CAMERA_INVALID');
    expect(bad({ direction: [0, 0, 0], orbit: { turns: 1 } })).toBe('MOV_CAMERA_INVALID');
    const result = execute(doc, 'render_animation', { source: still(1), camera: { orbit: { turns: 0 } } });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('MOV_CAMERA_INVALID');
  });

  it('refuses a walkthrough with a key span of zero or negative seconds (no NaN camera)', () => {
    const { doc, wt } = stage();
    const review = doc.review;
    const walkthrough = review?.walkthroughs[wt];
    expect(walkthrough).toBeDefined();
    for (const seconds of [0, -1]) {
      const keys = (walkthrough?.keys ?? []).map((key, i) => (i === 0 ? { ...key, seconds } : key));
      const broken = {
        ...doc,
        review:
          review === undefined || walkthrough === undefined ? review : { ...review, walkthroughs: { [wt]: { ...walkthrough, keys } } },
      } as CadDocument;
      const result = execute(broken, 'render_animation', { source: still(1), camera: { walkthroughId: wt } });
      expect(result.error?.code).toBe('MOV_CAMERA_INVALID');
      expect(result.document).toBe(broken);
    }
  });

  it('refuses unknown viewpoint / walkthrough ids (listing them), hostile keys, and a walkthrough whose viewpoint is gone', () => {
    const { doc, wt, ids } = stage();
    const unknown = execute(doc, 'render_animation', { source: still(1), camera: { viewpointId: 'vp-99' } });
    expect(unknown.error).toMatchObject({ code: 'MOV_UNKNOWN_ID', ids: ['vp-99'] });
    expect(refused(doc, { source: still(1), camera: { walkthroughId: 'wt-99' } })).toBe('MOV_UNKNOWN_ID');
    for (const hostile of ['__proto__', 'constructor', 'toString']) {
      expect(['MOV_UNKNOWN_ID', 'CMD_RESERVED_ID']).toContain(refused(doc, { source: still(1), camera: { viewpointId: hostile } }));
      expect(['MOV_UNKNOWN_ID', 'CMD_RESERVED_ID']).toContain(refused(doc, { source: still(1), camera: { walkthroughId: hostile } }));
    }
    const review = doc.review;
    expect(review).toBeDefined();
    const gone = ids[1] ?? '';
    const viewpoints = Object.fromEntries(Object.entries(review?.viewpoints ?? {}).filter(([id]) => id !== gone));
    const broken = { ...doc, review: review === undefined ? review : { ...review, viewpoints } } as CadDocument;
    const missing = execute(broken, 'render_animation', { source: still(1), camera: { walkthroughId: wt } });
    expect(missing.error).toMatchObject({ code: 'MOV_UNKNOWN_ID', ids: [gone] });
  });
});

describe('determinism and purity', () => {
  it('gives identical frame digests twice and leaves the document untouched, for walkthrough and orbit paths', () => {
    const { doc, wt } = stage();
    const before = JSON.stringify(doc);
    for (const camera of [{ walkthroughId: wt }, { orbit: { turns: 1 } }]) {
      const params = { source: still(1), camera, format: 'apng' };
      const a = run(doc, params).data;
      const b = run(doc, params).data;
      expect(a.frameSha256).toEqual(b.frameSha256);
      expect(a.fileSha256).toBe(b.fileSha256);
      expect(new Set(a.frameSha256).size).toBeGreaterThan(1);
    }
    expect(JSON.stringify(doc)).toBe(before);
    const result = execute(doc, 'render_animation', {
      source: still(1),
      camera: { orbit: { turns: 1 } },
      format: 'frames',
      width: 64,
      height: 64,
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('keeps the contents of timeline.json (with the per-frame cameras) equal to data.timeline', () => {
    const { data } = run(stage().doc, { source: still(0.5), camera: { orbit: { turns: 1 } } });
    const file = JSON.parse(new TextDecoder().decode(fileBytes(data, 'timeline.json'))) as { timeline: unknown };
    expect(file.timeline).toEqual(JSON.parse(JSON.stringify(data.timeline)));
  });
});
