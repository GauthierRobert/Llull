/**
 * Cross-section sheet as SVG: one panel per station with the ground line, the road template with
 * batters to daylight, and the cut / fill areas, all drawn at one common 1:1 scale.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { AlignmentObject, CivilModel } from '@core/model/civil';
import { groundAtOffset, sectionOffsets } from './roadSection';
import { surfaceTinById } from './surfaceTin';
import type { StationAnalysis } from './roadReport';
import { formatStation } from './model';
import { svgDocument, svgLine, svgPolygon, svgPolyline, svgRect, svgText } from './roadSvg';
import { toMetres } from '../model';

const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 230;
const COLUMNS = 3;
const MARGIN = 20;
/** Panels per sheet at most; the caller thins the stations beyond this. */
export const MAX_CROSS_SECTIONS = 60;

type Pair = readonly [number, number];

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
    svgText(
      MARGIN,
      18,
      `Cross sections - ${alignment.name} (scale 1:${Math.round(1 / scale)} H = V, m)`,
      { size: 13, weight: 'bold' },
    ),
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
    body.push(
      svgText(
        left + 6,
        top + 14,
        `${formatStation(toMetres(doc, cross.station))}  CL ${designM.toFixed(2)}`,
        { size: 10, weight: 'bold' },
      ),
    );
    body.push(svgLine([centreX, top + 22], [centreX, top + PANEL_HEIGHT - 28], '#ddd', 1, '4,3'));
    const designLine = cross.design.map((node): Pair => [px(node.offset), py(node.z)]);
    if (tin) {
      const offsets = sectionOffsets(cross, 0.5 / metre);
      const groundLine = offsets.flatMap((offset): Pair[] => {
        const z = groundAtOffset(cross, tin, offset);
        return z === null ? [] : [[px(offset), py(z)]];
      });
      if (groundLine.length >= 2) {
        body.push(svgPolygon([...groundLine, ...[...designLine].reverse()], '#d0a040'));
        body.push(svgPolyline(groundLine, '#5a4a2a', 1.5));
      }
    }
    body.push(svgPolyline(designLine, '#d02020', 2));
    const notes = areas
      ? `Cut ${(areas.cutArea * metre * metre).toFixed(2)} m2   Fill ${(areas.fillArea * metre * metre).toFixed(2)} m2`
      : 'no existing ground';
    body.push(svgText(left + 6, top + PANEL_HEIGHT - 8, notes, { size: 9 }));
    const day = [cross.right, cross.left].map((node) =>
      node ? `${(Math.abs(node.offset) * metre).toFixed(1)}` : '-',
    );
    body.push(
      svgText(
        left + PANEL_WIDTH - 6,
        top + PANEL_HEIGHT - 8,
        `daylight R ${day[0]} / L ${day[1]} m`,
        { size: 9, anchor: 'end' },
      ),
    );
  });
  return svgDocument(
    MARGIN * 2 + COLUMNS * (PANEL_WIDTH + 10),
    40 + rowsCount * (PANEL_HEIGHT + 10),
    body,
  );
}
