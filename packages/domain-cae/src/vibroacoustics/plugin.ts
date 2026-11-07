/** Vibro-acoustics plugin (PHY-20): acoustic spectra as document data and exact level / band conversions, under the `analysis` toolset. */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { vibroacousticsCommands } from './catalog';
import { vibroacousticsErrors } from './model';

/** Pure definition data: nothing is derived, nothing is restored. */
const vibroacousticsDocument: DocumentExtension = {
  validate: vibroacousticsErrors,
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
};

export const vibroacousticsPlugin: CadPlugin = {
  name: 'physics-vibroacoustics',
  toolset: 'analysis',
  commands: vibroacousticsCommands,
  document: vibroacousticsDocument,
};
