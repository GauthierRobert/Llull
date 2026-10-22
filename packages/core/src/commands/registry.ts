/**
 * The registry: the composition point that fills the command table with every feature's catalog (`<feature>/catalog.ts`) and every
 * installed plugin's commands. UI menus, CLI tool schemas (`toToolSchemas`) and `execute` all read that table — register once, every
 * surface gains it. Surfaces import from this module so that importing the API also registers the core catalog.
 *
 * Adding a core command: define it in its feature folder, list it in that folder's catalog.
 */

import { registerCommands } from './commandTable';
import { onPluginInstalled } from '../plugins/host';
import { documentCommands } from './document/catalog';
import { solidsCommands } from './solids/catalog';
import { draw2dCommands } from './draw2d/catalog';
import { modify2dCommands } from './modify2d/catalog';
import { editCommands } from './edit/catalog';
import { brepCommands } from './brep/catalog';
import { featuresCommands } from './features/catalog';
import { inspectCommands } from './inspect/catalog';
import { renderCommands } from './render/catalog';
import { parametricCommands } from './parametric/catalog';
import { historyCommands } from './history/catalog';
import { projectCommands } from './project/catalog';
import { assemblyCommands } from './assembly/catalog';
import { motionCommands } from './motion/catalog';
import { exchangeCommands } from './exchange/catalog';
import { persistenceCommands } from './persistence/catalog';
import { drawingsCommands } from './drawings/catalog';
import { pmiCommands } from './pmi/catalog';
import { reviewCommands } from './review/catalog';
import { materialLabCommands } from './materiallab/catalog';
import { materialCommands } from './materials/catalog';
import { surfaceCommands } from './surface/catalog';
import { meshCommands } from './mesh/catalog';
import { deformCommands } from './deform/catalog';

registerCommands('core', [
  ...documentCommands,
  ...solidsCommands,
  ...draw2dCommands,
  ...modify2dCommands,
  ...editCommands,
  ...brepCommands,
  ...featuresCommands,
  ...inspectCommands,
  ...renderCommands,
  ...parametricCommands,
  ...historyCommands,
  ...projectCommands,
  ...assemblyCommands,
  ...motionCommands,
  ...exchangeCommands,
  ...persistenceCommands,
  ...drawingsCommands,
  ...pmiCommands,
  ...reviewCommands,
  ...materialLabCommands,
  ...materialCommands,
  ...surfaceCommands,
  ...meshCommands,
  ...deformCommands,
]);
onPluginInstalled((plugin) => registerCommands(`plugin '${plugin.name}'`, plugin.commands));

export { execute } from './execute';
export { getCommand, listCommands, toToolSchemas, type ToolSchema } from './commandTable';
