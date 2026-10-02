/**
 * Which geometry kernel a surface installs; one setting for browser (`?kernel=`) and server
 * (`LLULL_KERNEL`).
 *
 * @layer core/geometry
 */

export type KernelChoice = 'manifold' | 'occt';

/** @invariant unknown / empty / missing values yield 'manifold'. */
export function parseKernelChoice(value: string | null | undefined): KernelChoice {
  return value?.trim().toLowerCase() === 'occt' ? 'occt' : 'manifold';
}
