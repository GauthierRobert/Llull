import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, noop } from '@core/commands/noop';
import type { PipeLine } from '@aec/plant/types';
import { getPiping, refuse, withPiping } from '../model';
import { refuseDerivation, rederive } from '../runUpdate';
import { createSpecLookup, isMiss } from '../specLookup';
import { templateLineNumber } from './pipeline';

/**
 * @affects changes 1 pipe line (plant.piping) and re-derives every run of it (a new spec re-selects every part)
 * @invariant a line number that followed the template follows it again after a service / sequence / spec / insulation change, an explicit one is
 *   kept unless lineNumber is given; the size (dn) never changes; atomic: when the new spec cannot build a run, nothing changes
 * @failure unknown line -> RTE_UNKNOWN_LINE; unknown spec -> RTE_SPEC_UNKNOWN; line number used -> RTE_DUPLICATE_LINE_NUMBER; the new spec lacks a
 *   part a run needs -> that run's RTE_* code (RTE_SPEC_NO_COMPONENT, RTE_NO_FITTING_FOR_ANGLE, RTE_SEGMENT_TOO_SHORT ...)
 */
export const updatePipeline = defineCommand({
  name: 'update_pipeline',
  description:
    'Change a pipe line (create_pipeline) and re-derive its runs: service, sequence, spec, line number, design conditions, insulation, from / to text. ' +
    'A new spec re-selects every part of the line (elbows, flanges, gaskets, valves, tees) from that spec and its catalogues, and the cut lengths follow; ' +
    'the change is refused whole (nothing changes) when the new spec cannot build one of the runs (missing component, bend angle, leg too short, ' +
    'rating or size of a port). A line number that followed the template DN-service-sequence-spec[-insulation] follows it again; an explicit line ' +
    'number is kept unless you pass lineNumber. The size (dn) cannot change: create another line. Omitted fields stay; from / to "" clear the text; ' +
    'insulation null clears the insulation. Returns the line id (affected[0]); data = { lineId, lineNumber, changed (field names), specChanged, ' +
    'rederivedRuns, unverified }. Refusals: RTE_UNKNOWN_LINE, RTE_SPEC_UNKNOWN, RTE_SPEC_NO_COMPONENT (no pipe row for the dn), ' +
    'RTE_DUPLICATE_LINE_NUMBER, and the RTE_* code of the first run that no longer derives. Next: check_piping, piping_takeoff.',
  params: z.object({
    lineId: z.string().describe('Pipe line id (affected[0] of create_pipeline).'),
    service: z.string().min(1).optional().describe("New service code, e.g. 'CW'."),
    sequence: z.string().min(1).optional().describe("New line sequence number, e.g. '1002'."),
    spec: z.string().min(1).optional().describe("Id of another piping spec already in the document (list_pipe_specs), e.g. 'CS300'."),
    lineNumber: z
      .string()
      .min(1)
      .optional()
      .describe('Explicit line number (unique); otherwise the template when the old number followed it.'),
    designPressureBarG: z.number().optional().describe('Design pressure, bar g.'),
    designTempC: z.number().optional().describe('Design temperature, degC.'),
    insulation: z
      .object({
        code: z.string().min(1).describe("Insulation code, e.g. 'H'."),
        thicknessMm: z.number().positive().describe('Thickness, mm.'),
      })
      .nullable()
      .optional()
      .describe('New insulation; null removes it.'),
    from: z.string().optional().describe('From tag text for the line list; "" clears it.'),
    to: z.string().optional().describe('To tag text for the line list; "" clears it.'),
  }),
  run: (doc, params): CommandResult => {
    const piping = getPiping(doc);
    const line = piping.lines[params.lineId];
    if (line === undefined) return refuse(doc, 'update_pipeline', 'RTE_UNKNOWN_LINE', `no pipe line "${params.lineId}"`, [], ['lineId']);
    const { lineNumber: explicitNumber, insulation, from, to } = params;
    const followedTemplate = line.lineNumber === templateLineNumber(line);
    const nextInsulation = insulation === undefined ? line.insulation : (insulation ?? undefined);
    const nextFrom = from === undefined ? line.from : from === '' ? undefined : from;
    const nextTo = to === undefined ? line.to : to === '' ? undefined : to;
    const pressure = params.designPressureBarG ?? line.designPressureBarG;
    const temperature = params.designTempC ?? line.designTempC;
    const next: PipeLine = {
      id: line.id,
      lineNumber: line.lineNumber,
      service: params.service ?? line.service,
      sequence: params.sequence ?? line.sequence,
      spec: params.spec ?? line.spec,
      dn: line.dn,
      ...(nextInsulation === undefined ? {} : { insulation: nextInsulation }),
      ...(pressure === undefined ? {} : { designPressureBarG: pressure }),
      ...(temperature === undefined ? {} : { designTempC: temperature }),
      ...(nextFrom === undefined ? {} : { from: nextFrom }),
      ...(nextTo === undefined ? {} : { to: nextTo }),
    };
    const lineNumber = explicitNumber ?? (followedTemplate ? templateLineNumber(next) : line.lineNumber);
    const updated: PipeLine = { ...next, lineNumber };
    const changedFields = (Object.keys({ ...line, ...updated }) as Array<keyof PipeLine>).filter(
      (key) => JSON.stringify(line[key]) !== JSON.stringify(updated[key]),
    );
    if (changedFields.length === 0) return noop(doc, `update_pipeline: line ${line.id} already has these values; no-op.`);
    const clash = piping.lineOrder.find((id) => id !== line.id && piping.lines[id]?.lineNumber === lineNumber);
    if (clash !== undefined)
      return refuse(
        doc,
        'update_pipeline',
        'RTE_DUPLICATE_LINE_NUMBER',
        `line number ${lineNumber} is used by ${clash}`,
        [clash],
        ['lineNumber'],
      );
    const lookup = createSpecLookup(doc, updated.spec);
    if (isMiss(lookup)) return refuse(doc, 'update_pipeline', lookup.miss, lookup.detail, [...lookup.ids], ['spec']);
    const pipe = lookup.pipe(updated.dn);
    if (isMiss(pipe)) return refuse(doc, 'update_pipeline', pipe.miss, pipe.detail, [...pipe.ids], ['spec']);
    const stored = withPiping(doc, { ...piping, lines: { ...piping.lines, [line.id]: updated } });
    const runIds = piping.runOrder.filter((id) => piping.runs[id]?.lineId === line.id);
    const result = runIds.length === 0 ? null : rederive(stored, runIds);
    if (result !== null && !result.ok) return refuseDerivation(doc, 'update_pipeline', result, result.runId);
    const unverified =
      result === null
        ? lookup.status() !== 'approved' || pipe.unverified
        : Object.values(result.derivations).some((derived) => derived.unverified);
    return {
      ...changed(
        result === null ? stored : result.document,
        `update_pipeline: line ${line.id} ${lineNumber}: changed ${changedFields.join(', ')}${changedFields.includes('spec') ? ` (spec ${line.spec} -> ${updated.spec})` : ''}; ` +
          `${runIds.length} run(s) re-derived${unverified ? '; unverified' : ''}.`,
        [line.id, ...(result === null ? [] : result.runIds)],
      ),
      data: {
        lineId: line.id,
        lineNumber,
        changed: changedFields,
        specChanged: line.spec !== updated.spec,
        rederivedRuns: result === null ? [] : result.runIds,
        unverified,
      },
    };
  },
});
