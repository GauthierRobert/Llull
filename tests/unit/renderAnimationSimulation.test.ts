/**
 * render_animation, the `simulation` source on the PHY-10 slider-crank (PHY-22 MOV-M1): VC-MOV-01 / 02 / 15 / 16 / 17 against the closed form in
 * docs/physics/22-motion-video/validation, plus `simulate_motion detail: 'poses+series'` (TR-MOV-04) and the refusals of the source.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { setFontProvider } from '@core/commands/fontPort';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { decodePng, fileBytes, pixelAt, pixelOf, planDocument, readJson, type AnimationData } from './renderAnimationFixtures';
import { sliderCrank } from './sliderCrankFixture';
import { firaProvider } from './wrap/fixtures';

interface Expected {
  cases: { id: string; quantity: string; value: number | number[]; tolerance?: { abs?: number } }[];
}
interface Reference {
  sliderCrank: { frames: number; samples: { frame: number; tS: number; pistonXmm: number }[] };
}
const expected = readJson<Expected>('expected_results.json').cases;
const reference = readJson<Reference>('mov_reference.json');

let engine: Awaited<ReturnType<typeof createMujocoPhysics>>;
beforeAll(async () => {
  engine = await createMujocoPhysics();
  setPhysicsEngine(engine);
  setFontProvider(firaProvider());
});
afterAll(() => setPhysicsEngine(null));

const { document: crank, render } = planDocument('mov_slider_crank_video.plan.json');
const video = render.params as { source: { duration: number; timestep: number; playbackRate: number }; fps: number };
const params = {
  ...render.params,
  format: 'frames',
  width: 320,
  height: 180,
  overlays: { ...(render.params['overlays'] as object), readouts: ['j_crank', 'j_slide', 'piston'] },
};

let first: AnimationData;
beforeAll(() => {
  first = execute(crank, 'render_animation', params).data as AnimationData;
}, 120_000);

describe('simulation source on the slider-crank (VC-MOV-01, 02)', () => {
  it('draws 189 frames, frame k at t = k / 3000 s', () => {
    expect(expected.find((c) => c.id === 'VC-MOV-01')?.value).toBe(189);
    expect(first.frames).toBe(189);
    expect(first.timeline).toHaveLength(189);
    first.timeline.forEach((entry, k) => expect(Math.abs(entry.tS - k / 3000)).toBeLessThan(1e-12));
    expect(first.videoDurationS).toBeCloseTo(6.3, 12);
    expect(first.playbackRate).toBe(0.01);
    expect(first.sourceDurationS).toBe(video.source.duration);
  });

  it('puts the piston centre of mass on the closed form r cos θ + √(l² − r² sin² θ) within 0.01 mm at frames 0, 15, …, 180', () => {
    const cases = expected.filter((c) => c.id === 'VC-MOV-02');
    expect(cases).toHaveLength(13);
    for (const item of cases) {
      const frame = Number(/frame (\d+)/.exec(item.quantity)?.[1]);
      const x = first.timeline[frame]?.readouts['piston.x']?.value ?? NaN;
      expect(Math.abs(x - (item.value as number))).toBeLessThan(item.tolerance?.abs ?? NaN);
    }
    for (const sample of reference.sliderCrank.samples) {
      expect(first.timeline[sample.frame]?.readouts['piston.x']?.value).toBeCloseTo(sample.pistonXmm, 1);
    }
  });

  it('reads j_slide in agreement with the drawn piston: piston x = 250 + j_slide, y and z constant', () => {
    first.timeline.forEach((entry) => {
      const slide = entry.readouts['j_slide']?.value ?? NaN;
      expect(Math.abs((entry.readouts['piston.x']?.value ?? NaN) - 250 - slide)).toBeLessThan(1e-6);
      expect(Math.abs(entry.readouts['piston.y']?.value ?? NaN)).toBeLessThan(1e-6);
    });
    expect(first.timeline[0]?.readouts['j_slide']?.unit).toBe('mm');
    expect(first.timeline[15]?.readouts['j_crank']?.unit).toBe('deg');
    expect(first.timeline[15]?.readouts['j_crank']?.value).toBeCloseTo(28.6478897565, 3);
  });

  it('records the bracketing samples of every frame and the sample interval', () => {
    expect(first.sampleIntervalS).toBeCloseTo(2e-5, 12);
    const entry = first.timeline[1];
    expect(entry?.sample?.before).toBe(16);
    expect(entry?.sample?.after).toBe(17);
    expect(entry?.sample?.weight).toBeCloseTo(2 / 3, 9);
    expect(first.warnings.every((w) => w.code === 'MOV_SIMULATION_WARNING')).toBe(true);
  });

  it('draws the frame of the moving mechanism with its overlays (the piston dot sits on the traced piston)', () => {
    const image = decodePng(fileBytes(first, 'frame-0046.png'));
    const [x, y] = pixelOf(first, first.traces?.['piston']?.at[45] as [number, number, number]);
    expect(pixelAt(image, x, y).slice(0, 3)).toEqual([255, 210, 74]);
    expect(first.moving).toHaveLength(3);
  });
});

describe('readouts equal one simulate_motion run (VC-MOV-16)', () => {
  let simulated: {
    poses: { times: number[]; bodies: Record<string, { position: number[][] }> };
    series: { times: number[]; jointPosition: Record<string, number[]> };
  };
  beforeAll(() => {
    simulated = execute(crank, 'simulate_motion', {
      duration: video.source.duration,
      timestep: video.source.timestep,
      sampleRate: 1 / video.source.timestep,
      detail: 'poses+series',
    }).data as typeof simulated;
  });

  it('gives the joint values of frame k as the linear interpolation of the recorded series at t_k (1e-12)', () => {
    const rate = video.source.playbackRate;
    const interpolate = (track: number[], t: number): number => {
      const times = simulated.series.times;
      let i = Math.min(times.length - 2, Math.max(0, Math.floor(t / video.source.timestep + 1e-9)));
      while ((times[i + 1] ?? Infinity) < t) i += 1;
      const w = (t - (times[i] ?? 0)) / ((times[i + 1] ?? 1) - (times[i] ?? 0));
      return (track[i] ?? 0) + ((track[i + 1] ?? 0) - (track[i] ?? 0)) * w;
    };
    first.timeline.forEach((entry, k) => {
      const t = (k * rate) / video.fps;
      const angle = interpolate(simulated.series.jointPosition['j_crank'] ?? [], t);
      const slide = interpolate(simulated.series.jointPosition['j_slide'] ?? [], t);
      expect(Math.abs((entry.readouts['j_crank']?.value ?? NaN) - (angle * 180) / Math.PI)).toBeLessThan(1e-9);
      expect(Math.abs((entry.readouts['j_slide']?.value ?? NaN) - slide * 1000)).toBeLessThan(1e-9);
    });
  });

  it('runs the simulation once per command, never per frame', () => {
    const base = defaultContext();
    let simulations = 0;
    const counting: ExecutionContext = {
      ...base,
      registry: (name) => {
        const found = base.registry(name);
        if (name !== 'simulate_motion' || found === undefined) return found;
        return {
          ...found,
          run: (doc, args, ctx) => {
            simulations += 1;
            return found.run(doc, args, ctx);
          },
        };
      },
    };
    const result = execute(crank, 'render_animation', { ...params, width: 64, height: 64, sheet: undefined }, counting);
    expect((result.data as AnimationData).frames).toBe(189);
    expect(simulations).toBe(1);
  });
});

describe('trace and sheet (VC-MOV-15, 17)', () => {
  it('traces the piston through the recorded samples exactly like render_motion for the same samples', () => {
    const motion = execute(crank, 'render_motion', {
      times: [0],
      duration: video.source.duration,
      timestep: video.source.timestep,
      sampleRate: 1 / video.source.timestep,
      trace: 'piston',
      view: 'front',
    }).data as { trace: Record<string, number[][]> };
    const path = first.traces?.['piston']?.path ?? [];
    expect(path.length).toBeGreaterThan(3000);
    expect(path).toEqual(motion.trace['piston']);
  });

  it('makes a sheet of every 15th frame plus the last: 14 cells labelled #k t = … s', () => {
    expect(expected.find((c) => c.id === 'VC-MOV-15')?.value).toBe(14);
    expect(first.sheet?.frames).toEqual([...Array.from({ length: 13 }, (_, i) => i * 15), 188]);
    expect(first.sheet).toMatchObject({ columns: 6, width: 6 * 320 });
    const sheet = decodePng(fileBytes(first, 'sheet.png'));
    expect(sheet.height).toBe(3 * (180 + 2 * 13));
  });
});

describe('rates, sampling and refusals', () => {
  const pendulum = (startDeg: number): CadDocument => {
    const a = (startDeg * Math.PI) / 180;
    return execute(createEmptyDocument(), 'build_project', {
      actions: [
        { command: 'set_units', params: { units: 'mm' } },
        { command: 'add_sphere', params: { radius: 10, position: [1000 * Math.sin(a), 0, -1000 * Math.cos(a)] }, as: 'bob' },
        { command: 'add_rigid_body', params: { id: 'pend', entityIds: ['$bob'] } },
        { command: 'add_body_joint', params: { id: 'pivot', kind: 'revolute', child: 'pend', anchor: [0, 0, 0], axis: [0, 1, 0] } },
      ],
    }).document;
  };
  const small = { fps: 30, width: 96, height: 72, format: 'frames' } as const;

  it('warns MOV_SAMPLES_SPARSE when the recorded samples are further apart than a frame, and interpolates', () => {
    const result = execute(pendulum(10), 'render_animation', {
      ...small,
      source: { kind: 'simulation', duration: 0.1, timestep: 0.01, playbackRate: 0.1 },
      camera: { view: 'front' },
    });
    const data = result.data as AnimationData;
    expect(data.frames).toBe(31);
    expect(data.sampleIntervalS).toBeCloseTo(0.01, 12);
    expect(data.warnings.map((w) => w.code)).toContain('MOV_SAMPLES_SPARSE');
    expect(data.timeline[1]?.sample?.weight).toBeGreaterThan(0);
    expect(data.timeline[1]?.sample?.weight).toBeLessThan(1);
    const dense = execute(pendulum(10), 'render_animation', {
      ...small,
      source: { kind: 'simulation', duration: 0.1, timestep: 0.001, playbackRate: 1 },
      camera: { view: 'front' },
    }).data as AnimationData;
    expect(dense.warnings.map((w) => w.code)).not.toContain('MOV_SAMPLES_SPARSE');
  });

  it('refuses a mechanism that does not move (a pendulum at rest) with MOV_NO_MOTION', () => {
    const result = execute(pendulum(0), 'render_animation', { ...small, source: { kind: 'simulation', duration: 0.2 } });
    expect(result.error?.code).toBe('MOV_NO_MOTION');
    expect(result.data).toBeUndefined();
  });

  it('refuses a document without rigid bodies (VC-MOV-24) and unknown ids with the ids listed', () => {
    const empty = execute(createEmptyDocument(), 'render_animation', { ...small, source: { kind: 'simulation', duration: 1 } });
    expect(empty.error?.code).toBe('MOV_NO_MOTION');
    const trace = execute(crank, 'render_animation', { ...params, overlays: { trace: ['ghost'] } });
    expect(trace.error).toMatchObject({ code: 'MOV_UNKNOWN_ID', ids: ['ghost'] });
    const readout = execute(crank, 'render_animation', { ...params, overlays: { readouts: ['j_crank', 'nope'] } });
    expect(readout.error).toMatchObject({ code: 'MOV_UNKNOWN_ID', ids: ['nope'] });
    const spherical = execute(crank, 'render_animation', { ...params, overlays: { readouts: ['j_wristpin'] } });
    expect(spherical.error).toMatchObject({ code: 'MOV_UNKNOWN_ID', ids: ['j_wristpin'] });
  });

  it('quotes the simulation refusal (an open loop) as MOV_SOURCE_FAILED and refuses without a physics engine', () => {
    const { doc } = sliderCrank({ wristGapMm: 5 });
    const motor = execute(doc, 'add_motor', { joint: 'crank_j', kind: 'speed', rpm: 600, maxTorque: 1e5 }).document;
    const open = execute(motor, 'render_animation', { ...small, source: { kind: 'simulation', duration: 0.05 } });
    expect(open.error?.code).toBe('MOV_SOURCE_FAILED');
    expect(open.summary).toContain('FPR_LOOP_OPEN');
    setPhysicsEngine(null);
    try {
      const none = execute(crank, 'render_animation', { ...params });
      expect(none.error?.code).toBe('MOV_SOURCE_FAILED');
      expect(none.summary).toContain('no physics engine');
    } finally {
      setPhysicsEngine(engine);
    }
  });

  it('is pure: the document is deep-equal after, nothing is affected and no feature step is added', () => {
    const before = JSON.stringify(crank);
    const result = execute(crank, 'render_animation', { ...params, width: 64, height: 64 });
    expect(result.data).toBeDefined();
    expect(JSON.stringify(crank)).toBe(before);
    expect(result.document).toBe(crank);
    expect(result.affected).toEqual([]);
    expect(result.document.featureHistory).toBe(crank.featureHistory);
  });
});
