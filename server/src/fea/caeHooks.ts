/** The only server module that imports the pure @cae functions the FE transports call (deck writing, result parsing, summaries). */

import type {
  FeArtifactPort,
  FeConvergenceRow,
  FeMeshArtifact,
  FeResultsArtifact,
  MeshSummary,
  ResultsSummary,
} from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash, meshRequest, type MeshRequest } from '@cae/index';
import { writeBdf, type BdfResult } from '@cae/decks/bdfWriter';
import { writeInp } from '@cae/decks/inpWriter';
import { firstNonFinite, parseFrd } from '@cae/results/frdReader';
import { classifyNonlinearStop, parseSta, type NonlinearStopCode } from '@cae/nonlinear/solverLog';
import { parseDat } from '@cae/results/datReader';
import { readOp2, type Op2Result, type Op2Tables } from '@cae/results/op2Reader';
import { op2ToResults, type Op2Import } from '@cae/results/op2Results';
import { writeVtu, type VtuEncoding } from '@cae/results/vtuWriter';
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
  /** Nastran bulk data of a static / modal / buckling analysis (05 §5.6). */
  writeBdf(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact, artifacts: FeArtifactPort | null): BdfResult;
  /** VTK XML UnstructuredGrid of a mesh and optional results. */
  writeVtu(
    mesh: FeMeshArtifact,
    results: FeResultsArtifact | null,
    encoding: VtuEncoding,
  ): { readonly text: string; readonly cells: number; readonly dropped: number };
  readOp2(bytes: Uint8Array): Op2Result;
  op2ToResults(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact, meshHash: string, op2: Op2Tables): Op2Import;
  parseFrd(text: string): FeResultsArtifact['steps'];
  /** Where the first non-finite value of parsed result steps is, or null. */
  firstNonFinite(steps: FeResultsArtifact['steps']): string | null;
  parseDat(text: string): NonNullable<FeResultsArtifact['dat']>;
  /** CalculiX `.sta` increment table of a nonlinear solve (one row per increment). */
  parseSta(text: string): FeConvergenceRow[];
  /** Why a nonlinear run stopped (increment too small / INC reached / no convergence), null for any other failure. */
  classifyNonlinearStop(log: string): NonlinearStopCode | null;
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
  writeBdf,
  writeVtu,
  readOp2,
  op2ToResults,
  parseFrd,
  firstNonFinite,
  parseDat,
  parseSta,
  classifyNonlinearStop,
  parseFieldTable,
  meshSummary,
  resultsSummary,
};
