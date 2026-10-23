/** Findings of `check_pipe_spec` (§5.6): one shape for every pass, with a stable key, ids, paths, values and the remediation of its code. */

import type { CheckStatus } from '@core/model/checkResult';
import { remediationFor } from '../../catalog/codes';
import type { NominalSize, PipingCatalog } from '../../catalog/types';
import type { PipeSpec } from '../types';

export const SPEC_RULES = [
  'coverage',
  'overlap',
  'references',
  'branch',
  'design',
  'dimStandard',
  'joints',
  'trust',
  'status',
  'document',
] as const;
export type SpecRule = (typeof SPEC_RULES)[number];

export interface SpecFinding {
  readonly code: string;
  readonly status: CheckStatus;
  readonly rule: SpecRule;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly findingKey: string;
  readonly values: Readonly<Record<string, number | string>>;
  readonly message: string;
  readonly remediation: string;
}

export function finding(
  specId: string,
  rule: SpecRule,
  code: string,
  status: CheckStatus,
  ids: readonly string[],
  paths: readonly string[],
  message: string,
  values: Record<string, number | string> = {},
): SpecFinding {
  return {
    code,
    status,
    rule,
    ids,
    paths,
    findingKey: `spec:${specId}:${code}:${rule}:${ids.join(',') || paths.join(',')}`,
    values,
    message,
    remediation: remediationFor(code),
  };
}

/** Everything a pass reads: the spec, the catalogues it searches (found / missing) and the standard sizes inside its range. */
export interface CheckContext {
  readonly spec: PipeSpec;
  readonly catalogs: readonly PipingCatalog[];
  readonly missingCatalogs: readonly string[];
  readonly sizes: readonly NominalSize[];
}

/** Short list of size keys with the count beyond `limit`. */
export function listSizes(sizes: readonly NominalSize[], limit = 12): string {
  const shown = sizes.slice(0, limit).map((entry) => entry.key);
  return `${sizes.length} size(s): ${shown.join(', ')}${sizes.length > limit ? ` … (+${sizes.length - limit})` : ''}`;
}

const RANK: Readonly<Record<CheckStatus, number>> = { fail: 0, not_run: 1, warn: 2, info: 3, pass: 4 };

/** Fails first, then not-run checks, warnings, info; stable inside a status. */
export const sortFindings = (findings: readonly SpecFinding[]): SpecFinding[] =>
  [...findings].sort((a, b) => RANK[a.status] - RANK[b.status]);
