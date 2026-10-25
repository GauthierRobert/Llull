/** Implicit plugin (05 IMP): field modelling and lattices; derived bodies are read-only mesh solids re-derived on load. */

import type { CadPlugin } from '@core/plugins/plugin';
import { beamLatticeOf } from './beamLattice';
import { implicitCommands } from './catalog';
import { implicitDocument, implicitGuard } from './document';
import { levelSetOf } from './levelSet';
import { bodyOf } from './model';

export const implicitPlugin: CadPlugin = {
  name: 'implicit',
  toolset: 'implicit',
  commands: implicitCommands,
  guards: [implicitGuard],
  document: implicitDocument,
  beamLattice: beamLatticeOf,
  levelSet: levelSetOf,
  stepSkip: (doc, entityId) =>
    bodyOf(doc, entityId) === undefined
      ? null
      : 'IMP_STEP_NOT_EXACT: an implicit body is a mesh without an exact B-rep; export_stl or export_3mf (mesh to B-rep is 07 MSH)',
};
