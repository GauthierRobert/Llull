/** Scene objects (RV1 RV-M2): lights and cameras. */

import { commandCatalog } from '../schema';
import { addLight } from './addLight';
import { addCamera } from './addCamera';
import { editLight } from './editLight';
import { editCamera } from './editCamera';

export const sceneCommands = commandCatalog(addLight, addCamera, editLight, editCamera);
