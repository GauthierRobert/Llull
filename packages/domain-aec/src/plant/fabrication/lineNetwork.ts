/**
 * The network of one pipe line whatever its source (routed, imported PCF, legacy pipe), with the field welds of the fabrication slice applied (plant 05 ISO §3).
 * Every fabrication query (welds, spools, cut list, BOM) reads a line through `loadLine`.
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { selectRuns } from '../piping/graph';
import { getPiping, refuse } from '../piping/model';
import { refuseIso } from './codes';
import { splitComponents } from './fieldWelds';
import { legacyLines, legacyNetwork } from './legacyNetwork';
import type { FieldWeldRecord, PipingNetwork } from './model';
import { networkOf } from './pcf/pcfMap';
import { routeNetwork } from './routeNetwork';
import { getFabrication } from './state';

export interface LineRead {
  readonly ok: true;
  /** The id the line is addressed by (routed line id, PCF line number, legacy line number). */
  readonly lineId: string;
  readonly network: PipingNetwork;
  /** Field welds applied to the network, by weld id the pipe pieces they produced. */
  readonly pieces: Readonly<Record<string, readonly [string, string]>>;
  readonly staleWelds: readonly string[];
}

export const fieldWeldsOf = (doc: CadDocument, lineId: string): FieldWeldRecord[] =>
  Object.values(getFabrication(doc).fieldWelds ?? {})
    .filter((weld) => weld.lineId === lineId)
    .sort((a, b) => a.id.localeCompare(b.id));

/** Every line id with piping, in a fixed order: routed lines (with a run), imported lines (sorted), legacy lines. */
export function allLineIds(doc: CadDocument): string[] {
  const piping = getPiping(doc);
  const routed = piping.lineOrder.filter((id) => piping.runOrder.some((runId) => piping.runs[runId]?.lineId === id));
  return [...routed, ...Object.keys(getFabrication(doc).pcfLines).sort(), ...legacyLines(doc).keys()];
}

/** The line's network with its field welds, or a coded refusal of `command`. */
export function loadLine(doc: CadDocument, command: string, lineId: string): LineRead | CommandResult {
  const piping = getPiping(doc);
  const stored = getFabrication(doc).pcfLines[lineId];
  let network: PipingNetwork | null = null;
  const routed = piping.lines[lineId];
  if (routed !== undefined) {
    if (!piping.runOrder.some((runId) => piping.runs[runId]?.lineId === lineId))
      return refuseIso(doc, command, 'ISO_NO_PIPING', `no routed run on line ${lineId}: route_pipe first`, [lineId], ['lineId']);
    const selection = selectRuns(doc, [lineId]);
    const broken = selection.broken.find((entry) => piping.runs[entry.runId]?.lineId === lineId);
    if (broken !== undefined)
      return refuse(
        doc,
        command,
        broken.failure.code,
        `run ${broken.runId} does not derive: ${broken.failure.message}`,
        [broken.runId, ...broken.failure.ids],
        [...broken.failure.paths],
        broken.failure.detail,
      );
    network = routeNetwork({
      line: routed,
      runs: selection.graphRuns.filter((run) => run.lineId === lineId),
      project: doc.building?.project.name,
    }).network;
  } else if (stored !== undefined) network = networkOf(stored);
  else network = legacyNetwork(doc, lineId);
  if (network === null) return refuseIso(doc, command, 'ISO_LINE_NOT_FOUND', `no pipe line "${lineId}"`, [lineId], ['lineId']);
  const error = network.warnings.find((warning) => warning.severity === 'error');
  if (error !== undefined) return refuseIso(doc, command, error.code, error.message, error.ids, error.paths);
  const split = splitComponents(network.components, fieldWeldsOf(doc, lineId));
  return { ok: true, lineId, network: { ...network, components: split.components }, pieces: split.pieces, staleWelds: split.stale };
}

export const isLineRead = (value: LineRead | CommandResult): value is LineRead => 'network' in value && 'staleWelds' in value;
