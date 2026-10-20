/** Import / export: mesh formats, DXF, code exchange, exact STEP / IGES exchange with validation properties. */

import { commandCatalog } from '../schema';
import { exportStl } from './exportStl';
import { exportObj } from './exportFormats';
import { exportGltf } from './exportGltf';
import { exportCode } from './exportCode';
import { applyCodeTrace } from './codeTrace';
import { importMesh } from './importMesh';
import { importDxf } from './importDxf';
import { importStepExact } from './importStepExact';
import { exportStepAp242 } from './exportStepAp242';
import { exportIges, importIges } from './igesExchange';
import { verifyExchangeFile } from './verifyExchangeFile';
import { geometricValidationProperties } from './gvp';

export const exchangeCommands = commandCatalog(
  exportStl,
  exportObj,
  exportGltf,
  exportCode,
  applyCodeTrace,
  importMesh,
  importDxf,
  importStepExact,
  exportStepAp242,
  exportIges,
  importIges,
  verifyExchangeFile,
  geometricValidationProperties,
);
