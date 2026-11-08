/**
 * Mixer of the flight controller (TR-FLT-05): the effectiveness of each rotor's thrust on [collective thrust, roll, pitch, yaw torque] from the
 * rotor geometry, its pseudo-inverse, the rank check (FLT_MIXER_RANK) and the allocation of a demand within the rotor thrust limits.
 */

import type { Vec3 } from '@core/model/vectors';
import { invertDense } from '@lib/denseLinalg';
import { cross3, dot3, scale3, sub3 } from '@lib/vec3';

/** One rotor as the mixer sees it: body axes at the modelled pose, arm from the centre of mass in metres. */
export interface MixerRotor {
  readonly arm: Vec3;
  /** Unit thrust axis. */
  readonly axis: Vec3;
  /** +1 for 'ccw' (reaction torque about -axis), -1 for 'cw'. */
  readonly spin: number;
  /** m: reaction torque per newton of thrust at J = 0, Q/T = C_P·D / (2π·C_T). */
  readonly torquePerThrust: number;
}

export type MixerRow = readonly [number, number, number, number];

/** Relative pivot below which a row of the (row-normalised) effectiveness matrix is dependent on the others. */
const RANK_TOLERANCE = 1e-9;

/**
 * 4 × N effectiveness B: column i = [a_i · t, r_i × a_i - s_i κ_i a_i] for one newton of rotor i (t = vehicle thrust axis): the collective
 * thrust along t and the torque about the centre of mass, body axes.
 */
export function effectiveness(rotors: readonly MixerRotor[], thrustAxis: Vec3): number[][] {
  const columns = rotors.map((rotor) => {
    const torque = sub3(cross3(rotor.arm, rotor.axis), scale3(rotor.axis, rotor.spin * rotor.torquePerThrust));
    return [dot3(rotor.axis, thrustAxis), torque[0], torque[1], torque[2]];
  });
  return [0, 1, 2, 3].map((row) => columns.map((column) => column[row] ?? 0));
}

/** Rank of a small dense matrix after scaling each row to a largest entry of 1 (rows in different units: N and N·m). */
export function matrixRank(matrix: readonly (readonly number[])[]): number {
  const rows = matrix.map((row) => {
    const scale = Math.max(...row.map(Math.abs));
    return scale > 0 ? row.map((value) => value / scale) : row.map(() => 0);
  });
  const columns = Math.max(0, ...rows.map((row) => row.length));
  let rank = 0;
  for (let column = 0; column < columns && rank < rows.length; column++) {
    let pivot = rank;
    for (let r = rank + 1; r < rows.length; r++) {
      const candidate = Math.abs(rows[r]?.[column] ?? 0);
      if (candidate > Math.abs(rows[pivot]?.[column] ?? 0)) pivot = r;
    }
    const pivotRow = rows[pivot] ?? [];
    const lead = pivotRow[column] ?? 0;
    if (Math.abs(lead) <= RANK_TOLERANCE) continue;
    rows[pivot] = rows[rank] ?? [];
    rows[rank] = pivotRow;
    for (let r = rank + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const factor = (row[column] ?? 0) / lead;
      rows[r] = row.map((value, k) => value - factor * (pivotRow[k] ?? 0));
    }
    rank++;
  }
  return rank;
}

/** Moore-Penrose pseudo-inverse Bᵀ(BBᵀ)⁻¹ of a full-row-rank 4 × N effectiveness: N rows of 4, or null when BBᵀ is singular. */
export function pseudoInverse(b: readonly (readonly number[])[]): MixerRow[] | null {
  const n = Math.max(0, ...b.map((row) => row.length));
  const gram = b.map((row) => b.map((other) => row.reduce((sum, value, k) => sum + value * (other[k] ?? 0), 0)));
  const inverse = invertDense(gram, 1e-300);
  if (inverse === null) return null;
  return Array.from({ length: n }, (_, i) => {
    const column = b.map((row) => row[i] ?? 0);
    const entry = (j: number): number => column.reduce((sum, value, k) => sum + value * (inverse[k]?.[j] ?? 0), 0);
    return [entry(0), entry(1), entry(2), entry(3)] as const;
  });
}

/** B · M (4 × 4): what a mixer M actually commands on the vehicle; rank 4 = it can command the four axes. */
export function commandedAxes(b: readonly (readonly number[])[], mixer: readonly MixerRow[]): number[][] {
  return b.map((row) => [0, 1, 2, 3].map((j) => row.reduce((sum, value, i) => sum + value * (mixer[i]?.[j] ?? 0), 0)));
}

export interface Allocation {
  /** N per rotor, inside its limits. */
  readonly thrusts: number[];
  /** A limit clipped the demand (the yaw torque was reduced or a rotor clamped). */
  readonly saturated: boolean;
}

/**
 * Rotor thrusts for demand [T, τx, τy, τz] within [min_i, max_i]: the yaw torque is given up first (largest λ in [0, 1] keeping
 * M·[T, τx, τy, 0] + λ·M·[0, 0, 0, τz] inside the limits), then any rotor still outside is clamped.
 */
export function allocate(mixer: readonly MixerRow[], demand: MixerRow, min: readonly number[], max: readonly number[]): Allocation {
  const base = mixer.map((row) => row[0] * demand[0] + row[1] * demand[1] + row[2] * demand[2]);
  const yaw = mixer.map((row) => row[3] * demand[3]);
  let lambda = 1;
  base.forEach((value, i) => {
    const delta = yaw[i] ?? 0;
    const lo = min[i] ?? 0;
    const hi = max[i] ?? 0;
    if (delta > 0 && value + delta > hi) lambda = Math.min(lambda, (hi - value) / delta);
    if (delta < 0 && value + delta < lo) lambda = Math.min(lambda, (lo - value) / delta);
  });
  lambda = Math.max(0, lambda);
  let clamped = false;
  const thrusts = base.map((value, i) => {
    const wanted = value + lambda * (yaw[i] ?? 0);
    const hi = max[i] ?? 0;
    const lo = min[i] ?? 0;
    const limited = Math.min(hi, Math.max(lo, wanted));
    if (limited !== wanted) clamped = true;
    return limited;
  });
  return { thrusts, saturated: clamped || lambda < 1 };
}
