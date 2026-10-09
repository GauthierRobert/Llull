/**
 * Plan-and-profile sheet: a stationed plan strip of the alignment above its long section, both at
 * the same horizontal scale so stations line up vertically.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { AlignmentObject } from '@core/model/civil';
import { escapeXml } from '@lib/escapeXml';
import {
  composeSheetSvg,
  fitScale,
  MARGIN,
  n,
  northArrow,
  PAPER_MM,
  sheetDrawingArea,
  type PaperSize,
} from '../sheet';
import { toMetres, toMm } from '../model';
import { endStation, horizontalElements } from './alignmentGeometry';
import { formatStation, getCivil } from './model';
import { analyseStations, reportRows, reportStations } from './roadReport';
import { LONG_SECTION_LEFT, longSectionSvg } from './longSectionSvg';
import { validateProfile } from './profileGeometry';

/** Paper millimetres per long-section SVG unit. */
const PAPER_PER_UNIT = 0.25;
const STRIP_HEIGHT = 42;
const LONG_SECTION_RIGHT = 40;

export interface PlanProfileOptions {
  readonly paper: PaperSize;
  readonly scale: number | undefined;
  readonly verticalExaggeration: number;
}

export interface PlanProfileSheet {
  readonly text: string;
  readonly scale: number;
  readonly fits: boolean;
}

function sizeOf(svg: string): { width: number; height: number } {
  const match = /width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  return { width: Number(match?.[1] ?? 0), height: Number(match?.[2] ?? 0) };
}

/**
 * @pure
 * @returns the sheet, or an explanation string when the alignment cannot be drawn
 */
export function buildPlanProfileSheet(
  doc: CadDocument,
  alignment: AlignmentObject,
  options: PlanProfileOptions,
): PlanProfileSheet | string {
  if (validateProfile(alignment.profile) !== null) {
    return `${alignment.name} has no design profile (set_alignment_profile).`;
  }
  if (options.scale !== undefined && !(options.scale > 0)) return 'scale must be > 0.';
  if (!(options.verticalExaggeration > 0)) return 'verticalExaggeration must be > 0.';
  const civil = getCivil(doc);
  const [width, height] = PAPER_MM[options.paper];
  const area = sheetDrawingArea(width, height);
  const startM = toMetres(doc, alignment.startStation);
  const lengthM = toMetres(doc, endStation(alignment)) - startM;
  const scale =
    options.scale ??
    fitScale(lengthM * 1000, 1, {
      ...area,
      width: area.width - (LONG_SECTION_LEFT + LONG_SECTION_RIGHT) * PAPER_PER_UNIT,
    });
  const mmPerMetre = 1000 / scale;
  const rows = reportRows(
    doc,
    alignment,
    analyseStations(doc, civil, alignment, reportStations(alignment, alignment.stationInterval)),
  );
  const section = longSectionSvg(
    doc,
    civil,
    alignment,
    rows,
    options.verticalExaggeration,
    mmPerMetre / PAPER_PER_UNIT,
  );
  if (section === null) return `${alignment.name}: the profile has no stations on the alignment.`;
  const size = sizeOf(section);
  const sectionTop = area.y + STRIP_HEIGHT + 4;
  const stationX = (stationM: number): number =>
    area.x + LONG_SECTION_LEFT * PAPER_PER_UNIT + (stationM - startM) * mmPerMetre;
  const axisY = area.y + 22;
  const halfWidth = alignment.section
    ? Math.max(
        ((alignment.section.laneWidth + alignment.section.shoulderWidth) * toMm(doc, 1)) / scale,
        1.5,
      )
    : 3;
  const strip: string[] = [
    `<text x="${n(area.x)}" y="${n(area.y + 4)}" font-size="3.2" text-anchor="start">${escapeXml(`PLAN - ${alignment.name}`)}</text>`,
    ...[-halfWidth, halfWidth].map(
      (side) =>
        `<line class="road-edge" x1="${n(stationX(startM))}" y1="${n(axisY + side)}" x2="${n(stationX(startM + lengthM))}" y2="${n(axisY + side)}" class="thin"/>`,
    ),
    `<line class="centreline" x1="${n(stationX(startM))}" y1="${n(axisY)}" x2="${n(stationX(startM + lengthM))}" y2="${n(axisY)}" stroke="#d04a4a" stroke-width="0.35"/>`,
  ];
  const interval = Math.max(toMetres(doc, alignment.stationInterval), 1e-6);
  const stride = Math.max(1, Math.ceil(14 / (interval * mmPerMetre)));
  reportStations(alignment, alignment.stationInterval).forEach((station, index) => {
    if (index % stride !== 0) return;
    const x = stationX(toMetres(doc, station));
    strip.push(
      `<line class="station-tick" x1="${n(x)}" y1="${n(axisY - halfWidth - 2)}" x2="${n(x)}" y2="${n(axisY + halfWidth + 2)}" stroke="#5a5a5a" stroke-width="0.18"/>`,
      `<text class="station-label" x="${n(x)}" y="${n(axisY + halfWidth + 6)}" font-size="2" text-anchor="middle">${escapeXml(formatStation(toMetres(doc, station)))}</text>`,
    );
  });
  for (const element of horizontalElements(alignment)) {
    if (element.kind !== 'arc') continue;
    const from = stationX(toMetres(doc, element.startStation));
    const to = stationX(toMetres(doc, element.startStation + element.length));
    strip.push(
      `<rect class="curve" x="${n(from)}" y="${n(axisY - halfWidth - 8)}" width="${n(to - from)}" height="4" fill="none" stroke="#2f6f9c" stroke-width="0.2"/>`,
      `<text class="curve-label" x="${n((from + to) / 2)}" y="${n(axisY - halfWidth - 9.5)}" font-size="2" text-anchor="middle">${escapeXml(`R=${toMetres(doc, element.radius).toFixed(1)} m ${element.rotation === 'cw' ? 'right' : 'left'}`)}</text>`,
    );
  }
  const body =
    strip.join('') +
    `<svg class="long-section" x="${n(area.x)}" y="${n(sectionTop)}" width="${n(size.width * PAPER_PER_UNIT)}" height="${n(size.height * PAPER_PER_UNIT)}" viewBox="0 0 ${n(size.width)} ${n(size.height)}">${section.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</svg>`;
  const title = `Plan and profile - ${alignment.name}`;
  const text = composeSheetSvg(doc, {
    width,
    height,
    title,
    scale,
    paper: options.paper,
    caption: `${title} · H 1:${scale} · V 1:${n(scale / options.verticalExaggeration)} · stations and levels in m`,
    bodyId: 'plan-profile',
    body,
    overlays: [northArrow(width - MARGIN - 12, MARGIN + 12)],
  });
  const fits =
    area.x + size.width * PAPER_PER_UNIT <= area.x + area.width &&
    sectionTop + size.height * PAPER_PER_UNIT <= area.y + area.height;
  return { text: `${text}\n`, scale, fits };
}
