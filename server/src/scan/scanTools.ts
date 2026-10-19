/**
 * The point-cloud host tools of the `llull` CLI (plant 10): `scan_import` (file -> content-addressed asset, never the document) and
 * `scan_list` (the assets of this machine's store). Run in-process for a local --doc and through `POST /exchange` for --app / --server.
 */

import type { ToolDefinition } from '@protocol/tools';
import type { CommandOutcome } from '@protocol/restProtocol';
import { isRecord } from '@lib/isRecord';
import { createComputeRunner } from '../native/computeJob';
import { AssetReader } from './assetReader';
import { DEFAULT_IMPORT_TIMEOUT_S, importOptionsOf, runScanImport, type ScanDeps } from './scanImport';
import { assetDir, listAssets, scanCacheDir } from './scanStore';

export function scanToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'scan_import',
      description:
        "Import a point-cloud file (E57, LAS, LAZ, or ASCII XYZ / PTS / CSV) into this machine's cloud store with the native llull-compute " +
        '(readers, octree, lossless integer coordinates). Prints the sourceSha256, the content-addressed assetKey and the manifest summary ' +
        '(points, scans, bounds, attributes, warnings). The document is NOT changed: attach the cloud with attach_point_cloud assetKey=<key>. ' +
        'Re-importing the same file with the same options is instant (cached). ReCap RCP / RCS, Faro FLS and other closed formats are refused ' +
        '(SCN_FORMAT_PROPRIETARY): export E57 from the vendor tool. Errors: SCN_E57_CHECKSUM, SCN_CLOUD_EMPTY, SCN_LAS_HEADER, SCN_ASCII_PARSE, ' +
        'NATIVE_TOOL_MISSING. CLI shorthand: llull scan import <file>.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the cloud file on this machine.' },
          format: { type: 'string', enum: ['xyz', 'pts', 'csv'], description: 'ASCII flavour when the extension does not say it.' },
          sourceUnit: { type: 'string', enum: ['m', 'mm', 'cm', 'ft', 'in'], description: 'Unit of ASCII coordinates (default m).' },
          columns: { type: 'string', description: 'ASCII column order with x y z i r g b, _ skips a column (default xyz).' },
          applyStationPoses: { type: 'boolean', description: 'E57: apply each scan pose (default true).' },
          checksum: { type: 'string', enum: ['all', 'sparse', 'none'], description: 'E57 page CRC check (default all).' },
          maxPointsPerNode: { type: 'number', description: 'Octree node capacity (default 20000).' },
          timeoutS: {
            type: 'number',
            minimum: 1,
            maximum: 86400,
            description: `Wall-clock limit in seconds (default ${DEFAULT_IMPORT_TIMEOUT_S}).`,
          },
        },
        required: ['path'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    {
      name: 'scan_list',
      description: "List the point-cloud assets in this machine's store (assetKey, source name, format, points). Read-only.",
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
  ];
}

const NAMES: ReadonlySet<string> = new Set(['scan_import', 'scan_list']);

export const isScanTool = (name: string): boolean => NAMES.has(name);

export function defaultScanDeps(env: NodeJS.ProcessEnv = process.env, onProgress?: (line: string) => void): ScanDeps {
  return { runner: createComputeRunner(env), store: scanCacheDir(env), env, ...(onProgress !== undefined ? { onProgress } : {}) };
}

const failure = (summary: string, code: string): CommandOutcome => ({
  summary,
  affected: [],
  isError: true,
  changed: false,
  data: { code },
});

/** Runs a scan tool; null for any other name. Never changes the document. */
export async function runScanTool(name: string, params: unknown, deps: ScanDeps): Promise<CommandOutcome | null> {
  if (!isScanTool(name)) return null;
  if (name === 'scan_list') {
    const assets = listAssets(deps.store).flatMap((key) => {
      const reader = AssetReader.open(assetDir(deps.store, key), key);
      return reader === null
        ? []
        : [
            {
              assetKey: key,
              sourceName: reader.manifest.sourceName,
              format: reader.manifest.format,
              pointCount: reader.manifest.pointCount,
            },
          ];
    });
    return {
      summary: `scan_list: ${assets.length} asset(s) in ${deps.store}.`,
      affected: [],
      isError: false,
      changed: false,
      data: { store: deps.store, assets },
    };
  }
  const args = isRecord(params) ? params : {};
  const file = args['path'];
  if (typeof file !== 'string' || file === '') return failure('scan_import: path is required.', 'SCN_PARAM_INVALID');
  const options = importOptionsOf(args);
  if (typeof options === 'string') return failure(`scan_import: ${options}.`, 'SCN_PARAM_INVALID');
  const timeoutS = typeof args['timeoutS'] === 'number' && Number.isFinite(args['timeoutS']) ? args['timeoutS'] : undefined;
  const result = await runScanImport({ path: file, options, ...(timeoutS !== undefined ? { timeoutS } : {}) }, deps);
  if (!result.ok) return failure(`scan_import: ${result.code} — ${result.message}`, result.code);
  const { manifest } = result;
  const warnings = result.warnings.map((w) => w.code);
  return {
    summary:
      `scan_import: ${manifest.sourceName} -> asset ${result.assetKey} (${manifest.pointCount} points, ${manifest.format}, ${manifest.scans.length} scan(s), ` +
      `${manifest.octree.nodeCount} octree nodes)${result.cached ? ' [cached]' : ''}${warnings.length > 0 ? ` warnings: ${warnings.join(', ')}` : ''}. ` +
      `Attach it: attach_point_cloud assetKey=${result.assetKey}`,
    affected: [],
    isError: false,
    changed: false,
    data: {
      sourceSha256: result.sourceSha256,
      assetKey: result.assetKey,
      cached: result.cached,
      elapsedMs: result.elapsedMs,
      manifest: {
        sourceName: manifest.sourceName,
        format: manifest.format,
        pointCount: manifest.pointCount,
        dropped: manifest.dropped,
        scans: manifest.scans.map((s) => ({ guid: s.guid, pointCount: s.pointCount, pose: s.pose, fields: s.fields })),
        bounds: manifest.bounds,
        centroid: manifest.centroid,
        quantum: manifest.quantum,
        attributes: manifest.attributes,
        ...(manifest.crs !== undefined ? { crs: manifest.crs } : {}),
        octree: manifest.octree,
        importerVersion: manifest.importerVersion,
        warnings: manifest.warnings,
      },
    },
  };
}
