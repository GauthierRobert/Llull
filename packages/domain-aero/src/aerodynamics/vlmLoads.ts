/**
 * Loads of a solved horseshoe lattice: Kutta–Joukowski force on each bound vortex in the free stream V = (cos α, 0, sin α) (ρ = 1,
 * |V| = 1), pitching moment about the reference point (nose up positive), induced drag in the Trefftz plane (trailing legs as 2D point
 * vortices; D_i = ½ Σ Γ_i (v_i × s_i)·x̂ with the fully developed wake velocity v_i at each projected bound-vortex midpoint), spanwise
 * loading and the neutral point (Katz & Plotkin §12.3; Etkin & Reid, "Dynamics of Flight", §2.3 for the neutral point and static margin).
 */

import type { Vec3 } from '@core/model/types';
import { PANEL_STRIDE, panelCount, trefftzVelocity } from './vlmKernel';
import type { Lattice } from './vlmLattice';

export interface LatticeReference {
  readonly area: number;
  readonly chord: number;
  readonly span: number;
  /** Moment reference point = centre of gravity for the static margin. */
  readonly point: Vec3;
}

export interface LatticeBasis {
  readonly gammaX: ArrayLike<number>;
  readonly gammaZ: ArrayLike<number>;
}

export interface AlphaLoads {
  readonly alpha: number;
  readonly cl: number;
  readonly cdi: number;
  readonly cm: number;
  readonly surfaceCl: readonly number[];
}

/** Trefftz-plane wake velocities at the bound midpoints for the two basis circulations (computed once, combined per α). */
export interface TrefftzBasis {
  readonly vX: Float64Array;
  readonly vZ: Float64Array;
}

export function trefftzBasis(lattice: Lattice, basis: LatticeBasis): TrefftzBasis {
  const { panels } = lattice;
  const n = panelCount(panels);
  const vX = new Float64Array(2 * n);
  const vZ = new Float64Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    const o = i * PANEL_STRIDE;
    const y = ((panels[o + 1] as number) + (panels[o + 4] as number)) / 2;
    const z = ((panels[o + 2] as number) + (panels[o + 5] as number)) / 2;
    const [xv, xw] = trefftzVelocity(panels, basis.gammaX, y, z);
    const [zv, zw] = trefftzVelocity(panels, basis.gammaZ, y, z);
    vX[2 * i] = xv;
    vX[2 * i + 1] = xw;
    vZ[2 * i] = zv;
    vZ[2 * i + 1] = zw;
  }
  return { vX, vZ };
}

/** Γ(α) of panel i. */
const gammaAt = (basis: LatticeBasis, i: number, alpha: number): number =>
  Math.cos(alpha) * (basis.gammaX[i] as number) + Math.sin(alpha) * (basis.gammaZ[i] as number);

/** Kutta–Joukowski force f = Γ (V × l) of panel i at α (ρ = 1, |V| = 1). */
function panelForce(panels: Float64Array, i: number, gamma: number, alpha: number): Vec3 {
  const o = i * PANEL_STRIDE;
  const lx = (panels[o + 3] as number) - (panels[o] as number);
  const ly = (panels[o + 4] as number) - (panels[o + 1] as number);
  const lz = (panels[o + 5] as number) - (panels[o + 2] as number);
  const vx = Math.cos(alpha);
  const vz = Math.sin(alpha);
  return [gamma * -vz * ly, gamma * (vz * lx - vx * lz), gamma * vx * ly];
}

export function alphaLoads(
  lattice: Lattice,
  basis: LatticeBasis,
  trefftz: TrefftzBasis,
  reference: LatticeReference,
  alpha: number,
): AlphaLoads {
  const { panels } = lattice;
  const n = panelCount(panels);
  const q = 0.5 * reference.area;
  const sinA = Math.sin(alpha);
  const cosA = Math.cos(alpha);
  let lift = 0;
  let moment = 0;
  let drag = 0;
  const surfaceLift = lattice.surfaceArea.map(() => 0);
  for (let i = 0; i < n; i += 1) {
    const o = i * PANEL_STRIDE;
    const gamma = gammaAt(basis, i, alpha);
    const f = panelForce(panels, i, gamma, alpha);
    const l = -f[0] * sinA + f[2] * cosA;
    lift += l;
    const s = lattice.surfaceOf[i] as number;
    surfaceLift[s] = (surfaceLift[s] as number) + l;
    const mx = ((panels[o] as number) + (panels[o + 3] as number)) / 2 - reference.point[0];
    const mz = ((panels[o + 2] as number) + (panels[o + 5] as number)) / 2 - reference.point[2];
    moment += mz * f[0] - mx * f[2];
    const v = cosA * (trefftz.vX[2 * i] as number) + sinA * (trefftz.vZ[2 * i] as number);
    const w = cosA * (trefftz.vX[2 * i + 1] as number) + sinA * (trefftz.vZ[2 * i + 1] as number);
    const sy = (panels[o + 4] as number) - (panels[o + 1] as number);
    const sz = (panels[o + 5] as number) - (panels[o + 2] as number);
    drag += 0.5 * gamma * (v * sz - w * sy);
  }
  return { alpha, cl: lift / q, cdi: drag / q, cm: moment / (q * reference.chord), surfaceCl: surfaceLift.map((value) => value / q) };
}

/** Section lift coefficient of each positive-side strip of surface `s` at α (strip lift / (½ c_j w_j)). */
export function stripLoading(lattice: Lattice, basis: LatticeBasis, s: number, alpha: number): number[] {
  const strips = lattice.strips[s] ?? [];
  const lift = strips.map(() => 0);
  const n = panelCount(lattice.panels);
  for (let i = 0; i < n; i += 1) {
    const strip = lattice.stripOf[i] as number;
    if (lattice.surfaceOf[i] !== s || strip < 0) continue;
    const f = panelForce(lattice.panels, i, gammaAt(basis, i, alpha), alpha);
    lift[strip] = (lift[strip] as number) - f[0] * Math.sin(alpha) + f[2] * Math.cos(alpha);
  }
  return lift.map((value, j) => value / (0.5 * (strips[j]?.chord ?? 1) * (strips[j]?.width ?? 1)));
}

export interface Stability {
  readonly liftSlopePerRad: number;
  readonly momentSlopePerRad: number;
  /** x of the neutral point: the moment reference where dCm/dα = 0. */
  readonly neutralPointX: number;
  /** (x_np − x_ref) / c_ref: positive = statically stable with the CG at the reference point. */
  readonly staticMargin: number;
}

/** Slopes at α = 0 by central differences over ±0.5° and the neutral point x_np = x_ref − (Cm_α / CL_α) c_ref. */
export function stability(lattice: Lattice, basis: LatticeBasis, trefftz: TrefftzBasis, reference: LatticeReference): Stability {
  const h = (0.5 * Math.PI) / 180;
  const plus = alphaLoads(lattice, basis, trefftz, reference, h);
  const minus = alphaLoads(lattice, basis, trefftz, reference, -h);
  const liftSlope = (plus.cl - minus.cl) / (2 * h);
  const momentSlope = (plus.cm - minus.cm) / (2 * h);
  const neutralPointX = reference.point[0] - (momentSlope / liftSlope) * reference.chord;
  return {
    liftSlopePerRad: liftSlope,
    momentSlopePerRad: momentSlope,
    neutralPointX,
    staticMargin: (neutralPointX - reference.point[0]) / reference.chord,
  };
}
