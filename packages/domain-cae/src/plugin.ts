/** CAE plugin: analysis set-up (05), thermal (PHY-03), thermo-mechanical (PHY-04), nonlinear static (PHY-05), contact and joints (PHY-06), creep (PHY-11) and structural dynamics (PHY-09) commands under the `analysis` toolset. */

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
import { contactCommands } from './contact/catalog';
import { creepCommands } from './creep/catalog';
import { reliabilityCommands } from './reliability/catalog';
import { reliabilityErrors } from './reliability/model';
import { vnvCommands } from './vnv/catalog';
import { thermalCommands } from './thermal/catalog';
import { thermomechCommands } from './thermomech/catalog';
import { caeRetiredCommands } from './retired';

/** The analysis slice is pure definition data: nothing is derived, nothing is restored. */
const analysisDocument: DocumentExtension = {
  validate: (raw) => [...analysisErrors(raw), ...reliabilityErrors(raw), ...dynamicsErrors(raw)],
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
  // Replay regenerates the cases from their steps: the ledgers of human acts are kept so a recorded accept_verification_exception / dispose_fit_result / dispose_margin / dispose_thermal_limit re-applies its verified act.
  replaySeed: (base) => {
    const { exceptionLedger, fitLedger, dispositionLedger } = base.analysis ?? {};
    const kept = {
      ...(exceptionLedger !== undefined && exceptionLedger.length > 0 ? { exceptionLedger } : {}),
      ...(fitLedger !== undefined && fitLedger.length > 0 ? { fitLedger } : {}),
      ...(dispositionLedger !== undefined && dispositionLedger.length > 0 ? { dispositionLedger } : {}),
    };
    const ledger = base.probabilistic?.acceptanceLedger;
    return {
      ...(Object.keys(kept).length === 0 ? {} : { analysis: { cases: {}, caseOrder: [], ...kept } }),
      ...(ledger === undefined || ledger.length === 0
        ? {}
        : { probabilistic: { variables: {}, variableOrder: [], limitStates: {}, limitStateOrder: [], acceptanceLedger: ledger } }),
    };
  },
};

export const caePlugin: CadPlugin = {
  name: 'cae',
  toolset: 'analysis',
  commands: [
    ...feaCommands,
    ...vnvCommands,
    ...analyticCommands,
    ...marginCommands,
    ...thermalCommands,
    ...thermomechCommands,
    ...nonlinearCommands,
    ...contactCommands,
    ...creepCommands,
    ...fatigueCommands,
    ...fractureCommands,
    ...reliabilityCommands,
    ...dynamicsCommands,
  ],
  guards: [analysisReferenceGuard, durabilityReferenceGuard],
  document: analysisDocument,
  retiredCommands: caeRetiredCommands,
};
