/** Feature-history meta-commands (edit the recipe, regenerate). */

import { commandCatalog } from '../schema';
import { replayHistoryCommand, setStepSuppressed, editStepParams, reorderStep, deleteStep, insertStep } from './history';

export const historyCommands = commandCatalog(replayHistoryCommand, setStepSuppressed, editStepParams, reorderStep, deleteStep, insertStep);
