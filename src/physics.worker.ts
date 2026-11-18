// Worker entry of the renderer (next to main.tsx): the composition root of the in-page physics engine (architecture L9). Plugins, the
// Manifold kernel and MuJoCo are installed here, in the worker's own module graph, the first time a job arrives. See @app/physicsJob for
// why this is a worker.

import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { setGeometryKernel } from '@core/geometry/kernel';
import { errorMessage } from '@lib/errorMessage';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { answerPhysicsJob, type PhysicsJobAnswer, type PhysicsWorkerRequest } from '@app/physicsJob';
import { installDefaultPlugins } from '@app/plugins';

let ready: Promise<void> | null = null;

function prepare(): Promise<void> {
  ready ??= (async (): Promise<void> => {
    installDefaultPlugins();
    setGeometryKernel(await createManifoldKernel());
    setPhysicsEngine(await createMujocoPhysics());
  })();
  return ready;
}

const post = (answer: PhysicsJobAnswer): void => (self as unknown as { postMessage(message: PhysicsJobAnswer): void }).postMessage(answer);

self.onmessage = (event: MessageEvent<PhysicsWorkerRequest>): void => {
  const request = event.data;
  prepare().then(
    () => {
      if ('warm' in request) return post({ id: request.id, summary: 'The physics engine is loaded.', data: undefined });
      try {
        post(answerPhysicsJob(request));
      } catch (error) {
        post({ id: request.id, summary: `${request.command} failed in the physics worker: ${errorMessage(error)}`, data: undefined });
      }
    },
    (error: unknown) => {
      ready = null;
      post({ id: request.id, summary: `The physics engine could not be loaded: ${errorMessage(error)}`, data: undefined });
    },
  );
};
