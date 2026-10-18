/** Stable PRB_* refusal codes of the reliability commands (PHY-18 TECHNICAL_SPEC §7.1) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  PRB_DISTRIBUTION_INVALID: 'fix the parameters: sd > 0, lognormal mean > 0, min < max, shape and scale > 0',
  PRB_CORRELATION_INVALID: 'give a symmetric matrix with unit diagonal, off-diagonals in (-1, 1), positive definite, for defined variables',
  PRB_BINDING_UNRESOLVED: 'create the document parameter first (set_parameter) or bind to { kind: "free" }',
  PRB_EXPRESSION_INVALID:
    'use + - * / pow() sqrt() exp() ... over defined random variables, document parameters and numbers (no ^: use pow)',
  PRB_VARIABLE_NOT_FOUND: 'define it with define_random_variable',
  PRB_LIMIT_STATE_NOT_FOUND: 'define it with define_limit_state',
  PRB_MODEL_EMPTY: 'define random variables (define_random_variable) and a limit state (define_limit_state) that uses them',
  PRB_BUDGET_EXCEEDED: 'use fewer samples (cap 2000000), Latin hypercube sampling, or FORM',
  PRB_PARAMS_INVALID: 'follow the command description (sampling methods need an integer seed)',
  PRB_TARGET_INVALID: 'targetBeta / targetPf need a value (targetPf in (0, 1)) and a non-empty source (owner or company rule)',
};

export const refuseReliability = tableRejection(REMEDIATION);
