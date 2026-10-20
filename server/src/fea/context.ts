/**
 * The execution context every server / CLI `execute` call runs in: process defaults + the FE artifact port + the material library provider + the
 * signature port of this machine (trust store, 09 PLM) + the local vault's objects (`LLULL_VAULT`). Human-only acts are cleared by that port, never by a caller label.
 */

import { defaultContext } from '@core/commands/context';
import type { ExecutionContext, PlanStepEvent } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { createLibraryProvider } from '../libraries/libraryStore';
import { createSignaturePort } from '../plm/signaturePort';
import { objectsOf } from '../plm/vault/location';
import { defaultFeArtifactStore } from './artifactStore';

export function serverContext(
  onStep?: (event: PlanStepEvent) => void,
  humanSignature: HumanSignaturePort = createSignaturePort(),
): ExecutionContext {
  return {
    ...defaultContext(),
    feaArtifacts: defaultFeArtifactStore(),
    humanSignature,
    libraries: createLibraryProvider(),
    objects: objectsOf(),
    ...(onStep !== undefined ? { onStep } : {}),
  };
}
