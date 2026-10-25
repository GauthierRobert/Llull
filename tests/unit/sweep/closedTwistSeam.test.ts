/** A closed sweep whose total twist is a whole number of turns of the section's symmetry (not of 2π) closes ring n-1 on the matching vertex of ring 0. */
import { describe, it, expect } from 'vitest';
import { type SweepEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { placeLoop, sweepTriangles } from '@core/geometry/sweep';
import { evaluateSweep } from '@core/geometry/sweepEval/evaluate';
import { sectionLoops } from '@core/geometry/sweepEval/sections';

const SQUARE_LOOP = [
  [0, 0, 0],
  [50, 0, 0],
  [50, 50, 0],
  [0, 50, 0],
];

const polygon = (sides: number, radius: number): number[][] =>
  Array.from({ length: sides }, (_, k) => [radius * Math.cos((2 * Math.PI * k) / sides), radius * Math.sin((2 * Math.PI * k) / sides)]);

const SQUARE = polygon(4, 5 * Math.SQRT2);
const HEXAGON_AREA = (3 * Math.sqrt(3) * 25) / 2;
/** Area of the 24-gon the mesh uses for a round section of radius r. */
const roundArea = (r: number): number => 12 * Math.sin(Math.PI / 12) * r * r;

interface Case {
  readonly label: string;
  /** Section parameters of sweep_profile. */
  readonly section: Record<string, unknown>;
  readonly start?: number;
  readonly twist: number;
  /** Least distance of the outline from the path through the closing span. */
  readonly reach: number;
  readonly area: number;
  /** Whether the bore (inner ring) is checked as well. */
  readonly bore?: boolean;
}

const CASES: readonly Case[] = [
  { label: 'square, twist 0 -> pi/2', section: { section: SQUARE }, twist: Math.PI / 2, reach: 6.95, area: 100 },
  { label: 'square, twist 0 -> -pi/2', section: { section: SQUARE }, twist: -Math.PI / 2, reach: 6.95, area: 100 },
  { label: 'clockwise square, twist 0 -> pi/2', section: { section: [...SQUARE].reverse() }, twist: Math.PI / 2, reach: 6.95, area: 100 },
  {
    label: 'square, twist pi/4 -> 3 pi/4',
    section: { section: SQUARE },
    start: Math.PI / 4,
    twist: (3 * Math.PI) / 4,
    reach: 6.95,
    area: 100,
  },
  {
    label: 'square with a repeated closing point',
    section: { section: [...SQUARE, SQUARE[0]] },
    twist: Math.PI / 2,
    reach: 6.95,
    area: 100,
  },
  { label: 'hexagon, twist 0 -> pi/3', section: { section: polygon(6, 5) }, twist: Math.PI / 3, reach: 4.95, area: HEXAGON_AREA },
  { label: 'hexagon, twist 0 -> 2 pi/3', section: { section: polygon(6, 5) }, twist: (2 * Math.PI) / 3, reach: 4.95, area: HEXAGON_AREA },
  {
    label: 'hollow round section, twist 0 -> 1.3 rad',
    section: { radius: 5, innerRadius: 2 },
    twist: 1.3,
    reach: 4.85,
    area: roundArea(5) - roundArea(2),
    bore: true,
  },
];

function build(testCase: Case): SweepEntity {
  const result = execute(createEmptyDocument(), 'sweep_profile', {
    path: SQUARE_LOOP,
    closed: true,
    ...testCase.section,
    bendRadius: 15,
    twist: { type: 'linear', start: testCase.start ?? 0, end: testCase.twist },
  });
  expect(result.affected, result.summary).toHaveLength(1);
  return result.document.entities[result.affected[0] as string] as SweepEntity;
}

const signedVolume = (sweep: SweepEntity): number =>
  sweepTriangles(sweep).reduce((sum, [a, b, c]) => {
    const cross = [b[1] * c[2] - b[2] * c[1], b[2] * c[0] - b[0] * c[2], b[0] * c[1] - b[1] * c[0]];
    return sum + (a[0] * cross[0]! + a[1] * cross[1]! + a[2] * cross[2]!) / 6;
  }, 0);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe.each(CASES)('closed sweep, $label', (testCase) => {
  const sweep = build(testCase);

  it('keeps the section reach through the closing span (no pinch)', () => {
    const ts = Array.from({ length: 41 }, (_, k) => 0.9 + k * 0.0025);
    const data = execute({ ...createEmptyDocument(), entities: { [sweep.id]: sweep }, order: [sweep.id] }, 'inspect_sweep', {
      id: sweep.id,
      at: ts,
      outline: true,
    }).data as { samples: Array<{ point: Vec3; outline: Vec3[] }> };
    expect(data.samples).toHaveLength(ts.length);
    for (const { point, outline } of data.samples) {
      const reach = Math.max(...outline.map((p) => Math.hypot(...sub(p, point))));
      expect(reach).toBeGreaterThan(testCase.reach);
    }
  });

  it.each(['outer', 'inner'] as const)('joins the closing wall of the %s ring to matching vertices: one closing span apart', (which) => {
    const loop = sectionLoops(sweep.section)[which];
    if (loop === null) {
      expect(which === 'inner' && testCase.bore !== true).toBe(true);
      return;
    }
    const evaluation = evaluateSweep(sweep);
    if (!('frames' in evaluation)) throw new Error('sweep does not evaluate');
    const last = evaluation.frames.length - 1;
    const lastRing = placeLoop(evaluation, last, loop, [0, 0, 0]);
    const firstRing = placeLoop(evaluation, 0, loop, [0, 0, 0]);
    const key = (p: Vec3): string => p.map((v) => v.toFixed(9)).join(',');
    const lastKeys = new Set(lastRing.map(key));
    const firstKeys = new Set(firstRing.map(key));
    const partner = new Map<string, number>();
    let wall = 0;
    for (const triangle of sweepTriangles(sweep)) {
      const fromLast = triangle.filter((p) => lastKeys.has(key(p)));
      const fromFirst = triangle.filter((p) => firstKeys.has(key(p)));
      if (fromLast.length === 0 || fromFirst.length === 0) continue;
      wall++;
      for (const a of fromLast)
        partner.set(key(a), Math.min(partner.get(key(a)) ?? Infinity, ...fromFirst.map((b) => Math.hypot(...sub(a, b)))));
    }
    expect(wall).toBeGreaterThanOrEqual(loop.length * 2);
    // a mismatched wall pairs a vertex with one a section apart (or, for a round section, a few chords)
    expect(Math.max(...partner.values())).toBeLessThan(1.05 * (1 - (evaluation.fractions[last] as number)) * evaluation.length);
  });

  it('has the closed-form volume area x length (centred section, minimal frames)', () => {
    const evaluation = evaluateSweep(sweep);
    if (!('frames' in evaluation)) throw new Error('sweep does not evaluate');
    const expected = testCase.area * evaluation.length;
    expect(Math.abs(signedVolume(sweep) - expected) / expected).toBeLessThan(2e-3);
  });

  it('turns the outline with twistRad across the closing span', () => {
    const ts = Array.from({ length: 41 }, (_, k) => 0.9 + k * 0.0025);
    const data = execute({ ...createEmptyDocument(), entities: { [sweep.id]: sweep }, order: [sweep.id] }, 'inspect_sweep', {
      id: sweep.id,
      at: ts,
      outline: true,
    }).data as { samples: Array<{ point: Vec3; normal: Vec3; binormal: Vec3; twistRad: number; outline: Vec3[] }> };
    const first = sectionLoops(sweep.section).outer[0] as [number, number];
    const base = Math.atan2(first[1], first[0]);
    for (const sample of data.samples) {
      const offset = sub(sample.outline[0] as Vec3, sample.point);
      const angle = Math.atan2(dot(offset, sample.binormal), dot(offset, sample.normal));
      const difference = angle - (base + sample.twistRad);
      expect(Math.abs(difference - 2 * Math.PI * Math.round(difference / (2 * Math.PI)))).toBeLessThan(0.05);
    }
  });
});

describe('closed sweep twist admission follows the outline, not the vertex set', () => {
  const sweepWith = (section: number[][], end: number): ReturnType<typeof execute> =>
    execute(createEmptyDocument(), 'sweep_profile', {
      path: SQUARE_LOOP,
      closed: true,
      section,
      bendRadius: 15,
      twist: { type: 'linear', start: 0, end },
    });

  it('refuses a quarter turn on a polygon whose vertex set is symmetric but whose outline is not', () => {
    const bowTie = [
      [2, 2],
      [0, 1],
      [-2, 2],
      [-1, 0],
      [-2, -2],
      [0, -1],
      [1, 0],
      [2, -2],
    ];
    const result = sweepWith(bowTie, Math.PI / 2);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('SWG_CLOSED_TWIST_NOT_PERIODIC');
  });

  it('drops a repeated closing point of the section, so the square keeps its four-fold symmetry', () => {
    const result = sweepWith([...SQUARE, SQUARE[0] as number[]], Math.PI / 2);
    expect(result.affected, result.summary).toHaveLength(1);
    const sweep = result.document.entities[result.affected[0] as string] as SweepEntity;
    expect(sweep.section.shape === 'profile' && sweep.section.profile).toHaveLength(4);
  });

  it('drops points 1e-13 apart (float noise) too, so the square stays four-fold', () => {
    const noisy = [...SQUARE, SQUARE[0] as number[]].flatMap((p, i) => (i === 1 ? [p, [(p[0] as number) + 1e-13, p[1] as number]] : [p]));
    const result = sweepWith(noisy, Math.PI / 2);
    expect(result.affected, result.summary).toHaveLength(1);
    const sweep = result.document.entities[result.affected[0] as string] as SweepEntity;
    expect(sweep.section.shape === 'profile' && sweep.section.profile).toHaveLength(4);
  });

  it('refuses a section left with fewer than three distinct points', () => {
    const result = sweepWith(
      [
        [0, 0],
        [0, 0],
        [4, 0],
        [4, 0],
      ],
      0,
    );
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('distinct');
  });
});
