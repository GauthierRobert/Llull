// check_prototype result fixtures (TECHNICAL_SPEC §3.4) for the Review tab until the command exists.

import type { CheckItem, CheckResult, PrototypeReview } from '@ui/panels/review/reviewTypes';

export const hardOverlap: CheckItem = {
  code: 'FPR_PAIR_HARD',
  status: 'fail',
  ids: ['piston', 'head'],
  findingKey: 'assembly:FPR_PAIR_HARD:head,piston',
  values: { overlapVolumeMm3: 12.5 },
  remediation: 'Move or resize one part, or declare the overlap with allow_interference and a reason.',
};

export const thinWall: CheckItem = {
  code: 'FPR_WALL_THIN',
  status: 'warn',
  ids: ['crankcase'],
  findingKey: 'assembly:FPR_WALL_THIN:crankcase',
  values: { thicknessMm: 0.6 },
  threshold: { value: 0.794, unit: 'mm', source: 'cnc_metal, Xometry', grade: 'B', defaulted: false },
  remediation: 'Thicken the wall.',
};

const referenceMismatch: CheckItem = {
  code: 'FPR_REFERENCE_MISMATCH',
  status: 'warn',
  ids: ['crank'],
  findingKey: 'dynamics:FPR_REFERENCE_MISMATCH:crank',
  values: { brakeTorqueNm: 71.2 },
  accuracy: {
    brakeTorqueNm: {
      band: { rel: 0.05 },
      basis: 'rotax_912uls_full_throttle (datasheet, grade B)',
      origin: 'predicted',
      validationLevel: 2,
      comparison: { referenceId: 'rotax_912uls_full_throttle', s: 71.2, d: 80, e: -8.8, uVal: 4 },
      warnings: ['rigid bodies: no torsional resonance'],
    },
  },
  remediation: 'Review the model input with the largest band.',
  unverified: true,
};

function envelope(check: CheckResult['check'], status: CheckResult['status'], items: readonly CheckItem[]): CheckResult {
  return {
    check,
    status,
    items,
    provenance: { method: `${check} method v1`, kernel: 'manifold 3.0', tolerances: { touchMm: 0.001 }, params: { clearanceMm: 0.5 } },
    inputsHash: `hash-${check}`,
    unverified: false,
    reviewRequired: true,
  };
}

export const reviewFixture: PrototypeReview = {
  verdict: 'fail',
  ownerSummary: '1 fail, 2 warnings: the piston overlaps the head.',
  checks: [
    envelope('assembly', 'fail', [hardOverlap, thinWall]),
    envelope('mechanism', 'pass', []),
    envelope('motion_clearance', 'not_run', []),
    envelope('dynamics', 'warn', [referenceMismatch]),
  ],
};

export function withAccepted(item: CheckItem): CheckItem {
  return { ...item, disposition: { status: 'accepted', comment: 'press fit by design', by: 'human', stale: false } };
}

export function reviewWith(items: { assembly: readonly CheckItem[] }): PrototypeReview {
  return { ...reviewFixture, checks: reviewFixture.checks.map((c) => (c.check === 'assembly' ? { ...c, items: items.assembly } : c)) };
}
