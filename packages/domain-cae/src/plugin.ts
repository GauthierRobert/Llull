/** CAE plugin: analysis set-up (05), thermal (PHY-03) and thermo-mechanical (PHY-04) commands under the `analysis` toolset. */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { feaCommands } from './commands/catalog';
import { fatigueCommands } from './fatigue/catalog';
import { fractureCommands } from './fracture/catalog';
import { analysisReferenceGuard, durabilityReferenceGuard } from './guard';
import { marginCommands } from './margins/catalog';
import { analysisErrors } from './model/validate';
import { thermalCommands } from './thermal/catalog';
import { thermomechCommands } from './thermomech/catalog';

/** The analysis slice is pure definition data: nothing is derived, nothing is restored. */
const analysisDocument: DocumentExtension = { validate: analysisErrors, derivedEntityIds: () => new Set<string>(), restore: (raw) => raw };

export const caePlugin: CadPlugin = {
  name: 'cae',
  toolset: 'analysis',
  commands: [...feaCommands, ...marginCommands, ...thermalCommands, ...thermomechCommands, ...fatigueCommands, ...fractureCommands],
  guards: [analysisReferenceGuard, durabilityReferenceGuard],
  document: analysisDocument,
};
