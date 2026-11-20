/** CAE plugin: analysis set-up (05), thermal (PHY-03), thermo-mechanical (PHY-04), nonlinear static (PHY-05), contact and joints (PHY-06), creep (PHY-11) and structural dynamics (PHY-09) commands under the `analysis` toolset. */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { survivesReplay, type StepStamped } from '@lib/replaySurvivors';
import { analyticCommands } from './analytic/catalog';
import { feaCommands } from './commands/catalog';
import { dynamicsCommands } from './dynamics/catalog';
import { dynamicsErrors } from './dynamics/validate';
import { fatigueCommands } from './fatigue/catalog';
import { flightLoadCommands } from './flightLoads/catalog';
import { printErrors } from './flightLoads/print/validate';
import { fractureCommands } from './fracture/catalog';
import { analysisReferenceGuard, durabilityReferenceGuard } from './guard';
import { marginCommands } from './margins/catalog';
import { analysisErrors } from './model/validate';
import { nonlinearCommands } from './nonlinear/catalog';
import { contactCommands } from './contact/catalog';
import { creepCommands } from './creep/catalog';
import { processCommands } from './process/catalog';
import { reliabilityCommands } from './reliability/catalog';
import { reliabilityErrors } from './reliability/model';
import { vnvCommands } from './vnv/catalog';
import { thermalCommands } from './thermal/catalog';
import { thermomechCommands } from './thermomech/catalog';
import { caeRetiredCommands } from './retired';

/** The analysis slice is pure definition data: nothing is derived, nothing is restored. */
const analysisDocument: DocumentExtension = {
  validate: (raw) => [...analysisErrors(raw), ...reliabilityErrors(raw), ...dynamicsErrors(raw), ...printErrors(raw)],
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
  // Replay regenerates the cases from their steps: the ledgers of human acts are kept so a recorded accept_verification_exception / dispose_fit_result / dispose_margin / dispose_thermal_limit re-applies its verified act.
  replaySeed: (base, liveStepKeys) => {
    // SIG-REPLAY: a ledger entry is seeded only while the step that recorded it is live
    const live = <T extends StepStamped>(ledger: readonly T[] | undefined): T[] | undefined =>
      ledger?.filter((entry) => survivesReplay(entry, liveStepKeys));
    const exceptionLedger = live(base.analysis?.exceptionLedger);
    const fitLedger = live(base.analysis?.fitLedger);
    const dispositionLedger = live(base.analysis?.dispositionLedger);
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
    ...processCommands,
    ...fatigueCommands,
    ...flightLoadCommands,
    ...fractureCommands,
    ...reliabilityCommands,
    ...dynamicsCommands,
  ],
  guards: [analysisReferenceGuard, durabilityReferenceGuard],
  document: analysisDocument,
  retiredCommands: caeRetiredCommands,
};
