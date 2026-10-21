// Axis lines + min/max/end tick labels shared by the compact SVG charts (SeriesChart, ReferenceChart).

import React from 'react';

export interface ChartFrame {
  readonly width: number;
  readonly height: number;
  readonly pad: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
}

export function ChartAxes({
  frame,
  baselineY,
  yHigh,
  yLow,
  highLabel,
  lowLabel,
  endLabel,
}: {
  frame: ChartFrame;
  /** SVG y of the x axis. */
  baselineY: number;
  /** SVG y of the high / low tick values. */
  yHigh: number;
  yLow: number;
  highLabel: string;
  lowLabel: string;
  endLabel: string;
}): React.ReactElement {
  const { width, height, pad } = frame;
  return (
    <>
      <line className="series-chart__axis" x1={pad.left} y1={baselineY} x2={width - pad.right} y2={baselineY} />
      <line className="series-chart__axis" x1={pad.left} y1={pad.top} x2={pad.left} y2={height - pad.bottom} />
      <text className="series-chart__tick" x={pad.left - 4} y={yHigh + 4} textAnchor="end">
        {highLabel}
      </text>
      <text className="series-chart__tick" x={pad.left - 4} y={yLow + 4} textAnchor="end">
        {lowLabel}
      </text>
      <text className="series-chart__tick" x={width - pad.right} y={height - 4} textAnchor="end">
        {endLabel}
      </text>
    </>
  );
}
