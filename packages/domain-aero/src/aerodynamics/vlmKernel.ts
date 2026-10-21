/**
 * Horseshoe vortex-lattice kernel (Katz & Plotkin, "Low-Speed Aerodynamics", 2nd ed., §12.3 and eq. 10.115; Bertin & Smith, "Aerodynamics
 * for Engineers", §7.4): each panel carries a horseshoe vortex of strength Γ: a bound segment A→B on the panel's quarter-chord line and two
 * trailing legs parallel to +x to infinity; the flow tangency condition holds at the three-quarter-chord control point C with normal n.
 * The influence build is written component by component; `llull-panel` (Rust) performs the same operations in the same order.
 *
 * Panel layout (PANEL_STRIDE f64 per panel): Ax Ay Az Bx By Bz Cx Cy Cz nx ny nz.
 */

import { luFactor, luSolve } from '@lib/denseLinalg';

export const PANEL_STRIDE = 12;
const FOUR_PI = 4 * Math.PI;
/** sin² of the angle below which a field point counts as on a vortex line (no self-induced singularity). */
const CORE = 1e-20;

/** Velocity induced at (px, py, pz) by the unit horseshoe of panel `j`, accumulated into `out`. */
function horseshoe(panels: Float64Array, j: number, px: number, py: number, pz: number, out: Float64Array): void {
  const o = j * PANEL_STRIDE;
  const ax = panels[o] as number;
  const ay = panels[o + 1] as number;
  const az = panels[o + 2] as number;
  const bx = panels[o + 3] as number;
  const by = panels[o + 4] as number;
  const bz = panels[o + 5] as number;
  let u = 0;
  let v = 0;
  let w = 0;
  // Bound segment A -> B.
  const r1x = px - ax;
  const r1y = py - ay;
  const r1z = pz - az;
  const r2x = px - bx;
  const r2y = py - by;
  const r2z = pz - bz;
  const cx = r1y * r2z - r1z * r2y;
  const cy = r1z * r2x - r1x * r2z;
  const cz = r1x * r2y - r1y * r2x;
  const c2 = cx * cx + cy * cy + cz * cz;
  const n1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z);
  const n2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z);
  if (c2 > CORE * (n1 * n1) * (n2 * n2)) {
    const k = ((bx - ax) * (r1x / n1 - r2x / n2) + (by - ay) * (r1y / n1 - r2y / n2) + (bz - az) * (r1z / n1 - r2z / n2)) / (FOUR_PI * c2);
    u += k * cx;
    v += k * cy;
    w += k * cz;
  }
  // Trailing leg B -> +∞ along +x: (x̂ × r)(1 + x̂·r/|r|) / (4π |x̂ × r|²), r = P − B; x̂ × r = (0, −r_z, r_y).
  const d2b = r2y * r2y + r2z * r2z;
  if (d2b > CORE * (n2 * n2)) {
    const k = (1 + r2x / n2) / (FOUR_PI * d2b);
    v += k * -r2z;
    w += k * r2y;
  }
  // Trailing leg +∞ -> A: minus the leg A -> +∞.
  const d2a = r1y * r1y + r1z * r1z;
  if (d2a > CORE * (n1 * n1)) {
    const k = (1 + r1x / n1) / (FOUR_PI * d2a);
    v -= k * -r1z;
    w -= k * r1y;
  }
  out[0] = (out[0] as number) + u;
  out[1] = (out[1] as number) + v;
  out[2] = (out[2] as number) + w;
}

/** Number of panels of a panel buffer. */
export const panelCount = (panels: Float64Array): number => panels.length / PANEL_STRIDE;

/** Influence matrix a_ij = V_j(C_i)·n_i (row-major n × n). */
export function influenceMatrix(panels: Float64Array): Float64Array {
  const n = panelCount(panels);
  const a = new Float64Array(n * n);
  const velocity = new Float64Array(3);
  for (let i = 0; i < n; i += 1) {
    const o = i * PANEL_STRIDE;
    const px = panels[o + 6] as number;
    const py = panels[o + 7] as number;
    const pz = panels[o + 8] as number;
    const nx = panels[o + 9] as number;
    const ny = panels[o + 10] as number;
    const nz = panels[o + 11] as number;
    for (let j = 0; j < n; j += 1) {
      velocity.fill(0);
      horseshoe(panels, j, px, py, pz, velocity);
      a[i * n + j] = (velocity[0] as number) * nx + (velocity[1] as number) * ny + (velocity[2] as number) * nz;
    }
  }
  return a;
}

/** Right-hand sides for the free streams x̂ and ẑ: b = −V·n (two n-vectors, x̂ first). */
export function basisRightHandSides(panels: Float64Array): Float64Array {
  const n = panelCount(panels);
  const b = new Float64Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    b[i] = -(panels[i * PANEL_STRIDE + 9] as number);
    b[n + i] = -(panels[i * PANEL_STRIDE + 11] as number);
  }
  return b;
}

/**
 * Circulations for the unit free streams x̂ and ẑ (Γ(α) = cos α Γx + sin α Γz, the boundary condition being linear in V): one influence
 * build, one LU factorisation, two solves.
 * @failure singular influence matrix -> null
 */
export function solveBasis(panels: Float64Array): { readonly gammaX: Float64Array; readonly gammaZ: Float64Array } | null {
  const n = panelCount(panels);
  const factors = luFactor(influenceMatrix(panels), n);
  if (factors === null) return null;
  const b = basisRightHandSides(panels);
  const gammaX = luSolve(factors, b.subarray(0, n));
  const gammaZ = luSolve(factors, b.subarray(n));
  return [...gammaX, ...gammaZ].every(Number.isFinite) ? { gammaX, gammaZ } : null;
}

/** The wake (Trefftz-plane) velocity (v, w) at (y, z) of every trailing leg pair, for circulations `gamma` (2D point vortices). */
export function trefftzVelocity(panels: Float64Array, gamma: ArrayLike<number>, y: number, z: number): readonly [number, number] {
  const n = panelCount(panels);
  let v = 0;
  let w = 0;
  for (let k = 0; k < n; k += 1) {
    const o = k * PANEL_STRIDE;
    const g = (gamma[k] as number) / (2 * Math.PI);
    const dby = y - (panels[o + 4] as number);
    const dbz = z - (panels[o + 5] as number);
    const day = y - (panels[o + 1] as number);
    const daz = z - (panels[o + 2] as number);
    const rb = dby * dby + dbz * dbz;
    const ra = day * day + daz * daz;
    if (rb > 0) {
      v -= (g * dbz) / rb;
      w += (g * dby) / rb;
    }
    if (ra > 0) {
      v += (g * daz) / ra;
      w -= (g * day) / ra;
    }
  }
  return [v, w];
}
