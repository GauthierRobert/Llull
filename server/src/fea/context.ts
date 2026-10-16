/** The execution context every server / CLI `execute` call runs in: process defaults + the FE artifact port (no human signature: 09 PLM). */

import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { defaultFeArtifactStore } from './artifactStore';

export function serverContext(): ExecutionContext {
  return { ...defaultContext(), feaArtifacts: defaultFeArtifactStore(), humanSignature: null };
}
