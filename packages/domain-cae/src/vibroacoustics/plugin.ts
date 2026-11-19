/** Vibro-acoustics plugin (PHY-20): acoustic spectra as document data and exact level / band conversions, under the `analysis` toolset. */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { vibroacousticsCommands } from './catalog';
import { vibroacousticsErrors } from './model';

/** Pure definition data: nothing is derived, nothing is restored; a replay keeps the signed reviewer dispositions (their steps carry no signature). */
const vibroacousticsDocument: DocumentExtension = {
  validate: vibroacousticsErrors,
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
  replaySeed: (base) => {
    const reviews = base.vibroacoustics?.reviews ?? {};
    return Object.keys(reviews).length === 0
      ? {}
      : { vibroacoustics: { spectra: {}, spectrumOrder: [], exposures: {}, exposureOrder: [], reviews } };
  },
};

export const vibroacousticsPlugin: CadPlugin = {
  name: 'physics-vibroacoustics',
  toolset: 'analysis',
  commands: vibroacousticsCommands,
  document: vibroacousticsDocument,
};
