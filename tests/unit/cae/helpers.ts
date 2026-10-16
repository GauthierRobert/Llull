import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { AnalysisCase } from '@core/model/analysis';

export const caseIn = (doc: CadDocument, analysisId: string): AnalysisCase => {
  const found = doc.analysis?.cases[analysisId];
  if (found === undefined) throw new Error(`no analysis ${analysisId}`);
  return found;
};

export const run = (doc: CadDocument, name: string, params: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(doc, name, params);

/** Document with one box and (optionally) a part-bearing analysis of `analysisType`. */
export function modelWithAnalysis(
  analysisType = 'static',
  extra: Record<string, unknown> = {},
): { doc: CadDocument; boxId: string; analysisId: string } {
  const boxed = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
  const boxId = boxed.affected[0] ?? '';
  const created = execute(boxed.document, 'create_analysis', { name: 'A', analysisType, ...extra });
  const analysisId = created.affected[0] ?? '';
  const withPart = execute(created.document, 'set_part_idealization', { analysisId, entityId: boxId });
  return { doc: withPart.document, boxId, analysisId };
}
