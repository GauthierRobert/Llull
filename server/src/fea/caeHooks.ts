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
import type { GeometryKernel } from '@core/geometry/kernel';
import {
  partMidsurfaceGeometry,
  type MidsurfaceGeometry,
  mapShellResults,
  analysisInputHash,
  meshRequest,
  type MeshRequest,
  writeBdf,
  type BdfResult,
  writeInp,
  firstNonFinite,
  parseFrd,
  classifyNonlinearStop,
  parseSta,
  type NonlinearStopCode,
  parseDat,
  readOp2,
  type Op2Result,
  type Op2Tables,
  op2ToResults,
  type Op2Import,
  writeVtu,
  type VtuEncoding,
  meshSummary,
  resultsSummary,
  parseFieldTable,
  type TableImport,
} from '@cae/index';

export interface CaeCode {
  readonly code: string;
  readonly message: string;
}

export interface CaeHooks {
  meshRequest(doc: CadDocument, analysisId: string): MeshRequest | CaeCode;
  /** Midsurface / plane-stress geometry of a 2D part for the mesher, null for a solid part. */
  partMidsurface(
    doc: CadDocument,
    analysisId: string,
    entityId: string,
    kernel: GeometryKernel | null,
  ): MidsurfaceGeometry | CaeCode | null;
  /** Shell / plane-stress results read back from the CalculiX 3D expansion onto the mesh nodes, with top / bottom fibre stresses (05 OQ 7). */
  mapShellResults(
    doc: CadDocument,
    analysisId: string,
    mesh: FeMeshArtifact,
    steps: FeResultsArtifact['steps'],
    frdText: string,
  ): { readonly steps: FeResultsArtifact['steps'] } | CaeCode;
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
  partMidsurface: partMidsurfaceGeometry,
  mapShellResults,
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
