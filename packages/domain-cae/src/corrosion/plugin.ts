/** Corrosion and environmental compatibility plugin (PHY-13): environment, galvanic groups, surface systems, isolations, galvanic checks and the human acceptance gate, toolset `materials`. */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { corrosionCommands } from './catalog';
import { corrosionErrors } from './model';

/** Definition data: nothing is derived, nothing is restored; a replay keeps the human acceptances (their steps carry no signature). */
const corrosionDocument: DocumentExtension = {
  validate: corrosionErrors,
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
  replaySeed: (base) => {
    const acceptances = base.corrosion?.acceptances ?? {};
    return Object.keys(acceptances).length === 0 ? {} : { corrosion: { materials: {}, surfaceSystems: {}, isolations: {}, acceptances } };
  },
};

export const corrosionPlugin: CadPlugin = {
  name: 'physics-corrosion',
  toolset: 'materials',
  commands: corrosionCommands,
  document: corrosionDocument,
};
