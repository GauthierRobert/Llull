/**
 * PHY-05 TR-NLS-20 2D corotational frame (Crisfield's Euler-Bernoulli element) with a banded LU without pivoting: the arithmetic of
 * `element`, `Frame.assemble`, `Frame.factor` and `Frame.solve` in docs/physics/05-nonlinear-structural/validation/generate_nls_reference.py,
 * in the same order (dofs numbered along the member chain, 3 per node: ux, uy, rz).
 */

/** Element i of a numeric array; 0 for an index past the end (noUncheckedIndexedAccess identity, never an engineering default). */
const at = (values: ArrayLike<number>, index: number): number => values[index] ?? 0;

export interface FrameElement {
  readonly a: number;
  readonly b: number;
  readonly E: number;
  readonly A: number;
  readonly I: number;
}

export interface FrameModel {
  /** Global node coordinates (input nodes and member subdivision nodes, numbered along the members in input order). */
  readonly coords: readonly (readonly [number, number])[];
  readonly elements: readonly FrameElement[];
  /** Global dof count (3 per node). */
  readonly dofs: number;
  /** Free global dofs in increasing order. */
  readonly free: readonly number[];
  /** Global dof -> index among the free dofs, -1 when fixed. */
  readonly position: Int32Array;
  /** Largest |i - j| over the free dof pairs of any element. */
  readonly bandwidth: number;
}

const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Internal force vector (6) and tangent stiffness (6 x 6, row-major) of one element at the nodal displacements `u1`, `u2` = [ux, uy, rz]. */
function elementResponse(
  X1: readonly [number, number],
  X2: readonly [number, number],
  u1: readonly [number, number, number],
  u2: readonly [number, number, number],
  { E, A, I }: Pick<FrameElement, 'E' | 'A' | 'I'>,
): { readonly force: number[]; readonly stiffness: number[] } {
  const [ux1, uy1, rz1] = u1;
  const [ux2, uy2, rz2] = u2;
  const dx0 = X2[0] - X1[0];
  const dy0 = X2[1] - X1[1];
  const L0 = Math.hypot(dx0, dy0);
  const b0 = Math.atan2(dy0, dx0);
  const dx = dx0 + ux2 - ux1;
  const dy = dy0 + uy2 - uy1;
  const L = Math.hypot(dx, dy);
  const b = Math.atan2(dy, dx);
  const c = dx / L;
  const s = dy / L;
  const t1 = wrap(rz1 + b0 - b);
  const t2 = wrap(rz2 + b0 - b);
  const ul = (L * L - L0 * L0) / (L + L0);
  const N = ((E * A) / L0) * ul;
  const M1 = ((E * I) / L0) * (4 * t1 + 2 * t2);
  const M2 = ((E * I) / L0) * (2 * t1 + 4 * t2);
  const B0 = [-c, -s, 0, c, s, 0];
  const B1 = [-s / L, c / L, 1, s / L, -c / L, 0];
  const B2 = [-s / L, c / L, 0, s / L, -c / L, 1];
  const SIX = [0, 1, 2, 3, 4, 5];
  const force = SIX.map((j) => at(B0, j) * N + at(B1, j) * M1 + at(B2, j) * M2);
  // rows of D B with D = diag-block [[EA/L0], [4EI/L0, 2EI/L0], [2EI/L0, 4EI/L0]], summed from 0 as Python's sum()
  const row = (d0: number, d1: number, d2: number): number[] => SIX.map((j) => 0 + d0 * at(B0, j) + d1 * at(B1, j) + d2 * at(B2, j));
  const DB0 = row((E * A) / L0, 0, 0);
  const DB1 = row(0, (4 * E * I) / L0, (2 * E * I) / L0);
  const DB2 = row(0, (2 * E * I) / L0, (4 * E * I) / L0);
  const r = [s, -c, 0, -s, c, 0];
  const z = [-c, -s, 0, c, s, 0];
  const stiffness = new Array<number>(36);
  for (let a = 0; a < 6; a++)
    for (let bb = 0; bb < 6; bb++) {
      const material = 0 + at(B0, a) * at(DB0, bb) + at(B1, a) * at(DB1, bb) + at(B2, a) * at(DB2, bb);
      const geometric = (N / L) * at(r, a) * at(r, bb) + ((M1 + M2) / (L * L)) * (at(r, a) * at(z, bb) + at(z, a) * at(r, bb));
      stiffness[a * 6 + bb] = material + geometric;
    }
  return { force, stiffness };
}

/** Banded matrix over the free dofs: row r holds columns r - bandwidth .. r + bandwidth. */
export interface Banded {
  readonly size: number;
  readonly bandwidth: number;
  readonly values: Float64Array;
}

/** Relative pivot size below which the tangent counts as singular (rounding of a rigid-body mode lands near 1e-16). */
const SINGULAR_PIVOT = 1e-12;

const slot = (matrix: Banded, row: number, column: number): number => row * (2 * matrix.bandwidth + 1) + column - row + matrix.bandwidth;

const bandedZero = (size: number, bandwidth: number): Banded => ({ size, bandwidth, values: new Float64Array(size * (2 * bandwidth + 1)) });

/** Internal forces (global, every dof) and the tangent stiffness over the free dofs at the global displacements `u`. */
export function assemble(model: FrameModel, u: Float64Array): { readonly force: Float64Array; readonly stiffness: Banded } {
  const force = new Float64Array(model.dofs);
  const value = (index: number): number => u[index] ?? 0;
  const stiffness = bandedZero(model.free.length, model.bandwidth);
  for (const element of model.elements) {
    const dofs = [3 * element.a, 3 * element.a + 1, 3 * element.a + 2, 3 * element.b, 3 * element.b + 1, 3 * element.b + 2];
    const response = elementResponse(
      model.coords[element.a] ?? [0, 0],
      model.coords[element.b] ?? [0, 0],
      [value(3 * element.a), value(3 * element.a + 1), value(3 * element.a + 2)],
      [value(3 * element.b), value(3 * element.b + 1), value(3 * element.b + 2)],
      element,
    );
    for (let i = 0; i < 6; i++) {
      const di = dofs[i] ?? 0;
      force[di] = at(force, di) + at(response.force, i);
      const pi = model.position[di];
      if (pi === undefined || pi < 0) continue;
      for (let j = 0; j < 6; j++) {
        const pj = model.position[at(dofs, j)];
        if (pj === undefined || pj < 0) continue;
        const index = slot(stiffness, pi, pj);
        stiffness.values[index] = at(stiffness.values, index) + at(response.stiffness, i * 6 + j);
      }
    }
  }
  return { force, stiffness };
}

/** Largest |diagonal entry| of a banded matrix (the stiffness scale of the frame). */
export function maxDiagonal(matrix: Banded): number {
  let largest = 0;
  for (let r = 0; r < matrix.size; r++) largest = Math.max(largest, Math.abs(matrix.values[slot(matrix, r, r)] ?? 0));
  return largest;
}

/** LU factors of a banded matrix (Doolittle, no pivoting): `lower` holds the multipliers, `upper` the reduced rows. */
export interface BandedLu {
  readonly lower: Banded;
  readonly upper: Banded;
}

/**
 * In-band LU without pivoting.
 * @failure a pivot that is not finite or not above SINGULAR_PIVOT x the original diagonal entry of its row (singular tangent: a mechanism,
 *   or a limit point hit exactly) -> null
 */
export function factor(matrix: Banded): BandedLu | null {
  const { size, bandwidth } = matrix;
  const upper: Banded = { size, bandwidth, values: Float64Array.from(matrix.values) };
  const lower = bandedZero(size, bandwidth);
  for (let c = 0; c < size; c++) {
    const pivot = upper.values[slot(upper, c, c)] ?? 0;
    const diagonal = Math.abs(matrix.values[slot(matrix, c, c)] ?? 0);
    if (!Number.isFinite(pivot) || !(Math.abs(pivot) > SINGULAR_PIVOT * diagonal) || pivot === 0) return null;
    const last = Math.min(size, c + bandwidth + 1);
    for (let r = c + 1; r < last; r++) {
      const value = upper.values[slot(upper, r, c)] ?? 0;
      if (value === 0) continue;
      const multiplier = value / pivot;
      lower.values[slot(lower, r, c)] = multiplier;
      for (let k = c; k < last; k++) {
        const cell = slot(upper, r, k);
        upper.values[cell] = at(upper.values, cell) - multiplier * at(upper.values, slot(upper, c, k));
      }
    }
  }
  return { lower, upper };
}

/** x with A x = b for the factors of A. */
export function solve({ lower, upper }: BandedLu, rhs: Float64Array): Float64Array {
  const { size, bandwidth } = upper;
  const y = Float64Array.from(rhs);
  for (let r = 0; r < size; r++)
    for (let c = Math.max(0, r - bandwidth); c < r; c++) {
      const multiplier = lower.values[slot(lower, r, c)] ?? 0;
      if (multiplier !== 0) y[r] = at(y, r) - multiplier * at(y, c);
    }
  const x = new Float64Array(size);
  for (let r = size - 1; r >= 0; r--) {
    let sum = y[r] ?? 0;
    for (let c = r + 1; c < Math.min(size, r + bandwidth + 1); c++) sum -= at(upper.values, slot(upper, r, c)) * at(x, c);
    x[r] = sum / at(upper.values, slot(upper, r, r));
  }
  return x;
}

/** Model over `coords` / `elements` with the global dofs in `fixed` restrained. */
export function frameModel(
  coords: readonly (readonly [number, number])[],
  elements: readonly FrameElement[],
  fixed: ReadonlySet<number>,
): FrameModel {
  const dofs = 3 * coords.length;
  const free: number[] = [];
  const position = new Int32Array(dofs).fill(-1);
  for (let dof = 0; dof < dofs; dof++)
    if (!fixed.has(dof)) {
      position[dof] = free.length;
      free.push(dof);
    }
  let bandwidth = 0;
  for (const { a, b } of elements) {
    const used = [3 * a, 3 * a + 1, 3 * a + 2, 3 * b, 3 * b + 1, 3 * b + 2].flatMap((dof) => {
      const p = position[dof];
      return p === undefined || p < 0 ? [] : [p];
    });
    if (used.length > 0) bandwidth = Math.max(bandwidth, Math.max(...used) - Math.min(...used));
  }
  return { coords, elements, dofs, free, position, bandwidth };
}
