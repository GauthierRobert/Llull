import { answerPhysicsJob, type PhysicsJobRequest, type PhysicsWorkerLike } from '@app/physicsJob';

/**
 * A physics worker that answers in this process (the engine installed with setPhysicsEngine), one task later, like a real worker would.
 * `log` receives the jobs, `warmUps` counts the engine warm-up requests.
 */
export function inProcessPhysicsWorker(log: PhysicsJobRequest[] = [], warmUps: { count: number } = { count: 0 }): PhysicsWorkerLike {
  const worker: PhysicsWorkerLike = {
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
    postMessage(request) {
      if ('warm' in request) {
        warmUps.count += 1;
        setTimeout(() => worker.onmessage?.({ data: { id: request.id, summary: 'The physics engine is loaded.', data: undefined } }), 0);
        return;
      }
      log.push(request);
      setTimeout(() => worker.onmessage?.({ data: answerPhysicsJob(request) }), 0);
    },
  };
  return worker;
}
