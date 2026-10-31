/** One line read, connected, numbered (provisionally) and split into spools: what every fabrication query (weld_list, spool_list, cut_list, piping_bom) works on. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { buildLineGraph, type JointClass, type LineGraph } from './joints';
import { isLineRead, loadLine, type LineRead } from './lineNetwork';
import type { FabricationModel, SpoolBreak } from './model';
import { getFabrication } from './state';
import { ALL_BREAKS, buildSpools, type SpoolPlan } from './spools';
import { baseHighest, planNumbering, storedWelds, type NumberingPlan } from './welds';

export interface LineAnalysis {
  readonly lineId: string;
  /** The line number shown to people (PIPELINE-REFERENCE); equals `lineId` except for a routed line addressed by id. */
  readonly name: string;
  readonly read: LineRead;
  readonly graph: LineGraph;
  readonly numbering: NumberingPlan;
  /** Joint class by node key, with the `set_weld_type` overrides applied. */
  readonly classes: ReadonlyMap<string, JointClass>;
  readonly breakAt: readonly SpoolBreak[];
  readonly spools: SpoolPlan;
  readonly fabrication: FabricationModel;
}

export function analyseLine(
  doc: CadDocument,
  command: string,
  lineId: string,
  options: { readonly breakAt?: readonly SpoolBreak[]; readonly renumber?: boolean } = {},
): LineAnalysis | CommandResult {
  const read = loadLine(doc, command, lineId);
  if (!isLineRead(read)) return read;
  const fabrication = getFabrication(doc);
  const graph = buildLineGraph(read.network);
  const numbering = planNumbering({
    lineId,
    network: read.network,
    graph,
    stored: storedWelds(fabrication, lineId),
    rules: fabrication.rules,
    startHighest: baseHighest(fabrication, lineId, read.network),
    renumber: options.renumber === true,
  });
  const classes = new Map<string, JointClass>(graph.joints.map((joint) => [joint.key, joint.joint]));
  for (const entry of numbering.entries) classes.set(entry.joint.key, entry.record.kind);
  const breakAt = options.breakAt ?? fabrication.spoolBreaks?.[lineId] ?? ALL_BREAKS;
  const spools = buildSpools({
    network: read.network,
    graph,
    classes,
    breakAt,
    prefix: fabrication.rules?.spoolPrefix ?? read.network.lineId,
  });
  return { lineId, name: read.network.lineId, read, graph, numbering, classes, breakAt, spools, fabrication };
}

export const isAnalysis = (value: LineAnalysis | CommandResult): value is LineAnalysis => 'numbering' in value && 'spools' in value;
