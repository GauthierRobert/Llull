/**
 * Inject the rigid-body physics engine (MuJoCo WASM) into the core at startup (architecture L9), so `simulate_motion` works for the CLI
 * agents and the CLI exactly as in the browser app. On failure the command keeps its graceful "no physics engine" no-op.
 */

import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { errorMessage } from '@lib/errorMessage';

export async function installPhysicsEngine(): Promise<boolean> {
  try {
    setPhysicsEngine(await createMujocoPhysics());
    return true;
  } catch (error) {
    console.warn('[server] physics engine unavailable; simulate_motion will no-op:', errorMessage(error));
    return false;
  }
}
