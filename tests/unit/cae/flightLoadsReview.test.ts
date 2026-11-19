/**
 * 14 FLL-M2b review fixes: the planar / thin hull keeps its distance bound, the C3D10 body-force shares over the real geometry, the envelope
 * case cap, orphan-free re-export of a coarser envelope and the rotor-spin refusal reason, on synthetic runs fed through the registry.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute, getCommand } from '@core/commands/registry';
import type { CommandDefinition, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { convexEnvelopeIndices } from '@cae/flightLoads/convexEnvelope';
import { bodyForceShares } from '@cae/flightLoads/tetShares';
import { expectNoOp } from '../../helpers/expectNoOp';
import { barDocument } from './deckFixtures';

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const diagonal = (points: readonly Vec3[]): number =>
  Math.hypot(
    ...[0, 1, 2].map((k) => {
      const values = points.map((p) => p[k as 0 | 1 | 2]);
      return values.reduce((a, b) => Math.max(a, b), -Infinity) - values.reduce((a, b) => Math.min(a, b), Infinity);
    }),
  );
const directions = (n: number): Vec3[] =>
  Array.from({ length: n }, (_, k) => {
    const z = 1 - (2 * (k + 0.5)) / n;
    const r = Math.sqrt(1 - z * z);
    const phi = k * Math.PI * (3 - Math.sqrt(5));
    return [r * Math.cos(phi), r * Math.sin(phi), z];
  });
/** Largest shortfall of the support function of the chosen points against all points (a lower bound of the largest distance to their hull). */
function supportGap(points: readonly Vec3[], chosen: readonly number[]): number {
  let gap = 0;
  for (const u of [...directions(400), [1, 0, 0] as Vec3, [0, 0, 1] as Vec3, [-1, 0, 0] as Vec3, [0, 0, -1] as Vec3]) {
    const all = points.reduce((best, p) => Math.max(best, dot(u, p)), -Infinity);
    const kept = chosen.reduce((best, index) => Math.max(best, dot(u, points[index] ?? [0, 0, 0])), -Infinity);
    gap = Math.max(gap, all - kept);
  }
  return gap;
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Exact distance from p to the segment a b. */
function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const e = sub3(b, a);
  const length2 = dot(e, e);
  const t = length2 > 0 ? Math.min(1, Math.max(0, dot(sub3(p, a), e) / length2)) : 0;
  return norm3(sub3(p, [a[0] + t * e[0], a[1] + t * e[1], a[2] + t * e[2]]));
}

/** Exact distance from p to the triangle a b c (a degenerate one by its edges). */
function triangleDistance(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const n = cross3(sub3(b, a), sub3(c, a));
  const area2 = norm3(n);
  const edges = Math.min(segmentDistance(p, a, b), segmentDistance(p, b, c), segmentDistance(p, c, a));
  if (!(area2 > 1e-14)) return edges;
  const unitN: Vec3 = [n[0] / area2, n[1] / area2, n[2] / area2];
  const h = dot(sub3(p, a), unitN);
  const q = sub3(p, [unitN[0] * h, unitN[1] * h, unitN[2] * h]);
  const inside = [
    [a, b],
    [b, c],
    [c, a],
  ].every(([x, y]) => dot(cross3(sub3(y as Vec3, x as Vec3), sub3(q, x as Vec3)), unitN) >= 0);
  return inside ? Math.abs(h) : edges;
}

/**
 * An upper bound of the Euclidean distance from every sample to the hull of the chosen ones, exact for a sample outside it: the minimum over
 * every triangle (and segment) of chosen vertices (the hull boundary is a union of such triangles).
 */
function largestHullDistance(points: readonly Vec3[], chosen: readonly number[]): number {
  const vertices = chosen.map((index): Vec3 => points[index] ?? [0, 0, 0]);
  let worst = 0;
  for (const p of points) {
    let best = vertices.reduce((d, v) => Math.min(d, norm3(sub3(p, v))), Infinity);
    for (let i = 0; i < vertices.length; i++)
      for (let j = i + 1; j < vertices.length; j++) {
        const [a, b] = [vertices[i] as Vec3, vertices[j] as Vec3];
        best = Math.min(best, segmentDistance(p, a, b));
        for (let k = j + 1; k < vertices.length; k++) best = Math.min(best, triangleDistance(p, a, b, vertices[k] as Vec3));
      }
    worst = Math.max(worst, best);
  }
  return worst;
}

/** Exact largest distance from samples in the z = 0 plane to the 2D convex hull of the chosen ones (monotone chain of the chosen). */
function largestPlanarDistance(points: readonly Vec3[], chosen: readonly number[]): number {
  const sorted = chosen.map((index): Vec3 => points[index] ?? [0, 0, 0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross2 = (o: Vec3, a: Vec3, b: Vec3): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (list: readonly Vec3[]): Vec3[] => {
    const out: Vec3[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross2(out[out.length - 2] as Vec3, out[out.length - 1] as Vec3, p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  const ring = [...chain(sorted), ...chain([...sorted].reverse())];
  let worst = 0;
  for (const p of points) {
    const outside = ring.some((a, k) => cross2(a, ring[(k + 1) % ring.length] as Vec3, p) < 0);
    if (!outside) continue;
    worst = Math.max(
      worst,
      ring.reduce((d, a, k) => Math.min(d, segmentDistance(p, a, ring[(k + 1) % ring.length] as Vec3)), Infinity),
    );
  }
  return worst;
}

describe('convex envelope of a flat cloud (the planar branch)', () => {
  const arc = (count: number, sweep: number, wobble = 0): Vec3[] =>
    Array.from({ length: count }, (_, k) => {
      const angle = (sweep * k) / (count - 1);
      return [10 * Math.cos(angle), wobble * Math.sin(37 * k), 9.81 + 10 * Math.sin(angle)];
    });

  it('a sampled half circle in x-z keeps its apex and every sample within the tolerance (the chord alone is 10 away)', () => {
    const points = arc(401, Math.PI);
    const chosen = convexEnvelopeIndices(points, 0.02);
    expect(chosen).toContain(200);
    expect(chosen.length).toBeGreaterThan(4);
    expect(chosen.length).toBeLessThan(40);
    expect(supportGap(points, chosen)).toBeLessThanOrEqual(0.02 * diagonal(points));
  });

  it('a full circle is a polygon, not a segment, and bounds every sample at the default tolerance', () => {
    const points = arc(720, 2 * Math.PI * (719 / 720));
    const chosen = convexEnvelopeIndices(points, 0.02);
    expect(chosen.length).toBeGreaterThan(6);
    expect(supportGap(points, chosen)).toBeLessThanOrEqual(0.02 * diagonal(points));
  });

  it('points on the edges of a flat square leave only its four corners (collinear vertices are pruned)', () => {
    const edge: Vec3[] = [];
    for (let k = 1; k < 40; k++) {
      const t = (k * 0.618034) % 1;
      edge.push([4 * t, 0, 0], [4, 0, 3 * t], [4 * t, 0, 3], [0, 0, 3 * t]);
    }
    const corners: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 3],
      [0, 0, 3],
    ];
    const points = [...edge.slice(0, 50), ...corners, ...edge.slice(50)];
    expect(convexEnvelopeIndices(points, 1e-12).map((index) => points[index])).toEqual(expect.arrayContaining(corners));
    expect(convexEnvelopeIndices(points, 1e-12)).toHaveLength(4);
  });

  it('a thin 3D cloud (off-plane wobble below the flat threshold) is hulled in its plane and still bounded in 3D', () => {
    const points = arc(401, Math.PI, 0.05);
    const chosen = convexEnvelopeIndices(points, 0.02);
    expect(largestHullDistance(points, chosen)).toBeLessThanOrEqual(0.02 * diagonal(points));
    expect(chosen.length).toBeLessThan(40);
  });

  it('a flat cloud whose samples straddle the plane (+h at the hull edge, -h beyond it) stays within eps in 3D (round 2 regression)', () => {
    const cloud = (h: number, d: number): Vec3[] => [
      [-10, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
      [5, -8, h],
      [-5, -8, h],
      [0, -8 - d, -h],
    ];
    let points = cloud(0, 0);
    for (let k = 0; k < 5; k++) {
      const step = (0.99 * 0.02 * diagonal(points)) / Math.SQRT2;
      points = cloud(step, step);
    }
    const eps = 0.02 * diagonal(points);
    const chosen = convexEnvelopeIndices(points, 0.02);
    expect(largestHullDistance(points, chosen)).toBeLessThanOrEqual(eps * (1 + 1e-9));
  });

  it('collinear pruning does not drift: noisy samples on a line in the plane stay within eps plus the 1e-9 floor (seeded)', () => {
    let worst = 0;
    for (let seed = 1; seed <= 40; seed++) {
      let state = seed;
      const random = (): number => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
      };
      const points: Vec3[] = Array.from({ length: 300 }, () => {
        const x = 20 * random() - 10;
        return [x, 0.5 * x + 1e-7 * (random() - 0.5), 0];
      });
      const chosen = convexEnvelopeIndices(points, 1e-12);
      const allowed = (1e-12 + 1e-9) * diagonal(points);
      worst = Math.max(worst, largestPlanarDistance(points, chosen) / allowed);
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
});

describe('bodyForceShares (consistent body force, integral of N_i det J)', () => {
  const corners: Vec3[] = [
    [0, 0, 0],
    [2, 0, 0],
    [0, 3, 0],
    [0, 0, 1],
  ];
  const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const [p1, p2, p3, p4] = corners as [Vec3, Vec3, Vec3, Vec3];
  const straight: Vec3[] = [...corners, mid(p1, p2), mid(p2, p3), mid(p3, p1), mid(p1, p4), mid(p2, p4), mid(p3, p4)];
  const volume = 1;

  it('a straight C3D10 gets -V/20 per corner and V/5 per mid node; a C3D4 V/4; others are not handled', () => {
    const shares = bodyForceShares('C3D10', straight) ?? [];
    shares.slice(0, 4).forEach((share) => expect(share).toBeCloseTo(-volume / 20, 12));
    shares.slice(4).forEach((share) => expect(share).toBeCloseTo(volume / 5, 12));
    expect(bodyForceShares('C3D4', corners)).toEqual([0.25, 0.25, 0.25, 0.25].map((k) => expect.closeTo(k * volume, 12)));
    expect(bodyForceShares('S3', corners.slice(0, 3))).toBeNull();
    expect(bodyForceShares('C3D10', corners)).toBeNull();
  });

  it('a curved C3D10 (a boundary mid node pushed out) gets its own shares, summing to its larger volume', () => {
    const curved = straight.map((p, k): Vec3 => (k === 5 ? [p[0] + 0.2, p[1] + 0.3, p[2]] : p));
    const shares = bodyForceShares('C3D10', curved) ?? [];
    const total = shares.reduce((sum, share) => sum + share, 0);
    expect(total).toBeGreaterThan(volume * 1.01);
    // the moved node (mid of edge 2-3) takes more than V/5, the straight rule would be wrong
    expect(shares[5]).toBeGreaterThan(volume / 5 + 0.01);
  });

  it('refuses a folded C3D10 (det J changes sign between Gauss points) and a flat C3D4; a consistently inverted element keeps |det J|', () => {
    const folded = straight.map((p, k): Vec3 => (k === 4 ? [p[0], p[1] - 1.6, p[2] + 1.6] : p));
    expect(bodyForceShares('C3D10', folded)).toBeNull();
    expect(
      bodyForceShares('C3D4', [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
        [0, 0, 1],
      ]),
    ).toBeNull();
    // swapping corners 2 and 3 (and the mid nodes that follow them) mirrors the order: det J < 0 everywhere, same shares
    const order = [0, 2, 1, 3, 6, 5, 4, 7, 9, 8];
    const mirrored = order.map((k) => straight[k] as Vec3);
    const shares = bodyForceShares('C3D10', mirrored) ?? [];
    const reference = bodyForceShares('C3D10', straight) ?? [];
    order.forEach((k, position) => expect(shares[position]).toBeCloseTo(reference[k] ?? Number.NaN, 12));
  });
});

describe('export_flight_loads on a synthetic run (run_flight replaced in the registry)', () => {
  const bar = barDocument({ supports: false });

  /** A series whose acceleration traces `accel(k)` (velocity = running sum), with one rotor r1. */
  function series(count: number, accel: (k: number) => Vec3): Record<string, unknown> {
    const dt = 0.001;
    const times = Array.from({ length: count }, (_, k) => k * dt);
    const velocity: Vec3[] = [];
    let v: Vec3 = [0, 0, 0];
    for (let k = 0; k < count; k++) {
      const a = accel(k);
      v = [v[0] + a[0] * dt, v[1] + a[1] * dt, v[2] + a[2] * dt];
      velocity.push(v);
    }
    return {
      times,
      velocityMps: velocity,
      attitudeDeg: times.map(() => [0, 0, 0]),
      bodyRateDegS: times.map(() => [0, 0, 0]),
      rotors: { r1: { thrustN: times.map(() => 1), rpm: times.map(() => 6000), shaftPowerW: times.map(() => 10) } },
    };
  }

  function contextFor(data: Record<string, unknown>, inspect = true): ExecutionContext {
    const base = defaultContext();
    const real = getCommand('run_flight');
    if (real === undefined) throw new Error('run_flight is not registered');
    const fake = {
      ...real,
      run: (doc: CadDocument) => ({ document: doc, summary: 'synthetic run', affected: [], data: { series: data } }),
    };
    return {
      ...base,
      registry: (name) =>
        name === 'run_flight'
          ? (fake as unknown as CommandDefinition<unknown>)
          : !inspect && name === 'inspect_dynamics'
            ? undefined
            : base.registry(name),
    };
  }

  /** Points on a sphere of radius 5 m/s^2 (a spiral over it): every sample is a hull vertex. */
  const sphere = (k: number, count: number): Vec3 => {
    const z = 1 - (2 * (k + 0.5)) / count;
    const r = Math.sqrt(1 - z * z);
    const phi = k * 0.7;
    return [5 * r * Math.cos(phi), 5 * r * Math.sin(phi), 5 * z];
  };

  it('refuses more than 48 hull vertex instants (FLL_ENVELOPE_TOO_LARGE) and accepts the same run at a coarse tolerance', () => {
    const ctx = contextFor(series(400, (k) => sphere(k, 400)));
    const params = { analysisId: bar.analysisId, scenario: 's', at: 'convex_envelope' };
    const fine = execute(bar.doc, 'export_flight_loads', { ...params, envelopeTolerance: 1e-6 }, ctx);
    expectNoOp(fine, bar.doc);
    expect(fine.error?.code).toBe('FLL_ENVELOPE_TOO_LARGE');
    expect(fine.summary).toMatch(/at most 48 load cases/);
    const coarse = execute(bar.doc, 'export_flight_loads', { ...params, envelopeTolerance: 0.3 }, ctx);
    expect(coarse.rejected, coarse.summary).not.toBe(true);
  });

  it('re-exporting a coarser envelope of the same scenario removes the earlier _hull_k cases it no longer has; other scenarios stay', () => {
    const ctx = contextFor(series(400, (k) => sphere(k, 400)));
    const params = { analysisId: bar.analysisId, scenario: 's', at: 'convex_envelope' };
    const cases = (doc: CadDocument): string[] => [
      ...new Set(Object.values(doc.analysis?.cases[bar.analysisId]?.loads ?? {}).map((load) => load.loadCase)),
    ];
    const fine = execute(bar.doc, 'export_flight_loads', { ...params, envelopeTolerance: 0.05 }, ctx).document;
    const other = execute(fine, 'export_flight_loads', { ...params, scenario: 'other', at: 'peak_load' }, ctx).document;
    const coarse = execute(other, 'export_flight_loads', { ...params, envelopeTolerance: 0.4 }, ctx).document;
    const before = cases(fine).filter((name) => name.startsWith('FLT_s_hull_'));
    const after = cases(coarse).filter((name) => name.startsWith('FLT_s_hull_'));
    expect(after.length).toBeLessThan(before.length);
    expect(after).toEqual(after.map((_, k) => `FLT_s_hull_${k + 1}`));
    expect(cases(coarse)).toContain('FLT_other_peak');
  });

  it('carries the reason the rotor spins could not be read into the mount refusal', () => {
    const ctx = contextFor(
      series(10, () => [0, 0, 1]),
      false,
    );
    const result = execute(
      bar.doc,
      'export_flight_loads',
      {
        analysisId: bar.analysisId,
        scenario: 's',
        mounts: [
          { name: 'm', rotorId: 'r1', direction: [0, 0, 1], reactionTorque: true, target: { entityId: bar.boxId, facesNear: [[1, 0, 0]] } },
        ],
      },
      ctx,
    );
    expectNoOp(result, bar.doc);
    expect(result.error?.code).toBe('FLL_MOUNT_INVALID');
    expect(result.summary).toContain('the rotor spins could not be read: inspect_dynamics is not registered');
  });
});
