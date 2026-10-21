/** CAE plugin: analysis set-up (05), thermal (PHY-03), thermo-mechanical (PHY-04), nonlinear static (PHY-05) and structural dynamics (PHY-09) commands under the `analysis` toolset. */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { analyticCommands } from './analytic/catalog';
import { feaCommands } from './commands/catalog';
import { dynamicsCommands } from './dynamics/catalog';
import { dynamicsErrors } from './dynamics/validate';
import { fatigueCommands } from './fatigue/catalog';
import { fractureCommands } from './fracture/catalog';
import { analysisReferenceGuard, durabilityReferenceGuard } from './guard';
import { marginCommands } from './margins/catalog';
import { analysisErrors } from './model/validate';
import { nonlinearCommands } from './nonlinear/catalog';
import { reliabilityCommands } from './reliability/catalog';
import { reliabilityErrors } from './reliability/model';
import { thermalCommands } from './thermal/catalog';
import { thermomechCommands } from './thermomech/catalog';
import { caeRetiredCommands } from './retired';

/** The analysis slice is pure definition data: nothing is derived, nothing is restored. */
const analysisDocument: DocumentExtension = {
  validate: (raw) => [...analysisErrors(raw), ...reliabilityErrors(raw), ...dynamicsErrors(raw)],
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
};

export const caePlugin: CadPlugin = {
  name: 'cae',
  toolset: 'analysis',
  commands: [
    ...feaCommands,
    ...analyticCommands,
    ...marginCommands,
    ...thermalCommands,
    ...thermomechCommands,
    ...nonlinearCommands,
    ...fatigueCommands,
    ...fractureCommands,
    ...reliabilityCommands,
    ...dynamicsCommands,
  ],
  guards: [analysisReferenceGuard, durabilityReferenceGuard],
  document: analysisDocument,
  retiredCommands: caeRetiredCommands,
};
