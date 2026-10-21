/**
 * Phase-aligned comparison of two runs of one mechanism at different timesteps (check_dynamics FPR_TIMESTEP_SENSITIVE). The final instant
 * of a fast periodic motion is phase-sensitive, so both runs are resampled onto one grid of the driving joint's angle over the last turn
 * and compared there: speed and position of every joint at the same angle (RMS of the difference over the turn, relative to the peak),
 * plus the cycle-mean |speed|.
 * @invariant returns null (caller falls back to the final-state comparison) when no joint turns monotonically through at least half a turn
 */

import type { SimulationData } from '../sim/simulationReport';

const GRID = 144;
/** Smallest turn of the driving joint (radians) the comparison needs. */
const MIN_TURN = Math.PI;

export interface PhaseChange {
  readonly change: number;
  readonly worstJoint: string | null;
  readonly moved: boolean;
  /** Driving joint and the angle span (radians) of the grid. */
  readonly drivingJoint: string;
  readonly spanRad: number;
}

type Series = NonNullable<SimulationData['series']>;

/** `values` (sampled at `phase`, non-decreasing) at angle `at`, linear between samples. */
function interpolate(phase: readonly number[], values: readonly number[], at: number): number {
  let low = 0;
  let high = phase.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if ((phase[middle] ?? 0) <= at) low = middle;
    else high = middle;
  }
  const [p0, p1] = [phase[low] ?? 0, phase[high] ?? 0];
  const [v0, v1] = [values[low] ?? 0, values[high] ?? 0];
  return p1 > p0 ? v0 + ((v1 - v0) * (at - p0)) / (p1 - p0) : v0;
}

/** The angle series of `id` made non-decreasing (a joint turning the other way is negated), or null when it does not turn one way. */
function monotonic(series: readonly number[]): number[] | null {
  const first = series[0] ?? 0;
  const last = series[series.length - 1] ?? 0;
  const sign = last >= first ? 1 : -1;
  const scale = Math.max(1e-12, Math.abs(last - first));
  const out = series.map((value) => sign * value);
  for (let i = 1; i < out.length; i++) if ((out[i] ?? 0) < (out[i - 1] ?? 0) - 1e-6 * scale) return null;
  return out;
}

export function phaseAlignedChange(a: SimulationData, b: SimulationData): PhaseChange | null {
  const [sa, sb] = [a.series, b.series];
  if (sa === undefined || sb === undefined) return null;
  let driver: { id: string; pa: number[]; pb: number[]; travel: number } | null = null;
  for (const id of Object.keys(sa.jointPosition)) {
    const [ra, rb] = [sa.jointPosition[id], sb.jointPosition[id]];
    if (ra === undefined || rb === undefined || ra.length < 2 || rb.length < 2) continue;
    const [pa, pb] = [monotonic(ra), monotonic(rb)];
    if (pa === null || pb === null) continue;
    const travel = Math.min((pa[pa.length - 1] ?? 0) - (pa[0] ?? 0), (pb[pb.length - 1] ?? 0) - (pb[0] ?? 0));
    if (travel >= MIN_TURN && (driver === null || travel > driver.travel)) driver = { id, pa, pb, travel };
  }
  if (driver === null) return null;
  const { pa, pb } = driver;
  const hi = Math.min(pa[pa.length - 1] ?? 0, pb[pb.length - 1] ?? 0);
  const lo = Math.max(hi - 2 * Math.PI, pa[0] ?? 0, pb[0] ?? 0);
  if (hi - lo < MIN_TURN) return null;
  const grid = Array.from({ length: GRID }, (_, k) => lo + ((hi - lo) * k) / (GRID - 1));
  const sample = (phase: number[], series: Series, kind: 'jointVelocity' | 'jointPosition', id: string): number[] | null => {
    const values = series[kind][id];
    return values === undefined ? null : grid.map((angle) => interpolate(phase, values, angle));
  };
  let change = 0;
  let worstJoint: string | null = null;
  let moved = false;
  for (const id of Object.keys(sa.jointVelocity)) {
    const [va, vb] = [sample(pa, sa, 'jointVelocity', id), sample(pb, sb, 'jointVelocity', id)];
    const [xa, xb] = [sample(pa, sa, 'jointPosition', id), sample(pb, sb, 'jointPosition', id)];
    if (va === null || vb === null || xa === null || xb === null) continue;
    const peak = Math.max(...va.map(Math.abs), ...vb.map(Math.abs));
    const reach = Math.max(...xa.map(Math.abs), ...xb.map(Math.abs));
    const rms = (p: number[], q: number[]): number =>
      Math.sqrt(p.reduce((sum, value, i) => sum + (value - (q[i] ?? 0)) ** 2, 0) / p.length);
    const meanAbs = (p: number[]): number => p.reduce((sum, value) => sum + Math.abs(value), 0) / p.length;
    const speed = peak > 1e-9 ? rms(va, vb) / peak : 0;
    // positions are compared as excursions about their cycle mean, so a joint far from zero is not diluted by its offset
    const [ma, mb] = [xa.reduce((s, v) => s + v, 0) / xa.length, xb.reduce((s, v) => s + v, 0) / xb.length];
    const excursion = Math.max(...xa.map((v) => Math.abs(v - ma)), ...xb.map((v) => Math.abs(v - mb)));
    const position =
      excursion > 1e-9
        ? rms(
            xa.map((v) => v - ma),
            xb.map((v) => v - mb),
          ) / excursion
        : 0;
    const mean = Math.max(meanAbs(va), meanAbs(vb)) > 1e-9 ? Math.abs(meanAbs(va) - meanAbs(vb)) / Math.max(meanAbs(va), meanAbs(vb)) : 0;
    if (peak > 1e-9 || reach > 1e-9) moved = true;
    const worst = Math.max(speed, position, mean);
    if (worst > change) {
      change = worst;
      worstJoint = id;
    }
  }
  return { change, worstJoint, moved, drivingJoint: driver.id, spanRad: hi - lo };
}
