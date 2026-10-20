/**
 * Classical Laminate Theory (06 CMP §5.2, Jones 1999 ch. 2-4, NASA RP-1351). N, mm, MPa; plies bottom to top; engineering shear strain.
 * Pure leaf shared by the composites plugin (`@aero`) and the margin recovery of `@cae`; the lamina record is described structurally
 * (`LaminaElastic`) so no plugin type is imported (`CadDocument.composites` lamina records satisfy it).
 */

export type Matrix = number[][];
export type Triple = readonly [number, number, number];

/** What CLT needs of a lamina record: moduli (MPa), cured thickness (mm) and the optional expansion coefficients. */
export interface LaminaElastic {
  readonly E1: number;
  readonly E2: number;
  readonly G12: number;
  readonly nu12: number;
  /** Cured ply thickness, mm. */
  readonly plyThickness: number;
  readonly alpha1?: number | undefined;
  readonly alpha2?: number | undefined;
  readonly beta1?: number | undefined;
  readonly beta2?: number | undefined;
}

export interface ReducedStiffness {
  readonly Q11: number;
  readonly Q12: number;
  readonly Q22: number;
  readonly Q66: number;
}

export interface StackPly<M extends LaminaElastic = LaminaElastic> {
  readonly material: M;
  /** Degrees from the laminate x axis. */
  readonly angle: number;
}

export interface Laminate {
  /** N/mm. */
  readonly A: Matrix;
  /** N. */
  readonly B: Matrix;
  /** N*mm. */
  readonly D: Matrix;
  /** Total thickness, mm. */
  readonly thickness: number;
  /** Ply interfaces z_0 .. z_N (mm) from the bottom of the laminate about the mid-plane (z_0 = -h/2). */
  readonly z: readonly number[];
}

export function reducedStiffness({ E1, E2, G12, nu12 }: Pick<LaminaElastic, 'E1' | 'E2' | 'G12' | 'nu12'>): ReducedStiffness {
  const nu21 = (nu12 * E2) / E1;
  const delta = 1 - nu12 * nu21;
  return { Q11: E1 / delta, Q22: E2 / delta, Q12: (nu12 * E2) / delta, Q66: G12 };
}

/** Qbar(theta) as a 3x3 matrix. */
export function transformedStiffness({ Q11, Q12, Q22, Q66 }: ReducedStiffness, angleDeg: number): Matrix {
  const theta = (angleDeg * Math.PI) / 180;
  const m = Math.cos(theta);
  const n = Math.sin(theta);
  const [m2, n2] = [m * m, n * n];
  const q11 = Q11 * m2 * m2 + 2 * (Q12 + 2 * Q66) * m2 * n2 + Q22 * n2 * n2;
  const q12 = (Q11 + Q22 - 4 * Q66) * m2 * n2 + Q12 * (m2 * m2 + n2 * n2);
  const q22 = Q11 * n2 * n2 + 2 * (Q12 + 2 * Q66) * m2 * n2 + Q22 * m2 * m2;
  const q16 = (Q11 - Q12 - 2 * Q66) * m2 * m * n + (Q12 - Q22 + 2 * Q66) * m * n2 * n;
  const q26 = (Q11 - Q12 - 2 * Q66) * m * n2 * n + (Q12 - Q22 + 2 * Q66) * m2 * m * n;
  const q66 = (Q11 + Q22 - 2 * Q12 - 2 * Q66) * m2 * n2 + Q66 * (m2 * m2 + n2 * n2);
  return [
    [q11, q12, q16],
    [q12, q22, q26],
    [q16, q26, q66],
  ];
}

const zeros3 = (): Matrix => [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

/**
 * A, B, D of the stack (summed bottom to top, plain doubles). Ply thickness comes from each ply's material.
 * @invariant z_0 = -h/2, z_k = z_{k-1} + t_k; B follows the bottom-to-top convention (a 0 ply at the bottom of [0/90] gives B11 < 0)
 */
export function laminateStiffness(stack: readonly StackPly[]): Laminate {
  const thickness = stack.reduce((sum, ply) => sum + ply.material.plyThickness, 0);
  const z: number[] = [-thickness / 2];
  const A = zeros3();
  const B = zeros3();
  const D = zeros3();
  for (const ply of stack) {
    const lower = z[z.length - 1] as number;
    const upper = lower + ply.material.plyThickness;
    z.push(upper);
    const q = transformedStiffness(reducedStiffness(ply.material), ply.angle);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const value = (q[i] as number[])[j] as number;
        (A[i] as number[])[j] = ((A[i] as number[])[j] as number) + value * (upper - lower);
        (B[i] as number[])[j] = ((B[i] as number[])[j] as number) + (value * (upper * upper - lower * lower)) / 2;
        (D[i] as number[])[j] = ((D[i] as number[])[j] as number) + (value * (upper ** 3 - lower ** 3)) / 3;
      }
  }
  return { A, B, D, thickness, z };
}

/** [[A, B], [B, D]] as a 6x6 matrix. */
function assemble6(laminate: Pick<Laminate, 'A' | 'B' | 'D'>): Matrix {
  const { A, B, D } = laminate;
  return [0, 1, 2, 3, 4, 5].map((i) =>
    [0, 1, 2, 3, 4, 5].map((j) => {
      const block = i < 3 ? (j < 3 ? A : B) : j < 3 ? B : D;
      return (block[i % 3] as number[])[j % 3] as number;
    }),
  );
}

const norm1 = (matrix: Matrix): number =>
  Math.max(...(matrix[0] ?? []).map((_, j) => matrix.reduce((sum, row) => sum + Math.abs(row[j] as number), 0)));

/** Gauss-Jordan inverse with partial pivoting; null when singular or when the 1-norm condition number exceeds 1e12. */
export function invert(matrix: Matrix): Matrix | null {
  const n = matrix.length;
  const work = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++)
      if (Math.abs((work[row] as number[])[column] as number) > Math.abs((work[pivot] as number[])[column] as number)) pivot = row;
    const pivotRow = work[pivot] as number[];
    if (Math.abs(pivotRow[column] as number) < 1e-300) return null;
    [work[column], work[pivot]] = [work[pivot] as number[], work[column] as number[]];
    const lead = (work[column] as number[])[column] as number;
    work[column] = (work[column] as number[]).map((value) => value / lead);
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = (work[row] as number[])[column] as number;
      if (factor === 0) continue;
      work[row] = (work[row] as number[]).map((value, j) => value - factor * ((work[column] as number[])[j] as number));
    }
  }
  const inverse = work.map((row) => row.slice(n));
  return norm1(matrix) * norm1(inverse) > 1e12 ? null : inverse;
}

export interface EngineeringConstants {
  readonly Ex: number;
  readonly Ey: number;
  readonly Gxy: number;
  readonly nuxy: number;
}

const constantsOf = (a: Matrix, thickness: number): EngineeringConstants => {
  const at = (i: number, j: number): number => (a[i] as number[])[j] as number;
  return { Ex: 1 / (thickness * at(0, 0)), Ey: 1 / (thickness * at(1, 1)), Gxy: 1 / (thickness * at(2, 2)), nuxy: -at(0, 1) / at(0, 0) };
};

/** Flexural constants of an equivalent homogeneous plate from D inverse: E = 12 / (h^3 d). */
const flexuralOf = (d: Matrix, thickness: number): EngineeringConstants => {
  const at = (i: number, j: number): number => (d[i] as number[])[j] as number;
  const scale = 12 / thickness ** 3;
  return { Ex: scale / at(0, 0), Ey: scale / at(1, 1), Gxy: scale / at(2, 2), nuxy: -at(0, 1) / at(0, 0) };
};

/**
 * Membrane constants (A inverse), in-plane constants with bending unrestrained ("free bending": top-left 3x3 block of the ABD inverse) and
 * flexural constants (D inverse); membrane and free-bending are equal for symmetric laminates.
 * @failure singular or ill-conditioned ABD -> null
 */
export function engineeringConstants(
  laminate: Laminate,
): {
  readonly abdInverse: Matrix;
  readonly membrane: EngineeringConstants;
  readonly freeBending: EngineeringConstants;
  readonly flexural: EngineeringConstants | null;
} | null {
  const abdInverse = invert(assemble6(laminate));
  const aInverse = invert(laminate.A);
  const dInverse = invert(laminate.D);
  if (abdInverse === null || aInverse === null) return null;
  return {
    abdInverse,
    flexural: dInverse === null ? null : flexuralOf(dInverse, laminate.thickness),
    membrane: constantsOf(aInverse, laminate.thickness),
    freeBending: constantsOf(
      abdInverse.slice(0, 3).map((row) => row.slice(0, 3)),
      laminate.thickness,
    ),
  };
}

export type Load6 = readonly [number, number, number, number, number, number];

/** Mid-plane strains and curvatures for the resultant load [Nx, Ny, Nxy, Mx, My, Mxy] (N/mm, N*mm/mm). */
export function strainsFor(abdInverse: Matrix, load: Load6): { readonly strain: Triple; readonly curvature: Triple } {
  const response = abdInverse.map((row) => row.reduce((sum, value, j) => sum + value * (load[j] as number), 0));
  return {
    strain: [response[0] as number, response[1] as number, response[2] as number],
    curvature: [response[3] as number, response[4] as number, response[5] as number],
  };
}

export interface PlyPointStress {
  /** Stresses in the laminate axes (sx, sy, txy), MPa. */
  readonly xy: Triple;
  /** Stresses in the material axes (s1, s2, t12), MPa. */
  readonly material: Triple;
}

/** Stresses at height z (mm from the mid-plane) in a ply of angle `angleDeg`. */
export function plyStressAt(
  material: LaminaElastic,
  angleDeg: number,
  strain: Triple,
  curvature: Triple,
  z: number,
  free: Triple = [0, 0, 0],
): PlyPointStress {
  const q = transformedStiffness(reducedStiffness(material), angleDeg);
  const epsilon = strain.map((value, i) => value + z * (curvature[i] as number) - (free[i] as number));
  const [sx, sy, txy] = q.map((row) => row.reduce((sum, value, j) => sum + value * (epsilon[j] as number), 0)) as [number, number, number];
  const theta = (angleDeg * Math.PI) / 180;
  const [m, n] = [Math.cos(theta), Math.sin(theta)];
  return {
    xy: [sx, sy, txy],
    material: [
      m * m * sx + n * n * sy + 2 * m * n * txy,
      n * n * sx + m * m * sy - 2 * m * n * txy,
      -m * n * sx + m * n * sy + (m * m - n * n) * txy,
    ],
  };
}

/** Uniform change of temperature (K) and moisture content (mass fraction) the laminate sees relative to its stress-free state. */
export interface Environment {
  readonly deltaT: number;
  readonly deltaMoisture: number;
}

/** Names of the hygrothermal coefficients `material` lacks for `env`. */
export function missingHygrothermal(material: LaminaElastic, env: Environment): string[] {
  const thermal = env.deltaT !== 0 ? (['alpha1', 'alpha2'] as const).filter((name) => material[name] === undefined) : [];
  const moisture = env.deltaMoisture !== 0 ? (['beta1', 'beta2'] as const).filter((name) => material[name] === undefined) : [];
  return [...thermal, ...moisture];
}

/** Free (unrestrained) strain of a ply in the laminate axes (engineering shear): alpha dT + beta dC rotated by the ply angle. */
export function freeStrainXy(material: LaminaElastic, angleDeg: number, env: Environment): Triple {
  const theta = (angleDeg * Math.PI) / 180;
  const [m, n] = [Math.cos(theta), Math.sin(theta)];
  const along = (material.alpha1 ?? 0) * env.deltaT + (material.beta1 ?? 0) * env.deltaMoisture;
  const across = (material.alpha2 ?? 0) * env.deltaT + (material.beta2 ?? 0) * env.deltaMoisture;
  return [along * m * m + across * n * n, along * n * n + across * m * m, 2 * (along - across) * m * n];
}

/** Hygrothermal force (N/mm) and moment (N*mm/mm) resultants of the stack: sum of Qbar e_free over the plies. */
export function environmentResultants(stack: readonly StackPly[], laminate: Laminate, env: Environment): Load6 {
  const load = [0, 0, 0, 0, 0, 0];
  stack.forEach((ply, index) => {
    const [lower, upper] = [laminate.z[index] as number, laminate.z[index + 1] as number];
    const q = transformedStiffness(reducedStiffness(ply.material), ply.angle);
    const free = freeStrainXy(ply.material, ply.angle, env);
    q.forEach((row, i) => {
      const force = row.reduce((sum, value, j) => sum + value * (free[j] as number), 0);
      load[i] = (load[i] as number) + force * (upper - lower);
      load[i + 3] = (load[i + 3] as number) + (force * (upper * upper - lower * lower)) / 2;
    });
  });
  return load as unknown as Load6;
}
