/** Import / export: mesh formats, DXF, code exchange. */

import { commandCatalog } from '../schema';
import { exportStl } from './exportStl';
import { exportObj } from './exportFormats';
import { export3mf } from './export3mf';
import { exportUrdf } from './exportUrdf';
import { meshToSolid } from './meshToSolid';
import { exportGltf } from './exportGltf';
import { exportCode } from './exportCode';
import { applyCodeTrace } from './codeTrace';
import { importMesh } from './importMesh';
import { importDxf } from './importDxf';
import { importStepExact } from './importStepExact';
import { exportBcf } from './bcf/exportBcf';
import { exportIges } from './exportIges';

export const exchangeCommands = commandCatalog(
  exportStl,
  exportObj,
  exportGltf,
  export3mf,
  exportUrdf,
  meshToSolid,
  exportCode,
  applyCodeTrace,
  importMesh,
  importDxf,
  importStepExact,
  exportBcf,
  exportIges,
);
