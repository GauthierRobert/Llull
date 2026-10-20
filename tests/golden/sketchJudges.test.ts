/**
 * SC-Q4b judges for the sketch solver (docs/MUTATION.md): every constraint family solved through `build_project`, checked against the
 * independent oracle (`sketchOracle.ts`: residuals to 1e-9, DOF = unknowns − rank), plus the guards that refuse conflicting, redundant
 * and flipping constraints.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { describePlans } from './describePlans';
import { runPlan } from './runPlan';
import { sketchPlans } from './sketchPlans';
import { oracleDof, worstResidual } from './sketchOracle';

interface SolveData {
  converged: boolean;
  dof: number;
  fullyConstrained: string[];
  isFullyConstrained: boolean;
  skipped: unknown[];
}

const solve = (doc: CadDocument): { document: CadDocument; data: SolveData } => {
  const result = execute(doc, 'solve_constraints', {});
  return { document: result.document, data: result.data as SolveData };
};

describe('sketch judge corpus', () => describePlans(Object.fromEntries(Object.entries(sketchPlans).map(([name, p]) => [name, p.actions]))));

describe('sketch judges against the independent oracle', () => {
  for (const [name, plan] of Object.entries(sketchPlans)) {
    it(`${name}: converges, satisfies every constraint and reports DOF ${plan.dof}`, () => {
      const outcome = runPlan(plan.actions);
      expect(outcome.failedSteps).toEqual([]);
      const { document, data } = solve(outcome.document);
      expect(data.converged).toBe(true);
      expect(data.skipped).toEqual([]);
      expect(worstResidual(document).residual).toBeLessThan(1e-9);
      expect(data.dof).toBe(plan.dof);
      expect(oracleDof(document)).toBe(plan.dof);
      expect(data.isFullyConstrained).toBe(plan.dof === 0);
    });
  }
});
