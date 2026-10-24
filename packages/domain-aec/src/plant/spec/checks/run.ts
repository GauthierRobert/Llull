/**
 * `check_pipe_spec` runner (TR-PSC-10, TR-PSC-11): runs the passes of §5.6 in order over one spec revision and sorts the findings (fails first).
 * @invariant pure; unverified inputs always produce PSC_DATA_UNVERIFIED (warn, not suppressible)
 */

import type { CheckStatus } from '@core/model/checkResult';
import { worstStatus } from '@core/model/checkResult';
import type { CadDocument } from '@core/model/types';
import { sizesInRange } from '../size';
import { specCatalogs } from '../store';
import type { PipeSpec } from '../types';
import { branchFindings, coverageFindings, overlapFindings, referenceFindings, statusFindings, trustFindings } from './structure';
import { dimStandardFindings, jointFindings } from './compat';
import { designFindings, type DesignConditions } from './design';
import { sortFindings, type CheckContext, type SpecFinding } from './finding';
import { componentRows } from './rows';

export interface SpecCheck {
  readonly findings: readonly SpecFinding[];
  readonly status: CheckStatus;
  readonly design?: Readonly<Record<string, unknown>>;
  readonly sizes: number;
}

/** Findings of the spec passes (plus the design pass when `design` is given). */
export function checkSpec(doc: CadDocument, spec: PipeSpec, design: DesignConditions | undefined): SpecCheck {
  const { catalogs, missing } = specCatalogs(doc, spec);
  const context: CheckContext = { spec, catalogs, missingCatalogs: missing, sizes: sizesInRange(spec.sizeRange.from, spec.sizeRange.to) };
  const rows = componentRows(context);
  const designOutcome = design === undefined ? undefined : designFindings(context, design);
  const findings = sortFindings([
    ...coverageFindings(context),
    ...overlapFindings(context),
    ...referenceFindings(context, rows),
    ...branchFindings(context),
    ...(designOutcome?.findings ?? []),
    ...dimStandardFindings(context, rows),
    ...jointFindings(context),
    ...trustFindings(context, rows),
    ...statusFindings(context),
  ]);
  return {
    findings,
    status: worstStatus(findings.map((entry) => entry.status)),
    ...(designOutcome === undefined ? {} : { design: designOutcome.data }),
    sizes: context.sizes.length,
  };
}
