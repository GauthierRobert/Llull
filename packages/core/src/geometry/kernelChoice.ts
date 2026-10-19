/** Which geometry kernel the local backend and the CLI install (`LLULL_KERNEL`). */

export type KernelChoice = 'manifold' | 'occt';

/** @invariant unknown / empty / missing values yield 'manifold'. */
export function parseKernelChoice(value: string | null | undefined): KernelChoice {
  return value?.trim().toLowerCase() === 'occt' ? 'occt' : 'manifold';
}
