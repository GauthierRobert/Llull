/**
 * Pure reference of the 2D SIMP topology optimisation of PHY-17 (formulation of Andreassen et al. 2011, "top88"): Q4 plane-stress element,
 * linear-hat filters, optimality-criteria update, exact banded Cholesky solve. Small grids only; it is the oracle of the native job and the
 * `ts-reference` solver of the host transport.
 * @invariant grid layout: element e = ix + nx * iy (y up), node n = ix + (nx + 1) * iy, dof = 2 n + (0: x, 1: y), corners BL, BR, TR, TL
 * @invariant a pure function of its inputs: no randomness, no clock, fixed summation order
 */

import { bandIndex, factorBanded, solveBanded } from './bandedCholesky';

const A11 = [12, 3, -6, -3, 3, 12, 3, 0, -6, 3, 12, -3, -3, 0, -3, 12];
const A12 = [-6, -3, 0, 3, -3, -6, -3, -6, 0, -3, -6, 3, 3, -6, 3, -6];
const B11 = [-4, 3, -2, 9, 3, -4, -9, 4, -2, -9, -4, -3, 9, 4, -3, -4];
const B12 = [2, -3, 4, -9, -3, 2, 9, -2, 4, 9, 2, 3, -9, -2, 3, 2];

/** 8 x 8 (row-major) stiffness of a unit square Q4 plane-stress element with E = 1 and thickness 1 (top88's KE). */
export function q4ElementStiffness(poisson: number): Float64Array {
  const at = (block: readonly number[], i: number, j: number): number => block[i * 4 + j] ?? 0;
  const assemble = (p11: readonly number[], p12: readonly number[]): number[] => {
    const out = new Array<number>(64).fill(0);
    for (let i = 0; i < 4; i += 1)
      for (let j = 0; j < 4; j += 1) {
        out[i * 8 + j] = at(p11, i, j);
        out[i * 8 + 4 + j] = at(p12, i, j);
        out[(4 + i) * 8 + j] = at(p12, j, i);
        out[(4 + i) * 8 + 4 + j] = at(p11, i, j);
      }
    return out;
  };
  const a = assemble(A11, A12);
  const b = assemble(B11, B12);
  const factor = 1 / (1 - poisson * poisson) / 24;
  return Float64Array.from(a, (value, i) => factor * (value + poisson * (b[i] ?? 0)));
}

/** Linear-hat filter weights `max(0, rmin - distance)` between active elements, as a compressed row structure. */
export interface ElementFilter {
  readonly start: Int32Array;
  readonly index: Int32Array;
  readonly weight: Float64Array;
  /** Sum of the weights of each row (0 for an inactive element). */
  readonly rowSum: Float64Array;
}

/**
 * @param radius filter radius in element sizes (rmin)
 * @param active 1 = element exists; absent = all elements; inactive elements neither contribute nor receive
 */
export function buildFilter(nx: number, ny: number, radius: number, active?: Uint8Array): ElementFilter {
  const reach = Math.ceil(radius) - 1;
  const start = new Int32Array(nx * ny + 1);
  const index: number[] = [];
  const weight: number[] = [];
  const rowSum = new Float64Array(nx * ny);
  for (let iy = 0; iy < ny; iy += 1)
    for (let ix = 0; ix < nx; ix += 1) {
      const e = ix + nx * iy;
      if (active === undefined || active[e] === 1)
        for (let jy = Math.max(iy - reach, 0); jy <= Math.min(iy + reach, ny - 1); jy += 1)
          for (let jx = Math.max(ix - reach, 0); jx <= Math.min(ix + reach, nx - 1); jx += 1) {
            const w = Math.max(0, radius - Math.hypot(ix - jx, iy - jy));
            if (w > 0 && (active === undefined || active[jx + nx * jy] === 1)) {
              index.push(jx + nx * jy);
              weight.push(w);
              rowSum[e] = (rowSum[e] ?? 0) + w;
            }
          }
      start[e + 1] = index.length;
    }
  return { start, index: Int32Array.from(index), weight: Float64Array.from(weight), rowSum };
}

/** `out = H v` row by row (not normalised). */
function applyFilter(filter: ElementFilter, values: Float64Array, out: Float64Array, divideByRowSum: boolean): void {
  for (let e = 0; e < out.length; e += 1) {
    let sum = 0;
    for (let k = filter.start[e] ?? 0; k < (filter.start[e + 1] ?? 0); k += 1)
      sum += (filter.weight[k] ?? 0) * (values[filter.index[k] ?? 0] ?? 0);
    out[e] = divideByRowSum ? sum / (filter.rowSum[e] || 1) : sum;
  }
}

/** Bisection steps on the multiplier at most (a non-binding volume constraint would otherwise halve it to underflow). */
const MAX_BISECTIONS = 100;

export interface OcInput {
  /** Design variables before the update. */
  readonly x: Float64Array;
  /** Objective sensitivities (negative) and volume sensitivities (positive) after filtering. */
  readonly dc: Float64Array;
  readonly dv: Float64Array;
  readonly move: number;
  /** Physical densities of a trial `xNew` (filter, passive elements) written into `out`. */
  readonly physical: (xNew: Float64Array, out: Float64Array) => void;
  /** Largest allowed sum of the physical densities. */
  readonly volumeLimit: number;
  /** Stop of the bisection on the multiplier, relative; default 1e-3 (top88). */
  readonly lambdaTolerance?: number;
}

/**
 * Optimality-criteria update of PHY-17 TECHNICAL_SPEC 5.2: bisection on the volume multiplier, move-limited and clamped to [0, 1].
 * @returns the new design variables and their physical densities
 */
export function ocUpdate(input: OcInput): { readonly xNew: Float64Array; readonly xPhys: Float64Array } {
  const { x, dc, dv, move, volumeLimit } = input;
  const tolerance = input.lambdaTolerance ?? 1e-3;
  const xNew = new Float64Array(x.length);
  const xPhys = new Float64Array(x.length);
  let low = 0;
  let high = 1e9;
  for (let bisection = 0; bisection < MAX_BISECTIONS && (high - low) / (low + high) > tolerance; bisection += 1) {
    const lambda = 0.5 * (high + low);
    for (let e = 0; e < x.length; e += 1) {
      const xe = x[e] ?? 0;
      const candidate = xe * Math.sqrt(-(dc[e] ?? 0) / (dv[e] ?? 1) / lambda);
      xNew[e] = Math.max(0, Math.max(xe - move, Math.min(1, Math.min(xe + move, candidate))));
    }
    input.physical(xNew, xPhys);
    let total = 0;
    for (let e = 0; e < xPhys.length; e += 1) total += xPhys[e] ?? 0;
    if (total > volumeLimit) low = lambda;
    else high = lambda;
  }
  return { xNew, xPhys };
}

interface SimpLoadCase {
  readonly name: string;
  readonly weight: number;
  /** Sparse nodal force: `values[i]` acts on dof `dofs[i]` (force unit of the analysis). */
  readonly dofs: readonly number[];
  readonly values: readonly number[];
}

export interface Simp2dProblem {
  readonly nx: number;
  readonly ny: number;
  /** 1 = the element exists (inactive elements are removed from the system). */
  readonly active: Uint8Array;
  readonly keepIn: Uint8Array;
  readonly keepOut: Uint8Array;
  readonly fixedDofs: readonly number[];
  readonly loadCases: readonly SimpLoadCase[];
  /** Young's modulus times thickness: the stiffness scale of a solid element (a square element's in-plane stiffness is size independent). */
  readonly stiffness: number;
  readonly poisson: number;
  readonly volumeFraction: number;
  readonly penal: number;
  readonly eminRatio: number;
  readonly move: number;
  readonly changeTol: number;
  readonly maxIterations: number;
  readonly filter: { readonly kind: 'sensitivity' | 'density'; readonly radius: number };
}

interface SimpHistoryRow {
  readonly it: number;
  readonly compliance: number;
  readonly volume: number;
  readonly change: number;
}

export interface Simp2dResult {
  readonly ok: true;
  readonly xPhys: Float64Array;
  readonly iterations: number;
  readonly status: 'converged' | 'max_iterations';
  readonly history: readonly SimpHistoryRow[];
  /** Compliance of the final xPhys (weighted sum over the load cases) and per load case. */
  readonly compliance: number;
  readonly perLoadCase: Readonly<Record<string, number>>;
  /** Compliance printed at the start of the last iteration (what top88 shows). */
  readonly lastIterationCompliance: number;
  /** Mean xPhys over the active elements. */
  readonly volumeFraction: number;
  /** Mean 4 x (1 - x) over the active elements. */
  readonly grey: number;
}

export interface SimpFailure {
  readonly ok: false;
  readonly reason: string;
}

interface Assembly {
  readonly ndof: number;
  readonly bandwidth: number;
  /** Internal (band-reduced) dof of an external dof. */
  readonly internal: Int32Array;
  readonly edofs: Int32Array;
  readonly usedDofs: Uint8Array;
}

/** Numbering along the shorter grid side keeps the bandwidth small. */
function numbering(problem: Simp2dProblem): Assembly {
  const { nx, ny } = problem;
  const nodes = (nx + 1) * (ny + 1);
  const internal = new Int32Array(2 * nodes);
  for (let iy = 0; iy <= ny; iy += 1)
    for (let ix = 0; ix <= nx; ix += 1) {
      const external = ix + (nx + 1) * iy;
      const renumbered = nx > ny ? iy + (ny + 1) * ix : external;
      internal[2 * external] = 2 * renumbered;
      internal[2 * external + 1] = 2 * renumbered + 1;
    }
  const edofs = new Int32Array(8 * nx * ny);
  const usedDofs = new Uint8Array(2 * nodes);
  let bandwidth = 0;
  for (let iy = 0; iy < ny; iy += 1)
    for (let ix = 0; ix < nx; ix += 1) {
      const e = ix + nx * iy;
      const corners = [ix + (nx + 1) * iy, ix + 1 + (nx + 1) * iy, ix + 1 + (nx + 1) * (iy + 1), ix + (nx + 1) * (iy + 1)];
      const dofs = corners.flatMap((node) => [internal[2 * node] ?? 0, internal[2 * node + 1] ?? 0]);
      edofs.set(dofs, 8 * e);
      if (problem.active[e] === 1) {
        for (const dof of dofs) usedDofs[dof] = 1;
        bandwidth = Math.max(bandwidth, Math.max(...dofs) - Math.min(...dofs));
      }
    }
  return { ndof: 2 * nodes, bandwidth, internal, edofs, usedDofs };
}

/** Banded stiffness of the active elements with `scale[e]` times the unit stiffness, constraints imposed by identity rows. */
function assembleStiffness(problem: Simp2dProblem, mesh: Assembly, ke: Float64Array, scale: Float64Array, fixed: Uint8Array): Float64Array {
  const { bandwidth, ndof, edofs, usedDofs } = mesh;
  const band = new Float64Array(ndof * (bandwidth + 1));
  for (let e = 0; e < scale.length; e += 1) {
    if (problem.active[e] !== 1) continue;
    const factor = scale[e] ?? 0;
    for (let a = 0; a < 8; a += 1) {
      const row = edofs[8 * e + a] ?? 0;
      for (let b = 0; b < 8; b += 1) {
        const column = edofs[8 * e + b] ?? 0;
        if (column <= row)
          band[bandIndex(row, column, bandwidth)] = (band[bandIndex(row, column, bandwidth)] ?? 0) + factor * (ke[a * 8 + b] ?? 0);
      }
    }
  }
  for (let i = 0; i < ndof; i += 1) {
    if (fixed[i] === 1 || usedDofs[i] !== 1) {
      for (let j = Math.max(0, i - bandwidth); j < i; j += 1) band[bandIndex(i, j, bandwidth)] = 0;
      for (let k = i + 1; k <= Math.min(ndof - 1, i + bandwidth); k += 1) band[bandIndex(k, i, bandwidth)] = 0;
      band[bandIndex(i, i, bandwidth)] = 1;
    }
  }
  return band;
}

interface Solved {
  /** Per load case: `uᵀ KE u` of every element. */
  readonly energy: Float64Array[];
  readonly compliance: number[];
}

function solveCases(problem: Simp2dProblem, mesh: Assembly, ke: Float64Array, scale: Float64Array, fixed: Uint8Array): Solved | null {
  const band = assembleStiffness(problem, mesh, ke, scale, fixed);
  if (!factorBanded(band, mesh.ndof, mesh.bandwidth)) return null;
  const energy: Float64Array[] = [];
  const compliance: number[] = [];
  for (const loadCase of problem.loadCases) {
    const rhs = new Float64Array(mesh.ndof);
    loadCase.dofs.forEach((dof, i) => {
      const target = mesh.internal[dof] ?? 0;
      if (fixed[target] !== 1) rhs[target] = (rhs[target] ?? 0) + (loadCase.values[i] ?? 0);
    });
    const u = solveBanded(band, mesh.ndof, mesh.bandwidth, rhs);
    const perElement = new Float64Array(scale.length);
    let total = 0;
    for (let e = 0; e < scale.length; e += 1) {
      if (problem.active[e] !== 1) continue;
      let sum = 0;
      for (let a = 0; a < 8; a += 1) {
        let row = 0;
        for (let b = 0; b < 8; b += 1) row += (ke[a * 8 + b] ?? 0) * (u[mesh.edofs[8 * e + b] ?? 0] ?? 0);
        sum += (u[mesh.edofs[8 * e + a] ?? 0] ?? 0) * row;
      }
      perElement[e] = sum;
      total += (scale[e] ?? 0) * sum;
    }
    energy.push(perElement);
    compliance.push(total);
  }
  return { energy, compliance };
}

const weighted = (problem: Simp2dProblem, values: readonly number[]): number =>
  problem.loadCases.reduce((sum, loadCase, i) => sum + loadCase.weight * (values[i] ?? 0), 0);

/**
 * Minimum-compliance SIMP (modified, E(x) = Emin + x^p (E0 - Emin)) with sensitivity or density filter and the OC update.
 * @invariant keep-in elements are 1 and keep-out elements 0 in x and xPhys at every iteration; stop when max |dx| <= changeTol
 * @failure a singular system (unsupported structure, disconnected load) -> `{ ok: false, reason }`
 */
export function runSimp2d(problem: Simp2dProblem): Simp2dResult | SimpFailure {
  const count = problem.nx * problem.ny;
  const mesh = numbering(problem);
  const ke = q4ElementStiffness(problem.poisson);
  const fixed = new Uint8Array(mesh.ndof);
  for (const dof of problem.fixedDofs) fixed[mesh.internal[dof] ?? 0] = 1;
  const filter = buildFilter(problem.nx, problem.ny, problem.filter.radius, problem.active);
  const density = problem.filter.kind === 'density';
  const emax = problem.stiffness;
  const emin = problem.eminRatio * emax;
  const nActive = problem.active.reduce((sum, flag) => sum + flag, 0);
  const x = new Float64Array(count);
  const fixPassive = (values: Float64Array): void => {
    for (let e = 0; e < count; e += 1) {
      if (problem.active[e] !== 1) values[e] = 0;
      else if (problem.keepIn[e] === 1) values[e] = 1;
      else if (problem.keepOut[e] === 1) values[e] = 0;
    }
  };
  for (let e = 0; e < count; e += 1) x[e] = problem.active[e] === 1 ? problem.volumeFraction : 0;
  fixPassive(x);
  let xPhys: Float64Array = Float64Array.from(x);
  const physical = (xNew: Float64Array, out: Float64Array): void => {
    if (density) applyFilter(filter, xNew, out, true);
    else out.set(xNew);
    fixPassive(out);
  };
  const history: SimpHistoryRow[] = [];
  let design: Float64Array = x;
  let change = 1;
  let iteration = 0;
  const stiffnessOf = (field: Float64Array): Float64Array =>
    Float64Array.from(field, (value) => emin + value ** problem.penal * (emax - emin));
  while (change > problem.changeTol && iteration < problem.maxIterations) {
    iteration += 1;
    const scale = stiffnessOf(xPhys);
    const solved = solveCases(problem, mesh, ke, scale, fixed);
    if (solved === null) return { ok: false, reason: 'the stiffness matrix is singular: add supports or connect every load to a support' };
    const objective = weighted(problem, solved.compliance);
    const dc = new Float64Array(count);
    for (let e = 0; e < count; e += 1) {
      if (problem.active[e] !== 1) continue;
      let energy = 0;
      problem.loadCases.forEach((loadCase, i) => {
        energy += loadCase.weight * (solved.energy[i]?.[e] ?? 0);
      });
      dc[e] = -problem.penal * (emax - emin) * (xPhys[e] ?? 0) ** (problem.penal - 1) * energy;
    }
    const dv = new Float64Array(count).fill(1);
    const filteredDc = new Float64Array(count);
    if (density) {
      const scaledDc = Float64Array.from(dc, (value, e) => value / (filter.rowSum[e] || 1));
      const scaledDv = Float64Array.from(dv, (value, e) => value / (filter.rowSum[e] || 1));
      applyFilter(filter, scaledDc, filteredDc, false);
      applyFilter(filter, scaledDv, dv, false);
      for (let e = 0; e < count; e += 1) if (problem.active[e] !== 1) dv[e] = 1;
    } else {
      const weightedDc = Float64Array.from(dc, (value, e) => (design[e] ?? 0) * value);
      applyFilter(filter, weightedDc, filteredDc, true);
      for (let e = 0; e < count; e += 1) filteredDc[e] = (filteredDc[e] ?? 0) / Math.max(1e-3, design[e] ?? 0);
    }
    const updated = ocUpdate({
      x: design,
      dc: filteredDc,
      dv,
      move: problem.move,
      physical,
      volumeLimit: problem.volumeFraction * nActive,
    });
    change = 0;
    for (let e = 0; e < count; e += 1) change = Math.max(change, Math.abs((updated.xNew[e] ?? 0) - (design[e] ?? 0)));
    design = updated.xNew;
    xPhys = updated.xPhys;
    history.push({ it: iteration, compliance: objective, volume: sumOf(xPhys) / nActive, change });
  }
  const final = solveCases(problem, mesh, ke, stiffnessOf(xPhys), fixed);
  if (final === null) return { ok: false, reason: 'the stiffness matrix of the final design is singular' };
  const perLoadCase = Object.fromEntries(problem.loadCases.map((loadCase, i) => [loadCase.name, final.compliance[i] ?? 0]));
  let grey = 0;
  for (let e = 0; e < count; e += 1) if (problem.active[e] === 1) grey += 4 * (xPhys[e] ?? 0) * (1 - (xPhys[e] ?? 0));
  return {
    ok: true,
    xPhys,
    iterations: iteration,
    status: change > problem.changeTol ? 'max_iterations' : 'converged',
    history,
    compliance: weighted(problem, final.compliance),
    perLoadCase,
    lastIterationCompliance: history[history.length - 1]?.compliance ?? 0,
    volumeFraction: sumOf(xPhys) / nActive,
    grey: grey / nActive,
  };
}

function sumOf(values: Float64Array): number {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i] ?? 0;
  return total;
}
