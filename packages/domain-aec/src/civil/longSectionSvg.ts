/**
 * Long-section (profile) drawing as SVG: ground line, design line with PVIs, vertical curves and
 * grades, a station axis and a station / ground / design / cut-fill table band.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { AlignmentObject, CivilModel } from '@core/model/civil';
import { endStation, pointAtStation } from './alignmentGeometry';
import {
  designElevation,
  grades,
  validateProfile,
  verticalCurves,
  verticalCurveStations,
} from './profileGeometry';
import { surfaceTinById } from './surfaceTin';
import { elevationAt } from './tin';
import type { ReportRow } from './roadReport';
import { formatStation } from './model';
import { niceStep, svgDocument, svgLine, svgPolyline, svgRect, svgText } from './roadSvg';
import { toMetres } from '../model';

const LEFT = 90;
const TOP = 60;
const ROW_HEIGHT = 16;
const MAX_PLOT_WIDTH = 1000;
const MAX_PLOT_HEIGHT = 480;

type Pair = readonly [number, number];

function samples(
  doc: CadDocument,
  civil: CivilModel,
  alignment: AlignmentObject,
): { ground: Pair[]; design: Pair[] } {
  const start = alignment.startStation;
  const end = endStation(alignment);
  const tin = alignment.surfaceId ? surfaceTinById(civil, alignment.surfaceId) : null;
  const extra = verticalCurveStations(alignment.profile);
  const stations = new Set<number>([start, end, ...extra.filter((s) => s > start && s < end)]);
  for (const pvi of alignment.profile)
    if (pvi.station >= start && pvi.station <= end) stations.add(pvi.station);
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
): string | null {
  if (validateProfile(alignment.profile) !== null) return null;
  const { ground, design } = samples(doc, civil, alignment);
  if (design.length < 2) return null;
  const startM = toMetres(doc, alignment.startStation);
  const lengthM = toMetres(doc, endStation(alignment)) - startM;
  const all = [...ground, ...design].map((p) => p[1]);
  const gridMin = Math.min(...all);
  const gridMax = Math.max(...all);
  const pad = Math.max((gridMax - gridMin) * 0.1, 0.5);
  const rangeM = gridMax - gridMin + 2 * pad;
  const hScale = Math.min(
    MAX_PLOT_WIDTH / lengthM,
    MAX_PLOT_HEIGHT / (rangeM * verticalExaggeration),
  );
  const vScale = hScale * verticalExaggeration;
  const plotWidth = lengthM * hScale;
  const plotHeight = rangeM * vScale;
  const zTop = gridMax + pad;
  const x = (stationM: number): number => LEFT + (stationM - startM) * hScale;
  const y = (z: number): number => TOP + (zTop - z) * vScale;
  const body: string[] = [];
  body.push(svgText(LEFT, 24, `Long section - ${alignment.name}`, { size: 14, weight: 'bold' }));
  body.push(
    svgText(
      LEFT,
      42,
      `Scale H 1:${Math.round(1 / hScale)}  V 1:${Math.round(1 / vScale)}  (vertical exaggeration x${verticalExaggeration}); levels in m`,
      { size: 10 },
    ),
  );
  body.push(svgRect(LEFT, TOP, plotWidth, plotHeight));
  const zStep = niceStep(28 / vScale);
  for (let z = Math.ceil((zTop - rangeM) / zStep) * zStep; z <= zTop; z += zStep) {
    body.push(svgLine([LEFT, y(z)], [LEFT + plotWidth, y(z)], '#e2e2e2'));
    body.push(svgText(LEFT - 6, y(z) + 3, z.toFixed(2), { anchor: 'end', size: 9 }));
  }
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
      svgText(
        px,
        TOP + 10 + (index % 2) * 10,
        `PVI ${formatStation(toMetres(doc, pvi.station))} / ${toMetres(doc, pvi.elevation).toFixed(2)}`,
        { anchor: 'middle', size: 8, fill: '#a01818' },
      ),
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
      ? ` ${curve.kind === 'crest' ? 'high' : 'low'} ${toMetres(doc, curve.turning.elevation).toFixed(2)}@${formatStation(toMetres(doc, curve.turning.station))}`
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
  const labels = ['Station', 'Ground', 'Design', 'Cut(-)/Fill(+)'];
  labels.forEach((label, r) => {
    body.push(
      svgText(LEFT - 6, bandTop + r * ROW_HEIGHT + 12, label, {
        anchor: 'end',
        size: 9,
        weight: 'bold',
      }),
    );
    body.push(
      svgLine(
        [LEFT, bandTop + (r + 1) * ROW_HEIGHT],
        [LEFT + plotWidth, bandTop + (r + 1) * ROW_HEIGHT],
        '#ccc',
      ),
    );
  });
  body.push(svgLine([LEFT, bandTop], [LEFT + plotWidth, bandTop], '#444'));
  const stride = Math.max(1, Math.ceil(64 / Math.max(1, plotWidth / Math.max(1, rows.length - 1))));
  rows.forEach((row, index) => {
    if (index % stride !== 0 && index !== rows.length - 1) return;
    const px = x(row.station);
    body.push(svgLine([px, TOP + plotHeight], [px, bandTop + 4 * ROW_HEIGHT], '#ddd'));
    const cells = [
      row.stationText,
      row.groundM === null ? '-' : row.groundM.toFixed(2),
      row.designM === null ? '-' : row.designM.toFixed(2),
      row.cutFillM === null ? '-' : (row.cutFillM > 0 ? '+' : '') + row.cutFillM.toFixed(2),
    ];
    cells.forEach((cell, r) => {
      body.push(svgText(px, bandTop + r * ROW_HEIGHT + 12, cell, { anchor: 'middle', size: 8 }));
    });
  });
  return svgDocument(LEFT + plotWidth + 40, bandTop + 4 * ROW_HEIGHT + 20, body);
}
