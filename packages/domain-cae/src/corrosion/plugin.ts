/** Corrosion and environmental compatibility plugin (PHY-13): environment, galvanic groups, surface systems, isolations, galvanic checks and the human acceptance gate, toolset `materials`. */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { survivingRecords } from '@lib/replaySurvivors';
import { corrosionCommands } from './catalog';
import { corrosionReferenceGuard } from './guard';
import { corrosionErrors } from './model';

/** Definition data: nothing is derived, nothing is restored; a replay keeps the human acceptances whose step is live (their steps carry no signature). */
const corrosionDocument: DocumentExtension = {
  validate: corrosionErrors,
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
  replaySeed: (base, liveStepKeys) => {
    const acceptances = survivingRecords(base.corrosion?.acceptances ?? {}, liveStepKeys);
    return Object.keys(acceptances).length === 0 ? {} : { corrosion: { materials: {}, surfaceSystems: {}, isolations: {}, acceptances } };
  },
};

export const corrosionPlugin: CadPlugin = {
  name: 'physics-corrosion',
  toolset: 'materials',
  commands: corrosionCommands,
  guards: [corrosionReferenceGuard],
  document: corrosionDocument,
};
