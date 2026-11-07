/** Derived state of a recorded convergence study: staleness, report, review reasons. Nothing here is stored in the document (L8). */

import type { AnalysisCase, MeshControls } from '@core/model/analysis';
import type { ConvergenceStudy } from '@core/model/convergenceStudy';
import type { CadDocument } from '@core/model/types';
import type { ConvergenceSample } from '@lib/convergence';
import { elasticConstants, isElasticRefusal, propertyTemperatureK } from '../decks/elastic';
import { analysisInputHash } from '../hash/inputHash';
import { withCase } from '../shared/access';
import { analyseSamples, type AnalysisOutcome } from './convergenceAnalysis';

export type CaseStudy = ConvergenceStudy<MeshControls>;

/** Studies of a case in recording order. */
export const studiesOf = (analysisCase: AnalysisCase): CaseStudy[] =>
  (analysisCase.studyOrder ?? []).flatMap((id) => {
    const study = analysisCase.studies !== undefined && Object.hasOwn(analysisCase.studies, id) ? analysisCase.studies[id] : undefined;
    return study === undefined ? [] : [study];
  });

/** `doc` with `study` added (appended to the order) or replaced in place. */
export function withStudy(doc: CadDocument, analysisCase: AnalysisCase, study: CaseStudy): CadDocument {
  const order = analysisCase.studyOrder ?? [];
  return withCase(doc, {
    ...analysisCase,
    studies: { ...analysisCase.studies, [study.id]: study },
    studyOrder: order.includes(study.id) ? order : [...order, study.id],
  });
}

/** `doc` without the study `studyId` (the maps are dropped when it was the last one). */
export function withoutStudy(doc: CadDocument, analysisCase: AnalysisCase, studyId: string): CadDocument {
  const { studies, studyOrder, ...rest } = analysisCase;
  const left = Object.entries(studies ?? {}).filter(([id]) => id !== studyId);
  return withCase(
    doc,
    left.length === 0
      ? rest
      : { ...rest, studies: Object.fromEntries(left), studyOrder: (studyOrder ?? []).filter((id) => id !== studyId) },
  );
}

/** The case as it was when level `controls` were meshed: the hash of this equals the level's recorded input hash while nothing else changed. */
export const levelDocument = (doc: CadDocument, analysisCase: AnalysisCase, controls: MeshControls): CadDocument =>
  withCase(doc, { ...analysisCase, mesh: controls });

/**
 * Why `study` no longer matches the analysis: levels whose input hash (05 TR-FEA-06, with the level's own mesh controls) is not the current
 * one (geometry, material, loads, supports, probes changed) and a change of the element family, order or bonding the levels were meshed with.
 * @invariant pure, from hashes only (no artifact is read); empty = current
 */
export function staleReasons(doc: CadDocument, analysisCase: AnalysisCase, study: CaseStudy): string[] {
  const reasons: string[] = [];
  const stale = study.levels.filter(
    (level) => analysisInputHash(levelDocument(doc, analysisCase, level.controls), analysisCase.id, 'full') !== level.inputHash,
  );
  if (stale.length > 0)
    reasons.push(`level ${stale.map((level) => level.index).join(', ')}: the analysis inputs differ from the ones it was run with`);
  const finest = study.levels[0]?.controls;
  const now = analysisCase.mesh;
  if (finest !== undefined && (finest.order !== now.order || finest.elementFamily !== now.elementFamily || finest.bonding !== now.bonding))
    reasons.push(
      `the case now meshes with ${now.elementFamily} order ${now.order}${now.bonding === undefined ? '' : ` ${now.bonding}`}, the study with ${finest.elementFamily} order ${finest.order}${finest.bonding === undefined ? '' : ` ${finest.bonding}`}`,
    );
  return reasons;
}

const samplesOf = (study: CaseStudy): ConvergenceSample[] => study.levels.map((level) => ({ h: level.h, value: level.value }));

/**
 * The GCI analysis of a study's levels (finest first).
 * @invariant Fs and the formal order are the study's NAMED values (source and `defaulted` kept)
 */
export function analyseStudy(study: CaseStudy, gciTarget?: number): AnalysisOutcome {
  const outcome = analyseSamples(samplesOf(study), {
    ...(study.safetyFactor.defaulted ? {} : { safetyFactor: study.safetyFactor.value }),
    ...(study.formalOrder !== undefined ? { formalOrder: study.formalOrder.value } : {}),
    ...(gciTarget !== undefined ? { gciTarget } : {}),
  });
  if (!outcome.ok) return outcome;
  return { ok: true, analysis: { ...outcome.analysis, ...(study.formalOrder !== undefined ? { formalOrder: study.formalOrder } : {}) } };
}

/** Reasons the materials of the analysed parts are unverified (05 FEA_MATERIAL_UNVERIFIED); heat analyses read no elastic constants. */
export function unverifiedReasons(doc: CadDocument, analysisCase: AnalysisCase): string[] {
  if (analysisCase.type === 'heat_steady' || analysisCase.type === 'heat_transient') return [];
  const reasons: string[] = [];
  for (const entityId of Object.keys(analysisCase.parts)) {
    const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
    const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
    if (materialId === undefined || material === undefined) continue;
    const elastic = elasticConstants(material, materialId, propertyTemperatureK(analysisCase));
    if (
      !isElasticRefusal(elastic) &&
      elastic.unverifiedReasons.length > 0 &&
      !reasons.some((reason) => reason.startsWith(`${materialId}:`))
    )
      reasons.push(`${materialId}: ${elastic.unverifiedReasons.join('; ')}`);
  }
  return reasons;
}

/** Whether the quantity can feed a margin of safety (compute_margins reads stresses): such a study needs a human review (AF-33). */
export function feedsMargin(analysisCase: AnalysisCase, study: CaseStudy): boolean {
  const { quantity } = study;
  if (quantity.kind === 'field_max') return quantity.field === 'von_mises';
  if (quantity.kind !== 'probe') return false;
  const probe = Object.hasOwn(analysisCase.probes, quantity.probeId) ? analysisCase.probes[quantity.probeId] : undefined;
  return probe !== undefined && (probe.quantity === 'von_mises' || probe.quantity.startsWith('s_'));
}
