/**
 * Random response by modal superposition (PHY-09 §5.4, TR-DYN-40/41/44) — the TypeScript reference of `llull-compute post random`.
 *
 * Base acceleration a_b with one-sided ASD W(f) (g^2/Hz), mass-normalised modes j with participation G_j in the excitation direction:
 *   relative response  r(w) / a_b = -sum_j c_j g_j(w)                 c_j = phi_j G_j (displacement) or sigma_j G_j (modal stress)
 *   absolute accel     a(w) / a_b = d + w^2 sum_j c_j g_j(w)           d = 1 in the excitation direction, else 0
 *   g_j(w) = 1 / D_j,  D_j = w_j^2 - w^2 + i (a_j + b_j w)            (viscous / Rayleigh: a = 0; structural: b = 0)
 * Integrated on the adaptive grid (`integrationGrid`, Simpson per sub-interval) through the modal quadratic forms
 *   A_jl = sum_k w_k Re(g_jk conj g_lk),  A'_jl = sum_k w_k w^4 Re(...),  B_j = sum_k w_k w^2 Re(g_jk),  T = sum_k w_k
 * so a node costs J^2 per component: rms^2 = c^T A c (relative), d T + 2 d c.B + c^T A' c (absolute).
 * The native job reproduces these loops in the same order with only + - * / and sqrt (bit-identical, RS1 §2 rule 3).
 */

import { asdAt, type AsdPoint } from './psd';

/** Base log-spaced grid density and the refinement around each kept mode (§5.4). */
const POINTS_PER_DECADE = 200;
const MODE_WINDOW_HALF_WIDTH_ZETAS = 5;
const MODE_WINDOW_INTERVALS = 40;
export const GRID_CONVERGENCE_TOLERANCE = 1e-4;

export interface ModalBasis {
  /** Natural circular frequencies w_j (rad/s). */
  readonly omega: readonly number[];
  /** Imaginary part of D_j = a_j + b_j w. */
  readonly dampingA: readonly number[];
  readonly dampingB: readonly number[];
}

export interface IntegrationGrid {
  /** Integration nodes (Hz): interval ends and Simpson midpoints, increasing. */
  readonly fHz: readonly number[];
  /** Simpson weight x W(f) (g^2/Hz x Hz = g^2) per node. */
  readonly weight: readonly number[];
  readonly intervals: number;
}

/**
 * Integration grid over `band` (Hz): 200 log-spaced points per decade, the spectrum breakpoints, and 40 equal intervals over
 * [f_j (1 - 5 zeta_j), f_j (1 + 5 zeta_j)] of every mode; each interval split in `refine` and integrated by Simpson (ends + midpoint).
 * @invariant deterministic: same inputs -> same nodes and weights (Math.pow only in the grid, which the native job receives as data)
 */
export function integrationGrid(
  spectrum: readonly AsdPoint[],
  band: readonly [number, number],
  modes: readonly { readonly fHz: number; readonly zeta: number }[],
  refine = 1,
): IntegrationGrid {
  const [lo, hi] = band;
  const breaks = new Set<number>([lo, hi]);
  const decades = Math.log10(hi / lo);
  const count = Math.max(1, Math.ceil(POINTS_PER_DECADE * decades));
  for (let i = 1; i < count; i += 1) breaks.add(lo * (hi / lo) ** (i / count));
  for (const [f] of spectrum) if (f > lo && f < hi) breaks.add(f);
  for (const { fHz, zeta } of modes) {
    const from = fHz * (1 - MODE_WINDOW_HALF_WIDTH_ZETAS * zeta);
    const to = fHz * (1 + MODE_WINDOW_HALF_WIDTH_ZETAS * zeta);
    for (let i = 0; i <= MODE_WINDOW_INTERVALS; i += 1) {
      const f = from + ((to - from) * i) / MODE_WINDOW_INTERVALS;
      if (f > lo && f < hi) breaks.add(f);
    }
  }
  const sorted = [...breaks].sort((a, b) => a - b);
  const fHz: number[] = [];
  const simpson: number[] = [];
  const push = (f: number, w: number): void => {
    if (fHz.length > 0 && fHz[fHz.length - 1] === f) simpson[simpson.length - 1] = (simpson[simpson.length - 1] ?? 0) + w;
    else {
      fHz.push(f);
      simpson.push(w);
    }
  };
  let intervals = 0;
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const a = sorted[i] ?? lo;
    const b = sorted[i + 1] ?? hi;
    for (let s = 0; s < refine; s += 1) {
      const x0 = a + ((b - a) * s) / refine;
      const x1 = s + 1 === refine ? b : a + ((b - a) * (s + 1)) / refine;
      const h = x1 - x0;
      push(x0, h / 6);
      push((x0 + x1) / 2, (4 * h) / 6);
      push(x1, h / 6);
      intervals += 1;
    }
  }
  return { fHz, weight: fHz.map((f, k) => (simpson[k] ?? 0) * asdAt(spectrum, f)), intervals };
}

export interface ModalForms {
  readonly modes: number;
  /** J x J, row-major. */
  readonly relative: Float64Array;
  readonly absolute: Float64Array;
  readonly cross: Float64Array;
  readonly total: number;
}

/**
 * Modal quadratic forms of a grid; `power` 2 weights every node by f^2 (spectral moment m2 for the zero up-crossing rate).
 * @invariant loop order k (grid), j, l >= j (mirrored): the native job uses the same order
 */
export function modalForms(basis: ModalBasis, grid: IntegrationGrid, power: 0 | 2 = 0): ModalForms {
  const modes = basis.omega.length;
  const relative = new Float64Array(modes * modes);
  const absolute = new Float64Array(modes * modes);
  const cross = new Float64Array(modes);
  const gr = new Float64Array(modes);
  const gi = new Float64Array(modes);
  let total = 0;
  for (let k = 0; k < grid.fHz.length; k += 1) {
    const f = grid.fHz[k] ?? 0;
    const w = power === 2 ? (grid.weight[k] ?? 0) * (f * f) : (grid.weight[k] ?? 0);
    const omega = 2 * Math.PI * f;
    const omega2 = omega * omega;
    const omega4 = omega2 * omega2;
    for (let j = 0; j < modes; j += 1) {
      const wj = basis.omega[j] ?? 0;
      const dr = wj * wj - omega2;
      const di = (basis.dampingA[j] ?? 0) + (basis.dampingB[j] ?? 0) * omega;
      const den = dr * dr + di * di;
      gr[j] = dr / den;
      gi[j] = -di / den;
    }
    total += w;
    for (let j = 0; j < modes; j += 1) {
      const rj = gr[j] ?? 0;
      const ij = gi[j] ?? 0;
      cross[j] = (cross[j] ?? 0) + w * omega2 * rj;
      for (let l = j; l < modes; l += 1) {
        const product = rj * (gr[l] ?? 0) + ij * (gi[l] ?? 0);
        relative[j * modes + l] = (relative[j * modes + l] ?? 0) + w * product;
        absolute[j * modes + l] = (absolute[j * modes + l] ?? 0) + w * omega4 * product;
      }
    }
  }
  for (let j = 0; j < modes; j += 1)
    for (let l = 0; l < j; l += 1) {
      relative[j * modes + l] = relative[l * modes + j] ?? 0;
      absolute[j * modes + l] = absolute[l * modes + j] ?? 0;
    }
  return { modes, relative, absolute, cross, total };
}

/** c^T M c as sum_j c_j (sum_l M_jl c_l). */
function quadratic(matrix: Float64Array, coefficients: Float64Array, modes: number): number {
  let q = 0;
  for (let j = 0; j < modes; j += 1) {
    let s = 0;
    for (let l = 0; l < modes; l += 1) s += (matrix[j * modes + l] ?? 0) * (coefficients[l] ?? 0);
    q += (coefficients[j] ?? 0) * s;
  }
  return q;
}

export interface ResponseComponent {
  readonly kind: 'relative' | 'absolute';
  /** absolute only: the response component is along the excitation (adds the rigid base term). */
  readonly unity: boolean;
  /** Multiplies the rms (e.g. g in the model acceleration unit for relative responses; 1 for absolute acceleration in g). */
  readonly scale: number;
}

/** Mean square of one response component with modal coefficients c (c_j = modal value x G_j). */
export function meanSquare(forms: ModalForms, coefficients: Float64Array, component: ResponseComponent): number {
  if (component.kind === 'relative') return quadratic(forms.relative, coefficients, forms.modes);
  const qa = quadratic(forms.absolute, coefficients, forms.modes);
  if (!component.unity) return qa;
  let linear = 0;
  for (let j = 0; j < forms.modes; j += 1) linear += (coefficients[j] ?? 0) * (forms.cross[j] ?? 0);
  return forms.total + 2 * linear + qa;
}

/** rms = scale sqrt(max(q, 0)). */
export const rmsOf = (q: number, component: ResponseComponent): number => component.scale * Math.sqrt(Math.max(q, 0));

/** Job layout of the nodal field (native `llull-compute post random` reads the same numbers). */
export interface NodalFieldJob {
  readonly nodeCount: number;
  readonly modes: number;
  /** Modal values per node and mode (e.g. ux, uy, uz [, sxx .. szx]). */
  readonly sources: number;
  readonly basis: ModalBasis;
  /** Participation factor per mode in the excitation direction. */
  readonly gamma: readonly number[];
  readonly grid: IntegrationGrid;
  readonly components: readonly (ResponseComponent & { readonly source: number })[];
}

/**
 * The nodal rms field: `modal` is node-major nodeCount x modes x sources; the result node-major nodeCount x components.
 * @invariant identical (bit for bit) to `llull-compute post random` on the same job
 */
export function nodalRmsReference(job: NodalFieldJob, modal: Float64Array): Float64Array {
  const forms = modalForms(job.basis, job.grid);
  const out = new Float64Array(job.nodeCount * job.components.length);
  const coefficients = new Float64Array(job.modes);
  for (let node = 0; node < job.nodeCount; node += 1)
    job.components.forEach((component, index) => {
      for (let j = 0; j < job.modes; j += 1)
        coefficients[j] = (modal[(node * job.modes + j) * job.sources + component.source] ?? 0) * (job.gamma[j] ?? 0);
      out[node * job.components.length + index] = rmsOf(meanSquare(forms, coefficients, component), component);
    });
  return out;
}
