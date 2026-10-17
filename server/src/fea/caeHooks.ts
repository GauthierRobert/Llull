/** The only server module that imports the pure @cae functions the FE transports call (deck writing, result parsing, summaries). */

import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact, MeshSummary, ResultsSummary } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash, meshRequest, type MeshRequest } from '@cae/index';
import { writeInp } from '@cae/decks/inpWriter';
import { firstNonFinite, parseFrd } from '@cae/results/frdReader';
import { parseDat } from '@cae/results/datReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { parseFieldTable, type TableImport } from '@cae/thermomech/tableImport';

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
  /** Where the first non-finite value of parsed result steps is, or null. */
  firstNonFinite(steps: FeResultsArtifact['steps']): string | null;
  parseDat(text: string): NonNullable<FeResultsArtifact['dat']>;
  /** CSV `x,y,z,T` -> the `fe_table` artifact of a temperature field (PHY-04 TR-TMC-14). */
  parseFieldTable(csv: string, coordinatesUnit: string, temperatureUnit: string): TableImport;
  meshSummary(mesh: FeMeshArtifact, meshHash: string): MeshSummary;
  resultsSummary(
    doc: CadDocument,
    analysisId: string,
    mesh: FeMeshArtifact,
    results: FeResultsArtifact,
    resultsHash: string,
  ): ResultsSummary;
}

export const caeHooks: CaeHooks = {
  meshRequest,
  analysisInputHash,
  writeInp,
  parseFrd,
  firstNonFinite,
  parseDat,
  parseFieldTable,
  meshSummary,
  resultsSummary,
};
