/** Review-tab envelope shared by check_mechanism / check_motion_clearance / check_dynamics (same shape as check_assembly's CheckResult, other `check` names). */

import { type CheckStatus, type CheckThreshold, findingKey, worstStatus } from '../../model/checkResult';
import type { Vec3 } from '../../model/vectors';
import { hashText } from '../../lib/hash';
import { canonicalJson } from '../../lib/canonicalJson';
import { roundDeep } from '../../lib/significant';

export type ReviewCheckName = 'mechanism' | 'motion_clearance' | 'dynamics';

export interface ReviewItem {
  readonly code: string;
  readonly status: CheckStatus;
  readonly ids: readonly string[];
  readonly findingKey: string;
  readonly values: Readonly<Record<string, number>>;
  readonly threshold?: CheckThreshold;
  readonly witness?: { readonly pointsMm: readonly Vec3[]; readonly crankDeg?: number };
  readonly remediation: string;
  readonly unverified?: boolean;
  readonly note?: string;
}

export interface ReviewResult {
  readonly check: ReviewCheckName;
  readonly status: CheckStatus;
  readonly items: readonly ReviewItem[];
  readonly provenance: {
    readonly method: string;
    readonly engine?: string;
    readonly tolerances: Readonly<Record<string, number>>;
    readonly params: unknown;
  };
  readonly inputsHash: string;
  readonly unverified: boolean;
  readonly reviewRequired: true;
}

export const reviewItem = (
  check: ReviewCheckName,
  code: string,
  status: CheckStatus,
  ids: readonly string[],
  remediation: string,
  extra: Partial<ReviewItem> = {},
): ReviewItem => ({ code, status, ids: [...ids].sort(), findingKey: findingKey(check, code, ids), values: {}, remediation, ...extra });

export function reviewResult(
  check: ReviewCheckName,
  items: readonly ReviewItem[],
  provenance: ReviewResult['provenance'],
  hashedInputs: unknown,
): ReviewResult {
  const result: ReviewResult = {
    check,
    status: items.length === 0 ? 'pass' : worstStatus(items.map((entry) => entry.status)),
    items,
    provenance,
    inputsHash: hashText(canonicalJson({ check, inputs: hashedInputs, params: provenance.params })),
    unverified: items.some((entry) => entry.status === 'not_run'),
    reviewRequired: true,
  };
  return roundDeep(result);
}

export function reviewSummary(command: string, result: ReviewResult, next: string): string {
  const count = (status: CheckStatus): number => result.items.filter((entry) => entry.status === status).length;
  return (
    `${command}: ${result.status} — ${count('fail')} fail, ${count('warn')} warn, ${count('not_run')} not_run, ${count('pass')} pass ` +
    `(hash ${result.inputsHash}). ${next} Computed by llull, not approved — needs a qualified engineer.`
  );
}
