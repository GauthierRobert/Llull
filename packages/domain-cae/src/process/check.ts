/** Set-up items of an `am_build_distortion` case (PHY-16 §7.1): appended to `check_analysis`. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { prcRemediation } from './codes';
import { amMeshFindings, amResultFindings } from './diagnostics';

export interface AmItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const item = (code: string, severity: AmItem['severity'], message: string, ids: readonly string[]): AmItem => ({
  code,
  severity,
  ids,
  message,
  remediation: prcRemediation(code),
});

/**
 * With a mesh: the empty-layer and probe-on-built-node findings; with results also the large-deflection one.
 * Items that stop the deck (no build set-up, no inherent strain, loads present) and the warning of an uncalibrated strain.
 * @invariant called for am_build_distortion cases only; a case without a release step reports none (the build state alone is still solved)
 */
export function checkAmItems(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact | null,
  results: FeResultsArtifact | null,
  lengthToAnalysis: number,
): AmItem[] {
  const id = analysis.id;
  const { am } = analysis;
  const items: AmItem[] = [];
  if (am === undefined) items.push(item('PRC_BUILD_SETUP_MISSING', 'error', 'no build set-up yet: call am_build_setup', [id]));
  else if (am.inherentStrain === undefined)
    items.push(item('PRC_INHERENT_STRAIN_MISSING', 'error', 'no inherent strain yet: call set_inherent_strain', [id]));
  else if (!am.inherentStrain.calibrated)
    items.push(
      item(
        'PRC_INHERENT_STRAIN_UNCALIBRATED',
        'warning',
        `the inherent strain is not calibrated (source: ${am.inherentStrain.source}): the predicted distortion is only as good as this estimate`,
        [id],
      ),
    );
  if (analysis.loadOrder.length > 0)
    items.push(item('PRC_LOADS_UNSUPPORTED', 'error', `${analysis.loadOrder.length} load(s) on the case: the build applies none`, [id]));
  if (mesh !== null) {
    const found = [
      ...amMeshFindings(analysis, mesh, lengthToAnalysis),
      ...(results === null ? [] : amResultFindings(analysis, mesh, results, lengthToAnalysis)),
    ];
    for (const finding of found) items.push(item(finding.code, finding.severity, finding.message, finding.ids));
  }
  return items;
}
