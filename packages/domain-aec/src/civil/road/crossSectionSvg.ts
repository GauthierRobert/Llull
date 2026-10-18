/**
 * Cross-section sheet as SVG: one panel per station with the ground line, the road template with batters to daylight, and the cut / fill
 * areas, all drawn at one common 1:1 scale.
 */

import type { CadDocument } from '@core/model/types';
import type { AlignmentObject, CivilModel } from '@core/model/civil';
import { designAtOffset, groundAtOffset, sectionOffsets } from './roadSection';
import { surfaceTinById } from '../surface/surfaceTin';
import type { StationAnalysis } from './roadReport';
import { stationText } from '../model';
import { scaleDenominator, svgDocument, svgLine, svgPolygon, svgPolyline, svgRect, svgText } from './roadSvg';
import { toMetres } from '@core/model/units';

const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 230;
const COLUMNS = 3;
const MARGIN = 20;
const CUT_COLOUR = '#e07b00';
const FILL_COLOUR = '#2a9d5c';
/** Panels per sheet at most; the caller thins the stations beyond this. */
export const MAX_CROSS_SECTIONS = 60;

type Pair = readonly [number, number];

/** Cut (ground above design) and fill (ground below design) polygons between the ground and design lines, split where they cross. */
function earthworkPolygons(
  samples: ReadonlyArray<{ readonly offset: number; readonly ground: number; readonly design: number }>,
  px: (offset: number) => number,
  py: (z: number) => number,
): string[] {
  const polygons: string[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!a || !b) continue;
    const [da, db] = [a.ground - a.design, b.ground - b.design];
    const piece = (from: typeof a, to: typeof a, colour: string): void => {
      polygons.push(
        svgPolygon(
          [
            [px(from.offset), py(from.ground)],
            [px(to.offset), py(to.ground)],
            [px(to.offset), py(to.design)],
            [px(from.offset), py(from.design)],
          ],
          colour,
        ),
      );
    };
    const colourOf = (diff: number): string => (diff >= 0 ? CUT_COLOUR : FILL_COLOUR);
    if (da * db >= 0) {
      piece(a, b, colourOf(da === 0 ? db : da));
      continue;
    }
    const t = da / (da - db);
    const offset = a.offset + (b.offset - a.offset) * t;
    const z = a.design + (b.design - a.design) * t;
    const mid = { offset, ground: z, design: z };
    piece(a, mid, colourOf(da));
    piece(mid, b, colourOf(db));
  }
  return polygons;
}

/** SVG sheet; null when no station has a cross-section. */
export function crossSectionSvg(
  doc: CadDocument,
  civil: CivilModel,
  alignment: AlignmentObject,
  analysis: ReadonlyArray<StationAnalysis>,
): string | null {
  const entries = analysis.filter((entry) => entry.cross !== null);
  if (entries.length === 0) return null;
  const tin = alignment.surfaceId ? surfaceTinById(civil, alignment.surfaceId) : null;
  const metre = toMetres(doc, 1);
  let halfWidth = 1;
  let spanZ = 1;
  for (const { cross } of entries) {
    if (!cross) continue;
    const zs = cross.design.map((node) => node.z * metre);
    halfWidth = Math.max(halfWidth, ...cross.design.map((node) => Math.abs(node.offset) * metre));
    spanZ = Math.max(spanZ, Math.max(...zs) - Math.min(...zs) + 2);
  }
  const scale = Math.min((PANEL_WIDTH - 40) / (2 * halfWidth), (PANEL_HEIGHT - 70) / spanZ);
  const rowsCount = Math.ceil(entries.length / COLUMNS);
  const body: string[] = [
    svgText(MARGIN, 18, `Cross sections - ${alignment.name} (scale 1:${scaleDenominator(scale)} H = V, m)`, { size: 13, weight: 'bold' }),
    svgRect(MARGIN + 400, 8, 10, 10, CUT_COLOUR, CUT_COLOUR),
    svgText(MARGIN + 415, 17, 'Cut (ground above design)', { size: 9 }),
    svgRect(MARGIN + 570, 8, 10, 10, FILL_COLOUR, FILL_COLOUR),
    svgText(MARGIN + 585, 17, 'Fill (ground below design)', { size: 9 }),
  ];
  entries.forEach((entry, index) => {
    const { cross, areas } = entry;
    if (!cross) return;
    const left = MARGIN + (index % COLUMNS) * (PANEL_WIDTH + 10);
    const top = 30 + Math.floor(index / COLUMNS) * (PANEL_HEIGHT + 10);
    const centreX = left + PANEL_WIDTH / 2;
    const designM = cross.designZ * metre;
    const baseY = top + 35 + (spanZ / 2) * scale;
    const px = (offset: number): number => centreX + offset * metre * scale;
    const py = (z: number): number => baseY - (z * metre - designM) * scale;
    body.push(svgRect(left, top, PANEL_WIDTH, PANEL_HEIGHT, '#bbb'));
    body.push(svgText(left + 6, top + 14, `${stationText(doc, cross.station)}  CL ${designM.toFixed(2)}`, { size: 10, weight: 'bold' }));
    body.push(svgLine([centreX, top + 22], [centreX, top + PANEL_HEIGHT - 28], '#ddd', 1, '4,3'));
    const designLine = cross.design.map((node): Pair => [px(node.offset), py(node.z)]);
    if (tin) {
      const offsets = sectionOffsets(cross, 0.5 / metre);
      const samples = offsets.flatMap((offset) => {
        const ground = groundAtOffset(cross, tin, offset);
        return ground === null ? [] : [{ offset, ground, design: designAtOffset(cross.design, offset) }];
      });
      const groundLine = samples.map((sample): Pair => [px(sample.offset), py(sample.ground)]);
      if (groundLine.length >= 2) {
        body.push(...earthworkPolygons(samples, px, py));
        body.push(svgPolyline(groundLine, '#5a4a2a', 1.5));
      }
    }
    body.push(svgPolyline(designLine, '#d02020', 2));
    const notes = areas
      ? `Cut ${(areas.cutArea * metre * metre).toFixed(2)} m2   Fill ${(areas.fillArea * metre * metre).toFixed(2)} m2`
      : 'no existing ground';
    body.push(svgText(left + 6, top + PANEL_HEIGHT - 8, notes, { size: 9 }));
    const day = [cross.right, cross.left].map((node) => (node ? `${(Math.abs(node.offset) * metre).toFixed(1)}` : '-'));
    body.push(svgText(left + PANEL_WIDTH - 6, top + PANEL_HEIGHT - 8, `daylight R ${day[0]} / L ${day[1]} m`, { size: 9, anchor: 'end' }));
  });
  return svgDocument(MARGIN * 2 + COLUMNS * (PANEL_WIDTH + 10), 40 + rowsCount * (PANEL_HEIGHT + 10), body);
}
