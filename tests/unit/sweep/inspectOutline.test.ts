/** inspect_sweep `outline`: every outline point lies on the surface the viewport draws (sweepTriangles of the whole entity). */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type SweepEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { sweepTriangles } from '@core/geometry/sweep';
import { isClosedChain, segmentPoint } from '@core/geometry/curveSegments';
import { evaluateSweep } from '@core/geometry/sweepEval/evaluate';
import { mixTransforms } from '@core/geometry/sweepEval/sectionTransform';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function toSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-30)));
  return Math.hypot(...sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
}

function toTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const n = cross(sub(b, a), sub(c, a));
  const length = Math.hypot(...n);
  const edges = Math.min(toSegment(p, a, b), toSegment(p, b, c), toSegment(p, c, a));
  if (length < 1e-14) return edges;
  const d = dot(sub(p, a), n) / length;
  const q: Vec3 = [p[0] - (n[0] * d) / length, p[1] - (n[1] * d) / length, p[2] - (n[2] * d) / length];
  const inside =
    dot(cross(sub(b, a), sub(q, a)), n) >= 0 && dot(cross(sub(c, b), sub(q, b)), n) >= 0 && dot(cross(sub(a, c), sub(q, c)), n) >= 0;
  return inside ? Math.abs(d) : edges;
}

const RECT = [
  [-10, -2.5],
  [10, -2.5],
  [10, 2.5],
  [-10, 2.5],
];
const U_PATH = [
  [0, 0, 0],
  [0, 50, 0],
  [50, 50, 0],
  [50, 0, 0],
];
const L_PATH = [
  [0, 0, 0],
  [0, 50, 0],
  [50, 50, 0],
];

function build(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; sweep: SweepEntity } {
  const result = execute(doc, command, params);
  expect(result.affected, result.summary).toHaveLength(1);
  return { doc: result.document, sweep: result.document.entities[result.affected[0] as string] as SweepEntity };
}

function railsDoc(): CadDocument {
  let doc = createEmptyDocument();
  for (const points of [
    [
      [0, 10, 0],
      [100, 5, 0],
    ],
    [
      [0, -10, 0],
      [100, -5, 0],
    ],
  ])
    doc = execute(doc, 'interpolate_curve', { points, degree: 1 }).document;
  return doc;
}

interface Case {
  readonly label: string;
  readonly make: () => { doc: CadDocument; sweep: SweepEntity };
  readonly at?: number[];
  readonly tolerance: number;
  /** The section is centred on the path: its outline centroid is the reported point, which is the path point at arc length t L. */
  readonly centred?: boolean;
}

const empty = createEmptyDocument();

const SQUARE_LOOP = [
  [0, 0, 0],
  [50, 0, 0],
  [50, 50, 0],
  [0, 50, 0],
];

/** Smallest span between two consecutive frames, closing span included, in document units. */
function minFrameStep(sweep: SweepEntity): number {
  const evaluation = evaluateSweep(sweep);
  if (!('frames' in evaluation)) throw new Error('sweep does not evaluate');
  const knots = isClosedChain(sweep.path) ? [...evaluation.fractions, 1] : evaluation.fractions;
  return Math.min(...knots.slice(1).map((f, k) => (f - (knots[k] as number)) * evaluation.length));
}

/** Path point at arc length `s` (a fine polyline of the path's own segments, independent of the sweep frames). */
function pathPointAtArc(path: SweepEntity['path'], fraction: number): Vec3 {
  const points = path.flatMap((segment) => Array.from({ length: 400 }, (_, k) => segmentPoint(segment, k / 400)));
  const last = path[path.length - 1];
  if (last !== undefined) points.push(segmentPoint(last, 1));
  const lengths = [0];
  for (let k = 1; k < points.length; k++)
    lengths.push((lengths[k - 1] as number) + Math.hypot(...sub(points[k] as Vec3, points[k - 1] as Vec3)));
  const target = fraction * (lengths[lengths.length - 1] as number);
  let k = 1;
  while (k < points.length - 1 && (lengths[k] as number) < target) k++;
  const [a, b] = [points[k - 1] as Vec3, points[k] as Vec3];
  const span = (lengths[k] as number) - (lengths[k - 1] as number);
  const u = span > 0 ? (target - (lengths[k - 1] as number)) / span : 0;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

const CASES: readonly Case[] = [
  {
    label: 'closed square loop with one full twist turn, samples at the wrap',
    centred: true,
    make: () => build(empty, 'sweep_profile', { path: SQUARE_LOOP, closed: true, section: RECT, bendRadius: 15, twistTurns: 1 }),
    at: [0, 0.3, 0.7, 0.95, 0.999, 1],
    tolerance: 1e-6,
  },
  {
    label: 'closed square loop, samples at the wrap',
    centred: true,
    make: () => build(empty, 'sweep_profile', { path: SQUARE_LOOP, closed: true, section: RECT, bendRadius: 15 }),
    at: [0, 0.3, 0.7, 0.95, 0.999, 1],
    tolerance: 1e-6,
  },
  {
    label: 'twist and scale laws on a U bend',
    make: () =>
      build(empty, 'sweep_profile', {
        path: U_PATH,
        section: RECT,
        bendRadius: 20,
        twist: { type: 'linear', start: 0, end: 1.5 },
        scale: { type: 'linear', start: 1, end: 0.5 },
      }),
    tolerance: 1e-6,
  },
  {
    // the minimum frame step here is a whole 50-unit leg, so the point bound (0.1 step = 5) only catches a one-span error (50)
    label: 'mitre joint, with samples on the joint',
    centred: true,
    make: () => build(empty, 'sweep_profile', { path: L_PATH, section: RECT, corners: 'miter' }),
    at: [0, 0.25, 0.4999, 0.5, 0.5001, 0.75, 1],
    tolerance: 1e-6,
  },
  {
    label: 'fixed orientation on a rising path',
    make: () =>
      build(empty, 'sweep_profile', {
        path: [
          [0, 0, 0],
          [0, 50, 10],
          [50, 50, 20],
        ],
        section: RECT,
        bendRadius: 20,
        orientation: { mode: 'fixed', direction: [0, 0, 1] },
      }),
    tolerance: 1e-6,
  },
  {
    label: 'axial screw frame (axis_plane)',
    make: () =>
      build(empty, 'sweep_profile', {
        path: [
          [20, 0, 0],
          [0, 20, 5],
          [-20, 0, 10],
          [0, -20, 15],
        ],
        smooth: true,
        section: [
          [16, -1],
          [24, -1],
          [24, 1],
          [16, 1],
        ],
        sectionFrame: 'axial',
        orientation: { mode: 'axis_plane', direction: [0, 0, 1], axisPoint: [0, 0, 0], sectionFrame: 'axial' },
      }),
    tolerance: 1e-6,
  },
  {
    label: 'add_coil',
    centred: true,
    make: () => build(empty, 'add_coil', { radius: 20, pitch: 10, turns: 2, sectionRadius: 1.5 }),
    tolerance: 1e-6,
  },
  {
    label: 'stations',
    make: () =>
      build(empty, 'sweep_profile', {
        path: L_PATH,
        bendRadius: 20,
        stations: [
          { at: 0, radius: 5 },
          { at: 1, radiusX: 10, radiusY: 3 },
        ],
      }),
    tolerance: 1e-6,
  },
  {
    label: 'two rails',
    make: () => {
      const doc = railsDoc();
      const ids = doc.order.slice(0, 2);
      return build(doc, 'sweep_profile', {
        guideIds: ids,
        radius: 10,
        anchors: [
          [10, 0],
          [-10, 0],
        ],
      });
    },
    tolerance: 1e-6,
  },
];

describe('inspect_sweep outline lies on the displayed sweep', () => {
  it.each(CASES)('$label', ({ make, at, tolerance, centred }) => {
    const { doc, sweep } = make();
    const triangles = sweepTriangles(sweep);
    expect(triangles.length).toBeGreaterThan(0);
    const result = execute(doc, 'inspect_sweep', { id: sweep.id, outline: true, ...(at === undefined ? { samples: 13 } : { at }) });
    const samples = (result.data as { samples: Array<{ t: number; point: Vec3; outline: Vec3[] }> }).samples;
    let worst = 0;
    for (const { t, point, outline } of samples) {
      for (const p of outline) worst = Math.max(worst, Math.min(...triangles.map(([a, b, c]) => toTriangle(p, a, b, c))));
      if (centred !== true) continue;
      const mean = outline.reduce((sum, p) => [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]] as Vec3, [0, 0, 0] as Vec3);
      const centroid: Vec3 = [mean[0] / outline.length, mean[1] / outline.length, mean[2] / outline.length];
      expect(Math.hypot(...sub(centroid, point)), `centroid at t=${t}`).toBeLessThan(1e-6);
      expect(Math.hypot(...sub(point, pathPointAtArc(sweep.path, t))), `point at t=${t}`).toBeLessThan(0.1 * minFrameStep(sweep));
    }
    expect(worst).toBeLessThan(tolerance);
  });
});

describe('inspect_sweep on a closed path wraps', () => {
  it('t = 1 is t = 0, and t = 0.999 lies between the last ring and ring 0', () => {
    const { doc, sweep } =
      CASES[0]?.make() ??
      (() => {
        throw new Error('no closed case');
      })();
    const read = (t: number): { point: Vec3; outline: Vec3[] } =>
      (execute(doc, 'inspect_sweep', { id: sweep.id, at: [t], outline: true }).data as { samples: Array<{ point: Vec3; outline: Vec3[] }> })
        .samples[0] as { point: Vec3; outline: Vec3[] };
    const [start, end, near] = [read(0), read(1), read(0.999)];
    expect(end.point).toEqual(start.point);
    expect(end.outline).toEqual(start.outline);
    expect(Math.hypot(...sub(near.point, pathPointAtArc(sweep.path, 0.999)))).toBeLessThan(0.1 * minFrameStep(sweep));
    expect(Math.hypot(...sub(near.point, read(0.9).point))).toBeGreaterThan(1);
  });
});

describe('inspect_sweep twist on a closed path', () => {
  it('rises monotonically across the closing span to the law value at t = 1 (one turn), where the section is frame 0 again', () => {
    const { doc, sweep } = build(empty, 'sweep_profile', { path: SQUARE_LOOP, closed: true, section: RECT, bendRadius: 15, twistTurns: 1 });
    const ts = Array.from({ length: 41 }, (_, k) => 0.9 + k * 0.0025);
    const samples = (
      execute(doc, 'inspect_sweep', { id: sweep.id, at: ts, outline: true }).data as {
        samples: Array<{ twistRad: number; outline: Vec3[] }>;
      }
    ).samples;
    const twist = samples.map((sample) => sample.twistRad);
    twist.slice(1).forEach((value, k) => expect(value, `t=${ts[k + 1]}`).toBeGreaterThanOrEqual(twist[k] as number));
    expect(twist[twist.length - 1]).toBeCloseTo(2 * Math.PI, 9);
    const start = (execute(doc, 'inspect_sweep', { id: sweep.id, at: [0], outline: true }).data as { samples: Array<{ outline: Vec3[] }> })
      .samples[0] as { outline: Vec3[] };
    samples[samples.length - 1]?.outline.forEach((p, k) => expect(Math.hypot(...sub(p, start.outline[k] as Vec3))).toBeLessThan(1e-6));
  });
});

describe('inspect_sweep twist with a start offset and a negative total on a closed path', () => {
  it('decreases monotonically from 0.3 to exactly 0.3 - 2 pi', () => {
    const end = 0.3 - 2 * Math.PI;
    const { doc, sweep } = build(empty, 'sweep_profile', {
      path: SQUARE_LOOP,
      closed: true,
      section: RECT,
      bendRadius: 15,
      twist: { type: 'linear', start: 0.3, end },
    });
    const ts = Array.from({ length: 41 }, (_, k) => 0.9 + k * 0.0025);
    const twist = (execute(doc, 'inspect_sweep', { id: sweep.id, at: ts }).data as { samples: Array<{ twistRad: number }> }).samples.map(
      (sample) => sample.twistRad,
    );
    twist.slice(1).forEach((value, k) => expect(value, `t=${ts[k + 1]}`).toBeLessThanOrEqual(twist[k] as number));
    expect(twist[twist.length - 1]).toBeCloseTo(end, 9);
  });
});

describe('mixTransforms', () => {
  it('promotes a side without an affine to its law matrix, so a mitre stretch survives the mix', () => {
    const law = { twist: Math.PI / 2, sx: 2, sy: 1 };
    const affine = { twist: 0, sx: 1, sy: 1, affine: [3, 0, 0, 3, 1, 1] as const };
    const mixed = mixTransforms(law, affine, 0.5);
    const lawMatrix = [0, -1, 2, 0, 0, 0];
    expect(mixed.affine).toEqual(lawMatrix.map((v, k) => expect.closeTo((v + (affine.affine[k] as number)) / 2, 12)));
    expect(mixTransforms(law, law, 0.5).affine).toBeUndefined();
  });
});
