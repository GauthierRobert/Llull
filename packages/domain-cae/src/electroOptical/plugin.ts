/** Electro-optical plugin (PHY-15): coatings, bond paths, bonding checks, optical balance and the human disposition gate, toolset `analysis`. */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { electroOpticalCommands } from './catalog';
import { electroOpticalReferenceGuard } from './guard';
import { electroOpticalErrors } from './model';

/** Definition data: nothing is derived, nothing is restored; a replay keeps the human dispositions (their steps carry no signature). */
const electroOpticalDocument: DocumentExtension = {
  validate: electroOpticalErrors,
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
  replaySeed: (base) => {
    const dispositions = base.electroOptical?.dispositions ?? {};
    return Object.keys(dispositions).length === 0 ? {} : { electroOptical: { coatings: {}, bondPaths: {}, dispositions } };
  },
};

export const electroOpticalPlugin: CadPlugin = {
  name: 'physics-electro-optical',
  toolset: 'analysis',
  commands: electroOpticalCommands,
  guards: [electroOpticalReferenceGuard],
  document: electroOpticalDocument,
};
