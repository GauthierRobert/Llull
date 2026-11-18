// simulate_motion for the Physics panel. It runs on the backend only (MuJoCo under Node): the served app's CSP has no 'unsafe-eval',
// which MuJoCo's WASM bindings need at load, so the renderer carries no engine. Disconnected, it answers that the backend is needed.

import { useStore } from '@ui/store';
import { postCommand, ServerCommandError } from '@ui/store/serverCommands';

export interface SimulationRun {
  readonly summary: string;
  readonly data: unknown;
}

async function runOnServer(params: Record<string, unknown>): Promise<SimulationRun> {
  try {
    const response = await postCommand('simulate_motion', params);
    return { summary: response.summary, data: response.data };
  } catch (error: unknown) {
    const reason = error instanceof ServerCommandError ? error.message : String(error);
    return { summary: `simulate_motion failed on the server: ${reason}`, data: undefined };
  }
}

const NEEDS_BACKEND = 'simulate_motion needs the llull backend (the physics engine runs there); it is not connected.';

export async function runSimulation(params: Record<string, unknown>): Promise<SimulationRun> {
  if (useStore.getState().liveStatus === 'connected') return runOnServer(params);
  return { summary: NEEDS_BACKEND, data: undefined };
}
