/** Import / export: mesh formats, DXF, code exchange. */

import { commandCatalog } from '../schema';
import { exportStl } from './exportStl';
import { exportObj, exportGltf } from './exportFormats';
import { exportCode } from './exportCode';
import { applyCodeTrace } from './codeTrace';
import { importMesh } from './importMesh';
import { importDxf } from './importDxf';

export const exchangeCommands = commandCatalog(
  exportStl,
  exportObj,
  exportGltf,
  exportCode,
  applyCodeTrace,
  importMesh,
  importDxf,
);
