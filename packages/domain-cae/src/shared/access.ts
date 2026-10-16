/** Read/replace helpers for the document's analysis slice (pure; every write returns a new document). */

import type { AnalysisCase, AnalysisModel } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';

const EMPTY_ANALYSIS: AnalysisModel = { cases: {}, caseOrder: [] };

export const analysisOf = (doc: CadDocument): AnalysisModel => doc.analysis ?? EMPTY_ANALYSIS;

/** The case `analysisId`, or undefined (prototype keys such as "constructor" do not count). */
export function caseOf(doc: CadDocument, analysisId: string): AnalysisCase | undefined {
  const { cases } = analysisOf(doc);
  return Object.hasOwn(cases, analysisId) ? cases[analysisId] : undefined;
}

/** `doc` with `analysisCase` added (appended to `caseOrder`) or replaced in place. */
export function withCase(doc: CadDocument, analysisCase: AnalysisCase): CadDocument {
  const model = analysisOf(doc);
  const known = model.caseOrder.includes(analysisCase.id);
  return {
    ...doc,
    analysis: {
      ...model,
      cases: { ...model.cases, [analysisCase.id]: analysisCase },
      caseOrder: known ? model.caseOrder : [...model.caseOrder, analysisCase.id],
    },
  };
}

/** `doc` without the case `analysisId`. */
export function withoutCase(doc: CadDocument, analysisId: string): CadDocument {
  const model = analysisOf(doc);
  return {
    ...doc,
    analysis: {
      ...model,
      cases: Object.fromEntries(Object.entries(model.cases).filter(([id]) => id !== analysisId)),
      caseOrder: model.caseOrder.filter((id) => id !== analysisId),
    },
  };
}
