/** Manufacturing features (07 FTR): holes, pockets, threads, recognition, machining checks and the hole table. */

import { commandCatalog } from '../schema';
import { addHole } from './addHole';
import { addTappedHole } from './addTappedHole';
import { addExternalThread } from './addExternalThread';
import { addPocket } from './addPocket';
import { addRib } from './addRib';
import { setThread } from './setThread';
import { recognizeFeatures } from './recognizeFeatures';
import { checkMachining } from './checkMachining';
import { holeTable } from './holeTable';
import { holesFromRecognition } from './holesFromRecognition';

export const featuresCommands = commandCatalog(
  addHole,
  addTappedHole,
  addExternalThread,
  addPocket,
  addRib,
  setThread,
  recognizeFeatures,
  checkMachining,
  holeTable,
  holesFromRecognition,
);
