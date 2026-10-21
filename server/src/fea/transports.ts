/** The `FeaToolsPort` of the server and CLI: Gmsh through llull-mesh (else the Python bridge), CalculiX through a tracked child, artifacts in the store. */

import type { FeaToolsPort } from '@protocol/index';
import { getGeometryKernel } from '@core/geometry/kernel';
import { positiveInteger } from '../env';
import { callBridge, pythonExchangeConfigFromEnv } from '../pythonExchange';
import { defaultFeArtifactStore } from './artifactStore';
import { caeHooks } from './caeHooks';
import { createCcxRunner } from './ccxProcess';
import { runFeaExport } from './feaExport';
import { runFeaImportField } from './feaImportField';
import { runFeaImportResults } from './feaImportResults';
import { runFeaMesh, type MeshBridgeResponse } from './feaMesh';
import { runFeaSolve } from './feaSolve';
import { callNativeMesher, chooseMesher } from './nativeMesher';
import { createComputeRunner } from '../native/computeJob';
import { nativeMappingStep } from '../native/mapField';
import { randomPostStep } from '../native/randomField';

const DEFAULT_MESH_TIMEOUT_MS = 600_000;

/** Without llull-mesh and with `LLULL_PYTHON=off` meshing answers FEA_TOOL_MISSING; solving and exporting an existing mesh still work. */
export function createFeaToolsPort(env: NodeJS.ProcessEnv = process.env): FeaToolsPort {
  const config = pythonExchangeConfigFromEnv(env);
  const python = env['LLULL_GMSH_PYTHON'] ?? config?.python ?? 'python3';
  const bridgeScript = config?.bridgeScript;
  const timeoutMs = positiveInteger(env['LLULL_FEA_MESH_TIMEOUT_MS'], DEFAULT_MESH_TIMEOUT_MS);
  const store = defaultFeArtifactStore();
  const ccx = createCcxRunner(env);
  const keepJobs = env['LLULL_FEA_KEEP'] === '1';
  const runner = createComputeRunner(env);
  const beforeDeck = nativeMappingStep({ store, runner, env }, env);
  const randomPost = randomPostStep(runner, env);
  const mesher = chooseMesher(env);
  const bridge = async (request: Record<string, unknown>): Promise<MeshBridgeResponse> => {
    if (mesher.kind === 'native') return callNativeMesher(mesher.binary, request, timeoutMs, env);
    if (bridgeScript === undefined) throw new Error('cannot start Python: the bridge is disabled (LLULL_PYTHON=off); FEA_TOOL_MISSING');
    return callBridge(python, bridgeScript, request, timeoutMs);
  };
  return {
    mesh: (analysisId, host) => runFeaMesh(analysisId, host, { bridge, store, hooks: caeHooks, kernel: getGeometryKernel }),
    solve: (analysisId, options, host) =>
      runFeaSolve(analysisId, options.timeoutS, host, { store, hooks: caeHooks, ccx, keepJobs, beforeDeck, randomPost }),
    exportDeck: (analysisId, host, options) => Promise.resolve(runFeaExport(analysisId, host, { store, hooks: caeHooks }, options)),
    importResults: (analysisId, file, host) => Promise.resolve(runFeaImportResults(analysisId, file, host, { store, hooks: caeHooks })),
    importField: (analysisId, table, host) => Promise.resolve(runFeaImportField(analysisId, table, host, { store, hooks: caeHooks })),
  };
}
