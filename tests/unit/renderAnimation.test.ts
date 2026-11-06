/**
 * render_animation, the sources that need no physics engine (PHY-22 MOV-M1): clips, sweep, the time base, camera, budgets, refusals, overlays, highlight,
 * contact sheet, native pixel stage, purity. The simulation source is in renderAnimationSimulation.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { setFontProvider } from '@core/commands/fontPort';
import { execute } from '@core/commands/registry';
import { documentAtAnimation } from '@core/geometry/animationPose';
import { boundsCorners } from '@core/geometry/bounds';
import { computeSceneSnapshot } from '@core/commands/inspect/scene';
import { rasterScenePixels } from '@core/commands/render/raster';
import { frameCountOf } from '@core/commands/render/animation/timeline';
import { sheetFrames } from '@core/commands/render/animation/sheet';
import type { RasterPort, RasterScene } from '@core/model/raster';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { firaProvider } from './wrap/fixtures';
import { decodePng, fileBytes, fourBar, pixelAt, pixelOf, planDocument, readJson, type AnimationData } from './renderAnimationFixtures';

interface Expected {
  cases: { id: string; value: unknown; unit: string }[];
}
interface Reference {
  spinClip: { fps: number; frames: number; samples: { frame: number; angleRad: number; centreMm: [number, number] }[] };
}
const expected = readJson<Expected>('expected_results.json').cases;
const reference = readJson<Reference>('mov_reference.json');

/** The default frame background #1a1a2e. */
const isBackground = (rgba: number[]): boolean =>
  Math.abs((rgba[0] ?? 0) - 26) < 3 && Math.abs((rgba[1] ?? 0) - 26) < 3 && Math.abs((rgba[2] ?? 0) - 46) < 3;

const spin = (): { document: CadDocument; box: string; params: Record<string, unknown> } => {
  const { document, render } = planDocument('mov_clip_spin.plan.json');
  return { document, box: document.order[0] ?? '', params: render.params };
};

const run = (doc: CadDocument, params: Record<string, unknown>): { data: AnimationData; summary: string } => {
  const result = execute(doc, 'render_animation', params);
  return { data: result.data as AnimationData, summary: result.summary };
};

beforeAll(() => setFontProvider(firaProvider()));

describe('time base (TR-MOV-01, VC-MOV-11)', () => {
  it('counts frames as floor(duration · fps / playbackRate + 1e-9) + 1', () => {
    expect(frameCountOf(1.01, 24, 1)).toBe(25);
    expect(frameCountOf(0.0628318530718, 30, 0.01)).toBe(189);
    expect(frameCountOf(2, 10, 1)).toBe(21);
    expect(frameCountOf(0.3, 10, 1)).toBe(4);
  });

  it('renders 25 frames for 1.01 s at 24 fps of clips, frame k at t = k / 24', () => {
    const { document, box } = spin();
    const { data } = run(document, {
      source: { kind: 'clips', duration: 1.01 },
      fps: 24,
      width: 96,
      height: 72,
      format: 'frames',
      camera: { view: 'top' },
    });
    expect(expected.find((c) => c.id === 'VC-MOV-11')?.value).toBe(25);
    expect(data.frames).toBe(25);
    expect(data.timeline).toHaveLength(25);
    data.timeline.forEach((entry, k) => expect(Math.abs(entry.tS - k / 24)).toBeLessThan(1e-12));
    expect(data.files.filter((file) => file.fileName.startsWith('frame-'))).toHaveLength(25);
    expect(box).not.toBe('');
  });

  it('sheetFrames takes every n-th frame and always the last', () => {
    expect(sheetFrames(21, 5)).toEqual([0, 5, 10, 15, 20]);
    expect(sheetFrames(21, 8)).toEqual([0, 8, 16, 20]);
    expect(sheetFrames(1, 3)).toEqual([0]);
  });
});

describe('clips source (VC-MOV-04)', () => {
  it('puts the spinning box centre on the closed form at frames 0, 5, 10, 15, 20', () => {
    const { document, box, params } = spin();
    const { data } = run(document, { ...params, format: 'frames', overlays: { trace: [box] } });
    expect(data.frames).toBe(reference.spinClip.frames);
    const at = data.traces?.[box]?.at ?? [];
    expect(at).toHaveLength(21);
    for (const sample of reference.spinClip.samples) {
      expect(Math.abs((at[sample.frame]?.[0] ?? NaN) - sample.centreMm[0])).toBeLessThan(1e-9);
      expect(Math.abs((at[sample.frame]?.[1] ?? NaN) - sample.centreMm[1])).toBeLessThan(1e-9);
    }
  });

  it('draws the box turned 90 degrees at frame 5 (pixel probe: the long axis runs along Y)', () => {
    const { document, params } = spin();
    const { data } = run(document, { ...params, format: 'frames', width: 320, height: 240 });
    const frame = (k: number): { width: number; rgba: Uint8Array } =>
      decodePng(fileBytes(data, `frame-${String(k + 1).padStart(4, '0')}.png`));
    const lit = (image: { width: number; rgba: Uint8Array }, x: number, y: number): boolean => !isBackground(pixelAt(image, x, y));
    const [cx, cy] = pixelOf(data, [50, 0, 0]);
    const [dx, dy] = pixelOf(data, [0, 50, 0]);
    expect(lit(frame(0), cx + 30, cy)).toBe(true);
    expect(lit(frame(0), cx, cy + 30)).toBe(false);
    expect(lit(frame(5), dx, dy - 30)).toBe(true);
    expect(lit(frame(5), dx + 30, dy)).toBe(false);
  });

  it('reads clip values as readouts (deg for a rotation, document units for a position clip)', () => {
    const { document, box } = spin();
    const withSlide = execute(document, 'animate', {
      targetId: box,
      mode: 'spin',
      speed: 2,
      channel: 'position',
      axis: [0, 0, 1],
    }).document;
    const [rotation, slide] = Object.keys(withSlide.animations);
    const { data } = run(withSlide, {
      source: { kind: 'clips', duration: 1 },
      fps: 2,
      width: 96,
      height: 72,
      format: 'frames',
      overlays: { readouts: [rotation ?? '', slide ?? ''] },
    });
    expect(data.timeline[2]?.readouts[rotation ?? '']).toEqual({ value: expect.closeTo(180, 6), unit: 'deg' });
    expect(data.timeline[2]?.readouts[slide ?? '']).toEqual({ value: expect.closeTo(2, 9), unit: 'mm' });
  });

  it('refuses a document with no auto clip, naming the skipped click clips (VC-MOV-24)', () => {
    const { document, box } = spin();
    const clickOnly = execute(execute(document, 'stop_animation', {}).document, 'animate', {
      targetId: box,
      mode: 'spin',
      speed: 1,
      trigger: 'click',
    }).document;
    const result = execute(clickOnly, 'render_animation', { source: { kind: 'clips', duration: 1 }, format: 'apng' });
    expect(result.error?.code).toBe('MOV_NO_MOTION');
    expect(result.error?.detail?.['warnings']).toEqual([
      { code: 'MOV_CLICK_CLIPS_SKIPPED', message: expect.stringContaining('click clip') },
    ]);
    expect(result.data).toBeUndefined();
    expect(result.rejected).toBe(true);
  });

  it('plays the auto clips and warns about the click ones', () => {
    const { document, box, params } = spin();
    const mixed = execute(document, 'animate', { targetId: box, mode: 'spin', speed: 1, trigger: 'click' }).document;
    expect(run(mixed, { ...params, format: 'frames' }).data.warnings.map((w) => w.code)).toEqual(['MOV_CLICK_CLIPS_SKIPPED']);
  });

  it('refuses a clip that does not move anything (speed 0) with MOV_NO_MOTION', () => {
    const { document, box } = spin();
    const still = execute(execute(document, 'stop_animation', {}).document, 'animate', { targetId: box, mode: 'spin', speed: 0 }).document;
    expect(execute(still, 'render_animation', { source: { kind: 'clips', duration: 1 }, format: 'apng' }).error?.code).toBe(
      'MOV_NO_MOTION',
    );
  });

  it('refuses unknown trace and readout ids, listing them (MOV_UNKNOWN_ID)', () => {
    const { document, params } = spin();
    const trace = execute(document, 'render_animation', { ...params, overlays: { trace: ['ghost'] } });
    expect(trace.error).toMatchObject({ code: 'MOV_UNKNOWN_ID', ids: ['ghost'] });
    const readout = execute(document, 'render_animation', { ...params, overlays: { readouts: ['anim-nope', 'other'] } });
    expect(readout.error).toMatchObject({ code: 'MOV_UNKNOWN_ID', ids: ['anim-nope', 'other'] });
  });
});

describe('hostile ids', () => {
  it('treats __proto__ / constructor as unknown ids, never as members of the document records', () => {
    const { document, params } = spin();
    const trace = execute(document, 'render_animation', { ...params, overlays: { trace: ['__proto__'] } });
    expect(trace.error).toMatchObject({ code: 'MOV_UNKNOWN_ID', ids: ['__proto__'] });
    const readout = execute(document, 'render_animation', { ...params, overlays: { readouts: ['constructor'] } });
    expect(readout.error).toMatchObject({ code: 'MOV_UNKNOWN_ID', ids: ['constructor'] });
    const { document: bar } = fourBar();
    const sweep = { kind: 'sweep', mode: 'joint', target: '__proto__', start: 0, end: 1, duration: 1 };
    expect(execute(bar, 'render_animation', { source: sweep, format: 'apng' }).error?.code).toBe('MOV_NO_MOTION');
    const bad = { kind: 'sweep', mode: 'parameter', target: 'constructor', start: 0, end: 1, duration: 1 };
    expect(execute(bar, 'render_animation', { source: bad, format: 'apng' }).error?.code).toBe('MOV_NO_MOTION');
  });
});

describe('sweep source (VC-MOV-05)', () => {
  const { document, drive, instances } = fourBar();
  const sweep = { kind: 'sweep', mode: 'joint', target: drive, start: 0, end: 2 * Math.PI, duration: 2.4 } as const;
  const options = { fps: 10, width: 160, height: 120, format: 'frames', camera: { view: 'top' } } as const;

  it('drives the crank joint 0 -> 2π over 25 frames: value of frame k = 2πk/24, readouts in degrees', () => {
    const { data } = run(document, { ...options, source: sweep, overlays: { readouts: [drive] } });
    expect(data.frames).toBe(25);
    data.timeline.forEach((entry, k) => {
      expect(Math.abs((entry.readouts[drive]?.value ?? NaN) - (360 * k) / 24)).toBeLessThan(1e-9);
      expect(entry.readouts[drive]?.unit).toBe('deg');
      expect(Math.abs(entry.tS - k / 10)).toBeLessThan(1e-12);
    });
  });

  it('with pingPong frame 12 is the end value and frame 24 the start value', () => {
    const { data } = run(document, { ...options, source: { ...sweep, pingPong: true }, overlays: { readouts: [drive] } });
    const value = (k: number): number => data.timeline[k]?.readouts[drive]?.value ?? NaN;
    expect(Math.abs(value(12) - 360)).toBeLessThan(1e-9);
    expect(Math.abs(value(24))).toBeLessThan(1e-9);
    expect(Math.abs(value(6) - 180)).toBeLessThan(1e-9);
    expect(Math.abs(value(18) - 180)).toBeLessThan(1e-9);
  });

  it('places the instances where motion_study does for the same values (same evaluator)', () => {
    const study = execute(document, 'motion_study', { mode: 'joint', target: drive, start: 0, end: 2 * Math.PI, steps: 25 });
    const steps = (study.data as { steps: { instancePositions: Record<string, number[]> }[] }).steps;
    const traced = Object.keys(steps[0]?.instancePositions ?? {})[0] ?? '';
    const { data } = run(document, { ...options, source: sweep, overlays: { trace: [traced] } });
    const at = data.traces?.[traced]?.at ?? [];
    steps.forEach((step, k) => {
      for (let axis = 0; axis < 3; axis += 1)
        expect(Math.abs((at[k]?.[axis] ?? NaN) - (step.instancePositions[traced]?.[axis] ?? NaN))).toBeLessThan(1e-12);
    });
    expect(Math.hypot((at[6]?.[0] ?? 0) - (at[0]?.[0] ?? 0), (at[6]?.[1] ?? 0) - (at[0]?.[1] ?? 0))).toBeGreaterThan(1);
  });

  it('sweeps a document parameter that a joint stores: the readout is the parameter value, unitless, and the crank follows', () => {
    const driven = execute(execute(document, 'set_joint_value', { id: drive, value: 0.5 }).document, 'set_parameter', {
      name: 'angle',
      expression: '0.5',
    }).document;
    const traced = instances[1] ?? '';
    const { data } = run(driven, {
      ...options,
      source: { kind: 'sweep', mode: 'parameter', target: 'angle', start: 0.5, end: 1.5, duration: 0.5 },
      overlays: { readouts: ['angle', drive], trace: [traced] },
    });
    expect(data.timeline.map((entry) => entry.readouts['angle']?.value)).toEqual(
      [0.5, 0.7, 0.9, 1.1, 1.3, 1.5].map((v) => expect.closeTo(v, 12)),
    );
    expect(data.timeline[5]?.readouts['angle']?.unit).toBe('');
    expect(data.timeline[5]?.readouts[drive]?.value).toBeCloseTo((1.5 * 180) / Math.PI, 6);
    expect(data.moving.length).toBeGreaterThan(0);
  });

  it('refuses an unknown joint or parameter, start = end, an unknown readout and a non-numeric parameter', () => {
    const code = (params: Record<string, unknown>): string | undefined =>
      execute(document, 'render_animation', { ...options, ...params }).error?.code;
    expect(code({ source: { ...sweep, target: 'joint-ghost' } })).toBe('MOV_NO_MOTION');
    expect(code({ source: { ...sweep, mode: 'parameter', target: 'ghost' } })).toBe('MOV_NO_MOTION');
    expect(code({ source: { ...sweep, end: 0 } })).toBe('MOV_NO_MOTION');
    expect(code({ source: sweep, overlays: { readouts: ['ghost'] } })).toBe('MOV_UNKNOWN_ID');
    expect(code({ source: sweep, overlays: { trace: ['ghost'] } })).toBe('MOV_UNKNOWN_ID');
  });

  it('warns when the closed loop cannot close at some frames (MOV_LOOP_OPEN), and still renders them', () => {
    const passive = Object.keys(document.joints).find((id) => document.joints[id]?.passive === true) ?? '';
    const joint = document.joints[passive];
    const locked = {
      ...document,
      joints: { ...document.joints, [passive]: { ...joint, limits: [{ min: -0.05, max: 0.05 }] } },
    } as unknown as CadDocument;
    const { data } = run(locked, { ...options, source: sweep });
    expect(data.frames).toBe(25);
    expect(data.warnings.map((w) => w.code)).toContain('MOV_LOOP_OPEN');
    expect(run(document, { ...options, source: sweep }).data.warnings.map((w) => w.code)).not.toContain('MOV_LOOP_OPEN');
  });
});

describe('fixed camera (VC-MOV-08)', () => {
  it('is one value for all frames and every frame bounds corner projects inside the image', () => {
    const { document, params } = spin();
    const { data } = run(document, { ...params, format: 'frames', width: 320, height: 240 });
    for (let k = 0; k < data.frames; k += 1) {
      const bounds = computeSceneSnapshot(documentAtAnimation(document, data.timeline[k]?.tS ?? 0)).bounds;
      expect(bounds).not.toBeNull();
      for (const corner of boundsCorners(bounds ?? { min: [0, 0, 0], max: [0, 0, 0] })) {
        const [x, y] = pixelOf(data, corner);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(data.width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(data.height);
      }
    }
  });

  it('frames the four-bar across all frames and refuses view with direction, or a zero direction', () => {
    const { document, drive } = fourBar();
    const source = { kind: 'sweep', mode: 'joint', target: drive, start: 0, end: 2 * Math.PI, duration: 1 } as const;
    const { data } = run(document, { source, fps: 8, width: 200, height: 150, format: 'frames', camera: { direction: [0, 0, 1] } });
    expect(data.camera.direction.map((c) => Math.round(c))).toEqual([0, 0, -1]);
    const both = execute(document, 'render_animation', { source, format: 'frames', camera: { view: 'top', direction: [0, 0, 1] } });
    expect(both.error?.code).toBe('MOV_CAMERA_INVALID');
    const zero = execute(document, 'render_animation', { source, format: 'frames', camera: { direction: [0, 0, 0] } });
    expect(zero.error?.code).toBe('MOV_CAMERA_INVALID');
  });
});

describe('budgets and refusals (VC-MOV-12, 13)', () => {
  const { document } = spin();
  const clips = (duration: number): Record<string, unknown> => ({ source: { kind: 'clips', duration } });

  it('refuses more frames than maxFrames before drawing anything (MOV_FRAME_BUDGET)', () => {
    const over = execute(document, 'render_animation', { ...clips(60), fps: 30, format: 'frames' });
    expect(over.error?.code).toBe('MOV_FRAME_BUDGET');
    expect(over.summary).toContain('1801 frames');
    expect(over.data).toBeUndefined();
    expect(execute(document, 'render_animation', { ...clips(1), fps: 10, maxFrames: 10, format: 'frames' }).error?.code).toBe(
      'MOV_FRAME_BUDGET',
    );
    expect(
      execute(document, 'render_animation', { ...clips(1), fps: 10, maxFrames: 11, width: 64, height: 64, format: 'frames' }).error,
    ).toBeUndefined();
  });

  it('refuses 600 frames of 1280×720 as frames or apng (5.5e8 pixels) with MOV_RENDER_BUDGET, not as the default mp4', () => {
    for (const format of ['frames', 'apng'] as const) {
      const result = execute(document, 'render_animation', { ...clips(19.97), fps: 30, format });
      expect(result.error?.code).toBe('MOV_RENDER_BUDGET');
    }
    expect(execute(document, 'render_animation', { ...clips(19.97), fps: 30 }).error?.code).toBe('NATIVE_TOOL_MISSING');
  });

  it('refuses gif and mp4 (the default) without an encoder, naming apng; apng succeeds (VC-MOV-13)', () => {
    for (const format of [undefined, 'mp4', 'gif']) {
      const result = execute(document, 'render_animation', { ...clips(1), fps: 10, ...(format === undefined ? {} : { format }) });
      expect(result.error?.code).toBe('NATIVE_TOOL_MISSING');
      expect(result.error?.remediation).toContain('apng');
      expect(result.data).toBeUndefined();
      expect(result.document).toBe(document);
    }
    const ok = run(document, { ...clips(1), fps: 10, width: 96, height: 72, format: 'apng' });
    expect(ok.data.format).toBe('apng');
  });

  it('refuses a native renderer without a raster port and bad colours / sizes are clamped or refused', () => {
    const native = execute(document, 'render_animation', { ...clips(1), format: 'apng', renderer: 'native' });
    expect(native.error?.code).toBe('NATIVE_TOOL_MISSING');
    expect(native.error?.remediation).toContain('reference');
    expect(execute(document, 'render_animation', { ...clips(1), format: 'apng', background: 'blue' }).error?.code).toBe(
      'MOV_RENDER_INVALID',
    );
    const accent = execute(document, 'render_animation', { ...clips(1), format: 'apng', overlays: { accent: '#12' } });
    expect(accent.error?.code).toBe('MOV_RENDER_INVALID');
    const clamped = run(document, { ...clips(0.1), fps: 10, width: 5, height: 99999, format: 'frames' });
    expect([clamped.data.width, clamped.data.height]).toEqual([64, 1080]);
  });

  it('refuses invalid params through the registry (fps 0, negative duration)', () => {
    expect(execute(document, 'render_animation', { ...clips(1), fps: 0 }).summary).toMatch(/invalid params/);
    expect(execute(document, 'render_animation', clips(-1)).summary).toMatch(/invalid params/);
  });
});

describe('determinism and purity (VC-MOV-06, 07)', () => {
  it('gives identical frame and APNG digests twice, and the digests are those of the files', () => {
    const { document, params } = spin();
    const first = run(document, params).data;
    const second = run(document, params).data;
    expect(first.frameSha256).toHaveLength(21);
    expect(first.frameSha256).toEqual(second.frameSha256);
    expect(first.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.fileSha256).toBe(second.fileSha256);
    expect(first.renderer).toBe('reference');
    expect(first.rendererVersion).toMatch(/^llull-ts-raster\//);
    expect(new Set(first.frameSha256).size).toBeGreaterThan(5);
    expect(fileBytes(first, 'animation.apng').length).toBeGreaterThan(1000);
  });

  it('leaves the document deep-equal, appends no feature step and affects nothing, for clips and sweep', () => {
    const { document, params } = spin();
    const { document: bar, drive } = fourBar();
    for (const [doc, args] of [
      [document, params],
      [
        bar,
        {
          source: { kind: 'sweep', mode: 'joint', target: drive, start: 0, end: 1, duration: 0.3 },
          fps: 10,
          width: 96,
          height: 72,
          format: 'frames',
        },
      ],
    ] as const) {
      const before = JSON.stringify(doc);
      const result = execute(doc, 'render_animation', args);
      expect(result.data).toBeDefined();
      expect(JSON.stringify(doc)).toBe(before);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.document.featureHistory).toBe(doc.featureHistory);
    }
  });

  it('keeps the contents of timeline.json equal to data.timeline', () => {
    const { document, params } = spin();
    const { data } = run(document, { ...params, format: 'frames' });
    const file = JSON.parse(new TextDecoder().decode(fileBytes(data, 'timeline.json'))) as {
      fps: number;
      playbackRate: number;
      frames: number;
      timeline: unknown;
    };
    expect(file).toEqual({ fps: 10, playbackRate: 1, frames: 21, timeline: data.timeline });
  });
});

describe('overlays as raster primitives (VC-MOV-17)', () => {
  const draw = (extra: Record<string, unknown>): { data: AnimationData; image: ReturnType<typeof decodePng> } => {
    const { document, box } = spin();
    const { data } = run(document, {
      source: { kind: 'clips', duration: 2 },
      fps: 10,
      width: 320,
      height: 240,
      format: 'frames',
      camera: { view: 'top' },
      ...extra,
      overlays: { trace: [box], time: true, ...((extra['overlays'] as object | undefined) ?? {}) },
    });
    return { data, image: decodePng(fileBytes(data, 'frame-0006.png')) };
  };

  it('draws the trace dot in its colour at the projected position of the traced point', () => {
    const { data, image } = draw({});
    const [x, y] = pixelOf(data, (data.traces ? Object.values(data.traces)[0]?.at[5] : undefined) as [number, number, number]);
    expect(pixelAt(image, x, y).slice(0, 3)).toEqual([255, 210, 74]);
    expect(pixelAt(image, x + 8, y + 8).slice(0, 3)).not.toEqual([255, 210, 74]);
  });

  it('draws the time label and the trace legend (ink in the corners) and none of it without a bundled font', () => {
    const { image } = draw({});
    const ink = (img: ReturnType<typeof decodePng>, x0: number, y0: number, w: number, h: number): number => {
      let count = 0;
      for (let y = y0; y < y0 + h; y += 1)
        for (let x = x0; x < x0 + w; x += 1) if ((pixelAt(img, x, y)[0] ?? 0) > 200 && (pixelAt(img, x, y)[2] ?? 0) > 200) count += 1;
      return count;
    };
    expect(ink(image, 0, 0, 90, 24)).toBeGreaterThan(20);
    setFontProvider(null);
    try {
      const bare = draw({});
      expect(ink(bare.image, 0, 0, 90, 24)).toBe(0);
      expect(bare.data.warnings.map((w) => w.code)).toContain('MOV_OVERLAY_TEXT_SKIPPED');
      const dot = pixelOf(bare.data, Object.values(bare.data.traces ?? {})[0]?.at[5] as [number, number, number]);
      expect(pixelAt(bare.image, dot[0], dot[1]).slice(0, 3)).toEqual([255, 210, 74]);
    } finally {
      setFontProvider(firaProvider());
    }
  });

  it('traces the whole path with the same colour (the line is drawn through the samples)', () => {
    const { data, image } = draw({ width: 320, height: 240 });
    const path = Object.values(data.traces ?? {})[0]?.path ?? [];
    expect(path).toHaveLength(21);
    const [x, y] = pixelOf(data, path[15] as [number, number, number]);
    expect(pixelAt(image, x, y).slice(0, 3)).toEqual([255, 210, 74]);
  });

  it('hands the overlay to a native raster port inside the scene it draws, in front of every solid, and reports no digests', () => {
    const { document, params, box } = spin();
    const scenes: RasterScene[] = [];
    const port: RasterPort = {
      render: (scene) => {
        scenes.push(scene);
        return {
          ok: true,
          image: { rgba: rasterScenePixels(scene), device: 'test', deterministic: false, engine: 'native-cpu', version: 'test 1' },
        };
      },
    };
    const result = execute(
      document,
      'render_animation',
      { ...params, format: 'frames', renderer: 'native', overlays: { trace: [box] } },
      { ...defaultContext(), raster: port },
    );
    const data = result.data as AnimationData & { engine?: string; deterministic?: boolean };
    expect(scenes).toHaveLength(21);
    expect(data.renderer).toBe('native');
    expect(data.engine).toBe('native-cpu');
    expect(data.deterministic).toBe(false);
    expect(data.frameSha256).toBeUndefined();
    expect(data.fileSha256).toBeUndefined();
    const scene = scenes[5] as RasterScene;
    const zs = Array.from({ length: scene.points.length / 3 }, (_, i) => scene.points[i * 3 + 2] ?? 0);
    expect(zs.some((z) => z <= -1e7)).toBe(true);
    expect(scene.strokes.length).toBeGreaterThan(0);
    const reference = run(document, { ...params, format: 'frames', overlays: { trace: [box] } }).data;
    expect(fileBytes(data, 'frame-0006.png')).toEqual(fileBytes(reference, 'frame-0006.png'));
  });

  it('fails with the port code when the native raster fails a frame', () => {
    const { document, params } = spin();
    const port: RasterPort = { render: () => ({ ok: false, code: 'NATIVE_JOB_FAILED', message: 'job exploded' }) };
    const result = execute(document, 'render_animation', { ...params, renderer: 'native' }, { ...defaultContext(), raster: port });
    expect(result.error?.code).toBe('NATIVE_JOB_FAILED');
    expect(result.data).toBeUndefined();
  });
});

describe('highlight (VC-MOV-18)', () => {
  it('draws the moving box in the accent colour and the static one never', () => {
    const { document, params } = spin();
    const withStatic = execute(document, 'add_box', { size: [20, 20, 10], position: [-80, -60, 0], anchor: 'center' }).document;
    const staticId = withStatic.order[withStatic.order.length - 1] ?? '';
    const { data } = run(withStatic, { ...params, width: 320, height: 240, format: 'frames', overlays: { highlight: 'moving' } });
    expect(data.moving).toEqual([document.order[0]]);
    expect(data.moving).not.toContain(staticId);
    /** The accent #ff9f1c under the top light: its hue (r / g = 255 / 159) at any brightness, low blue. */
    const accent = (rgba: number[]): boolean =>
      (rgba[0] ?? 0) > 120 && Math.abs((rgba[0] ?? 0) / (rgba[1] || 1) - 255 / 159) < 0.06 && (rgba[2] ?? 255) < 45;
    const frame = decodePng(fileBytes(data, 'frame-0001.png'));
    expect(accent(pixelAt(frame, ...pixelOf(data, [50, 0, 0])))).toBe(true);
    let accentInStatic = 0;
    const [sx, sy] = pixelOf(data, [-80, -60, 0]);
    for (let y = sy - 5; y <= sy + 5; y += 1)
      for (let x = sx - 5; x <= sx + 5; x += 1) if (accent(pixelAt(frame, x, y))) accentInStatic += 1;
    expect(accentInStatic).toBe(0);
    const plain = run(withStatic, { ...params, width: 320, height: 240, format: 'frames' }).data;
    expect(accent(pixelAt(decodePng(fileBytes(plain, 'frame-0001.png')), ...pixelOf(plain, [50, 0, 0])))).toBe(false);
  });

  it('refuses nothing moving even with a highlight, and takes a custom accent', () => {
    const { document, params } = spin();
    const { data } = run(document, {
      ...params,
      width: 160,
      height: 120,
      format: 'frames',
      overlays: { highlight: 'moving', accent: '#00ff00' },
    });
    const frame = decodePng(fileBytes(data, 'frame-0001.png'));
    const [r, g, b] = pixelAt(frame, ...pixelOf(data, [50, 0, 0]));
    expect(g).toBeGreaterThan((r ?? 0) + 100);
    expect(b).toBeLessThan(10);
  });
});

describe('contact sheet (VC-MOV-15)', () => {
  it('has one labelled cell per picked frame (every n-th and the last), at most 320 px wide, columns <= 6', () => {
    const { document, params } = spin();
    const { data } = run(document, { ...params, format: 'frames', width: 640, height: 360, sheet: { every: 4 } });
    expect(data.sheet?.frames).toEqual([0, 4, 8, 12, 16, 20]);
    expect(data.sheet).toMatchObject({ columns: 6, width: 6 * 320, height: 180 + 2 * 13 });
    const sheet = decodePng(fileBytes(data, 'sheet.png'));
    expect([sheet.width, sheet.height]).toEqual([data.sheet?.width, data.sheet?.height]);
    const wide = run(document, { ...params, format: 'frames', width: 200, height: 100, sheet: { every: 3 } }).data;
    expect(wide.sheet?.frames).toEqual([0, 3, 6, 9, 12, 15, 18, 20]);
    expect(wide.sheet).toMatchObject({ columns: 6, width: 1200, height: 2 * (100 + 2 * 8) });
  });

  it('draws the cells of the frames in order (the box points along X at #0 and along Y at #5) and writes labels', () => {
    const { document, params } = spin();
    const { data } = run(document, { ...params, format: 'frames', width: 320, height: 240, sheet: { every: 5 } });
    const sheet = decodePng(fileBytes(data, 'sheet.png'));
    const cellTop = 2 * 8 + 0;
    const [cx, cy] = pixelOf(data, [50, 0, 0]);
    const lit = (col: number, x: number, y: number): boolean => !isBackground(pixelAt(sheet, col * 320 + x, cellTop + y));
    expect(lit(0, cx + 30, cy)).toBe(true);
    expect(lit(1, cx + 30, cy)).toBe(false);
    let ink = 0;
    for (let y = 0; y < 14; y += 1) for (let x = 0; x < 120; x += 1) if ((pixelAt(sheet, x, y)[0] ?? 0) > 200) ink += 1;
    expect(ink).toBeGreaterThan(10);
  });

  it('is absent without `sheet`', () => {
    const { document, params } = spin();
    const { data } = run(document, params);
    expect(data.sheet).toBeUndefined();
    expect(data.files.map((f) => f.fileName)).toEqual(['animation.apng', 'timeline.json']);
  });
});

describe('an empty or static document', () => {
  it('is refused with MOV_NO_MOTION for every source, never throws', () => {
    const empty = createEmptyDocument();
    for (const source of [
      { kind: 'clips', duration: 1 },
      { kind: 'simulation', duration: 1 },
      { kind: 'sweep', mode: 'joint', target: 'j', start: 0, end: 1, duration: 1 },
    ]) {
      const result = execute(empty, 'render_animation', { source, format: 'apng' });
      expect(result.error?.code).toBe('MOV_NO_MOTION');
      expect(result.document).toBe(empty);
      expect(result.affected).toEqual([]);
    }
  });
});
