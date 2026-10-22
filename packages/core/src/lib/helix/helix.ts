/** Helix / spiral math: points, derivatives, length, curvature and a cubic Bézier chain within a stated tolerance of the exact curve. */

import type { Vec3 } from '../../model/vectors';
import { lawFunction } from '../law/evaluate';
import type { NurbsCurveData } from '../nurbs/types';
import { add3, cross3, distance3, dot3, len3, normalize3, scale3, sub3 } from '../vec3';
import type { ScalarLaw } from '../law/types';
import type { HelixDefinition } from './types';

const NODES: ReadonlyArray<readonly [number, number]> = [
  [0, 0.5688888888888889],
  [-0.5384693101056831, 0.47862867049936647],
  [0.5384693101056831, 0.47862867049936647],
  [-0.906179845938664, 0.23692688505618908],
  [0.906179845938664, 0.23692688505618908],
];

/** Widest angular span of one Bézier piece, radians (30 degrees: about 4e-7 of the radius for a circle). */
const MAX_SPAN = Math.PI / 6;
/** Times the span count may be doubled to reach the tolerance. */
const MAX_REFINEMENTS = 5;

/** Reference axes ⟂ `axis`: x̂ toward world +X (or +Y when the axis is near X), ŷ = axis × x̂. */
export function helixFrame(axis: Vec3): { x: Vec3; y: Vec3 } {
  const reference: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = normalize3(sub3(reference, scale3(axis, dot3(reference, axis))));
  return { x, y: cross3(axis, x) };
}

/** Total angle, radians. */
const totalAngle = (def: HelixDefinition): number => 2 * Math.PI * def.turns;

const pitchFunctions = new WeakMap<HelixDefinition, (u: number, length: number) => number>();

/** The pitch law compiled once per definition. */
function pitchFunction(def: HelixDefinition, law: ScalarLaw): (u: number, length: number) => number {
  const cached = pitchFunctions.get(def);
  if (cached !== undefined) return cached;
  const compiled = lawFunction(law);
  pitchFunctions.set(def, compiled);
  return compiled;
}

/** Axial advance per turn at turn fraction `u`. */
function pitchAt(def: HelixDefinition, u: number): number {
  if (def.type === 'spiral') return 0;
  return typeof def.pitch === 'number' ? def.pitch : pitchFunction(def, def.pitch)(u, 1);
}

/** Composite 5-point Gauss-Legendre of `f` over [a, b]. */
function integrate(f: (x: number) => number, a: number, b: number, pieces: number): number {
  const h = (b - a) / pieces;
  let sum = 0;
  for (let i = 0; i < pieces; i++) for (const [x, w] of NODES) sum += w * f(a + (i + 0.5) * h + (x * h) / 2) * (h / 2);
  return sum;
}

/** Cumulative height of a pitch-law helix at `HEIGHT_KNOTS` + 1 equally spaced turn fractions (computed once per definition). */
const heightTables = new WeakMap<HelixDefinition, number[]>();
const HEIGHT_KNOTS = 2048;

function heightTable(def: HelixDefinition, pitchLaw: ScalarLaw): number[] {
  const cached = heightTables.get(def);
  if (cached !== undefined) return cached;
  const f = pitchFunction(def, pitchLaw);
  const table = [0];
  for (let i = 0; i < HEIGHT_KNOTS; i++)
    table.push((table[i] as number) + def.turns * integrate((x) => f(x, 1), i / HEIGHT_KNOTS, (i + 1) / HEIGHT_KNOTS, 1));
  heightTables.set(def, table);
  return table;
}

/** Axial height reached at turn fraction `u` (0 for a spiral). */
export function helixHeightAt(def: HelixDefinition, u: number): number {
  if (def.type === 'spiral') return 0;
  if (typeof def.pitch === 'number') return def.pitch * def.turns * u;
  const knot = Math.min(HEIGHT_KNOTS - 1, Math.max(0, Math.floor(u * HEIGHT_KNOTS)));
  const f = pitchFunction(def, def.pitch);
  return (heightTable(def, def.pitch)[knot] as number) + def.turns * integrate((x) => f(x, 1), knot / HEIGHT_KNOTS, u, 1);
}

/** Point and derivative d/dθ at angle `theta`. */
export function helixAt(def: HelixDefinition, theta: number): { point: Vec3; derivative: Vec3 } {
  const total = totalAngle(def);
  const u = theta / total;
  const { x, y } = helixFrame(def.axis);
  const sign = def.handedness === 'right' ? 1 : -1;
  const phi = def.startAngle + sign * theta;
  const radius = def.radius + (def.endRadius - def.radius) * u;
  const slope = (def.endRadius - def.radius) / total;
  const radial = add3(scale3(x, Math.cos(phi)), scale3(y, Math.sin(phi)));
  const azimuthal = add3(scale3(x, -Math.sin(phi)), scale3(y, Math.cos(phi)));
  const point = add3(add3(def.origin, scale3(radial, radius)), scale3(def.axis, helixHeightAt(def, u)));
  const derivative = add3(add3(scale3(radial, slope), scale3(azimuthal, sign * radius)), scale3(def.axis, pitchAt(def, u) / (2 * Math.PI)));
  return { point, derivative };
}

/** Arc length of the helix. */
export function helixLength(def: HelixDefinition): number {
  const total = totalAngle(def);
  return integrate((theta) => len3(helixAt(def, theta).derivative), 0, total, Math.max(8, Math.ceil(def.turns * 64)));
}

/**
 * Exact points and unit tangents at equally spaced ARC-LENGTH fractions (the cumulative length is tabulated at 4096 angle steps and inverted by a
 * local Newton step), so a sweep along the helix has smooth stations independent of how its NURBS chain was cut.
 */
export function helixSamplesAtFractions(def: HelixDefinition, fractions: readonly number[]): Array<{ point: Vec3; tangent: Vec3 }> {
  const total = totalAngle(def);
  const steps = 4096;
  const lengths = [0];
  for (let i = 0; i < steps; i++)
    lengths.push(
      (lengths[i] as number) +
        integrate((theta) => len3(helixAt(def, theta).derivative), (total * i) / steps, (total * (i + 1)) / steps, 1),
    );
  const whole = lengths[steps] as number;
  return fractions.map((f) => {
    const target = Math.min(Math.max(f, 0), 1) * whole;
    let lo = 0;
    let hi = steps;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((lengths[mid] as number) <= target) lo = mid;
      else hi = mid;
    }
    let theta = (total * lo) / steps;
    for (let k = 0; k < 4; k++) {
      const speed = len3(helixAt(def, theta).derivative);
      theta +=
        (target - (lengths[lo] as number) - integrate((x) => len3(helixAt(def, x).derivative), (total * lo) / steps, theta, 1)) / speed;
    }
    const { point, derivative } = helixAt(def, theta);
    return { point, tangent: normalize3(derivative) };
  });
}

/** Smallest curvature radius and the mean torsion (1 / length units), from finite differences of the exact derivative. */
export function helixDifferentials(def: HelixDefinition): { curvatureRadiusMin: number; torsionMean: number } {
  if (def.type === 'helix' && def.radius === def.endRadius && typeof def.pitch === 'number') {
    const lead = def.pitch / (2 * Math.PI);
    const sum = def.radius ** 2 + lead ** 2;
    return { curvatureRadiusMin: sum / def.radius, torsionMean: ((def.handedness === 'right' ? 1 : -1) * lead) / sum };
  }
  const total = totalAngle(def);
  const samples = Math.max(64, Math.ceil(def.turns * 32));
  const h = total * 1e-4;
  let radiusMin = Number.POSITIVE_INFINITY;
  let torsionSum = 0;
  for (let i = 0; i <= samples; i++) {
    const theta = Math.min(total - 2 * h, Math.max(2 * h, (total * i) / samples));
    const d1 = helixAt(def, theta).derivative;
    const d2 = scale3(sub3(helixAt(def, theta + h).derivative, helixAt(def, theta - h).derivative), 1 / (2 * h));
    const d3 = scale3(sub3(add3(helixAt(def, theta + h).derivative, helixAt(def, theta - h).derivative), scale3(d1, 2)), 1 / (h * h));
    const c = cross3(d1, d2);
    radiusMin = Math.min(radiusMin, len3(d1) ** 3 / Math.max(len3(c), 1e-300));
    torsionSum += dot3(c, d3) / Math.max(dot3(c, c), 1e-300);
  }
  return { curvatureRadiusMin: radiusMin, torsionMean: torsionSum / (samples + 1) };
}

/** Distance from `target` to the exact curve between angles `a` and `b` (golden-section search of the nearest angle). */
function distanceToCurve(def: HelixDefinition, target: Vec3, a: number, b: number): number {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let lo = a;
  let hi = b;
  let x1 = hi - ratio * (hi - lo);
  let x2 = lo + ratio * (hi - lo);
  let f1 = distance3(helixAt(def, x1).point, target);
  let f2 = distance3(helixAt(def, x2).point, target);
  for (let i = 0; i < 28; i++) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - ratio * (hi - lo);
      f1 = distance3(helixAt(def, x1).point, target);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + ratio * (hi - lo);
      f2 = distance3(helixAt(def, x2).point, target);
    }
  }
  return Math.min(f1, f2);
}

function bezierPoint(p: readonly Vec3[], t: number): Vec3 {
  const s = 1 - t;
  const w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
  return add3(
    add3(scale3(p[0] as Vec3, w[0] as number), scale3(p[1] as Vec3, w[1] as number)),
    add3(scale3(p[2] as Vec3, w[2] as number), scale3(p[3] as Vec3, w[3] as number)),
  );
}

/** Cubic Bézier poles of `spans` equal angular pieces (4 per piece, joints shared) and the largest probed distance to the exact curve. */
function bezierChain(def: HelixDefinition, spans: number): { poles: Vec3[]; deviation: number } {
  const total = totalAngle(def);
  const step = total / spans;
  const alpha = (4 / 3) * Math.tan(step / 4);
  const poles: Vec3[] = [];
  let deviation = 0;
  for (let k = 0; k < spans; k++) {
    const start = helixAt(def, k * step);
    const end = helixAt(def, (k + 1) * step);
    const piece: Vec3[] = [
      start.point,
      add3(start.point, scale3(start.derivative, alpha)),
      sub3(end.point, scale3(end.derivative, alpha)),
      end.point,
    ];
    poles.push(...(k === 0 ? piece : piece.slice(1)));
    for (const t of [0.25, 0.5, 0.75])
      deviation = Math.max(deviation, distanceToCurve(def, bezierPoint(piece, t), k * step, (k + 1) * step));
  }
  return { poles, deviation };
}

/**
 * The helix as a clamped cubic NURBS (C1 Bézier chain) within `tolerance` of the exact curve; `deviation` is the probed maximum.
 * @failure tolerance not reached after halving the span 5 times -> the best curve found (deviation above tolerance)
 */
export function helixCurve(def: HelixDefinition, tolerance: number): { curve: NurbsCurveData; deviation: number; spans: number } {
  let spans = Math.max(1, Math.ceil(totalAngle(def) / MAX_SPAN - 1e-9));
  let built = bezierChain(def, spans);
  for (let k = 0; k < MAX_REFINEMENTS && built.deviation > tolerance; k++) {
    spans *= 2;
    built = bezierChain(def, spans);
  }
  const knots = Array.from({ length: spans + 1 }, (_, i) => i / spans);
  const multiplicities = knots.map((_, i) => (i === 0 || i === spans ? 4 : 3));
  return { curve: { degree: 3, poles: built.poles, knots, multiplicities }, deviation: built.deviation, spans };
}
