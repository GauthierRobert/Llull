import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { PipeLine } from '@aec/plant/types';
import { nextId } from '@lib/id';
import { getPiping, refuse, withPiping } from '../model';
import { pipeOutsideDiameter } from '../sizes';

/** 02 RTE §5.9 default template (one per document until `set_piping_settings`). */
export const LINE_NUMBER_TEMPLATE = '{dn}-{service}-{sequence}-{spec}[-{insulationCode}{insulationThickness}]';

/**
 * @affects creates 1 pipe line in plant.piping (no geometry)
 * @invariant lineNumber = explicit or the template; unique
 * @failure DN without a pipe row -> RTE_SPEC_NO_COMPONENT; line number used -> RTE_DUPLICATE_LINE_NUMBER
 */
export const createPipeline = defineCommand({
  name: 'create_pipeline',
  description:
    `Create a pipe line (the line-list record runs belong to): service, sequence, spec name, DN; line number from the template ${LINE_NUMBER_TEMPLATE} ` +
    'unless given. The spec is stored by name and reported unverified until the piping spec catalogue (01 PSC) is loaded. Insulation thickness ' +
    '(mm) widens the clearance envelope the auto-router keeps. Returns the line id (affected[0]); data.lineNumber. ' +
    'Refusals: RTE_SPEC_NO_COMPONENT (no pipe OD row for the DN), RTE_DUPLICATE_LINE_NUMBER. Next: add_tie_in_point, auto_route_pipe.',
  params: z.object({
    service: z.string().min(1).describe("Service code, e.g. 'P' (process), 'CW', 'HO'."),
    sequence: z.string().min(1).describe("Line sequence number, e.g. '1001'."),
    spec: z.string().min(1).describe("Piping spec name, e.g. 'CS150'."),
    dn: z.number().int().positive().describe('Nominal size DN of the line (e.g. 100).'),
    lineNumber: z.string().min(1).optional().describe('Explicit line number; default from the template.'),
    insulation: z
      .object({
        code: z.string().min(1).describe("Insulation code, e.g. 'H' (hot)."),
        thicknessMm: z.number().positive().describe('Insulation thickness, mm.'),
      })
      .optional()
      .describe('Insulation of the line (envelope OD + 2 x thickness).'),
    designPressureBarG: z.number().optional().describe('Design pressure, bar g.'),
    designTempC: z.number().optional().describe('Design temperature, °C.'),
    from: z.string().optional().describe('From tag text for the line list.'),
    to: z.string().optional().describe('To tag text for the line list.'),
  }),
  run: (doc, params): CommandResult => {
    const { service, sequence, spec, dn, insulation } = params;
    const piping = getPiping(doc);
    if (pipeOutsideDiameter(dn) === null)
      return refuse(doc, 'create_pipeline', 'RTE_SPEC_NO_COMPONENT', `no pipe row (outside diameter) for DN${dn}`, [], ['dn']);
    const suffix = insulation === undefined ? '' : `-${insulation.code}${insulation.thicknessMm}`;
    const lineNumber = params.lineNumber ?? `${dn}-${service}-${sequence}-${spec}${suffix}`;
    const clash = piping.lineOrder.find((id) => piping.lines[id]?.lineNumber === lineNumber);
    if (clash !== undefined)
      return refuse(
        doc,
        'create_pipeline',
        'RTE_DUPLICATE_LINE_NUMBER',
        `line number ${lineNumber} is used by ${clash}`,
        [clash],
        ['sequence'],
      );
    const id = nextId('line');
    const optional = <K extends 'designPressureBarG' | 'designTempC' | 'from' | 'to' | 'insulation'>(key: K): Partial<Pick<PipeLine, K>> =>
      params[key] === undefined ? {} : ({ [key]: params[key] } as Partial<Pick<PipeLine, K>>);
    const line: PipeLine = {
      id,
      lineNumber,
      service,
      sequence,
      spec,
      dn,
      ...optional('insulation'),
      ...optional('designPressureBarG'),
      ...optional('designTempC'),
      ...optional('from'),
      ...optional('to'),
    };
    const next = withPiping(doc, { ...piping, lines: { ...piping.lines, [id]: line }, lineOrder: [...piping.lineOrder, id] });
    const named = params.lineNumber === undefined ? ` (template ${LINE_NUMBER_TEMPLATE})` : '';
    return {
      ...changed(next, `create_pipeline: line ${id} ${lineNumber}${named}, DN${dn}, spec ${spec} (unresolved: unverified until 01 PSC).`, [
        id,
      ]),
      data: {
        lineId: id,
        lineNumber,
        template: { value: LINE_NUMBER_TEMPLATE, defaulted: params.lineNumber === undefined },
        unverified: true,
      },
    };
  },
});
