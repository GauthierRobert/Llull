/** Manufacturing features (07 FTR): holes, pockets, threads, recognition, machining checks and the hole table. */

import { commandCatalog } from '../schema';
import { addHole } from './addHole';
import { addPocket } from './addPocket';
import { setThread } from './setThread';
import { recognizeFeatures } from './recognizeFeatures';
import { checkMachining } from './checkMachining';
import { holeTable } from './holeTable';

export const featuresCommands = commandCatalog(addHole, addPocket, setThread, recognizeFeatures, checkMachining, holeTable);
