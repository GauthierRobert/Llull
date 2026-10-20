// Reference overlay (FR-FPR-63): the compare_to_reference points of the review on one chart against rpm — the reference D as markers with
// their validation-uncertainty bars (calibration points as diamonds, hold-out points as circles), the simulated S as a line inside its pass
// band (shaded strip). Hovering a point gives S, D, E, U_val and the reference. "Hold-out only" hides the calibration points.

import React, { useState } from 'react';
import type { CheckItem, CheckResult } from './reviewTypes';

const WIDTH = 260;
const HEIGHT = 130;
const PAD = { left: 40, right: 8, top: 10, bottom: 20 };

interface ReferencePoint {
  readonly key: string;
  readonly referenceId: string;
  readonly rpm: number;
  readonly s: number;
  readonly d: number;
  readonly bandRel: number;
  readonly uVal: number | null;
  readonly calibration: boolean;
}

function pointOf(item: CheckItem): ReferencePoint | null {
  const { rpm, simulated, reference, bandRel, validationUncertainty } = item.values;
  if (rpm === undefined || simulated === undefined || reference === undefined) return null;
  return {
    key: item.findingKey,
    referenceId: item.ids[0] ?? '',
    rpm,
    s: simulated,
    d: reference,
    bandRel: bandRel ?? 0,
    uVal: validationUncertainty ?? null,
    calibration: item.status === 'info' || item.accuracy?.['simulated']?.origin === 'calibrated',
  };
}

/** The speed-dependent reference points of the dynamics check, in rpm order. */
function referencePoints(checks: readonly CheckResult[]): ReferencePoint[] {
  return checks
    .filter((check) => check.check === 'dynamics')
    .flatMap((check) => check.items)
    .filter((item) => item.code === 'FPR_REFERENCE_MATCH' || item.code === 'FPR_REFERENCE_MISMATCH')
    .flatMap((item) => pointOf(item) ?? [])
    .sort((a, b) => a.rpm - b.rpm);
}

const tick = (value: number): string => String(Number(value.toPrecision(3)));

export function ReferenceChart({ checks }: { checks: readonly CheckResult[] }): React.ReactElement | null {
  const [holdOutOnly, setHoldOutOnly] = useState(false);
  const all = referencePoints(checks);
  if (all.length === 0) return null;
  const points = holdOutOnly ? all.filter((point) => !point.calibration) : all;
  const values = all.flatMap((p) => [p.s * (1 + p.bandRel), p.s * (1 - p.bandRel), p.d + (p.uVal ?? 0), p.d - (p.uVal ?? 0)]);
  const [low, high] = [Math.min(...values), Math.max(...values)];
  const [first, last] = [all[0]?.rpm ?? 0, all[all.length - 1]?.rpm ?? 1];
  const span = last > first ? last - first : 1;
  const x = (rpm: number): number => PAD.left + (WIDTH - PAD.left - PAD.right) * (all.length === 1 ? 0.5 : (rpm - first) / span);
  const y = (v: number): number => HEIGHT - PAD.bottom - ((HEIGHT - PAD.top - PAD.bottom) * (v - low)) / (high > low ? high - low : 1);
  const strip = [
    ...points.map((p) => `${x(p.rpm).toFixed(1)},${y(p.s * (1 + p.bandRel)).toFixed(1)}`),
    ...[...points].reverse().map((p) => `${x(p.rpm).toFixed(1)},${y(p.s * (1 - p.bandRel)).toFixed(1)}`),
  ].join(' ');
  return (
    <figure className="reference-chart" data-testid="reference-chart">
      <label className="loads-check">
        <input
          type="checkbox"
          checked={holdOutOnly}
          onChange={(e) => setHoldOutOnly(e.target.checked)}
          data-testid="reference-holdout-only"
        />
        Hold-out points only
      </label>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Simulated against reference: ${points.length} point(s)`}>
        <line className="series-chart__axis" x1={PAD.left} y1={HEIGHT - PAD.bottom} x2={WIDTH - PAD.right} y2={HEIGHT - PAD.bottom} />
        <line className="series-chart__axis" x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={HEIGHT - PAD.bottom} />
        <text className="series-chart__tick" x={PAD.left - 4} y={y(high) + 4} textAnchor="end">
          {tick(high)}
        </text>
        <text className="series-chart__tick" x={PAD.left - 4} y={y(low) + 4} textAnchor="end">
          {tick(low)}
        </text>
        <text className="series-chart__tick" x={WIDTH - PAD.right} y={HEIGHT - 4} textAnchor="end">
          {tick(last)} rpm
        </text>
        {points.length > 1 && <polygon className="reference-chart__band" points={strip} />}
        {points.length > 1 && (
          <polyline className="reference-chart__simulated" fill="none" points={points.map((p) => `${x(p.rpm)},${y(p.s)}`).join(' ')} />
        )}
        {points.map((p) => {
          const [cx, cy] = [x(p.rpm), y(p.d)];
          const e = p.s - p.d;
          return (
            <g key={p.key} data-testid={`reference-point-${p.calibration ? 'calibration' : 'holdout'}`}>
              <title>{`${p.referenceId} @ ${p.rpm} rpm: S ${tick(p.s)} · D ${tick(p.d)} · E ${tick(e)} · U_val ${p.uVal === null ? '?' : tick(p.uVal)}${p.calibration ? ' (calibration point, not evidence)' : ''}`}</title>
              {p.uVal !== null && <line className="reference-chart__error" x1={cx} y1={y(p.d - p.uVal)} x2={cx} y2={y(p.d + p.uVal)} />}
              {p.calibration ? (
                <polygon
                  className="reference-chart__calibration"
                  points={`${cx},${cy - 4} ${cx + 4},${cy} ${cx},${cy + 4} ${cx - 4},${cy}`}
                />
              ) : (
                <circle className="reference-chart__holdout" cx={cx} cy={cy} r={3} />
              )}
              <circle className="reference-chart__s" cx={cx} cy={y(p.s)} r={1.8} />
            </g>
          );
        })}
      </svg>
      <figcaption className="series-chart__legend">
        <span>◆ calibration (not evidence)</span> <span>● hold-out reference</span> <span>· simulated in its band</span>
      </figcaption>
    </figure>
  );
}
