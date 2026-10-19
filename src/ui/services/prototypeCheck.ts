// check_prototype for the Review tab (read-only query: kernel + physics). Online it runs on the server (same reason as simulationRun:
// the served app's CSP blocks the in-page MuJoCo load); offline it runs in the page. Where check_prototype is not registered, the tab
// runs the individual checks that are (check_assembly, check_mechanism, check_motion_clearance — each returns one check-result
// envelope) and wraps them as one review; a check no command provides reads "not run".

import { getCommand } from '@core/commands/registry';
import { ensurePhysicsEngine } from '@app/physics';
import { useStore } from '@ui/store';
import { runQuery } from '@ui/services/localQuery';
import { postCommand, ServerCommandError } from '@ui/store/serverCommands';

export const CHECK_COMMAND = 'check_prototype';
const ASSEMBLY_COMMAND = 'check_assembly';
/** Single-check commands composed into a review when check_prototype is absent, in checklist order. */
const MOTION_COMMAND = 'check_motion_clearance';
const DYNAMICS_COMMAND = 'check_dynamics';
const PART_COMMANDS = [ASSEMBLY_COMMAND, 'check_mechanism', MOTION_COMMAND, DYNAMICS_COMMAND] as const;
/** Single checks that simulate the mechanism (they need the physics engine). */
const SIMULATING = new Set<string>([MOTION_COMMAND, DYNAMICS_COMMAND]);

/** The single checks the Review tab will run (check_prototype absent). */
const CHECK_TITLES: Readonly<Record<string, string>> = {
  assembly: 'Buildability',
  mechanism: 'Mechanism',
  motion_clearance: 'Motion clearance',
  dynamics: 'Dynamics',
};

/** The single checks the Review tab will run (check_prototype absent). */
export const availableParts = (): string[] => PART_COMMANDS.filter((name) => getCommand(name) !== undefined);

/** The command the Review tab runs: check_prototype, else check_assembly (+ the other single checks), else none. */
export function reviewCheckCommand(): string | null {
  if (getCommand(CHECK_COMMAND) !== undefined) return CHECK_COMMAND;
  return getCommand(ASSEMBLY_COMMAND) !== undefined ? ASSEMBLY_COMMAND : null;
}

interface PrototypeCheckRun {
  readonly summary: string;
  readonly data: unknown;
}

async function runOnServer(command: string, params: Record<string, unknown>): Promise<PrototypeCheckRun> {
  try {
    const response = await postCommand(command, params);
    return { summary: response.summary, data: response.data };
  } catch (error: unknown) {
    const reason = error instanceof ServerCommandError ? error.message : String(error);
    return { summary: `${command} failed on the server: ${reason}`, data: undefined };
  }
}

const isEnvelope = (data: unknown): boolean => typeof data === 'object' && data !== null && 'check' in data && 'items' in data;

/** Runs every available single check and wraps the envelopes as one review (a failed run is reported, the others still count). */
async function runSingleChecks(params: Record<string, unknown>, onStatus: (status: string) => void): Promise<PrototypeCheckRun> {
  const online = useStore.getState().liveStatus === 'connected';
  // check_motion_clearance / check_dynamics simulate the mechanism: offline they need the in-page physics engine first.
  if (!online && availableParts().some((name) => SIMULATING.has(name))) {
    onStatus('Loading the physics engine…');
    await ensurePhysicsEngine();
  }
  const runs = await Promise.all(
    availableParts().map((name) => (online ? runOnServer(name, params) : Promise.resolve(runQuery(name, params)))),
  );
  const checks = runs.flatMap((run) => (isEnvelope(run.data) ? [run.data] : []));
  const summary = runs.map((run) => run.summary).join(' ');
  // The owner reads one line per check (verdict), not the agents' long summaries.
  const ownerSummary = checks
    .map(
      (check) =>
        `${CHECK_TITLES[String((check as { check: unknown }).check)] ?? 'Check'}: ${String((check as { status: unknown }).status)}`,
    )
    .join(' · ');
  return { summary, data: checks.length === 0 ? undefined : { checks, ownerSummary } };
}

export async function runPrototypeCheck(params: Record<string, unknown>, onStatus: (status: string) => void): Promise<PrototypeCheckRun> {
  if (reviewCheckCommand() === ASSEMBLY_COMMAND) return runSingleChecks(params, onStatus);
  if (useStore.getState().liveStatus === 'connected') return runOnServer(CHECK_COMMAND, params);
  onStatus('Loading the physics engine…');
  if (!(await ensurePhysicsEngine())) return { summary: 'The physics engine could not be loaded (see the console).', data: undefined };
  await new Promise((resolve) => setTimeout(resolve, 0));
  const run = runQuery(CHECK_COMMAND, params);
  return { summary: run.summary, data: run.data };
}
