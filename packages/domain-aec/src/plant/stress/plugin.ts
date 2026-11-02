/**
 * Pipe stress plugin (plant 07 PST): code rules as data and the closed-form quick checks (M1), the stress model, load cases, restraints, analysis,
 * code check, record and human approval (M3, `doc.plant.stress`), toolset `pipestress`.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { pipeStressCommands } from './catalog';
import { pipeStressDocument } from './model/document';

export const pipeStressPlugin: CadPlugin = {
  name: 'pipeStress',
  toolset: 'pipestress',
  commands: pipeStressCommands,
  document: pipeStressDocument,
};
