/**
 * anchorPlan: anchorPlanExport.
 * @layer core/commands/building
 */

import type { GridElement } from '@core/model/building';
import type { Vec2 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { fileSlug, getBuilding, isFiniteNumber, noChange, toMetres } from '../model';
import {
  BINDING_MARGIN,
  MARGIN,
  PAPER_MM,
  SHEET_DEFS,
  SHEET_STYLE,
  TITLE_HEIGHT,
  escapeXml,
  fitScale,
  scaleBar,
  titleBlock,
  type PaperSize,
  type Viewport,
} from '../sheet';
import { boltSize } from './evaluate';
import {
  BAND_STEP,
  BUBBLE_RADIUS,
  type BandDim,
  DEFAULT_EMBEDMENT_MM,
  GROUT_MM,
  type GridAxis,
  INSET,
  OFFSET_TOLERANCE_MM,
  ROW_HEIGHT,
  TABLE_WIDTH,
  TITLE,
  compareMark,
  gridAxes,
  gridRef,
  metres,
  n,
  nearest,
  packBands,
  placePlates,
} from './anchorPlanLayout';
import { PlanCanvas, mmText, scheduleTable } from './anchorPlanCanvas';

/**
 * @command export_anchor_plan
 * @pure read-only
 * @affects none; data = { svg, filename, boltCount, plates, paper, scale, levelId }
 * @failure unknown level / paper, invalid scale or embedment, no base plates -> no data
 */
export const exportAnchorPlan = defineCommand({
  name: 'export_anchor_plan',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Produce the anchor bolt setting-out plan (SVG in real millimetres, print to PDF at 100%): grid lines ' +
    'with bubbles, dashed footing outlines, base plate outlines and EVERY anchor bolt (circle with cross), ' +
    'dimensioned from the grid lines (grid spacing, grid line to each bolt group centre, bolt spacing of a ' +
    'typical group), a label per plate with top-of-concrete / grout level, and a bolt schedule (plate mark, ' +
    'grid ref like A/1, bolt count x size, embedment, projection above concrete, plate size). Needs steel ' +
    'columns with base plates (add_base_plates). data.svg holds the file text.',
  params: z.object({
    levelId: z
      .string()
      .optional()
      .describe('Level whose base plates are drawn. Default: active level.'),
    scale: z
      .number()
      .optional()
      .describe(
        'Scale denominator N for 1:N (e.g. 100). Default: smallest standard scale that fits the paper.',
      ),
    paper: z
      .enum(Object.keys(PAPER_MM) as [PaperSize, ...PaperSize[]])
      .optional()
      .describe('Paper size (landscape). Default A3.'),
    embedment: z
      .number()
      .optional()
      .describe(
        'Anchor bolt embedment below the plate underside in the schedule, in document units. Default 300 mm.',
      ),
  }),
  run: (doc, { levelId, scale, paper, embedment }): CommandResult => {
    if (scale !== undefined && !(isFiniteNumber(scale) && scale > 0)) {
      return noChange(doc, 'export_anchor_plan failed: scale must be a number > 0.');
    }
    if (embedment !== undefined && !(isFiniteNumber(embedment) && embedment > 0)) {
      return noChange(doc, 'export_anchor_plan failed: embedment must be a number > 0.');
    }
    const building = getBuilding(doc);
    const resolvedId = levelId ?? building.activeLevelId ?? building.levelOrder[0];
    const level = resolvedId !== undefined ? building.levels[resolvedId] : undefined;
    if (!level) {
      return noChange(
        doc,
        `export_anchor_plan failed: no such level${levelId !== undefined ? ` '${levelId}'` : ''} (add_level / add_portal_frame_building first).`,
      );
    }
    const mm = (value: number): number => toMetres(doc, value) * 1000;
    const plates = placePlates(doc, level, mm);
    if (plates.length === 0) {
      return noChange(
        doc,
        `export_anchor_plan failed: no base plates on level ${level.id} (add_base_plates first).`,
      );
    }
    const grids = Object.values(building.elements).filter(
      (element): element is GridElement => element.category === 'grid',
    );
    const { vertical, horizontal } = gridAxes(grids, mm);
    const embedmentMm = embedment !== undefined ? mm(embedment) : DEFAULT_EMBEDMENT_MM;

    const sheetPaper: PaperSize = paper ?? 'A3';
    const [width, height] = PAPER_MM[sheetPaper];
    const viewport: Viewport = {
      x: BINDING_MARGIN + 4 + INSET,
      y: MARGIN + 4 + INSET,
      width: width - BINDING_MARGIN - MARGIN - 8 - TABLE_WIDTH - 2 * INSET,
      height: height - 2 * MARGIN - TITLE_HEIGHT - 8 - 2 * INSET - 6,
    };
    const extent: Vec2[] = [
      ...plates.flatMap((placed) => [...placed.corners, ...placed.bolts]),
      ...[...vertical, ...horizontal].flatMap((axis): Vec2[] => [axis.from, axis.to]),
    ];
    const xs = extent.map((point) => point[0]);
    const ys = extent.map((point) => point[1]);
    const [minX, maxX, minY, maxY] = [
      Math.min(...xs),
      Math.max(...xs),
      Math.min(...ys),
      Math.max(...ys),
    ];
    const sheetScale = scale ?? fitScale(maxX - minX, maxY - minY, viewport);
    const canvas = new PlanCanvas([(minX + maxX) / 2, (minY + maxY) / 2], sheetScale, viewport);

    // Grid lines with bubbles at their low end.
    for (const [axes, isVertical] of [
      [vertical, true],
      [horizontal, false],
    ] as const) {
      for (const axis of axes) {
        canvas.line(
          canvas.map(axis.from),
          canvas.map(axis.to),
          'thin',
          ' stroke-dasharray="6 1 1 1"',
        );
        const [bx, by] = canvas.map(axis.from);
        const centre: Vec2 = isVertical ? [bx, by + BUBBLE_RADIUS] : [bx - BUBBLE_RADIUS, by];
        canvas.parts.push(
          `<ellipse cx="${n(centre[0])}" cy="${n(centre[1])}" rx="${BUBBLE_RADIUS}" ry="${BUBBLE_RADIUS}" class="frame-thin"/>`,
        );
        canvas.text([centre[0], centre[1] + 1.2], 3, axis.mark);
      }
    }

    // Footings (dashed), plates, bolts.
    for (const id of building.elementOrder) {
      const footing = building.elements[id];
      if (footing?.category !== 'footing' || footing.levelId !== level.id) continue;
      const [cx, cy] = [mm(footing.location[0]), mm(footing.location[1])];
      const [hx, hy] = [mm(footing.width) / 2, mm(footing.length) / 2];
      canvas.polygon(
        [
          [cx - hx, cy - hy],
          [cx + hx, cy - hy],
          [cx + hx, cy + hy],
          [cx - hx, cy + hy],
        ],
        'hidden',
      );
    }
    const rows: string[][] = [];
    const labelBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    const labelParts: Array<{ at: Vec2; text: string }> = [];
    const bottomDims: BandDim[] = [];
    const leftDims: BandDim[] = [];
    const drawnX = new Set<string>();
    const drawnY = new Set<string>();
    let boltCount = 0;
    plates.forEach((placed, index) => {
      const { plate } = placed;
      canvas.polygon(placed.corners, 'cut-line');
      const crossArm = Math.max(canvas.paper(placed.diameter) * 0.9, 0.9);
      for (const bolt of placed.bolts) {
        boltCount += 1;
        const [bx, by] = canvas.map(bolt);
        canvas.parts.push(
          `<circle cx="${n(bx)}" cy="${n(by)}" r="${n(Math.max(canvas.paper(placed.diameter) / 2, 0.6))}" class="thin"/>`,
        );
        canvas.line([bx - crossArm, by], [bx + crossArm, by], 'thin');
        canvas.line([bx, by - crossArm], [bx, by + crossArm], 'thin');
      }
      const columnGrid = nearest(vertical, placed.centre[0]);
      const rowGrid = nearest(horizontal, placed.centre[1]);
      const toc = placed.footingTop ?? placed.undersideLevel - GROUT_MM;
      const offsetX = columnGrid ? placed.centre[0] - columnGrid.position : 0;
      const offsetY = rowGrid ? placed.centre[1] - rowGrid.position : 0;
      const ref = `${gridRef(columnGrid, offsetX)}/${gridRef(rowGrid, offsetY)}`;
      const [labelX, labelY] = canvas.map([placed.centre[0], placed.centre[1]]);
      const below = canvas.paper(placed.width) / 2 + 3;
      const lines = [
        `${plate.mark} ${ref}`,
        `TOC ${metres(toc)} / grout ${metres(placed.undersideLevel)}`,
      ];
      lines.forEach((line, lineIndex) => {
        const lineY = labelY + below + lineIndex * 2.4;
        labelBox.minX = Math.min(labelBox.minX, labelX - line.length * 0.6);
        labelBox.maxX = Math.max(labelBox.maxX, labelX + line.length * 0.6);
        labelBox.minY = Math.min(labelBox.minY, lineY - 2);
        labelBox.maxY = Math.max(labelBox.maxY, lineY + 0.6);
        labelParts.push({ at: [labelX, lineY], text: line });
      });
      if (columnGrid && Math.abs(offsetX) > OFFSET_TOLERANCE_MM) {
        const key = `${columnGrid.mark}:${mmText(offsetX)}`;
        if (!drawnX.has(key)) {
          drawnX.add(key);
          bottomDims.push({
            from: Math.min(columnGrid.position, placed.centre[0]),
            to: Math.max(columnGrid.position, placed.centre[0]),
            label: mmText(Math.abs(offsetX)),
          });
        }
      }
      if (rowGrid && Math.abs(offsetY) > OFFSET_TOLERANCE_MM) {
        const key = `${rowGrid.mark}:${mmText(offsetY)}`;
        if (!drawnY.has(key)) {
          drawnY.add(key);
          leftDims.push({
            from: Math.min(rowGrid.position, placed.centre[1]),
            to: Math.max(rowGrid.position, placed.centre[1]),
            label: mmText(Math.abs(offsetY)),
          });
        }
      }
      // Bolt spacing of the first (typical) group.
      if (index === 0) {
        const perRow = Math.max(1, Math.floor(placed.bolts.length / 2));
        const [first, second, across] = [placed.bolts[0], placed.bolts[1], placed.bolts[perRow]];
        if (first && second && perRow > 1) {
          canvas.dimension(
            first,
            second,
            6,
            mmText(Math.hypot(second[0] - first[0], second[1] - first[1])),
          );
        }
        if (first && across) {
          canvas.dimension(
            first,
            across,
            -6,
            mmText(Math.hypot(across[0] - first[0], across[1] - first[1])),
          );
        }
      }
      const projection = placed.thickness + GROUT_MM + 2 * placed.diameter;
      rows.push([
        plate.mark,
        ref,
        `${plate.boltCount}x${boltSize(doc, plate.boltDiameter)}`,
        mmText(embedmentMm),
        mmText(projection),
        `${mmText(placed.length)}x${mmText(placed.width)}x${mmText(placed.thickness)}`,
        `${metres(toc)} / ${metres(placed.undersideLevel)}`,
      ]);
    });

    // Running dimensions sit outside the grid extents and the plate labels, in stacked bands.
    const bubbleSpan = 2 * BUBBLE_RADIUS;
    const topEdge = Math.min(canvas.map([minX, maxY])[1], labelBox.minY) - 10;
    const bottomEdge = Math.max(canvas.map([minX, minY])[1] + bubbleSpan, labelBox.maxY) + 10;
    const leftEdge = Math.min(canvas.map([minX, minY])[0] - bubbleSpan, labelBox.minX) - 10;
    canvas.parts.push(`<g id="grid-dimensions">`);
    const spans = (axes: ReadonlyArray<GridAxis>): Array<readonly [number, number]> =>
      axes.slice(1).map((axis, index) => [(axes[index] as GridAxis).position, axis.position]);
    const horizontalSpans = spans(vertical);
    if (vertical.length > 2) {
      horizontalSpans.push([
        (vertical[0] as GridAxis).position,
        (vertical[vertical.length - 1] as GridAxis).position,
      ]);
    }
    horizontalSpans.forEach(([from, to], index) => {
      const overall = vertical.length > 2 && index === horizontalSpans.length - 1;
      canvas.dimension(
        [from, maxY],
        [to, maxY],
        canvas.map([from, maxY])[1] - topEdge + (overall ? 8 : 0),
        mmText(to - from),
      );
    });
    const verticalSpans = spans(horizontal);
    if (horizontal.length > 2) {
      verticalSpans.push([
        (horizontal[0] as GridAxis).position,
        (horizontal[horizontal.length - 1] as GridAxis).position,
      ]);
    }
    verticalSpans.forEach(([from, to], index) => {
      const overall = horizontal.length > 2 && index === verticalSpans.length - 1;
      canvas.dimension(
        [minX, from],
        [minX, to],
        canvas.map([minX, from])[0] - leftEdge + (overall ? 8 : 0),
        mmText(to - from),
      );
    });
    canvas.parts.push(`</g><g id="offset-dimensions">`);
    packBands(bottomDims).forEach(({ dim, level: band }) => {
      canvas.dimension(
        [dim.from, minY],
        [dim.to, minY],
        -(bottomEdge - canvas.map([dim.from, minY])[1] + band * BAND_STEP),
        dim.label,
      );
    });
    packBands(leftDims).forEach(({ dim, level: band }) => {
      canvas.dimension(
        [minX, dim.from],
        [minX, dim.to],
        canvas.map([minX, dim.from])[0] -
          leftEdge +
          (horizontal.length > 2 ? 16 : 8) +
          band * BAND_STEP,
        dim.label,
      );
    });
    canvas.parts.push(`</g><g id="plate-labels">`);
    for (const label of labelParts) canvas.text(label.at, 2, label.text);
    canvas.parts.push(`</g>`);
    rows.sort((a, b) => compareMark(a[0] as string, b[0] as string));

    const tableX = width - MARGIN - TABLE_WIDTH - 2;
    const tableY = MARGIN + 8;
    const capacity = Math.max(
      1,
      Math.floor((height - 2 * MARGIN - TITLE_HEIGHT - 20) / ROW_HEIGHT) - 1,
    );
    const shown = rows.slice(0, capacity);
    const clipped =
      rows.length > shown.length
        ? `<text x="${n(tableX)}" y="${n(tableY + 6 + (shown.length + 1) * ROW_HEIGHT)}" font-size="2" text-anchor="start">… ${rows.length - shown.length} more plate(s) not shown</text>`
        : '';

    const title = `${TITLE} — ${level.name}`;
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`,
      `<title>${escapeXml(title)}</title>`,
      SHEET_STYLE,
      SHEET_DEFS,
      `<rect width="${width}" height="${height}" fill="#fff"/>`,
      `<rect x="${BINDING_MARGIN}" y="${MARGIN}" width="${width - BINDING_MARGIN - MARGIN}" height="${height - 2 * MARGIN}" class="frame"/>`,
      `<g id="anchor-plan">${canvas.parts.join('')}</g>`,
      scheduleTable(shown, tableX, tableY + 2),
      clipped,
      scaleBar(BINDING_MARGIN + 8, height - MARGIN - 12, sheetScale),
      `<text x="${BINDING_MARGIN + 8}" y="${n(height - MARGIN - 16)}" font-size="2.6" text-anchor="start">${escapeXml(title)} · level ${metres(mm(level.elevation))} m · 1:${sheetScale} · dimensions in mm</text>`,
      titleBlock(doc, { width, height, title, scale: sheetScale, paper: sheetPaper }),
      `</svg>`,
    ].join('\n');
    const filename = `${fileSlug(building.project.name, 'project')}_${fileSlug(level.name, 'level')}_anchor-plan_${sheetPaper}_1-${sheetScale}.svg`;
    return {
      document: doc,
      summary: `Anchor plan ${filename}: ${plates.length} base plate(s), ${boltCount} anchor bolt(s), ${vertical.length + horizontal.length} grid line(s) at 1:${sheetScale} on ${sheetPaper}, embedment ${mmText(embedmentMm)} mm.`,
      affected: [],
      data: {
        svg: `${svg}\n`,
        filename,
        boltCount,
        plates: plates.length,
        paper: sheetPaper,
        scale: sheetScale,
        levelId: level.id,
      },
    };
  },
});
