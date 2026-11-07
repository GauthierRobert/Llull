import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Design intent of the physics-office job (solution verification of a finite-element result): the 05 cantilever of the validation plan
 * `vnv_beamp_convergence` (1 mm x 1 mm x 8 mm steel bar, fixed at z = 0, 9 N across the free end), the owner's accuracy target and the closed-form
 * reference the verified result is judged against. The brief, the scripted calls and the acceptance criteria are all generated from it.
 */

export interface PlanStep {
  readonly command: string;
  readonly params: Record<string, unknown>;
  readonly as?: string;
}

export interface PhysicsIntent {
  readonly title: string;
  readonly bar: { readonly size: readonly [number, number, number]; readonly youngMpa: number; readonly poisson: number };
  readonly tipForceN: number;
  /** The owner's required GCI of the finest level, a fraction (no llull default exists). */
  readonly gciTarget: number;
  /** Tip deflection (mm) of Euler-Bernoulli plus Timoshenko shear (05 VC-FEA-10.b); the extrapolated value must be within `theoryTolerance`. */
  readonly tipDeflectionMm: number;
  readonly theoryTolerance: number;
  readonly levels: number;
  readonly ratio: number;
  /** The validation plan that builds the model (docs/physics/00-vv-harness/validation/plans). */
  readonly planSteps: readonly PlanStep[];
}

const PLAN = path.resolve(__dirname, '../../../docs/physics/00-vv-harness/validation/plans/vnv_beamp_convergence.plan.json');

export const physicsIntent: PhysicsIntent = {
  title: 'Cantilever tip deflection — verified to the owner target',
  bar: { size: [1, 1, 8], youngMpa: 210000, poisson: 0.3 },
  tipForceN: 9,
  gciTarget: 0.02,
  tipDeflectionMm: 0.0888411,
  theoryTolerance: 0.02,
  levels: 3,
  ratio: 2,
  planSteps: JSON.parse(readFileSync(PLAN, 'utf8')) as PlanStep[],
};
