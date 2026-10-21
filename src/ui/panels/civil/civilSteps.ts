// Start state of the civil workflow sections: a step is done once it holds objects; done steps and the first step not done start expanded.

import type { CivilCategory, CivilModel } from '@aec/index';
import type { CivilStepState } from './CivilParts';

const STEP_CATEGORIES = {
  survey: ['pointGroup'],
  terrain: ['surface'],
  earthworks: ['platform'],
  roads: ['alignment'],
  drainage: ['manhole', 'pipe'],
} as const satisfies Record<string, readonly CivilCategory[]>;

type CivilStep = keyof typeof STEP_CATEGORIES;

export function civilStepStates(civil: CivilModel | undefined): Record<CivilStep, CivilStepState> {
  const present = new Set(Object.values(civil?.objects ?? {}).map((object) => object.category));
  const steps = Object.keys(STEP_CATEGORIES) as CivilStep[];
  const isDone = (step: CivilStep): boolean => STEP_CATEGORIES[step].some((category) => present.has(category));
  const next = steps.find((step) => !isDone(step));
  return Object.fromEntries(steps.map((step) => [step, { done: isDone(step), defaultOpen: isDone(step) || step === next }])) as Record<
    CivilStep,
    CivilStepState
  >;
}
