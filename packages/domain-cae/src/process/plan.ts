/** CalculiX step numbering of an AM deck (one place for the writer and the readers): 1 = all layers removed, then per layer an activation step and a strain step, then the release steps. */

import type { AmBuildSettings } from '@core/model/am';

/** Step that activates build layer `buildIndex` (1-based): `*MODEL CHANGE, ADD=STRAIN FREE`, no load. */
export const activationStep = (buildIndex: number): number => 2 * buildIndex;

/** Step in which build layer `buildIndex` receives its inherent strain (global temperature `buildIndex`); the last one ends the build. */
export const strainStep = (buildIndex: number): number => 2 * buildIndex + 1;

/** Result phases of the case: the end of the build, then each release step, with the CalculiX step that carries them. */
export const amPhases = (am: AmBuildSettings, layerCount: number): readonly { readonly name: string; readonly step: number }[] => [
  { name: 'build', step: strainStep(layerCount) },
  ...am.releaseSteps.map((release, index) => ({ name: release.name, step: strainStep(layerCount) + 1 + index })),
];
