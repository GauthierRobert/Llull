// The reviewer dispositions of the document joined onto a stored check_prototype result (pure presentation): a disposition edit shows at
// once without re-running the checks (which can take minutes). Stale = made on another inputsHash, or its finding is no longer reported.

import type { Disposition } from '@core/model/prototype';
import type { CheckItem, PrototypeReview } from './reviewTypes';

function joined(item: CheckItem, inputsHash: string, dispositions: Readonly<Record<string, Disposition>>): CheckItem {
  const disposition = dispositions[item.findingKey];
  if (disposition === undefined) {
    if (item.disposition === undefined) return item;
    const rest: { -readonly [K in keyof CheckItem]: CheckItem[K] } = { ...item };
    delete rest.disposition;
    return rest;
  }
  return {
    ...item,
    disposition: {
      status: disposition.status,
      comment: disposition.comment,
      by: disposition.by,
      stale: disposition.inputsHash !== inputsHash,
    },
  };
}

export function joinDispositions(review: PrototypeReview, dispositions: Readonly<Record<string, Disposition>>): PrototypeReview {
  const checks = review.checks.map((check) => ({
    ...check,
    items: check.items.map((item) => joined(item, check.inputsHash, dispositions)),
  }));
  const current = new Map(checks.flatMap((check) => check.items.map((item) => [item.findingKey, check.inputsHash] as const)));
  const staleDispositions = Object.values(dispositions)
    .filter((disposition) => current.get(disposition.findingKey) !== disposition.inputsHash)
    .map((disposition) => disposition.findingKey)
    .sort();
  return { ...review, checks, staleDispositions };
}
