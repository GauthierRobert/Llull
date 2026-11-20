/** `FeatureStep.mergedStepKeys` (SIG-REPLAY), declared beside types.ts (at its line budget) by interface merging. */

import { stepKeyOf } from '../lib/id';
import type { FeatureStep } from './types';

/** Every step key `step` stands for: its own and those `squash_steps` merged into it (a signed record stamped by any of them stays live). */
export function stepKeysOf(step: FeatureStep): string[] {
  return [stepKeyOf(step.id), ...(step.mergedStepKeys ?? [])];
}

declare module './types' {
  interface FeatureStep {
    /** Keys of the steps `squash_steps` merged into this one besides its own: a signed record stamped by any of them stays live (SIG-REPLAY). */
    mergedStepKeys?: readonly string[];
  }
}
