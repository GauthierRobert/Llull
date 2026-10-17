/** The execution context every server / CLI `execute` call runs in: process defaults + the FE artifact port (no human signature: 09 PLM) + the material library provider. */

import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { createLibraryProvider } from '../libraries/libraryStore';
import { defaultFeArtifactStore } from './artifactStore';

export function serverContext(): ExecutionContext {
  return { ...defaultContext(), feaArtifacts: defaultFeArtifactStore(), humanSignature: null, libraries: createLibraryProvider() };
}
