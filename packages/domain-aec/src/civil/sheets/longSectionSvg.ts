/**
 * Long-section (profile) drawing as SVG: ground line, design line with PVIs, vertical curves and grades, a station axis and a station /
 * ground / design / cut-fill table band.
 */

import type { CadDocument } from '@core/model/types';
import type { AlignmentObject, CivilModel } from '@core/model/civil';
import { endStation, pointAtStation } from '../alignment/alignmentGeometry';
import { designElevation, grades, validateProfile, verticalCurves, verticalCurveStations } from '../alignment/profileGeometry';
import { surfaceTinById } from '../surface/surfaceTin';
import { elevationAt } from '../surface/tin';
import type { ReportRow } from '../road/roadReport';
import { stationText } from '../model';
import {
  PLOT_LEFT,
  PLOT_MAX_WIDTH,
  PLOT_ROW_HEIGHT,
  PLOT_TOP,
  bandAnchor,
  levelFrame,
  scaleDenominator,
  pushLevelGrid,
  pushTableLabels,
  svgDocument,
  svgLine,
  svgPolyline,
  svgRect,
  svgText,
} from '../road/roadSvg';
import { niceStep } from '@lib/niceStep';
import { toMetres } from '@core/model/units';

export const LONG_SECTION_LEFT = PLOT_LEFT;
const LEFT = PLOT_LEFT;
const TOP = PLOT_TOP;
const ROW_HEIGHT = PLOT_ROW_HEIGHT;
const MAX_PLOT_WIDTH = PLOT_MAX_WIDTH;
const MAX_PLOT_HEIGHT = 480;
/** Minimum horizontal gap (SVG units) between two table-band columns. */
const MIN_COLUMN_GAP = 64;

type Pair = readonly [number, number];

function samples(doc: CadDocument, civil: CivilModel, alignment: AlignmentObject): { ground: Pair[]; design: Pair[] } {
  const start = alignment.startStation;
  const end = endStation(alignment);
  const tin = alignment.surfaceId ? surfaceTinById(civil, alignment.surfaceId) : null;
  const extra = verticalCurveStations(alignment.profile);
  const stations = new Set<number>([start, end, ...extra.filter((s) => s > start && s < end)]);
  for (const pvi of alignment.profile) if (pvi.station >= start && pvi.station <= end) stations.add(pvi.station);
  const count = 300;
  for (let k = 1; k < count; k++) stations.add(start + ((end - start) * k) / count);
  const ground: Pair[] = [];
  const design: Pair[] = [];
  for (const s of [...stations].sort((a, b) => a - b)) {
    const m = toMetres(doc, s);
    const placed = pointAtStation(alignment, s);
    const g = tin && placed ? elevationAt(tin, placed.point) : null;
    if (g !== null) ground.push([m, toMetres(doc, g)]);
    const d = designElevation(alignment.profile, s);
    if (d !== null) design.push([m, toMetres(doc, d)]);
  }
  return { ground, design };
}

/** SVG long section; null when the profile is missing or invalid. */
export function longSectionSvg(
  doc: CadDocument,
  civil: CivilModel,
  alignment: AlignmentObject,
  rows: ReadonlyArray<ReportRow>,
  verticalExaggeration: number,
  horizontalScale?: number,
): string | null {
  if (validateProfile(alignment.profile) !== null) return null;
  const { ground, design } = samples(doc, civil, alignment);
  if (design.length < 2) return null;
  const startM = toMetres(doc, alignment.startStation);
  const lengthM = toMetres(doc, endStation(alignment)) - startM;
  const all = [...ground, ...design].map((p) => p[1]);
  const { rangeM, zTop } = levelFrame(all);
  const hScale = horizontalScale ?? Math.min(MAX_PLOT_WIDTH / lengthM, MAX_PLOT_HEIGHT / (rangeM * verticalExaggeration));
  const vScale = hScale * verticalExaggeration;
  const plotWidth = lengthM * hScale;
  const plotHeight = rangeM * vScale;
  const x = (stationM: number): number => LEFT + (stationM - startM) * hScale;
  const y = (z: number): number => TOP + (zTop - z) * vScale;
  const body: string[] = [];
  body.push(svgText(LEFT, 24, `Long section - ${alignment.name}`, { size: 14, weight: 'bold' }));
  body.push(
    svgText(
      LEFT,
      42,
      `Scale H 1:${scaleDenominator(hScale)}  V 1:${scaleDenominator(vScale)}  (vertical exaggeration x${verticalExaggeration}); levels in m`,
      { size: 10 },
    ),
  );
  body.push(svgRect(LEFT, TOP, plotWidth, plotHeight));
  pushLevelGrid(body, LEFT, plotWidth, y, zTop, rangeM, vScale);
  const sStep = niceStep(70 / hScale);
  for (let s = Math.ceil(startM / sStep) * sStep; s <= startM + lengthM + 1e-9; s += sStep) {
    body.push(svgLine([x(s), TOP], [x(s), TOP + plotHeight], '#eee'));
  }
  if (ground.length >= 2) {
    body.push(
      svgPolyline(
        ground.map(([s, z]) => [x(s), y(z)] as Pair),
        '#5a4a2a',
        1.5,
      ),
    );
  }
  body.push(
    svgPolyline(
      design.map(([s, z]) => [x(s), y(z)] as Pair),
      '#d02020',
      2,
    ),
  );
  const segmentGrades = grades(alignment.profile);
  alignment.profile.forEach((pvi, index) => {
    const px = x(toMetres(doc, pvi.station));
    const py = y(toMetres(doc, pvi.elevation));
    body.push(`<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="3" fill="#d02020"/>`);
    body.push(svgLine([px, py], [px, TOP + plotHeight], '#d9a0a0', 1, '3,3'));
    body.push(
      svgText(px, TOP + 10 + (index % 2) * 10, `PVI ${stationText(doc, pvi.station)} / ${toMetres(doc, pvi.elevation).toFixed(2)}`, {
        anchor: 'middle',
        size: 8,
        fill: '#a01818',
      }),
    );
    const next = alignment.profile[index + 1];
    const grade = segmentGrades[index];
    if (next && grade !== undefined) {
      const mid = (pvi.station + next.station) / 2;
      const gz = designElevation(alignment.profile, mid) ?? pvi.elevation;
      body.push(
        svgText(x(toMetres(doc, mid)), y(toMetres(doc, gz)) - 8, `${(grade * 100).toFixed(2)}%`, {
          anchor: 'middle',
          size: 9,
          weight: 'bold',
        }),
      );
    }
  });
  for (const curve of verticalCurves(alignment.profile)) {
    const px = x(toMetres(doc, curve.pviStation));
    const lengthText = toMetres(doc, curve.length).toFixed(1);
    const turning = curve.turning
      ? ` ${curve.kind === 'crest' ? 'high' : 'low'} ${toMetres(doc, curve.turning.elevation).toFixed(2)}@${stationText(doc, curve.turning.station)}`
      : '';
    body.push(
      svgText(
        px,
        y(toMetres(doc, curve.pviElevation)) + (curve.kind === 'crest' ? 18 : -14),
        `VC L=${lengthText} K=${curve.k.toFixed(1)} ${curve.kind}${turning}`,
        { anchor: 'middle', size: 8, fill: '#a01818' },
      ),
    );
  }
  const bandTop = TOP + plotHeight + 12;
  pushTableLabels(body, ['Station', 'Ground', 'Design', 'Cut(-)/Fill(+)'], LEFT, plotWidth, bandTop, ROW_HEIGHT);
  body.push(svgLine([LEFT, bandTop], [LEFT + plotWidth, bandTop], '#444'));
  const stride = Math.max(1, Math.ceil(MIN_COLUMN_GAP / Math.max(1, plotWidth / Math.max(1, rows.length - 1))));
  const lastX = x((rows[rows.length - 1] ?? { station: 0 }).station);
  rows.forEach((row, index) => {
    const isLast = index === rows.length - 1;
    if (!isLast && (index % stride !== 0 || lastX - x(row.station) < MIN_COLUMN_GAP)) return;
    const px = x(row.station);
    body.push(svgLine([px, TOP + plotHeight], [px, bandTop + 4 * ROW_HEIGHT], '#ddd'));
    const cells = [
      row.stationText,
      row.groundM === null ? '-' : row.groundM.toFixed(2),
      row.designM === null ? '-' : row.designM.toFixed(2),
      row.cutFillM === null ? '-' : (row.cutFillM > 0 ? '+' : '') + row.cutFillM.toFixed(2),
    ];
    cells.forEach((cell, r) => {
      body.push(svgText(px, bandTop + r * ROW_HEIGHT + 12, cell, { anchor: bandAnchor(index, rows.length), size: 8 }));
    });
  });
  return svgDocument(LEFT + plotWidth + 40, bandTop + 4 * ROW_HEIGHT + 20, body);
}
