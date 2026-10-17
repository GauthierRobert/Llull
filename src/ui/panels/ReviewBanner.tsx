// Standing notice on every computed manufacturing / materials result: llull computes, a qualified person approves.

import React from 'react';

export function ReviewBanner({ reason, unverified }: { reason?: string; unverified?: boolean }): React.ReactElement {
  return (
    <p className="review-banner" role="note" data-testid="review-required">
      <strong>Review required.</strong> {reason ?? 'Computed by llull, not approved: a qualified person must review before manufacture.'}
      {unverified === true && <span className="review-banner__unverified"> Uses unverified data.</span>}
    </p>
  );
}
