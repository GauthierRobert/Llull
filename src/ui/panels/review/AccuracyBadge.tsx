// Accuracy on screen (FR-FPR-62): a compact "± 5 %" / "± ?" badge with the origin tag (input, calibrated, predicted, self-check). The basis and
// the validation level are in the tooltip. A calibrated value is hatched and grey: it is matched by construction, never pass evidence.

import React from 'react';
import type { Accuracy } from './reviewTypes';

const ORIGIN_LABEL: Readonly<Record<Accuracy['origin'], string>> = {
  input: 'input',
  calibrated: 'calibrated',
  predicted: 'predicted',
  verification: 'self-check',
};

/** "± 5 %", "± 0.2 mm" or "± ?" when no band is known. */
export function bandText(band: Accuracy['band']): string {
  if (band === null) return '± ?';
  return 'rel' in band ? `± ${Number((band.rel * 100).toPrecision(2))} %` : `± ${Number(band.abs.toPrecision(3))} ${band.unit}`;
}

interface AccuracyBadgeProps {
  readonly accuracy: Accuracy;
  readonly testId?: string;
}

export function AccuracyBadge({ accuracy, testId }: AccuracyBadgeProps): React.ReactElement {
  const origin = ORIGIN_LABEL[accuracy.origin];
  return (
    <span
      className={`accuracy-badge accuracy-badge--${accuracy.origin}`}
      title={`${accuracy.basis} · validation level ${accuracy.validationLevel}`}
      data-testid={testId}
    >
      <span className="accuracy-badge__band">{bandText(accuracy.band)}</span>
      <span className="accuracy-badge__origin">{origin}</span>
    </span>
  );
}
