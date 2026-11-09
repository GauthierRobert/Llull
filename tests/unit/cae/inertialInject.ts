/** Adds an `inertial` load to a case by hand (add_fea_load does not take the kind): for consumers of the load-kind union that must not mishandle it. */
import type { FeaLoad } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';

export function withInertialLoad(doc: CadDocument, analysisId: string, load: Partial<FeaLoad> = {}): CadDocument {
  const analysis = doc.analysis?.cases[analysisId];
  if (analysis === undefined) throw new Error(`no analysis ${analysisId}`);
  const inertial: FeaLoad = {
    id: 'fl-inertial',
    name: 'inertial',
    loadCase: 'LC1',
    category: 'limit',
    kind: 'inertial',
    vector: [0, -9810, 0],
    ...load,
  };
  return {
    ...doc,
    analysis: {
      ...doc.analysis,
      caseOrder: doc.analysis?.caseOrder ?? [],
      cases: {
        ...doc.analysis?.cases,
        [analysisId]: {
          ...analysis,
          loads: { ...analysis.loads, [inertial.id]: inertial },
          loadOrder: [...analysis.loadOrder, inertial.id],
        },
      },
    },
  };
}
