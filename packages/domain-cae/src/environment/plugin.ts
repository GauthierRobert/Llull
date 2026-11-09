/** Space-environment plugin (PHY-14): moisture, outgassing and atomic-oxygen commands under the `environment` toolset. The slice is pure definition data. */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { environmentCommands } from './catalog';
import { spaceEnvironmentErrors } from './model';

const environmentDocument: DocumentExtension = {
  validate: spaceEnvironmentErrors,
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
  // A replay regenerates the environment from its steps and keeps the human deviations (their steps carry no signature).
  replaySeed: (base) => {
    const deviations = base.spaceEnvironment?.deviations ?? {};
    return Object.keys(deviations).length === 0 ? {} : { spaceEnvironment: { deviations } };
  },
};

export const environmentPlugin: CadPlugin = {
  name: 'physics-environment',
  toolset: 'environment',
  commands: environmentCommands,
  document: environmentDocument,
};
