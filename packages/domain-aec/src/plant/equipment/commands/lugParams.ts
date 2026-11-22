/** Resolution of the `lugs` support (plant 03 EQP §13.10): every dimension is a required caller input; refusals name the path. */

import { lugFitProblem } from '../geometry/lugs';
import type { LugSupport } from '../plantData';

/** Where the lugs may stand: shell ends as heights above the bottom tangent line, and the shell outside radius at the lug root. */
export interface LugShell {
  readonly from: number;
  readonly to: number;
  readonly rootRadius: number;
}

interface LugInput {
  readonly count?: number | undefined;
  readonly lugHeight?: number | undefined;
  readonly lugWidth?: number | undefined;
  readonly lugProjection?: number | undefined;
  readonly lugThickness?: number | undefined;
  readonly lugBasePlateThickness?: number | undefined;
  readonly lugBoltHoleDiameter?: number | undefined;
  readonly lugElevation?: number | undefined;
  readonly baseElevation?: number | undefined;
}

interface LugRefusal {
  readonly code: 'EQP_SUPPORT_INVALID';
  readonly message: string;
  readonly path: string;
}

const REQUIRED = ['lugHeight', 'lugWidth', 'lugProjection', 'lugThickness', 'lugBasePlateThickness', 'lugElevation', 'count'] as const;

/**
 * @failure a missing required dimension, count < 2, a lug that does not lie on the shell / fit the circumference / base plate thicker than the lug -> EQP_SUPPORT_INVALID with the path
 * @invariant no dimension is defaulted except baseElevation (named, 0)
 */
export function resolveLugs(input: LugInput, shell: LugShell, defaulted: string[]): LugSupport | LugRefusal {
  const fail = (message: string, path: string): LugRefusal => ({ code: 'EQP_SUPPORT_INVALID', message, path });
  for (const name of REQUIRED)
    if (input[name] === undefined)
      return fail(`support.${name} is required for a lugs support (no lug dimension is defaulted)`, `support.${name}`);
  const count = input.count as number;
  if (count < 2) return fail(`lugs needs count >= 2 (got ${count})`, 'support.count');
  const dimensions = {
    count,
    lugHeight: input.lugHeight as number,
    lugWidth: input.lugWidth as number,
    lugProjection: input.lugProjection as number,
    lugThickness: input.lugThickness as number,
    lugBasePlateThickness: input.lugBasePlateThickness as number,
    lugElevation: input.lugElevation as number,
    ...(input.lugBoltHoleDiameter === undefined ? {} : { lugBoltHoleDiameter: input.lugBoltHoleDiameter }),
  };
  const problem = lugFitProblem(dimensions, shell, shell.rootRadius);
  if (problem !== null) return fail(problem.message, problem.path);
  if (input.baseElevation === undefined) defaulted.push('support.baseElevation');
  return { type: 'lugs', ...dimensions, baseElevation: input.baseElevation ?? 0 };
}
