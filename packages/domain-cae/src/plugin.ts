/** CAE plugin: analysis set-up (05), thermal (PHY-03) and thermo-mechanical (PHY-04) commands under the `analysis` toolset. */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { feaCommands } from './commands/catalog';
import { analysisReferenceGuard } from './guard';
import { analysisErrors } from './model/validate';
import { thermalCommands } from './thermal/catalog';
import { thermomechCommands } from './thermomech/catalog';

/** The analysis slice is pure definition data: nothing is derived, nothing is restored. */
const analysisDocument: DocumentExtension = { validate: analysisErrors, derivedEntityIds: () => new Set<string>(), restore: (raw) => raw };

export const caePlugin: CadPlugin = {
  name: 'cae',
  toolset: 'analysis',
  commands: [...feaCommands, ...thermalCommands, ...thermomechCommands],
  guards: [analysisReferenceGuard],
  document: analysisDocument,
};
