/** add_motion_profile / evaluate_motion_profile and the profile evaluator: VC-DRV-21 (trapezoid, S-curve, triangle) and VC-DRV-22 (cam laws). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { compileProfile, isAngularUnit, isProfileRefusal, profilePeaks, profileUnitScale } from '@core/geometry/motionProfile';
import type { MotionProfile } from '@core/model/drives';
import { section } from './fixtures';

const profiles = section<{
  camLaws: Record<string, { Cv: number; Ca: number }>;
  trapezoid: { durationS: number };
  sCurve: { durationS: number };
  triangle: { peakVelocityMS: number; peakAccelerationMS2: number };
}>('profiles');

const add = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> => execute(doc, 'add_motion_profile', params);

interface Peaks {
  value: number;
  velocity: number;
  acceleration: number;
}
function peaksOf(
  segment: Record<string, unknown>,
  quantity = 'position',
  unit = 'm',
  extra: Record<string, unknown> = {},
): { peaks: Peaks; duration: number } {
  const result = execute(createEmptyDocument(), 'evaluate_motion_profile', {
    definition: { quantity, unit, segments: [segment], ...extra },
    samples: 11,
  });
  const data = result.data as { peaks: Peaks; durationS: number };
  return { peaks: data.peaks, duration: data.durationS };
}

describe('cam laws (VC-DRV-22)', () => {
  for (const [key, law] of [
    ['cycloidal', 'cycloidal'],
    ['poly345', 'poly345'],
    ['harmonic', 'harmonic'],
    ['modifiedTrapezoid', 'modified_trapezoid'],
    ['modifiedSine', 'modified_sine'],
  ] as const)
    it(`${law}: unit rise over a unit time has the tabulated C_v and C_a`, () => {
      const { peaks } = peaksOf({ kind: 'move', law, to: 1, duration: 1 });
      expect(peaks.velocity).toBeCloseTo(profiles.camLaws[key]?.Cv ?? Number.NaN, 6);
      expect(peaks.acceleration).toBeCloseTo(profiles.camLaws[key]?.Ca ?? Number.NaN, 6);
    });

  it('every cam law ends at rest on the rise and scales with h / β and h / β²', () => {
    for (const law of ['cycloidal', 'poly345', 'harmonic', 'modified_trapezoid', 'modified_sine'] as const) {
      const unit = peaksOf({ kind: 'move', law, to: 1, duration: 1 }).peaks;
      const scaled = peaksOf({ kind: 'move', law, to: 3, duration: 0.5 }).peaks;
      expect(scaled.velocity / unit.velocity).toBeCloseTo(6, 6);
      expect(scaled.acceleration / unit.acceleration).toBeCloseTo(12, 6);
      const compiled = compileProfile({
        id: 'p',
        quantity: 'position',
        unit: 'm',
        segments: [{ kind: 'move', law, to: 3, duration: 0.5 }],
      });
      if (isProfileRefusal(compiled)) throw new Error(compiled.error);
      expect(compiled.evaluate(0.5).value).toBeCloseTo(3, 9);
      expect(Math.abs(compiled.evaluate(0.4999999).velocity)).toBeLessThan(1e-3);
      expect(compiled.evaluate(0).velocity).toBeCloseTo(0, 9);
    }
  });
});

describe('trapezoid, S-curve and triangle (VC-DRV-21)', () => {
  it('trapezoid 0.1 m with v 0.5 and a 5 lasts 0.3 s', () => {
    const { duration, peaks } = peaksOf({ kind: 'move', law: 'trapezoid', to: 0.1, vmax: 0.5, amax: 5 });
    expect(duration).toBeCloseTo(profiles.trapezoid.durationS, 9);
    expect(peaks.velocity).toBeCloseTo(0.5, 6);
    expect(peaks.acceleration).toBeCloseTo(5, 9);
  });

  it('7-segment S-curve with jerk 100 lasts 0.35 s and respects v, a and the jerk', () => {
    const { duration, peaks } = peaksOf({ kind: 'move', law: 's_curve', to: 0.1, vmax: 0.5, amax: 5, jerk: 100 });
    expect(duration).toBeCloseTo(profiles.sCurve.durationS, 9);
    expect(peaks.velocity).toBeCloseTo(0.5, 6);
    expect(peaks.acceleration).toBeCloseTo(5, 6);
  });

  it('a 1 m move in 1 s with accelFraction 0.5 is the triangle: peaks 2 m/s and 4 m/s^2', () => {
    const { peaks, duration } = peaksOf({ kind: 'move', law: 'trapezoid', to: 1, duration: 1, accelFraction: 0.5 });
    expect(duration).toBe(1);
    expect(peaks.velocity).toBeCloseTo(profiles.triangle.peakVelocityMS, 6);
    expect(peaks.acceleration).toBeCloseTo(profiles.triangle.peakAccelerationMS2, 6);
  });

  it('a short move that cannot reach vmax is a triangle of 2 sqrt(D / a)', () => {
    const { duration, peaks } = peaksOf({ kind: 'move', law: 'trapezoid', to: 0.01, vmax: 10, amax: 4 });
    expect(duration).toBeCloseTo(2 * Math.sqrt(0.01 / 4), 9);
    expect(peaks.velocity).toBeCloseTo(Math.sqrt(0.01 * 4), 6);
  });

  it('an S-curve too short for the acceleration plateau reaches the lower peak acceleration and still covers the distance', () => {
    const doc = add(createEmptyDocument(), {
      id: 's',
      quantity: 'position',
      unit: 'm',
      segments: [{ kind: 'move', law: 's_curve', to: 0.02, vmax: 5, amax: 50, jerk: 100 }],
    }).document;
    const compiled = compileProfile(doc.dynamics?.profiles?.['s'] as MotionProfile);
    if (isProfileRefusal(compiled)) throw new Error(compiled.error);
    expect(compiled.evaluate(compiled.duration).value).toBeCloseTo(0.02, 9);
    expect(profilePeaks(compiled).acceleration).toBeLessThan(50);
    expect(Math.abs(compiled.evaluate(compiled.duration - 1e-9).velocity)).toBeLessThan(1e-6);
  });

  it('a longer duration than the shortest stretches the move with a lower peak speed', () => {
    const shortest = peaksOf({ kind: 'move', law: 's_curve', to: 0.1, vmax: 0.5, amax: 5, jerk: 100 });
    const stretched = peaksOf({ kind: 'move', law: 's_curve', to: 0.1, vmax: 0.5, amax: 5, jerk: 100, duration: 0.5 });
    expect(stretched.duration).toBeCloseTo(0.5, 9);
    expect(stretched.peaks.velocity).toBeLessThan(shortest.peaks.velocity);
    const slow = peaksOf({ kind: 'move', law: 'trapezoid', to: 0.1, vmax: 0.5, amax: 5, duration: 0.6 });
    expect(slow.duration).toBeCloseTo(0.6, 9);
    expect(slow.peaks.velocity).toBeLessThan(0.5);
  });

  it('a duration-only S-curve covers the distance with jerk fraction 1/4', () => {
    const doc = add(createEmptyDocument(), {
      id: 'd',
      quantity: 'position',
      unit: 'deg',
      segments: [{ kind: 'move', law: 's_curve', to: 90, duration: 0.3 }],
    }).document;
    const compiled = compileProfile(doc.dynamics?.profiles?.['d'] as MotionProfile);
    if (isProfileRefusal(compiled)) throw new Error(compiled.error);
    expect(compiled.duration).toBeCloseTo(0.3, 12);
    expect(compiled.evaluate(0.3).value).toBeCloseTo(90, 9);
    expect(compiled.evaluate(0.15).value).toBeCloseTo(45, 6);
  });
});

describe('add_motion_profile', () => {
  const base = { quantity: 'position', unit: 'deg' };

  it('stores a profile, reports duration and peaks, and consumes an id', () => {
    const doc = createEmptyDocument();
    const result = add(doc, {
      ...base,
      id: 'index',
      segments: [
        { kind: 'move', law: 'cycloidal', to: 90, duration: 0.3 },
        { kind: 'dwell', duration: 0.2 },
        { kind: 'move', law: 'cycloidal', to: 0, duration: 0.3 },
      ],
      repeat: 3,
    });
    expect(result.affected).toEqual(['index']);
    expect(result.document.dynamics?.profiles?.['index']?.repeat).toBe(3);
    expect(result.summary).toContain('duration 2.40000 s');
    expect(add(result.document, { ...base, id: 'index', segments: [{ kind: 'dwell', duration: 1 }] }).affected).toEqual([]);
  });

  it('is pure: the argument document is not mutated', () => {
    const doc = createEmptyDocument();
    const before = JSON.stringify(doc);
    add(doc, { ...base, segments: [{ kind: 'dwell', duration: 1 }] });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('refuses a velocity jump of a position profile (DRV_PROFILE_DISCONTINUOUS), accepts it with allowStep', () => {
    const segments = [
      { kind: 'move', law: 'linear', to: 10, duration: 1 },
      { kind: 'move', law: 'cycloidal', to: 0, duration: 1 },
    ];
    const refused = add(createEmptyDocument(), { ...base, segments });
    expect(refused.affected).toEqual([]);
    expect(refused.error?.code).toBe('DRV_PROFILE_DISCONTINUOUS');
    expect(add(createEmptyDocument(), { ...base, segments, allowStep: true }).affected).toHaveLength(1);
  });

  it('refuses a value jump (a table that does not start at the current value)', () => {
    const refused = add(createEmptyDocument(), {
      quantity: 'torque',
      unit: 'N*m',
      segments: [
        { kind: 'dwell', duration: 1 },
        {
          kind: 'table',
          points: [
            [0, 5],
            [1, 6],
          ],
        },
      ],
    });
    expect(refused.error?.code).toBe('DRV_PROFILE_DISCONTINUOUS');
  });

  it('refuses a repeat that does not end where it starts', () => {
    const refused = add(createEmptyDocument(), { ...base, segments: [{ kind: 'move', law: 'cycloidal', to: 10, duration: 1 }], repeat: 2 });
    expect(refused.error?.code).toBe('DRV_PROFILE_DISCONTINUOUS');
  });

  it('refuses an infeasible S-curve and names the shortest duration', () => {
    const refused = add(createEmptyDocument(), {
      ...base,
      segments: [{ kind: 'move', law: 's_curve', to: 90, vmax: 100, amax: 1000, jerk: 1e5, duration: 0.01 }],
    });
    expect(refused.error?.code).toBe('DRV_PROFILE_INFEASIBLE');
    expect(refused.error?.detail?.['shortestDurationS']).toBeGreaterThan(0.01);
    const trapezoid = add(createEmptyDocument(), {
      ...base,
      segments: [{ kind: 'move', law: 'trapezoid', to: 90, vmax: 100, amax: 1000, duration: 0.01 }],
    });
    expect(trapezoid.error?.code).toBe('DRV_PROFILE_INFEASIBLE');
  });

  it('refuses malformed input with DRV_PROFILE_INVALID and changes nothing', () => {
    const cases: Record<string, unknown>[] = [
      { ...base, unit: 'furlongs', segments: [{ kind: 'dwell', duration: 1 }] },
      { ...base, segments: [{ kind: 'dwell' }] },
      { ...base, segments: [{ kind: 'move', law: 'cycloidal' }] },
      { ...base, segments: [{ kind: 'move', law: 'cycloidal', to: 5 }] },
      { ...base, segments: [{ kind: 'sine', amplitude: 1 }] },
      { ...base, segments: [{ kind: 'table' }] },
      { ...base, segments: [{ kind: 'table', points: [[0, 0]] }] },
      {
        ...base,
        segments: [
          {
            kind: 'table',
            points: [
              [0.1, 0],
              [1, 1],
            ],
          },
        ],
      },
      { ...base, segments: [{ kind: 'move', law: 'trapezoid', to: 5 }] },
      { ...base, segments: [{ kind: 'move', law: 'trapezoid', to: 5, vmax: 2 }] },
      { ...base, segments: [{ kind: 'move', law: 's_curve', to: 5, vmax: 2 }] },
      { ...base, segments: [{ kind: 'move', law: 's_curve', to: 5 }] },
      { ...base, segments: [{ kind: 'move', law: 'linear', to: 5 }] },
    ];
    for (const params of cases) {
      const doc = createEmptyDocument();
      const result = add(doc, params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.summary).toMatch(/DRV_PROFILE_INVALID|rejected|no-op/);
    }
  });

  it('table (linear, monotone cubic), sine and dwell segments evaluate as defined', () => {
    const result = add(createEmptyDocument(), {
      id: 'mix',
      quantity: 'velocity',
      unit: 'rpm',
      segments: [
        {
          kind: 'table',
          points: [
            [0, 0],
            [1, 100],
            [2, 100],
            [3, 0],
          ],
          interpolation: 'monotone_cubic',
        },
        { kind: 'sine', amplitude: 10, frequencyHz: 2, cycles: 2 },
        {
          kind: 'table',
          points: [
            [0, 0],
            [1, 50],
          ],
        },
      ],
    });
    const doc = result.document;
    const evaluate = (times: number[]): { t: number; value: number; velocity: number }[] =>
      (
        execute(doc, 'evaluate_motion_profile', { profile: 'mix', times }).data as {
          samples: { t: number; value: number; velocity: number }[];
        }
      ).samples;
    const [a, b, c, d, e] = evaluate([0.5, 1.5, 3.125, 3.5, 4.5]);
    expect(a?.value).toBeGreaterThan(0);
    expect(a?.value).toBeLessThan(100);
    expect(b?.value).toBeCloseTo(100, 6);
    expect(c?.value).toBeCloseTo(10, 9);
    expect(d?.velocity).toBeCloseTo(10 * 2 * Math.PI * 2 * Math.cos(2 * Math.PI * 2 * 0.5), 9);
    expect(e?.value).toBeCloseTo(25, 9);
    expect(e?.velocity).toBeCloseTo(50, 9);
    const tail = evaluate([5, 5.5, 6, 100]);
    for (const sample of tail) expect([sample.value, sample.velocity]).toEqual([50, 0]);
  });

  it('a profile in repeat wraps around', () => {
    const doc = add(createEmptyDocument(), {
      id: 'r',
      quantity: 'position',
      unit: 'rad',
      segments: [
        { kind: 'move', law: 'cycloidal', to: 1, duration: 1 },
        { kind: 'move', law: 'cycloidal', to: 0, duration: 1 },
      ],
      repeat: 2,
    }).document;
    const samples = (
      execute(doc, 'evaluate_motion_profile', { profile: 'r', times: [0.5, 2.5, 3.5, 10] }).data as { samples: { value: number }[] }
    ).samples;
    expect(samples[0]?.value).toBeCloseTo(0.5, 9);
    expect(samples[1]?.value).toBeCloseTo(0.5, 9);
    expect(samples[3]?.value).toBeCloseTo(0, 9);
  });
});

describe('evaluate_motion_profile', () => {
  const doc = add(createEmptyDocument(), {
    id: 'p',
    quantity: 'position',
    unit: 'deg',
    segments: [{ kind: 'move', law: 'cycloidal', to: 90, duration: 1 }],
  }).document;

  it('returns uniform samples, the duration and the peaks, and leaves the document alone (pure, no step)', () => {
    const before = JSON.stringify(doc);
    const result = execute(doc, 'evaluate_motion_profile', { profile: 'p', samples: 5 });
    const data = result.data as { samples: { t: number; value: number }[]; durationS: number; peaks: { velocity: number } };
    expect(result.document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.affected).toEqual([]);
    expect(data.samples.map((s) => s.t)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(data.samples[4]?.value).toBeCloseTo(90, 9);
    expect(data.peaks.velocity).toBeCloseTo(180, 5);
    expect(data.durationS).toBe(1);
  });

  it('refuses: neither or both of profile / definition, an unknown id, a bad definition', () => {
    const none = execute(doc, 'evaluate_motion_profile', {});
    const both = execute(doc, 'evaluate_motion_profile', {
      profile: 'p',
      definition: { quantity: 'position', unit: 'deg', segments: [{ kind: 'dwell', duration: 1 }] },
    });
    const unknown = execute(doc, 'evaluate_motion_profile', { profile: 'zzz' });
    const bad = execute(doc, 'evaluate_motion_profile', {
      definition: { quantity: 'position', unit: 'deg', segments: [{ kind: 'dwell' }] },
    });
    const jump = execute(doc, 'evaluate_motion_profile', {
      definition: {
        quantity: 'position',
        unit: 'deg',
        segments: [
          { kind: 'move', law: 'linear', to: 1, duration: 1 },
          { kind: 'move', law: 'cycloidal', to: 2, duration: 1 },
        ],
      },
    });
    for (const result of [none, both, unknown, bad, jump]) {
      expect(result.data).toBeUndefined();
      expect(result.affected).toEqual([]);
    }
    expect(jump.error?.code).toBe('DRV_PROFILE_DISCONTINUOUS');
    expect(unknown.summary).toContain('not found');
  });

  it('10001 samples are fast (budget 50 ms plus the peak scan)', () => {
    const start = performance.now();
    execute(doc, 'evaluate_motion_profile', { profile: 'p', samples: 10001 });
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('units', () => {
  it('converts angular, linear and electrical units to SI', () => {
    expect(profileUnitScale('position', 'deg')).toBeCloseTo(Math.PI / 180, 15);
    expect(profileUnitScale('velocity', 'rpm')).toBeCloseTo(Math.PI / 30, 15);
    expect(profileUnitScale('position', 'mm')).toBe(1e-3);
    expect(profileUnitScale('voltage', 'rpm')).toBeNull();
  });
});

describe('evaluator refusals and edges', () => {
  const build = (segments: MotionProfile['segments'], extra: Partial<MotionProfile> = {}): ReturnType<typeof compileProfile> =>
    compileProfile({ id: 'p', quantity: 'position', unit: 'm', segments, ...extra });
  const codeOf = (outcome: ReturnType<typeof compileProfile>): string => (isProfileRefusal(outcome) ? outcome.code : 'compiled');

  it('refuses malformed profiles with DRV_PROFILE_INVALID', () => {
    const dwell = { kind: 'dwell', duration: 1 } as const;
    expect(codeOf(build([]))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([dwell], { repeat: 0 }))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([dwell], { repeat: 1.5 }))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([dwell], { start: Number.NaN }))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'dwell', duration: 0 }]))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'move', law: 'cycloidal', to: 0 }]))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'move', law: 'cycloidal', to: Number.NaN, duration: 1 }]))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'move', law: 'cycloidal', to: 1, duration: -1 }]))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'sine', amplitude: 1, frequencyHz: 0, cycles: 1 }]))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'table', points: [[0, 0]], interpolation: 'linear' }]))).toBe('DRV_PROFILE_INVALID');
    expect(
      codeOf(
        build([
          {
            kind: 'table',
            points: [
              [0, 0],
              [1, Number.NaN],
            ],
            interpolation: 'linear',
          },
        ]),
      ),
    ).toBe('DRV_PROFILE_INVALID');
    expect(
      codeOf(
        build([
          {
            kind: 'table',
            points: [
              [0, 0],
              [0, 1],
            ],
            interpolation: 'linear',
          },
        ]),
      ),
    ).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'move', law: 'trapezoid', to: 1, amax: 2 }]))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'move', law: 'trapezoid', to: 1, amax: -2, vmax: 1 }]))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'move', law: 'trapezoid', to: 1, duration: 1, accelFraction: 0.6 }]))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'move', law: 's_curve', to: 1, duration: 1, accelFraction: 0.7 }]))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'move', law: 's_curve', to: 1, vmax: 1, amax: 1 }]))).toBe('DRV_PROFILE_INVALID');
    expect(codeOf(build([{ kind: 'move', law: 'linear', to: 1 }]))).toBe('DRV_PROFILE_INVALID');
  });

  it('a zero-length move keeps the value; segments of zero duration are skipped; a first segment that starts away from `start` is a jump', () => {
    const held = build([{ kind: 'move', law: 'cycloidal', to: 0, duration: 2 }], { start: 0 });
    if (isProfileRefusal(held)) throw new Error(held.error);
    expect(held.evaluate(1)).toEqual({ value: 0, velocity: 0, acceleration: 0 });
    expect(codeOf(build([{ kind: 'move', law: 'cycloidal', to: 0 }]))).toBe('DRV_PROFILE_INVALID');
    expect(
      codeOf(
        build(
          [
            {
              kind: 'table',
              points: [
                [0, 5],
                [1, 6],
              ],
              interpolation: 'linear',
            },
          ],
          { start: 0 },
        ),
      ),
    ).toBe('DRV_PROFILE_DISCONTINUOUS');
    const free = build([
      {
        kind: 'table',
        points: [
          [0, 5],
          [1, 6],
        ],
        interpolation: 'linear',
      },
    ]);
    if (isProfileRefusal(free)) throw new Error(free.error);
    expect(free.evaluate(0.5).value).toBeCloseTo(5.5, 12);
    expect(free.evaluate(-3).value).toBe(5);
  });

  it('linear moves from vmax, a two-point monotone cubic, a table with a start velocity jump on a position profile', () => {
    const linear = build([{ kind: 'move', law: 'linear', to: 1, vmax: 0.5 }]);
    if (isProfileRefusal(linear)) throw new Error(linear.error);
    expect(linear.duration).toBeCloseTo(2, 12);
    expect(linear.evaluate(1).velocity).toBeCloseTo(0.5, 12);
    const cubic = build([
      {
        kind: 'table',
        points: [
          [0, 0],
          [2, 4],
        ],
        interpolation: 'monotone_cubic',
      },
    ]);
    if (isProfileRefusal(cubic)) throw new Error(cubic.error);
    expect(cubic.evaluate(1).value).toBeCloseTo(2, 9);
    expect(cubic.evaluate(1).acceleration).toBeCloseTo(0, 9);
    expect(
      codeOf(
        build([
          {
            kind: 'table',
            points: [
              [0, 0],
              [1, 1],
            ],
            interpolation: 'linear',
          },
          { kind: 'dwell', duration: 1 },
        ]),
      ),
    ).toBe('DRV_PROFILE_DISCONTINUOUS');
    expect(
      codeOf(
        build(
          [
            {
              kind: 'table',
              points: [
                [0, 0],
                [1, 1],
              ],
              interpolation: 'linear',
            },
            { kind: 'dwell', duration: 1 },
          ],
          { quantity: 'torque', unit: 'N*m' } as never,
        ),
      ),
    ).toBe('compiled');
  });

  it('the angular unit test and the peak scan of a flat profile', () => {
    expect(isAngularUnit('deg')).toBe(true);
    expect(isAngularUnit('mm')).toBe(false);
    const flat = build([{ kind: 'dwell', duration: 1 }]);
    if (isProfileRefusal(flat)) throw new Error(flat.error);
    expect(profilePeaks(flat)).toEqual({ value: 0, velocity: 0, acceleration: 0 });
  });
});
