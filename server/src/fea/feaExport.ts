/** fea_export: the CalculiX input deck of a meshed analysis (text + sha256); nothing is run or recorded. */

import { sha256Hex } from '@lib/sha256';
import type { FeaHost, FeaToolResult } from '@mcp/index';
import type { FeArtifactStore } from './artifactStore';
import type { CaeHooks } from './caeHooks';
import { currentMesh, feaFailure, isFailure } from './feaCommon';

export function runFeaExport(analysisId: string, host: FeaHost, deps: { store: FeArtifactStore; hooks: CaeHooks }): FeaToolResult {
  const doc = host.getDoc();
  const current = currentMesh('fea_export', doc, analysisId, deps.store, deps.hooks);
  if (isFailure(current)) return current;
  const deck = deps.hooks.writeInp(doc, analysisId, current.mesh, deps.store);
  if ('code' in deck) return feaFailure('fea_export', deck.code, deck.message, [analysisId]);
  const sha256 = sha256Hex(deck.text);
  return {
    summary: `fea_export: ${analysisId}.inp, ${deck.text.length} bytes, sha256 ${sha256.slice(0, 16)}… (data.text; llull --save <path> writes it).`,
    affected: [],
    isError: false,
    data: { format: 'inp', fileName: `${analysisId}.inp`, text: deck.text, sha256, bytes: deck.text.length, meshHash: current.meshHash },
  };
}
