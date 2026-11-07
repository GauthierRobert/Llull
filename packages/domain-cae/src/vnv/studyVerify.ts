/** Trust model of a study (TR-VNV-09): every level is re-derived from its artifacts in the store; a recorded number is a claim until it matches. */

import type { AnalysisCase, FeArtifactPort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { representativeSpacing } from '@lib/convergence';
import { analysisInputHash } from '../hash/inputHash';
import { resultsSummary } from '../results/summary';
import { fetchArtifact } from '../shared/trust';
import { isQuantityProblem, meshMeasure, quantityValue } from './studyQuantity';
import { levelDocument, type CaseStudy } from './studyState';

export interface StudyProblem {
  readonly code: 'VNV_ARTIFACT_NOT_FOUND' | 'VNV_SUMMARY_MISMATCH' | 'VNV_QUANTITY_UNAVAILABLE' | 'VNV_CASE_UNSUPPORTED';
  readonly message: string;
  readonly ids: readonly string[];
}

/** Why the level's `h` is not what its refinement kind derives (null = it is): the mesh spacing, the order, or (dt) nothing here: the time step is bound by the input hash. */
function sizeMismatch(study: CaseStudy, level: CaseStudy['levels'][number], volume: number, where: string): string | null {
  if (study.refinement === 'p') return level.h === 1 / level.controls.order ? null : `${where}: h is not 1 / order`;
  if (study.refinement === 'dt') return null;
  const { measure } = study;
  if (measure === undefined) return 'an h study needs its measure';
  if (level.index === 0 && volume !== measure.value) return `the finest mesh has volume ${volume}, not ${measure.value}`;
  return representativeSpacing(measure.value, level.elements, measure.dimension) === level.h
    ? null
    : `${where}: h is not (measure / elements)^(1/${measure.dimension})`;
}

const mismatch = (message: string, ids: readonly string[]): StudyProblem => ({ code: 'VNV_SUMMARY_MISMATCH', message, ids });

/**
 * `study` checked against the artifacts in `port`: hashes bind mesh to results and to the level inputs; with `current` (the study is not stale) the
 * element count, spacing, measure, unit and value of every level are re-derived and must equal the recorded ones exactly.
 * @invariant pure; a stale study is verified for existence and binding only (its numbers belong to an older set-up and are withheld by readers)
 * @failure artifact absent -> VNV_ARTIFACT_NOT_FOUND; any difference -> VNV_SUMMARY_MISMATCH; a quantity the results cannot give -> VNV_QUANTITY_UNAVAILABLE
 */
export function verifyStudy(
  doc: CadDocument,
  analysisCase: AnalysisCase,
  study: CaseStudy,
  port: FeArtifactPort,
  current: boolean,
): StudyProblem | null {
  for (const level of study.levels) {
    const where = `level ${level.index}`;
    const mesh = fetchArtifact(port, level.meshHash, 'fe_mesh');
    if ('code' in mesh)
      return {
        code: mesh.code === 'FEA_ARTIFACT_NOT_FOUND' ? 'VNV_ARTIFACT_NOT_FOUND' : 'VNV_SUMMARY_MISMATCH',
        message: `${where}: ${mesh.message}`,
        ids: [analysisCase.id, level.meshHash],
      };
    const results = fetchArtifact(port, level.resultsHash, 'fe_results');
    if ('code' in results)
      return {
        code: results.code === 'FEA_ARTIFACT_NOT_FOUND' ? 'VNV_ARTIFACT_NOT_FOUND' : 'VNV_SUMMARY_MISMATCH',
        message: `${where}: ${results.message}`,
        ids: [analysisCase.id, level.resultsHash],
      };
    const { artifact: meshArtifact } = mesh;
    const { artifact: resultsArtifact } = results;
    const ids = [analysisCase.id, level.resultsHash];
    if (resultsArtifact.meshHash !== level.meshHash)
      return mismatch(`${where}: the results were computed on mesh ${resultsArtifact.meshHash}, not ${level.meshHash}`, ids);
    if (resultsArtifact.inputHash !== level.inputHash)
      return mismatch(`${where}: the results artifact has input hash ${resultsArtifact.inputHash}, not ${level.inputHash}`, ids);
    if (
      resultsArtifact.solver !== level.solver ||
      resultsArtifact.solverVersion !== level.solverVersion ||
      meshArtifact.mesher !== level.mesher ||
      meshArtifact.mesherVersion !== level.mesherVersion
    )
      return mismatch(`${where}: solver / mesher names differ from the artifacts`, ids);
    if (!current) continue;
    const levelDoc = levelDocument(doc, analysisCase, study.refinement, level);
    if (meshArtifact.inputHash !== analysisInputHash(levelDoc, analysisCase.id, 'mesh'))
      return mismatch(`${where}: the mesh artifact was built for other inputs than the level controls`, [analysisCase.id, level.meshHash]);
    const measure = meshMeasure(meshArtifact);
    if (isQuantityProblem(measure))
      return {
        code: measure.code === 'VNV_PARAM_INVALID' ? 'VNV_CASE_UNSUPPORTED' : measure.code,
        message: `${where}: ${measure.message}`,
        ids,
      };
    if (measure.elements !== level.elements)
      return mismatch(`${where}: the mesh has ${measure.elements} tetrahedra, not ${level.elements}`, ids);
    const sizeProblem = sizeMismatch(study, level, measure.value, where);
    if (sizeProblem !== null) return mismatch(sizeProblem, ids);
    const summary = resultsSummary(levelDoc, analysisCase.id, meshArtifact, resultsArtifact, level.resultsHash);
    const reading = quantityValue(
      levelDoc,
      levelDoc.analysis?.cases[analysisCase.id] ?? analysisCase,
      meshArtifact,
      resultsArtifact,
      summary,
      study.quantity,
    );
    if (isQuantityProblem(reading))
      return {
        code: reading.code === 'VNV_PARAM_INVALID' ? 'VNV_QUANTITY_UNAVAILABLE' : reading.code,
        message: `${where}: ${reading.message}`,
        ids,
      };
    if (reading.unit !== study.unit) return mismatch(`${where}: the quantity is in ${reading.unit}, not ${study.unit}`, ids);
    if (reading.value !== level.value)
      return mismatch(`${where}: the value re-extracted from the results is ${reading.value}, not ${level.value}`, ids);
  }
  return null;
}
