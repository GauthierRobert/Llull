import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { PipeLine } from '@aec/plant/types';
import { nextId } from '@lib/id';
import { getPiping, refuse, withPiping } from '../model';
import { createSpecLookup, isMiss } from '../specLookup';

/** 02 RTE §5.9 default template (one per document until `set_piping_settings`). */
export const LINE_NUMBER_TEMPLATE = '{dn}-{service}-{sequence}-{spec}[-{insulationCode}{insulationThickness}]';

/**
 * @affects creates 1 pipe line in plant.piping (no geometry)
 * @invariant lineNumber = explicit or the template; unique
 * @invariant the spec is resolved now (newest revision, its catalogues loaded); every later derivation re-reads it
 * @failure spec not loaded -> RTE_SPEC_UNKNOWN; DN without a pipe row -> RTE_SPEC_NO_COMPONENT; line number used -> RTE_DUPLICATE_LINE_NUMBER
 */
export const createPipeline = defineCommand({
  name: 'create_pipeline',
  description:
    `Create a pipe line (the line-list record runs belong to): service, sequence, spec name, DN; line number from the template ${LINE_NUMBER_TEMPLATE} ` +
    'unless given. The spec must already be in the document (import_pipe_spec, with the catalogues it names via import_piping_catalog); its pipe row ' +
    'for the DN gives the OD and wall. Insulation thickness (mm) widens the clearance envelope the auto-router keeps. Returns the line id ' +
    '(affected[0]); data = { lineId, lineNumber, template, spec: { id, revision, status }, pipe: { outsideDiameterMm, wallMm }, unverified }. ' +
    'Refusals: RTE_SPEC_UNKNOWN (spec or a catalogue it names not loaded), RTE_SPEC_NO_COMPONENT (no pipe row for the DN), RTE_DUPLICATE_LINE_NUMBER. ' +
    'Next: add_tie_in_point (or add_nozzle on equipment), then route_pipe (compass legs) or auto_route_pipe.',
  params: z.object({
    service: z.string().min(1).describe("Service code, e.g. 'P' (process), 'CW', 'HO'."),
    sequence: z.string().min(1).describe("Line sequence number, e.g. '1001'."),
    spec: z.string().min(1).describe("Id of a piping spec already in the document (list_pipe_specs), e.g. 'CS150'."),
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
    const lookup = createSpecLookup(doc, spec);
    if (isMiss(lookup)) return refuse(doc, 'create_pipeline', lookup.miss, lookup.detail, [...lookup.ids], ['spec']);
    const pipe = lookup.pipe(dn);
    if (isMiss(pipe)) return refuse(doc, 'create_pipeline', pipe.miss, pipe.detail, [...pipe.ids], ['dn']);
    const unverified = lookup.status() !== 'approved' || pipe.unverified;
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
      ...changed(
        next,
        `create_pipeline: line ${id} ${lineNumber}${named}, DN${dn}, spec ${lookup.id} r${lookup.revision} ${lookup.status()}, OD ${pipe.dims['outsideDiameter']} mm${unverified ? '; unverified' : ''}.`,
        [id],
      ),
      data: {
        lineId: id,
        lineNumber,
        template: { value: LINE_NUMBER_TEMPLATE, defaulted: params.lineNumber === undefined },
        spec: { id: lookup.id, revision: lookup.revision, status: lookup.status() },
        pipe: { key: pipe.key, outsideDiameterMm: pipe.dims['outsideDiameter'], wallMm: pipe.dims['wall'] },
        unverified,
      },
    };
  },
});
