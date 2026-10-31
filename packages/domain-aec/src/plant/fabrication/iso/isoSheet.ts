/**
 * One isometric sheet of a line (plant 05 ISO §5.8 - §5.10, TR-ISO-09 .. 11): graph, dimensions, layout, symbols, annotations, tables, frame, title block and north arrow
 * as one primitive list plus the data behind every number on it. A single sheet: a line too large for the area is shrunk and reported (`ISO_SHEET_OVERFLOW`); the split
 * over several sheets is the next milestone. Every unissued sheet carries the NOT FOR CONSTRUCTION stamp. Pure, deterministic.
 */

import { sheetDrawingArea } from '@core/geometry/sheetLayout';
import { PAPER_MM, type PaperSize } from '@core/model/sheet';
import type { Vec2 } from '@core/model/vectors';
import type { LineAnalysis } from '../analysis';
import { isoIssue } from '../codes';
import { nodeKey } from '../joints';
import type { IsoIssue } from '../model';
import { lineAnnotations, mmText, runDimensions, type IsoAnnotation, type RunDimension } from './isoDimensions';
import { buildIsoGraph, type IsoGraph } from './isoGraph';
import type { ContinuationMark } from './isoSheets';
import { LabelPlacer, TEXT_SIZE, dimensionPrimitives } from './isoLabels';
import { layoutIso, type IsoLayout } from './isoLayout';
import { axisAngles, type NorthArrow } from './isoProjection';
import type { IsoPrimitive } from './isoRender';
import { isoSymbols } from './isoSymbols';
import { isoTables, type IsoTable, type TableName } from './isoTables';

/** The sheet of a split isometric: which components it prints and the continuation marks at its cuts. */
export interface SheetScope {
  readonly index: number;
  readonly total: number;
  readonly include: ReadonlySet<string>;
  readonly indices: ReadonlySet<number>;
  /** One of several sheets of the same spools (table rows count only what is on the sheet). */
  readonly partial: boolean;
  readonly continuation: readonly ContinuationMark[];
  readonly spool?: string;
}

/** A current human issue of the line: replaces the NOT FOR CONSTRUCTION stamp by the revision and approver. */
export interface SheetIssue {
  readonly revision: string;
  readonly purpose: string;
  readonly signer: string;
}

export interface SheetOptions {
  readonly style: 'check' | 'final' | 'spool';
  readonly paper: PaperSize;
  readonly northArrow: NorthArrow;
  readonly tables: readonly TableName[];
  readonly project: string;
  readonly sheet?: SheetScope;
  readonly issue?: SheetIssue;
}

export interface SheetAnnotation extends IsoAnnotation {
  /** Anchor on the sheet, paper mm (y up). */
  readonly sheet: readonly [number, number];
}

export interface IsoSheet {
  readonly width: number;
  readonly height: number;
  readonly primitives: readonly IsoPrimitive[];
  readonly graph: IsoGraph;
  readonly layout: IsoLayout;
  readonly dimensions: readonly RunDimension[];
  readonly annotations: readonly SheetAnnotation[];
  readonly tables: readonly IsoTable[];
  readonly warnings: readonly IsoIssue[];
  readonly title: string;
}

const MAX_TABLE_ROWS = 30;
const CELL = 2.2;
const CHAR = 1.3;
const PAD = 16;

const text = (at: Vec2, size: number, content: string, anchor: 'start' | 'middle' | 'end' = 'start'): IsoPrimitive => ({
  t: 'text',
  layer: 'ISO-TEXT',
  at,
  size,
  text: content,
  anchor,
});
const rect = (x0: number, y0: number, x1: number, y1: number, layer: 'ISO-FRAME' | 'ISO-TABLE'): IsoPrimitive => ({
  t: 'poly',
  layer,
  points: [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ],
  closed: true,
});

/** Column widths (paper mm) of a table from its widest cell. */
const columnWidths = (table: IsoTable): number[] =>
  table.columns.map(
    (column, at) => Math.max(column.length, ...table.rows.slice(0, MAX_TABLE_ROWS).map((row) => (row[at] ?? '').length)) * CHAR + 2,
  );

function tablePrimitives(tables: readonly IsoTable[], left: number, top: number): IsoPrimitive[] {
  const out: IsoPrimitive[] = [];
  let y = top;
  for (const table of tables) {
    const widths = columnWidths(table);
    const total = widths.reduce((sum, width) => sum + width, 0);
    const shown = table.rows.slice(0, MAX_TABLE_ROWS);
    const more = table.rows.length - shown.length;
    out.push(text([left, y - 3], 2.8, table.title));
    y -= 5;
    const rows = [table.columns, ...shown];
    rows.forEach((row) => {
      let x = left;
      row.forEach((cell, column) => {
        out.push({ t: 'text', layer: 'ISO-TABLE', at: [x + 1, y - 3.2], size: CELL, text: cell, anchor: 'start' });
        x += widths[column] as number;
      });
      out.push({ t: 'line', layer: 'ISO-TABLE', a: [left, y - 4.4], b: [left + total, y - 4.4] });
      y -= 4.4;
    });
    if (more > 0) {
      out.push({
        t: 'text',
        layer: 'ISO-TABLE',
        at: [left + 1, y - 3.2],
        size: CELL,
        text: `... ${more} more row(s) in the data`,
        anchor: 'start',
      });
      y -= 4.4;
    }
    y -= 4;
  }
  return out;
}

function titleBlock(width: number, lines: ReadonlyArray<ReadonlyArray<readonly [string, string]>>): IsoPrimitive[] {
  const blockWidth = Math.min(180, width - 30);
  const x = width - 10 - blockWidth;
  const column = blockWidth / 3;
  const out: IsoPrimitive[] = [rect(x, 10, x + blockWidth, 52, 'ISO-FRAME')];
  lines.forEach((cells, row) => {
    const y = 52 - 14 * row;
    if (row > 0) out.push({ t: 'line', layer: 'ISO-FRAME', a: [x, y], b: [x + blockWidth, y] });
    cells.forEach(([label, value], at) => {
      out.push(text([x + at * column + 2, y - 3.5], 2, label), text([x + at * column + 2, y - 9], 3.2, value));
    });
  });
  for (const at of [1, 2]) out.push({ t: 'line', layer: 'ISO-FRAME', a: [x + at * column, 10], b: [x + at * column, 52] });
  return out;
}

export function buildIsoSheet(analysis: LineAnalysis, options: SheetOptions): IsoSheet {
  const network = analysis.read.network;
  const graph = buildIsoGraph(network, options.sheet?.include);
  const warnings: IsoIssue[] = [];
  const { tables, warnings: tableWarnings } = isoTables(
    analysis,
    options.tables,
    options.sheet === undefined ? undefined : { indices: options.sheet.indices, partial: options.sheet.partial },
  );
  warnings.push(...tableWarnings);
  const [width, height] = PAPER_MM[options.paper];
  const area = sheetDrawingArea(width, height);
  const bottom = height - (area.y + area.height);
  const top = height - area.y;
  const tableWidth = tables.length === 0 ? 0 : Math.max(...tables.map((table) => columnWidths(table).reduce((sum, w) => sum + w, 0))) + 6;
  const drawWidth = area.width - tableWidth;
  const layout = layoutIso(graph, options.northArrow, { width: drawWidth - 2 * PAD, height: area.height - 2 * PAD });
  const originX = area.x + PAD + (drawWidth - 2 * PAD - layout.bounds[2]) / 2;
  const originY = bottom + PAD + (area.height - 2 * PAD - layout.bounds[3]) / 2;
  const shift = (point: Vec2): Vec2 => [originX + point[0], originY + point[1]];
  if (layout.overflow)
    warnings.push(
      isoIssue(
        'ISO_SHEET_OVERFLOW',
        'warning',
        `${options.sheet === undefined ? 'the line' : `sheet ${options.sheet.index}`} does not fit one ${options.paper} sheet without shrinking to ${Math.round(layout.scale * 100)} %`,
        [analysis.lineId],
      ),
    );
  const primitives: IsoPrimitive[] = [];
  const drawn: Array<readonly [Vec2, Vec2]> = [];
  graph.steps.forEach((_step, index) => {
    const [a, b] = [shift(layout.starts[index] as Vec2), shift(layout.ends[index] as Vec2)];
    drawn.push([a, b]);
    primitives.push({ t: 'line', layer: 'ISO-PIPE', a, b });
  });
  for (const crossing of layout.crossings) {
    const [a, b] = [layout.starts[crossing.farther] as Vec2, layout.ends[crossing.farther] as Vec2];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const unit: Vec2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    primitives.push({
      t: 'line',
      layer: 'ISO-PIPE',
      a: shift([crossing.at[0] - unit[0] * 1.6, crossing.at[1] - unit[1] * 1.6]),
      b: shift([crossing.at[0] + unit[0] * 1.6, crossing.at[1] + unit[1] * 1.6]),
      gap: true,
    });
  }
  const shiftedLayout: IsoLayout = {
    ...layout,
    starts: layout.starts.map(shift),
    ends: layout.ends.map(shift),
    nodes: new Map([...layout.nodes].map(([key, point]) => [key, shift(point)])),
  };
  primitives.push(...isoSymbols({ network, graph, layout: shiftedLayout, joints: analysis.graph.joints, classes: analysis.classes }));
  const dimensions = runDimensions(graph);
  const dimensionLines = dimensionPrimitives(dimensions, layout, shift);
  primitives.push(...dimensionLines);
  const placer = new LabelPlacer([
    ...drawn,
    ...dimensionLines.flatMap((primitive): Array<readonly [Vec2, Vec2]> => (primitive.t === 'line' ? [[primitive.a, primitive.b]] : [])),
  ]);
  const annotations: SheetAnnotation[] = [];
  const at2d = (xyz: readonly [number, number, number]): Vec2 | undefined => shiftedLayout.nodes.get(nodeKey(xyz));
  const label = (annotation: IsoAnnotation, anchor: Vec2 | undefined): void => {
    if (anchor === undefined) return;
    const placed = placer.place(anchor, annotation.text);
    primitives.push(text(placed.at, TEXT_SIZE, annotation.text, placed.align));
    annotations.push({ ...annotation, sheet: [Number(anchor[0].toFixed(2)), Number(anchor[1].toFixed(2))] });
  };
  for (const annotation of lineAnnotations(graph)) {
    if (annotation.kind !== 'slope') {
      label(annotation, at2d(annotation.at));
      continue;
    }
    const from = at2d(annotation['fallFrom'] as [number, number, number]);
    const to = at2d(annotation['fallTo'] as [number, number, number]);
    if (from === undefined || to === undefined) continue;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    const u: Vec2 = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
    const n: Vec2 = [-u[1], u[0]];
    const middle: Vec2 = [(from[0] + to[0]) / 2 + n[0] * 3.5, (from[1] + to[1]) / 2 + n[1] * 3.5];
    const tip: Vec2 = [middle[0] + u[0] * 5, middle[1] + u[1] * 5];
    primitives.push(
      { t: 'line', layer: 'ISO-SYMB', a: [middle[0] - u[0] * 5, middle[1] - u[1] * 5], b: tip },
      { t: 'line', layer: 'ISO-SYMB', a: tip, b: [tip[0] - u[0] * 1.8 + n[0] * 0.9, tip[1] - u[1] * 1.8 + n[1] * 0.9] },
      { t: 'line', layer: 'ISO-SYMB', a: tip, b: [tip[0] - u[0] * 1.8 - n[0] * 0.9, tip[1] - u[1] * 1.8 - n[1] * 0.9] },
    );
    drawn.push([middle, tip]);
    placer.avoid([middle, tip]);
    label(annotation, [middle[0] + n[0] * 3, middle[1] + n[1] * 3]);
  }
  for (const entry of analysis.numbering.entries)
    label(
      {
        kind: 'weld',
        text: entry.record.number,
        at: entry.record.joint.xyz,
        weldKind: entry.record.kind,
        numbered: entry.status === 'kept',
      },
      at2d(entry.record.joint.xyz),
    );
  for (const spool of analysis.spools.spools) {
    const index = graph.steps.findIndex((step) => spool.memberIndices.includes(step.segment.componentIndex));
    const step = graph.steps[index];
    if (step === undefined) continue;
    const a = shift(layout.starts[index] as Vec2);
    const b = shift(layout.ends[index] as Vec2);
    label(
      {
        kind: 'spool',
        text: spool.name,
        at: [(step.start[0] + step.end[0]) / 2, (step.start[1] + step.end[1]) / 2, (step.start[2] + step.end[2]) / 2],
      },
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
    );
  }
  for (const mark of options.sheet?.continuation ?? []) {
    const anchor = at2d(mark.at);
    if (anchor === undefined) continue;
    primitives.push({ t: 'circle', layer: 'ISO-SYMB', c: anchor, r: 3.4 });
    label(
      {
        kind: 'continuation',
        text: `CONT. ${mark.sheet > (options.sheet?.index ?? 0) ? 'ON' : 'FROM'} SHEET ${mark.sheet} - ${mark.weld ?? 'FLANGE'}`,
        at: mark.at,
        sheetRef: mark.sheet,
        weld: mark.weld,
        joint: mark.joint,
        eastMm: mark.at[0],
        northMm: mark.at[1],
        elevationMm: mark.at[2],
      },
      anchor,
    );
  }
  const stamp =
    options.issue === undefined ? 'NOT FOR CONSTRUCTION' : `ISSUED ${options.issue.purpose.toUpperCase()} REV ${options.issue.revision}`;
  const note =
    options.issue === undefined
      ? 'REVIEW REQUIRED - isometric not to scale; dimensions in mm from the 3D centreline'
      : `APPROVED BY ${options.issue.signer} - isometric not to scale; dimensions in mm from the 3D centreline`;
  const angles = axisAngles(options.northArrow);
  const centre: Vec2 = [area.x + area.width - tableWidth - 12, top - 14];
  const direction: Vec2 = [Math.cos((angles.northArrow * Math.PI) / 180), Math.sin((angles.northArrow * Math.PI) / 180)];
  const tipOfArrow: Vec2 = [centre[0] + direction[0] * 8, centre[1] + direction[1] * 8];
  primitives.push(
    { t: 'circle', layer: 'ISO-FRAME', c: centre, r: 9 },
    { t: 'line', layer: 'ISO-FRAME', a: centre, b: tipOfArrow },
    {
      t: 'poly',
      layer: 'ISO-FRAME',
      points: [
        tipOfArrow,
        [tipOfArrow[0] - direction[0] * 3 - direction[1] * 1.2, tipOfArrow[1] - direction[1] * 3 + direction[0] * 1.2],
        [tipOfArrow[0] - direction[0] * 3 + direction[1] * 1.2, tipOfArrow[1] - direction[1] * 3 - direction[0] * 1.2],
      ],
      closed: true,
      fill: true,
    },
    text([tipOfArrow[0] + direction[0] * 3 - 1, tipOfArrow[1] + direction[1] * 3 - 1], 3, 'N'),
    rect(20, 10, width - 10, height - 10, 'ISO-FRAME'),
    text([area.x + 2, top - 6], 5, stamp),
    text([area.x + 2, top - 11], 2.6, note),
    ...tablePrimitives(tables, area.x + area.width - tableWidth + 3, top - 30),
    ...titleBlock(width, [
      [
        ['PROJECT', options.project],
        ['LINE', analysis.name],
        ['SPEC', network.attributes['PIPING-SPEC'] ?? '-'],
      ],
      [
        ['DRAWING', 'ISOMETRIC - NOT TO SCALE'],
        ['STYLE', options.style.toUpperCase()],
        ['REV', network.attributes['REVISION'] ?? '-'],
      ],
      [
        ['STATUS', options.issue === undefined ? 'NOT FOR CONSTRUCTION' : `ISSUED REV ${options.issue.revision}`],
        ['SHEET', `${options.sheet?.index ?? 1} OF ${options.sheet?.total ?? 1}`],
        ['PAPER', `${options.paper} ${mmText(layout.scale * 100)} % fit`],
      ],
    ]),
  );
  return {
    width,
    height,
    primitives,
    graph,
    layout,
    dimensions,
    annotations,
    tables,
    warnings,
    title: `${analysis.name} isometric${options.sheet === undefined ? '' : ` sheet ${options.sheet.index}`}`,
  };
}
