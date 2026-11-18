/**
 * One job of the in-page physics worker: a read-only command run on a copy of the document where the MuJoCo engine is installed
 * (`src/physics.worker.ts`). The page itself cannot load the engine: the app's CSP forbids the Function constructor its bindings use, and a
 * dedicated worker takes its policy from its own script response instead (verified in the desktop app). Read-only only: a worker result
 * never becomes the document (architecture L1).
 */
import { execute, getCommand } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';

export interface PhysicsJobRequest {
  readonly id: number;
  readonly document: CadDocument;
  readonly command: string;
  readonly params: Record<string, unknown>;
}

export interface PhysicsJobAnswer {
  readonly id: number;
  readonly summary: string;
  readonly data: unknown;
}

/** Load the engine now, while the backend that serves it is reachable: a later job then runs even if the backend has gone. */
interface PhysicsWarmRequest {
  readonly id: number;
  readonly warm: true;
}

export type PhysicsWorkerRequest = PhysicsJobRequest | PhysicsWarmRequest;

/** The slice of a Worker the client uses (tests pass an in-process one). */
export interface PhysicsWorkerLike {
  postMessage(request: PhysicsWorkerRequest): void;
  onmessage: ((event: { readonly data: PhysicsJobAnswer }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
  terminate(): void;
}

export function answerPhysicsJob(request: PhysicsJobRequest): PhysicsJobAnswer {
  const { id, document, command, params } = request;
  if (getCommand(command)?.annotations?.readOnly !== true)
    return { id, summary: `${command} is not a read-only command: the physics worker only answers queries.`, data: undefined };
  const run = execute(document, command, params);
  return { id, summary: run.summary, data: run.data };
}
