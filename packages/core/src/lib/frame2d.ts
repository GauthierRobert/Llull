/**
 * Linear-elastic 2D frame analysis (direct stiffness method, 3 DOF per node).
 * Units are the caller's (e.g. N, mm). Member loads are uniformly distributed, global components
 * per unit member length.
 * @layer lib
 * @pure
 */

export interface FrameNode {
  readonly x: number;
  readonly y: number;
  /** Restrained [ux, uy, rotation]. */
  readonly restraint: readonly [boolean, boolean, boolean];
  /** Point load at the node: forces (global x, y) and moment (counter-clockwise +). */
  readonly load?: { readonly fx: number; readonly fy: number; readonly mz: number };
}

export interface FrameMember {
  readonly a: number;
  readonly b: number;
  readonly E: number;
  readonly A: number;
  readonly I: number;
  /** Uniform load per unit member length, global components. */
  readonly load?: { readonly qx: number; readonly qy: number };
}

interface MemberResult {
  /** Axial force (tension +) at end a and b. */
  readonly axial: readonly [number, number];
  /** Shear at end a and b (local y). */
  readonly shear: readonly [number, number];
  /** Internal bending moment (sagging +) at end a and b. */
  readonly moment: readonly [number, number];
  /** Largest |internal moment| along the member. */
  readonly maxMoment: number;
  /** Largest |axial force| along the member. */
  readonly maxAxial: number;
  /** Largest |global displacement| along the member (x, y), including the in-span deflection. */
  readonly maxDisplacement: { readonly x: number; readonly y: number };
}

export interface FrameResult {
  /** Nodal displacements [ux, uy, rz] per node. */
  readonly displacements: ReadonlyArray<readonly [number, number, number]>;
  readonly members: MemberResult[];
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const a = matrix.map((row, index) => [...row, rhs[index] as number]);
  const tolerance = 1e-10 * Math.max(...matrix.flat().map(Math.abs), 1e-300);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (
        Math.abs((a[row] as number[])[column] as number) >
        Math.abs((a[pivot] as number[])[column] as number)
      )
        pivot = row;
    }
    const pivotRow = a[pivot] as number[];
    if (Math.abs(pivotRow[column] as number) < tolerance) return null;
    [a[column], a[pivot]] = [pivotRow, a[column] as number[]];
    const current = a[column] as number[];
    for (let row = column + 1; row < n; row++) {
      const target = a[row] as number[];
      const factor = (target[column] as number) / (current[column] as number);
      for (let k = column; k <= n; k++)
        target[k] = (target[k] as number) - factor * (current[k] as number);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    const current = a[row] as number[];
    let sum = current[n] as number;
    for (let k = row + 1; k < n; k++) sum -= (current[k] as number) * (x[k] as number);
    x[row] = sum / (current[row] as number);
  }
  return x;
}

interface Local {
  readonly length: number;
  readonly c: number;
  readonly s: number;
  readonly k: number[][];
  /** Fixed-end forces (local, acting on the member's nodes as loads). */
  readonly f0: number[];
  readonly qAxial: number;
  readonly qTransverse: number;
}

function localOf(nodes: ReadonlyArray<FrameNode>, member: FrameMember): Local | null {
  const [na, nb] = [nodes[member.a], nodes[member.b]];
  if (!na || !nb) return null;
  const [dx, dy] = [nb.x - na.x, nb.y - na.y];
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;
  const [c, s] = [dx / length, dy / length];
  const { E, A, I } = member;
  const [ea, ei] = [(E * A) / length, (E * I) / length ** 3];
  const L = length;
  const k = [
    [ea, 0, 0, -ea, 0, 0],
    [0, 12 * ei, 6 * ei * L, 0, -12 * ei, 6 * ei * L],
    [0, 6 * ei * L, 4 * ei * L * L, 0, -6 * ei * L, 2 * ei * L * L],
    [-ea, 0, 0, ea, 0, 0],
    [0, -12 * ei, -6 * ei * L, 0, 12 * ei, -6 * ei * L],
    [0, 6 * ei * L, 2 * ei * L * L, 0, -6 * ei * L, 4 * ei * L * L],
  ];
  const qx = member.load?.qx ?? 0;
  const qy = member.load?.qy ?? 0;
  const qAxial = qx * c + qy * s;
  const qTransverse = -qx * s + qy * c;
  const f0 = [
    (qAxial * L) / 2,
    (qTransverse * L) / 2,
    (qTransverse * L * L) / 12,
    (qAxial * L) / 2,
    (qTransverse * L) / 2,
    (-qTransverse * L * L) / 12,
  ];
  return { length, c, s, k, f0, qAxial, qTransverse };
}

/** local = T · global for one 6-vector. */
function toLocal(c: number, s: number, global: ReadonlyArray<number>): number[] {
  const g = (index: number): number => global[index] as number;
  return [
    c * g(0) + s * g(1),
    -s * g(0) + c * g(1),
    g(2),
    c * g(3) + s * g(4),
    -s * g(3) + c * g(4),
    g(5),
  ];
}

/** global = Tᵀ · local for one 6-vector. */
function toGlobal(c: number, s: number, local: ReadonlyArray<number>): number[] {
  const l = (index: number): number => local[index] as number;
  return [
    c * l(0) - s * l(1),
    s * l(0) + c * l(1),
    l(2),
    c * l(3) - s * l(4),
    s * l(3) + c * l(4),
    l(5),
  ];
}

function memberDofs(member: FrameMember): number[] {
  const [a, b] = [3 * member.a, 3 * member.b];
  return [a, a + 1, a + 2, b, b + 1, b + 2];
}

/**
 * @returns displacements and member forces, or null for a mechanism / invalid model
 */
export function solveFrame(
  nodes: ReadonlyArray<FrameNode>,
  members: ReadonlyArray<FrameMember>,
): FrameResult | null {
  const size = nodes.length * 3;
  const K = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const F = new Array<number>(size).fill(0);
  const locals: Local[] = [];
  for (const member of members) {
    const local = localOf(nodes, member);
    if (!local) return null;
    locals.push(local);
    const dofs = memberDofs(member);
    // Kg = Tᵀ k T, built column by column from unit vectors.
    for (let j = 0; j < 6; j++) {
      const unit = new Array<number>(6).fill(0);
      unit[j] = 1;
      const localUnit = toLocal(local.c, local.s, unit);
      const kLocal = local.k.map((row) =>
        row.reduce((sum, value, index) => sum + value * (localUnit[index] as number), 0),
      );
      const column = toGlobal(local.c, local.s, kLocal);
      for (let i = 0; i < 6; i++) {
        const [row, col] = [dofs[i] as number, dofs[j] as number];
        (K[row] as number[])[col] = ((K[row] as number[])[col] as number) + (column[i] as number);
      }
    }
    const loads = toGlobal(local.c, local.s, local.f0);
    dofs.forEach((dof, index) => {
      F[dof] = (F[dof] as number) + (loads[index] as number);
    });
  }
  nodes.forEach((node, index) => {
    if (!node.load) return;
    F[3 * index] = (F[3 * index] as number) + node.load.fx;
    F[3 * index + 1] = (F[3 * index + 1] as number) + node.load.fy;
    F[3 * index + 2] = (F[3 * index + 2] as number) + node.load.mz;
  });
  const free: number[] = [];
  nodes.forEach((node, index) => {
    node.restraint.forEach((restrained, axis) => {
      if (!restrained) free.push(3 * index + axis);
    });
  });
  // Symmetric diagonal scaling: translational and rotational stiffnesses differ by many orders.
  const scale = free.map((dof) => {
    const diagonal = (K[dof] as number[])[dof] as number;
    return diagonal > 0 ? 1 / Math.sqrt(diagonal) : 1;
  });
  const reduced = free.map((row, i) =>
    free.map(
      (col, j) =>
        ((K[row] as number[])[col] as number) * (scale[i] as number) * (scale[j] as number),
    ),
  );
  const scaled =
    free.length > 0
      ? solveLinear(
          reduced,
          free.map((dof, i) => (F[dof] as number) * (scale[i] as number)),
        )
      : [];
  if (!scaled) return null;
  const solution = scaled.map((value, i) => value * (scale[i] as number));
  const u = new Array<number>(size).fill(0);
  free.forEach((dof, index) => {
    u[dof] = solution[index] as number;
  });
  const results = members.map((member, index): MemberResult => {
    const local = locals[index] as Local;
    const global = memberDofs(member).map((dof) => u[dof] as number);
    const d = toLocal(local.c, local.s, global);
    const end = local.k.map(
      (row, i) =>
        row.reduce((sum, value, j) => sum + value * (d[j] as number), 0) - (local.f0[i] as number),
    );
    const [Na, Va, Ma, Nb, , Mb] = end as [number, number, number, number, number, number];
    const momentAt = (x: number): number => -Ma + Va * x + (local.qTransverse * x * x) / 2;
    const L = local.length;
    const ei = member.E * member.I;
    // Hermite interpolation of the end displacements + the fixed-end deflection of the load.
    const transverseAt = (x: number): number => {
      const t = x / L;
      return (
        (1 - 3 * t * t + 2 * t ** 3) * (d[1] as number) +
        (t - 2 * t * t + t ** 3) * L * (d[2] as number) +
        (3 * t * t - 2 * t ** 3) * (d[4] as number) +
        (-t * t + t ** 3) * L * (d[5] as number) +
        (local.qTransverse * x * x * (L - x) ** 2) / (24 * ei)
      );
    };
    let maxMoment = 0;
    const maxDisplacement = { x: 0, y: 0 };
    for (let step = 0; step <= 40; step++) {
      const x = (L * step) / 40;
      maxMoment = Math.max(maxMoment, Math.abs(momentAt(x)));
      const axialDisplacement = (d[0] as number) + ((d[3] as number) - (d[0] as number)) * (x / L);
      const transverse = transverseAt(x);
      maxDisplacement.x = Math.max(
        maxDisplacement.x,
        Math.abs(local.c * axialDisplacement - local.s * transverse),
      );
      maxDisplacement.y = Math.max(
        maxDisplacement.y,
        Math.abs(local.s * axialDisplacement + local.c * transverse),
      );
    }
    return {
      axial: [-Na, Nb],
      shear: [Va, -(end[4] as number)],
      moment: [-Ma, Mb],
      maxMoment,
      maxAxial: Math.max(Math.abs(Na), Math.abs(Nb)),
      maxDisplacement,
    };
  });
  return {
    displacements: nodes.map(
      (_, index) =>
        [u[3 * index] as number, u[3 * index + 1] as number, u[3 * index + 2] as number] as const,
    ),
    members: results,
  };
}
