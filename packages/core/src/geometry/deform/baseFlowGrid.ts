/**
 * Sample points for the Jacobian of a flow with a base curve (01 DEF §17.2): the body's own vertices alone miss a fold of the target that falls between them.
 * The grid runs over the arc lengths the body covers on the base, four per interval of the target stations, at the corners of the body's offset range in the base
 * frame: q = P_b(s) + x N_b + y B_b, which the map sends to P_t + x N_t + y B_t with det J = ratio (1 - kt·o) / (1 - kb·o).
 */

import type { Vec3 } from '../../model/vectors';
import { add3, dot3, len3, scale3, sub3 } from '../../lib/vec3';
import { type FlowLaw, baseFrameAt, projectOnBase } from './flow';

/** Grid arc lengths per interval of the target table (a fold is sharpest inside an interval, not at a station) and the most arc lengths of the grid. */
const PER_INTERVAL = 4;
const MAX_STATIONS = 3000;
/** A target interval is sharp when its turn per unit length times the widest offset reaches this; the most such intervals sampled. */
const SHARP = 0.25;
const MAX_SHARP_INTERVALS = 1000;
/** Numbers per station of a frame table (P, T, N, B). */
const STRIDE = 12;

const stationTangent = (law: FlowLaw, k: number): Vec3 => [
  law.stations[k * STRIDE + 3] as number,
  law.stations[k * STRIDE + 4] as number,
  law.stations[k * STRIDE + 5] as number,
];

/**
 * Flat local xyz of the grid for `law` over the body whose vertices are `points` (flat local xyz); empty for a law without a base or a body without vertices.
 */
export function baseFlowGrid(law: FlowLaw, points: ReadonlyArray<number>): number[] {
  const { base } = law;
  if (base === undefined || points.length < 3) return [];
  const range = { s: [Infinity, -Infinity], x: [Infinity, -Infinity], y: [Infinity, -Infinity] } as Record<
    's' | 'x' | 'y',
    [number, number]
  >;
  const widen = (key: 's' | 'x' | 'y', value: number): void => {
    range[key][0] = Math.min(range[key][0], value);
    range[key][1] = Math.max(range[key][1], value);
  };
  for (let i = 0; i + 2 < points.length; i += 3) {
    const q: Vec3 = [points[i] as number, points[i + 1] as number, points[i + 2] as number];
    const s = projectOnBase(base, q);
    const own = baseFrameAt(base, s);
    const gap = sub3(q, own.point);
    widen('s', s);
    widen('x', dot3(gap, own.n));
    widen('y', dot3(gap, own.b));
  }
  const stations = Math.min(MAX_STATIONS, Math.max(2, Math.ceil((PER_INTERVAL * (range.s[1] - range.s[0]) * law.ratio) / law.step) + 1));
  const arcs: number[] = [];
  for (let k = 0; k < stations; k++) arcs.push(range.s[0] + ((range.s[1] - range.s[0]) * k) / (stations - 1));
  // a table with a sharp turn has so many stations that the uniform cap cannot sample every interval: sample the intervals whose turn matters at this width
  // (curvature x the widest offset), the sharpest first
  const reach = Math.max(...range.x.map(Math.abs), ...range.y.map(Math.abs));
  const turns: Array<{ k: number; kappa: number }> = [];
  for (let k = 0; k + 1 < law.stations.length / STRIDE; k++) {
    const turn = len3(sub3(stationTangent(law, k + 1), stationTangent(law, k))) / law.step;
    if (turn * reach >= SHARP) turns.push({ k, kappa: turn });
  }
  turns.sort((x, y) => y.kappa - x.kappa);
  for (const { k } of turns.slice(0, MAX_SHARP_INTERVALS))
    for (let i = 0; i <= PER_INTERVAL; i++) {
      const s = law.z0 + ((k + i / PER_INTERVAL) * law.step) / law.ratio;
      if (s >= range.s[0] && s <= range.s[1]) arcs.push(s);
    }
  const out: number[] = [];
  for (const s of arcs) {
    const own = baseFrameAt(base, s);
    for (const x of range.x) for (const y of range.y) out.push(...add3(own.point, add3(scale3(own.n, x), scale3(own.b, y))));
  }
  return out;
}
