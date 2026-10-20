/**
 * The execution context every server / CLI `execute` call runs in: process defaults + the FE artifact port + the material library provider + the
 * signature port of this machine (local key store, 09 PLM) + who is calling.
 */

import { defaultContext } from '@core/commands/context';
import type { CommandCaller, ExecutionContext, PlanStepEvent } from '@core/commands/types';
import { createLibraryProvider } from '../libraries/libraryStore';
import { createSignaturePort } from '../plm/signaturePort';
import { defaultFeArtifactStore } from './artifactStore';

export function serverContext(caller?: CommandCaller, onStep?: (event: PlanStepEvent) => void): ExecutionContext {
  return {
    ...defaultContext(),
    feaArtifacts: defaultFeArtifactStore(),
    humanSignature: createSignaturePort(),
    libraries: createLibraryProvider(),
    ...(caller !== undefined ? { caller } : {}),
    ...(onStep !== undefined ? { onStep } : {}),
  };
}
