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
  PRB_RESPONSE_NOT_QUERY: 'name a registered read-only (query) command and a JSON pointer to a number in its data',
  PRB_RESPONSE_NOT_FOUND: 'define it with define_response or pass { command, params, pointer }',
  PRB_RESPONSE_FAILED:
    'the query refused or its pointer is not a finite number at the perturbed / sampled values; fix the response or the range',
  PRB_PARAMETER_NOT_FOUND: 'create the document parameter first (set_parameter)',
  PRB_SOBOL_CORRELATED: 'Sobol indices need independent inputs: remove the correlation of the used variables',
  PRB_VARIANCE_ZERO: 'the response does not vary over the sampled inputs; widen the distributions or pick another response',
  PRB_VARIABLE_NOT_APPLIED:
    'a response is evaluated only through document parameters and material density: delete or rebind the listed variables, or study a limit state expression that uses them as symbols',
  PRB_HUMAN_GATE: 'hand the result over to the qualified reviewer, who accepts it in the desktop app; an agent cannot sign',
  PRB_DOCUMENT_UNIDENTIFIED: 'save the document so it has a uid before a human signs for it',
  PRB_RESULT_STALE: 'the model changed: re-run the study, read the new modelHash from describe_probabilistic_model and hand it over again',
  PRB_TARGET_INVALID: 'targetBeta / targetPf need a value (targetPf in (0, 1)) and a non-empty source (owner or company rule)',
};

export const refuseReliability = tableRejection(REMEDIATION);
