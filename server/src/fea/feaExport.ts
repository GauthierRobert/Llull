/** fea_export: the CalculiX input deck, the Nastran BDF or a VTU of the mesh (+ current results) of a meshed analysis (text + sha256); nothing is run or recorded. */

import type { FeResultsArtifact } from '@core/model/analysis';
import { sha256Hex } from '@lib/sha256';
import type { FeaExportFormat, FeaHost, FeaToolResult } from '@protocol/index';
import type { FeArtifactStore } from './artifactStore';
import type { CaeHooks } from './caeHooks';
import { currentMesh, feaFailure, isFailure } from './feaCommon';

const EXTENSION: Readonly<Record<FeaExportFormat, string>> = { calculix_inp: 'inp', nastran_bdf: 'bdf', vtu: 'vtu' };

/** The recorded results of the case when they are verified, current for the set-up and computed on this mesh; null otherwise. */
function currentResults(
  analysisId: string,
  host: FeaHost,
  meshHash: string,
  store: FeArtifactStore,
  hooks: CaeHooks,
): FeResultsArtifact | null {
  const doc = host.getDoc();
  const recorded = doc.analysis?.cases[analysisId]?.results;
  if (recorded === undefined || recorded.verified === false || recorded.inputHash !== hooks.analysisInputHash(doc, analysisId, 'full'))
    return null;
  const artifact = store.get(recorded.resultsHash);
  return artifact !== null && artifact.kind === 'fe_results' && artifact.meshHash === meshHash ? artifact : null;
}

/**
 * @failure unknown analysis / missing or stale mesh -> the shared codes; a deck the writer refuses (materials, constraints, unsupported analysis type for
 *   the BDF, ids too large ...) -> its code; the document is never changed
 */
export function runFeaExport(
  analysisId: string,
  host: FeaHost,
  deps: { store: FeArtifactStore; hooks: CaeHooks },
  options: { readonly format?: FeaExportFormat; readonly encoding?: 'ascii' | 'base64' } = {},
): FeaToolResult {
  const format = options.format ?? 'calculix_inp';
  const doc = host.getDoc();
  const current = currentMesh('fea_export', doc, analysisId, deps.store, deps.hooks);
  if (isFailure(current)) return current;
  let text: string;
  let note = '';
  const extra: Record<string, unknown> = {};
  if (format === 'vtu') {
    const results = currentResults(analysisId, host, current.meshHash, deps.store, deps.hooks);
    const written = deps.hooks.writeVtu(current.mesh, results, options.encoding ?? 'ascii');
    text = written.text;
    note = results === null ? ' (mesh only: no current results recorded)' : ` (mesh + ${results.steps.length} result set(s))`;
    Object.assign(extra, {
      cells: written.cells,
      droppedElements: written.dropped,
      withResults: results !== null,
      encoding: options.encoding ?? 'ascii',
    });
  } else if (format === 'nastran_bdf') {
    const deck = deps.hooks.writeBdf(doc, analysisId, current.mesh, deps.store);
    if ('code' in deck) return feaFailure('fea_export', deck.code, deck.message, [analysisId]);
    text = deck.text;
    note = deck.warnings.length === 0 ? '' : ` WARNING: ${deck.warnings.join('; ')}`;
    Object.assign(extra, { warnings: deck.warnings });
  } else {
    const deck = deps.hooks.writeInp(doc, analysisId, current.mesh, deps.store);
    if ('code' in deck) return feaFailure('fea_export', deck.code, deck.message, [analysisId]);
    text = deck.text;
  }
  const sha256 = sha256Hex(text);
  const fileName = `${analysisId}.${EXTENSION[format]}`;
  return {
    summary: `fea_export: ${fileName}, ${text.length} bytes, sha256 ${sha256.slice(0, 16)}… (data.text; llull --save <path> writes it)${note}.`,
    affected: [],
    isError: false,
    data: { format: EXTENSION[format], fileName, text, sha256, bytes: text.length, meshHash: current.meshHash, ...extra },
  };
}
