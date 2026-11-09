/** Standard-part fastener commands (08 MAT §4.2), toolset `fasteners`. */

import { commandCatalog } from '@core/commands/schema';
import { decodePartNumber, importFastenerCatalog, listFastenerFamilies } from './catalogCommands';
import { deleteFastenerStack, insertFastenerStack, selectFastener } from './insertCommands';
import { jointCapacity } from './jointCapacity';
import { checkFastenerLayout } from './layoutCommand';
import { insertFastenerRow } from './rowCommand';
import { listFastenerStacks } from './stackQuery';

export const fastenerCommands = commandCatalog(
  importFastenerCatalog,
  listFastenerFamilies,
  decodePartNumber,
  selectFastener,
  insertFastenerStack,
  insertFastenerRow,
  checkFastenerLayout,
  deleteFastenerStack,
  listFastenerStacks,
  jointCapacity,
);
