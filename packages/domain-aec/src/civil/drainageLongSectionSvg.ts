/**
 * Pipe-run long section as SVG: ground (rim) line, manhole shafts, pipe invert / obvert, hydraulic
 * grade line and a chainage / rim / invert / pipe / HGL table band. Levels in metres.
 * @layer domain-aec/civil
 * @pure
 */

import { niceStep, svgDocument, svgLine, svgPolyline, svgRect, svgText } from './roadSvg';

type Pair = readonly [number, number];

export interface RunStation {
  readonly id: string;
  readonly name: string;
  readonly chainageM: number;
  readonly rimM: number;
  readonly invertM: number;
  readonly hglM: number;
  readonly flooding: boolean;
}

export interface RunSegment {
  readonly id: string;
  readonly diameterMm: number;
  readonly lengthM: number;
  readonly slopePct: number;
  readonly startM: number;
  readonly endM: number;
  readonly invertUpM: number;
  readonly invertDownM: number;
  readonly hglUpM: number;
  readonly hglDownM: number;
  readonly surcharged: boolean;
}

const LEFT = 90;
const TOP = 60;
const ROW_HEIGHT = 16;
const MAX_PLOT_WIDTH = 1000;
const MAX_PLOT_HEIGHT = 420;
const TABLE_LABELS = ['Chainage', 'Rim', 'Invert', 'Pipe', 'HGL'];

export function drainageLongSectionSvg(
  title: string,
  stations: readonly RunStation[],
  segments: readonly RunSegment[],
): string {
  const lengthM = Math.max(stations[stations.length - 1]?.chainageM ?? 0, 1e-6);
  const levels = [
    ...stations.flatMap((s) => [s.rimM, s.invertM, s.hglM]),
    ...segments.flatMap((s) => [s.invertUpM, s.invertDownM, s.hglUpM, s.hglDownM]),
  ];
  const gridMin = Math.min(...levels);
  const gridMax = Math.max(...levels);
  const pad = Math.max((gridMax - gridMin) * 0.1, 0.5);
  const rangeM = gridMax - gridMin + 2 * pad;
  const hScale = Math.min(MAX_PLOT_WIDTH / lengthM, MAX_PLOT_HEIGHT / rangeM);
  const vScale = Math.min(MAX_PLOT_HEIGHT / rangeM, hScale * 10);
  const plotWidth = lengthM * hScale;
  const plotHeight = rangeM * vScale;
  const zTop = gridMax + pad;
  const x = (chainage: number): number => LEFT + chainage * hScale;
  const y = (z: number): number => TOP + (zTop - z) * vScale;
  const body: string[] = [
    svgText(LEFT, 24, `Drainage long section - ${title}`, { size: 14, weight: 'bold' }),
    svgText(
      LEFT,
      42,
      `Scale H 1:${Math.round(1 / hScale)}  V 1:${Math.round(1 / vScale)}; levels in m; ` +
        `ground = rim, red = obvert/invert, blue = HGL`,
      { size: 10 },
    ),
    svgRect(LEFT, TOP, plotWidth, plotHeight),
  ];
  const zStep = niceStep(28 / vScale);
  for (let z = Math.ceil((zTop - rangeM) / zStep) * zStep; z <= zTop; z += zStep) {
    body.push(svgLine([LEFT, y(z)], [LEFT + plotWidth, y(z)], '#e2e2e2'));
    body.push(svgText(LEFT - 6, y(z) + 3, z.toFixed(2), { anchor: 'end', size: 9 }));
  }
  body.push(
    svgPolyline(
      stations.map((s) => [x(s.chainageM), y(s.rimM)] as Pair),
      '#5a4a2a',
      1.5,
    ),
  );
  for (const station of stations) {
    const px = x(station.chainageM);
    body.push(svgLine([px, y(station.rimM)], [px, y(station.invertM)], '#666', 2));
    body.push(
      svgText(px, y(station.rimM) - 6, station.name, {
        anchor: 'middle',
        size: 9,
        weight: 'bold',
        fill: station.flooding ? '#c00000' : '#222',
      }),
    );
  }
  for (const segment of segments) {
    const depth = segment.diameterMm / 1000;
    const invert: [Pair, Pair] = [
      [x(segment.startM), y(segment.invertUpM)],
      [x(segment.endM), y(segment.invertDownM)],
    ];
    const obvert: [Pair, Pair] = [
      [x(segment.startM), y(segment.invertUpM + depth)],
      [x(segment.endM), y(segment.invertDownM + depth)],
    ];
    body.push(svgLine(invert[0], invert[1], '#d02020', 2));
    body.push(svgLine(obvert[0], obvert[1], '#d02020', 2));
  }
  const hglPoints: Pair[] = segments.flatMap((s) => [
    [x(s.startM), y(s.hglUpM)] as Pair,
    [x(s.endM), y(s.hglDownM)] as Pair,
  ]);
  if (hglPoints.length >= 2) body.push(svgPolyline(hglPoints, '#1060d0', 2));
  const bandTop = TOP + plotHeight + 12;
  TABLE_LABELS.forEach((label, row) => {
    body.push(
      svgText(LEFT - 6, bandTop + row * ROW_HEIGHT + 12, label, {
        anchor: 'end',
        size: 9,
        weight: 'bold',
      }),
    );
    body.push(
      svgLine(
        [LEFT, bandTop + (row + 1) * ROW_HEIGHT],
        [LEFT + plotWidth, bandTop + (row + 1) * ROW_HEIGHT],
        '#ccc',
      ),
    );
  });
  body.push(svgLine([LEFT, bandTop], [LEFT + plotWidth, bandTop], '#444'));
  const cell = (px: number, row: number, text: string): void => {
    body.push(svgText(px, bandTop + row * ROW_HEIGHT + 12, text, { anchor: 'middle', size: 8 }));
  };
  for (const station of stations) {
    const px = x(station.chainageM);
    body.push(svgLine([px, TOP + plotHeight], [px, bandTop + TABLE_LABELS.length * ROW_HEIGHT]));
    cell(px, 0, station.chainageM.toFixed(2));
    cell(px, 1, station.rimM.toFixed(2));
    cell(px, 2, station.invertM.toFixed(2));
    cell(px, 4, station.hglM.toFixed(2));
  }
  for (const segment of segments) {
    const mid = (x(segment.startM) + x(segment.endM)) / 2;
    cell(
      mid,
      3,
      `${segment.id} Ø${segment.diameterMm} ${segment.slopePct.toFixed(2)}% ${segment.lengthM.toFixed(1)}m`,
    );
  }
  return svgDocument(LEFT + plotWidth + 40, bandTop + TABLE_LABELS.length * ROW_HEIGHT + 20, body);
}
