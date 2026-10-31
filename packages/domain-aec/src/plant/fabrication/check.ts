/**
 * The `check_isometric` rule table (plant 05 ISO §5.12, TR-ISO-14): one pass over a line that returns findings with stable codes, severities, ids and a one-line fix.
 * Rules: connectivity (unreachable components, connection points closer than 1 mm that do not coincide), open ends (imported and routed lines by connectivity, legacy
 * lines by their from / to), missing SKEY and item code, unnumbered welds (error for the final style), spool limits, short cut pieces (when the rules hold a weld
 * gap), dimension closure, unverified catalogue rows, legacy-derived fittings, sheet overflow, and the unissued-iso review notice. A line that cannot be read is
 * itself a finding. Pure.
 */

import type { CadDocument } from '@core/model/types';
import { sheetDrawingArea } from '@core/geometry/sheetLayout';
import { PAPER_MM, type PaperSize } from '@core/model/sheet';
import type { Vec3 } from '@core/model/vectors';
import { analyseLine, isAnalysis } from './analysis';
import { bomRows } from './bom';
import { isoIssue } from './codes';
import { cutPieces } from './cutList';
import { buildIsoGraph } from './iso/isoGraph';
import { runDimensions } from './iso/isoDimensions';
import { layoutIso } from './iso/isoLayout';
import { nodeKey } from './joints';
import type { IsoIssue } from './model';
import { missingSkeyIds } from './pcf/pcfMap';
import { violationsOf } from './spools';

export interface CheckIssue extends IsoIssue {
  readonly lineId: string;
}

export interface CheckOptions {
  readonly style: 'check' | 'final';
  readonly paper: PaperSize;
}

const CLOSED_END_TYPES = new Set(['FL', 'CP', 'PL']);
const CLOSING_TYPES = new Set(['CAP', 'FLANGE-BLIND']);
const NO_ITEM = new Set(['WELD', 'SUPPORT']);
const CONNECTED_WITHIN_MM = 1;
const PAD = 16;

interface Point {
  readonly xyz: Vec3;
  readonly key: string;
  readonly id: string;
}

/** Pairs of connection points closer than 1 mm whose 0.1 mm keys differ: ids of the two components of each pair. */
function nearMisses(points: readonly Point[]): string[][] {
  const sorted = [...points].sort((a, b) => a.xyz[0] - b.xyz[0] || a.xyz[1] - b.xyz[1] || a.xyz[2] - b.xyz[2]);
  const pairs: string[][] = [];
  sorted.forEach((first, at) => {
    for (let k = at + 1; k < sorted.length && (sorted[k] as Point).xyz[0] - first.xyz[0] < CONNECTED_WITHIN_MM; k++) {
      const other = sorted[k] as Point;
      const distance = Math.hypot(other.xyz[0] - first.xyz[0], other.xyz[1] - first.xyz[1], other.xyz[2] - first.xyz[2]);
      if (distance < CONNECTED_WITHIN_MM && other.key !== first.key && other.id !== first.id) pairs.push([first.id, other.id]);
    }
  });
  return pairs;
}

export function checkLine(doc: CadDocument, lineId: string, options: CheckOptions): CheckIssue[] {
  const analysis = analyseLine(doc, 'check_isometric', lineId);
  if (!isAnalysis(analysis)) {
    const error = analysis.error;
    return [
      { ...isoIssue(error?.code ?? 'ISO_LINE_NOT_FOUND', 'error', analysis.summary, error?.ids ?? [lineId], error?.paths ?? []), lineId },
    ];
  }
  const network = analysis.read.network;
  const components = network.components;
  const found: IsoIssue[] = [];
  const add = (
    code: string,
    severity: IsoIssue['severity'],
    message: string,
    ids: readonly string[],
    paths: readonly string[] = [],
  ): void => {
    found.push(isoIssue(code, severity, message, ids, paths));
  };
  found.push(...network.warnings);
  if (analysis.read.staleWelds.length > 0)
    add(
      'ISO_FIELD_WELD_STALE',
      'warning',
      `${analysis.read.staleWelds.length} field weld(s) lie on no pipe any more`,
      analysis.read.staleWelds,
    );

  const graph = buildIsoGraph(network);
  if (graph.groups > 1)
    add('ISO_DISCONNECTED', 'error', `${graph.unreachable.length} component(s) are not connected to the line start`, graph.unreachable);
  const points: Point[] = components
    .filter((component) => !['WELD', 'GASKET', 'BOLT', 'SUPPORT'].includes(component.type))
    .flatMap((component) =>
      [...component.ends, ...(component.branch === undefined ? [] : [component.branch])].map((end) => ({
        xyz: end.xyz,
        key: nodeKey(end.xyz),
        id: component.id,
      })),
    );
  for (const pair of nearMisses(points))
    add('ISO_DISCONNECTED', 'error', `connection points of ${pair.join(' and ')} are closer than 1 mm but do not coincide`, pair);

  if (network.source !== 'legacy') {
    const open = analysis.graph.terminals.filter((terminal) => {
      const component = components[terminal.componentIndex];
      return !(
        (terminal.endType !== undefined && CLOSED_END_TYPES.has(terminal.endType)) ||
        (component !== undefined && CLOSING_TYPES.has(component.type))
      );
    });
    if (open.length > 0)
      add(
        'ISO_OPEN_END',
        'warning',
        `${open.length} line end(s) have no end flange, cap or plug: ${open.map((terminal) => terminal.xyz.join(' ')).join('; ')}`,
        [...new Set(open.map((terminal) => components[terminal.componentIndex]?.id ?? ''))],
      );
  }

  const noKey = missingSkeyIds(components);
  if (noKey.length > 0) add('ISO_SKEY_MISSING', 'error', `${noKey.length} component(s) have no isometric key (SKEY)`, noKey);
  const noItem = bomRows(components, () => true).withoutItemCode.filter((id) => {
    const component = components.find((candidate) => candidate.id === id);
    return component !== undefined && !NO_ITEM.has(component.type);
  });
  if (noItem.length > 0) add('ISO_ITEM_CODE_MISSING', 'warning', `${noItem.length} component(s) have no item code`, noItem);

  const unnumbered = analysis.numbering.entries.filter((entry) => entry.status === 'assigned');
  if (unnumbered.length > 0)
    add(
      'ISO_WELDS_UNNUMBERED',
      options.style === 'final' ? 'error' : 'warning',
      `${unnumbered.length} weld(s) have no stored number`,
      unnumbered.map((entry) => entry.record.number),
    );

  const rules = analysis.fabrication.rules;
  for (const spool of analysis.spools.spools)
    for (const violation of violationsOf(spool, rules?.maxSpool)) add(violation.code, 'error', violation.message, [spool.name]);

  if (
    rules?.weldGapMm !== undefined &&
    !([...analysis.classes.values()].some((kind) => kind === 'field_fit') && rules.fieldFitAllowanceMm === undefined)
  ) {
    const limit = Math.max(0, rules.minCutPieceMm?.value ?? 0);
    const short = cutPieces(analysis, rules.weldGapMm.value, rules.fieldFitAllowanceMm?.value ?? 0).filter(
      (piece) => piece.cutLengthMm <= limit,
    );
    if (short.length > 0)
      add(
        'ISO_CUT_LENGTH_SHORT',
        'error',
        `${short.length} cut piece(s) are not longer than ${limit} mm: ${short.map((piece) => `${piece.piece} ${piece.cutLengthMm} mm`).join(', ')}`,
        short.map((piece) => piece.componentId),
      );
  }

  const unclosed = runDimensions(graph).filter((dimension) => dimension.mismatches > 0);
  if (unclosed.length > 0)
    add(
      'ISO_DIMENSION_MISMATCH',
      'error',
      `${unclosed.length} dimension string(s) do not close to their overall`,
      unclosed.map((dimension) => `run ${dimension.run}`),
    );

  const unverified = components.filter((component) => component.unverified === true).map((component) => component.id);
  if (unverified.length > 0)
    add('ISO_UNVERIFIED_CATALOGUE', 'warning', `${unverified.length} component(s) use a catalogue row that is not verified`, unverified);

  if (graph.steps.length > 0) {
    const [width, height] = PAPER_MM[options.paper];
    const area = sheetDrawingArea(width, height);
    if (layoutIso(graph, 'up_right', { width: area.width - 2 * PAD, height: area.height - 2 * PAD }).overflow)
      add('ISO_SHEET_OVERFLOW', 'warning', `the line does not fit one ${options.paper} sheet`, [lineId]);
  }
  add('ISO_REVIEW_REQUIRED', 'info', `isometric of ${lineId} is not issued: reviewRequired`, [lineId]);
  return found.map((issue) => ({ ...issue, lineId }));
}
