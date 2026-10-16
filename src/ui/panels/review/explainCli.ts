// "Copy as CLI": the shell line that reproduces the query behind a check (`llull exec <command> '<json params>'`). Pure.

import type { CheckName, CheckResult } from './reviewTypes';

/** The registry query that produces each check. */
const CHECK_COMMAND: Readonly<Record<CheckName, string>> = {
  assembly: 'check_assembly',
  mechanism: 'inspect_dynamics',
  motion_clearance: 'check_motion_clearance',
  dynamics: 'simulate_motion',
};

export function explainCliCommand(result: CheckResult): string {
  const params = typeof result.provenance.params === 'object' && result.provenance.params !== null ? result.provenance.params : {};
  const json = JSON.stringify(params).replace(/'/g, `'\\''`);
  return `llull exec ${CHECK_COMMAND[result.check]} '${json}'`;
}
