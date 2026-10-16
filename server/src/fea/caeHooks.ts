/** The only server module that imports the pure @cae functions the FE transports call (deck writing, result parsing, summaries). */

import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact, MeshSummary, ResultsSummary } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash, meshRequest, type MeshRequest } from '@cae/index';
import { writeInp } from '@cae/decks/inpWriter';
import { parseFrd } from '@cae/results/frdReader';
import { parseDat } from '@cae/results/datReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';

export interface CaeCode {
  readonly code: string;
  readonly message: string;
}

export interface CaeHooks {
  meshRequest(doc: CadDocument, analysisId: string): MeshRequest | CaeCode;
  analysisInputHash(doc: CadDocument, analysisId: string, scope: 'mesh' | 'full'): string;
  writeInp(
    doc: CadDocument,
    analysisId: string,
    mesh: FeMeshArtifact,
    artifacts: FeArtifactPort | null,
  ): { readonly text: string } | CaeCode;
  parseFrd(text: string): FeResultsArtifact['steps'];
  parseDat(text: string): NonNullable<FeResultsArtifact['dat']>;
  meshSummary(mesh: FeMeshArtifact, meshHash: string): MeshSummary;
  resultsSummary(
    doc: CadDocument,
    analysisId: string,
    mesh: FeMeshArtifact,
    results: FeResultsArtifact,
    resultsHash: string,
  ): ResultsSummary;
}

export const caeHooks: CaeHooks = { meshRequest, analysisInputHash, writeInp, parseFrd, parseDat, meshSummary, resultsSummary };
