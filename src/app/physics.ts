/**
 * Browser composition of the physics engine (architecture L9): MuJoCo's ~10 MB WASM is fetched the first time a simulation is asked for,
 * never at startup. Resolves false (and simulate_motion keeps its "no physics engine" no-op) when it cannot load.
 */

import { getPhysicsEngine, setPhysicsEngine } from '@core/dynamics/physicsEngine';

let loading: Promise<boolean> | null = null;

export function ensurePhysicsEngine(): Promise<boolean> {
  if (getPhysicsEngine() !== null) return Promise.resolve(true);
  loading ??= import('@physics-mujoco/mujocoPhysics')
    .then(({ createMujocoPhysics }) => createMujocoPhysics())
    .then((engine) => {
      setPhysicsEngine(engine);
      return true;
    })
    .catch((error: unknown) => {
      console.error('MuJoCo physics engine failed to load', error);
      loading = null;
      return false;
    });
  return loading;
}
