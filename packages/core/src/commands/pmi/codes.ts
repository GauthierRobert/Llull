/** Stable refusal codes of the stack-up and fastener queries (GDT TECHNICAL_SPEC §7.2, AF-11) with their one-line remediation. */

import { tableRejection } from '../noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  GDT_STACKUP_EXPRESSION: 'use + - * / ( ), numbers, pi, the built-in functions and contributor names',
  GDT_STACKUP_SAMPLES_CAP: 'use 1000..2000000 samples, or the native tool `llull stackup_monte_carlo` (llull-compute) above',
  GDT_STACKUP_SENSITIVITY_CONFLICT: 'give either expression or a sensitivity on every contributor',
  GDT_STACKUP_CONTRIBUTOR_INVALID: 'give 1..64 contributors with unique identifier names and finite values',
  GDT_STACKUP_NON_FINITE: 'the expression is not finite for some sampled values (division by zero, sqrt of a negative): check the limits',
  GDT_LIMITS_INVERTED: 'swap the limits (lower <= upper)',
  GDT_FASTENER_HOLE_LE_FASTENER: 'no clearance: no positional tolerance is possible (hole MMC must exceed fastener MMC)',
  GDT_FASTENER_PARAM_INVALID: 'give positive sizes; actualSize within [holeMmc, holeLmc]; statedPosition for the bonus fields',
};

export const refuseGdt = tableRejection(REMEDIATION);
