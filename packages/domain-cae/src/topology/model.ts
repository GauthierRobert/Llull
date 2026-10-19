/** Access to and validation of the topology studies stored on analysis cases (`AnalysisCase.topology`, plugin `topology`). */

import type { AnalysisCase } from '@core/model/analysis';
import type { TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { analysisOf, caseOf, withCase } from '../shared/access';

/** Studies of `analysisCase` in creation order. */
export function studiesOf(analysisCase: AnalysisCase): TopologyStudy[] {
  return (analysisCase.topologyOrder ?? []).flatMap((id) => {
    const study = analysisCase.topology !== undefined && Object.hasOwn(analysisCase.topology, id) ? analysisCase.topology[id] : undefined;
    return study === undefined ? [] : [study];
  });
}

/** The study `studyId` with the analysis case that holds it, or undefined (ids are unique across cases). */
export function findStudy(
  doc: CadDocument,
  studyId: string,
): { readonly study: TopologyStudy; readonly analysisCase: AnalysisCase } | undefined {
  for (const caseId of analysisOf(doc).caseOrder) {
    const analysisCase = caseOf(doc, caseId);
    const study =
      analysisCase?.topology !== undefined && Object.hasOwn(analysisCase.topology, studyId) ? analysisCase.topology[studyId] : undefined;
    if (analysisCase !== undefined && study !== undefined) return { study, analysisCase };
  }
  return undefined;
}

/** `doc` with `study` added (appended to the order) or replaced in place on its analysis case. */
export function withStudy(doc: CadDocument, study: TopologyStudy): CadDocument {
  const analysisCase = caseOf(doc, study.analysisId);
  if (analysisCase === undefined) return doc;
  const order = analysisCase.topologyOrder ?? [];
  return withCase(doc, {
    ...analysisCase,
    topology: { ...analysisCase.topology, [study.id]: study },
    topologyOrder: order.includes(study.id) ? order : [...order, study.id],
  });
}

/** `doc` without the study (its derived entity is NOT touched: see `delete_topology_study`). */
export function withoutStudy(doc: CadDocument, study: TopologyStudy): CadDocument {
  const analysisCase = caseOf(doc, study.analysisId);
  if (analysisCase === undefined || analysisCase.topology === undefined) return doc;
  const { [study.id]: removed, ...rest } = analysisCase.topology;
  void removed;
  return withCase(doc, {
    ...analysisCase,
    topology: rest,
    topologyOrder: (analysisCase.topologyOrder ?? []).filter((id) => id !== study.id),
  });
}

const isNamed = (value: unknown): boolean =>
  isRecord(value) && typeof value['value'] === 'number' && Number.isFinite(value['value']) && typeof value['source'] === 'string';

const SETTING_KEYS = ['penal', 'eminRatio', 'move', 'changeTol', 'maxIterations', 'threshold', 'greyLimit'];

function studyErrors(where: string, key: string, study: unknown): string[] {
  const bad = (why: string): string[] => [`${where}: ${why}`];
  if (!isRecord(study) || study['id'] !== key || typeof study['name'] !== 'string' || typeof study['analysisId'] !== 'string')
    return bad('malformed study');
  if (study['dimension'] !== 2 && study['dimension'] !== 3) return bad('dimension must be 2 or 3');
  const { designDomain, voxel, volumeFraction, settings } = study;
  if (!Array.isArray(designDomain) || !designDomain.every((id) => typeof id === 'string')) return bad('designDomain must be a list of ids');
  if (typeof voxel !== 'number' || !(voxel > 0) || !Number.isFinite(voxel)) return bad('voxel must be > 0');
  if (typeof volumeFraction !== 'number' || !(volumeFraction > 0 && volumeFraction < 1)) return bad('volumeFraction must be in (0, 1)');
  if (!Array.isArray(study['keepIn']) || !Array.isArray(study['keepOut'])) return bad('keepIn / keepOut must be lists');
  if (!isRecord(settings) || !SETTING_KEYS.every((name) => isNamed(settings[name]))) return bad('settings are malformed');
  const filter = settings['filter'];
  if (!isRecord(filter) || !isNamed(filter['radius']) || (filter['kind'] !== 'sensitivity' && filter['kind'] !== 'density'))
    return bad('settings.filter is malformed');
  return [];
}

/** Value errors of the raw `analysis` slice's topology studies (persistence rejects the file when non-empty). */
export function topologyErrors(raw: Record<string, unknown>): string[] {
  const analysis = raw['analysis'];
  if (!isRecord(analysis) || !isRecord(analysis['cases'])) return [];
  const errors: string[] = [];
  for (const [caseId, analysisCase] of Object.entries(analysis['cases'])) {
    if (!isRecord(analysisCase) || analysisCase['topology'] === undefined) continue;
    const studies = analysisCase['topology'];
    const order = analysisCase['topologyOrder'];
    if (!isRecord(studies) || !Array.isArray(order) || order.some((id) => typeof id !== 'string' || !Object.hasOwn(studies, id)))
      errors.push(`analysis.cases.${caseId}.topology / topologyOrder are malformed`);
    else for (const [id, study] of Object.entries(studies)) errors.push(...studyErrors(`topology study '${id}'`, id, study));
  }
  return errors;
}
