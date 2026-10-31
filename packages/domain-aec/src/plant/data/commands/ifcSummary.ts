import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { summariseIfc } from '../ifcRead/summary';
import { refuse } from './params';

/**
 * @affects none; data = { schema, entityCount, counts, predefinedTypes, systems, ports, connections, physicalConnections, openPorts, duplicateTags, errors }
 * @invariant read-only and linear in the entities; the file is data (nothing is imported or executed); a damaged record is listed in errors, not fatal
 * @failure text that is not a STEP file, a FILE_SCHEMA outside the IFC family, no entity -> DAT_IFC_PARSE, document unchanged
 */
export const ifcSummary = defineCommand({
  name: 'ifc_summary',
  description:
    'Summarise an IFC file (IFC2X3, IFC4 or IFC4X3_ADD2 text, e.g. a contractor model) WITHOUT importing it (pure, document unchanged). ifc is the file text (CLI: file=<path>). Returns data = ' +
    '{ schema, entityCount, counts { IfcPipeSegment: n, ... } (all classes present; a class without a known proper name keeps its STEP upper-case name), predefinedTypes ' +
    '{ "IfcPipeFitting.BEND": n, "IfcPipeSegment.None": n } (IFC4 and later, distribution elements, systems and ports), systems [{ name, predefinedType, members, globalId }] (members ' +
    'assigned through IfcRelAssignsToGroup), ports, portsNestedInElements, connections (IfcRelConnectsPorts relationships), physicalConnections (distinct unordered port pairs: ' +
    'a file with two reciprocal relationships per connection reports the same number as one with a single relationship), connectedPorts, openPorts, duplicateTags (products ' +
    'sharing a Tag), errors (structure problems, at most 20) }. Refusal: DAT_IFC_PARSE (not an IFC STEP file). Next: check_ifc_requirements.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({ ifc: z.string().describe('The text of the IFC file (ISO 10303-21). With the CLI send file=<path>.') }),
  run: (doc, params): CommandResult => {
    const outcome = summariseIfc(params.ifc);
    if (!outcome.ok) return refuse(doc, 'ifc_summary', { code: 'DAT_IFC_PARSE', message: outcome.message, paths: ['ifc'] });
    const { summary } = outcome;
    const total = Object.values(summary.counts).reduce((sum, n) => sum + n, 0);
    return report(
      doc,
      `ifc_summary: ${summary.schema}, ${summary.entityCount} entities (${total} counted), ${summary.systems.length} system(s), ${summary.ports} port(s), ${summary.physicalConnections} physical connection(s), ${summary.openPorts} open port(s)${summary.errors.length === 0 ? '' : `, ${summary.errors.length} structure error(s)`}.`,
      summary,
    );
  },
});
