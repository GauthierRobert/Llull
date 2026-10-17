/** 6-component helpers (Voigt [11, 22, 33, 12, 13, 23]): stresses and tensor back stresses carry TENSOR shear, strains ENGINEERING shear. */

export type Vec6 = number[];

export const zero6 = (): Vec6 => [0, 0, 0, 0, 0, 0];

/** Double contraction a:b of two symmetric tensors in Voigt storage with tensor shear. */
export const contract = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) +
  (a[1] ?? 0) * (b[1] ?? 0) +
  (a[2] ?? 0) * (b[2] ?? 0) +
  2 * ((a[3] ?? 0) * (b[3] ?? 0) + (a[4] ?? 0) * (b[4] ?? 0) + (a[5] ?? 0) * (b[5] ?? 0));

export const mean3 = (a: readonly number[]): number => ((a[0] ?? 0) + (a[1] ?? 0) + (a[2] ?? 0)) / 3;

export function deviator(a: readonly number[]): Vec6 {
  const p = mean3(a);
  return [(a[0] ?? 0) - p, (a[1] ?? 0) - p, (a[2] ?? 0) - p, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0];
}

/** von Mises equivalent √(3/2 s:s) of the deviator of a stress tensor. */
export const vonMises = (stress: readonly number[]): number => Math.sqrt(1.5 * contract(deviator(stress), deviator(stress)));

/** Equivalent q = √(3/2 s:s) of an already deviatoric tensor. */
export const equivalent = (s: readonly number[]): number => Math.sqrt(1.5 * contract(s, s));

/** Equivalent strain rate √(2/3 e:e) of an engineering-shear strain increment (deviatoric part). */
export function equivalentStrain(strain: readonly number[]): number {
  const p = mean3(strain);
  const e0 = (strain[0] ?? 0) - p;
  const e1 = (strain[1] ?? 0) - p;
  const e2 = (strain[2] ?? 0) - p;
  const shear = ((strain[3] ?? 0) ** 2 + (strain[4] ?? 0) ** 2 + (strain[5] ?? 0) ** 2) / 2;
  return Math.sqrt((2 / 3) * (e0 ** 2 + e1 ** 2 + e2 ** 2 + shear));
}
