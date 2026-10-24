import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { PipeLine } from '@aec/plant/types';
import { nextId } from '@lib/id';
import { envelopeDiameter, resolveInsulation } from '../insulation';
import { lineNumberTemplate, parseLineNumber, renderLineNumber } from '../lineNumber';
import { getPiping, refuse, withPiping } from '../model';
import { createSpecLookup, isMiss } from '../specLookup';
import { insulationInput, lineSlopeInput, slopeProblem } from './lineInput';

/**
 * @affects creates 1 pipe line in plant.piping (no geometry)
 * @invariant lineNumber = explicit or the document's template (`set_piping_settings`, default DN-service-sequence-spec[-insulation]); unique
 * @invariant the spec is resolved now (newest revision, its catalogues loaded); every later derivation re-reads it; insulation "fromSpec" is read from
 *   the spec table once and stored with the row that gave it
 * @failure spec not loaded -> RTE_SPEC_UNKNOWN; DN without a pipe row, or no insulation table row -> RTE_SPEC_NO_COMPONENT; line number used ->
 *   RTE_DUPLICATE_LINE_NUMBER; unusable slope -> RTE_SLOPE_INVALID
 */
export const createPipeline = defineCommand({
  name: 'create_pipeline',
  description:
    'Create a pipe line (the line-list record runs belong to): service, sequence, spec name, DN; line number from the document template ' +
    '(default {dn}-{service}-{sequence}-{spec}[-{insulationCode}{insulationThickness}], change it with set_piping_settings) unless given. The spec must ' +
    'already be in the document (import_pipe_spec, with the catalogues it names via import_piping_catalog); its pipe row for the DN gives the OD and wall. ' +
    'insulation { code, thickness (mm or "fromSpec"), material? }: "fromSpec" reads the spec insulation table by code, DN and designTempC (the row ' +
    'is named in data.insulation); the envelope (OD + 2 x thickness, data.envelopeDiameterMm) is what check_clashes and the auto-router keep clear. ' +
    'slope { value, unit, fall } declares a gravity line: check_piping then reports legs rising against it (RTE_ADVERSE_SLOPE) and low / high points ' +
    'without drain / vent (RTE_POCKET). Returns the line id (affected[0]); data = { lineId, lineNumber, template { value, defaulted, applied }, ' +
    'lineNumberParse (explicit number only: how the template reads it, differences are reported, never corrected), spec: { id, revision, status }, ' +
    'pipe: { outsideDiameterMm, wallMm }, insulation, envelopeDiameterMm, slope, unverified }. Refusals: RTE_SPEC_UNKNOWN (spec or a catalogue it ' +
    'names not loaded), RTE_SPEC_NO_COMPONENT (no pipe row for the DN, no insulation row), RTE_DUPLICATE_LINE_NUMBER, RTE_SLOPE_INVALID. ' +
    'Next: add_tie_in_point (or add_nozzle on equipment), then route_pipe (compass legs) or auto_route_pipe.',
  params: z.object({
    service: z.string().min(1).describe("Service code, e.g. 'P' (process), 'CW', 'HO'."),
    sequence: z.string().min(1).describe("Line sequence number, e.g. '1001'."),
    spec: z.string().min(1).describe("Id of a piping spec already in the document (list_pipe_specs), e.g. 'CS150'."),
    dn: z.number().int().positive().describe('Nominal size DN of the line (e.g. 100).'),
    lineNumber: z.string().min(1).optional().describe('Explicit line number; default from the template.'),
    insulation: insulationInput.optional().describe('Insulation of the line (envelope OD + 2 x thickness).'),
    slope: lineSlopeInput.optional(),
    designPressureBarG: z.number().optional().describe('Design pressure, bar g.'),
    designTempC: z.number().optional().describe('Design temperature, °C (picks the insulation table row for "fromSpec").'),
    from: z.string().optional().describe('From tag text for the line list.'),
    to: z.string().optional().describe('To tag text for the line list.'),
  }),
  run: (doc, params): CommandResult => {
    const { service, sequence, spec, dn } = params;
    const piping = getPiping(doc);
    const lookup = createSpecLookup(doc, spec);
    if (isMiss(lookup)) return refuse(doc, 'create_pipeline', lookup.miss, lookup.detail, [...lookup.ids], ['spec']);
    const pipe = lookup.pipe(dn);
    if (isMiss(pipe)) return refuse(doc, 'create_pipeline', pipe.miss, pipe.detail, [...pipe.ids], ['dn']);
    if (params.slope !== undefined) {
      const problem = slopeProblem(params.slope);
      if (problem !== null) return refuse(doc, 'create_pipeline', 'RTE_SLOPE_INVALID', problem, [], ['slope']);
    }
    const resolved = params.insulation === undefined ? undefined : resolveInsulation(lookup, dn, params.designTempC, params.insulation);
    if (resolved !== undefined && isMiss(resolved))
      return refuse(doc, 'create_pipeline', resolved.miss, resolved.detail, [...resolved.ids], [...resolved.paths]);
    const insulation = resolved === undefined || isMiss(resolved) ? undefined : resolved;
    const unverified = lookup.status() !== 'approved' || pipe.unverified;
    const template = lineNumberTemplate(piping);
    const fields = { dn, service, sequence, spec, insulation };
    const lineNumber = params.lineNumber ?? renderLineNumber(template.value, fields);
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
    const line: PipeLine = {
      id,
      lineNumber,
      service,
      sequence,
      spec,
      dn,
      ...(insulation === undefined ? {} : { insulation }),
      ...(params.slope === undefined ? {} : { slope: params.slope }),
      ...(params.designPressureBarG === undefined ? {} : { designPressureBarG: params.designPressureBarG }),
      ...(params.designTempC === undefined ? {} : { designTempC: params.designTempC }),
      ...(params.from === undefined ? {} : { from: params.from }),
      ...(params.to === undefined ? {} : { to: params.to }),
    };
    const next = withPiping(doc, { ...piping, lines: { ...piping.lines, [id]: line }, lineOrder: [...piping.lineOrder, id] });
    const outsideDiameter = pipe.dims['outsideDiameter'];
    const envelope = insulation === undefined || outsideDiameter === undefined ? null : envelopeDiameter(outsideDiameter, insulation);
    const insulationText =
      insulation === undefined
        ? ''
        : `, insulation ${insulation.code} ${insulation.thicknessMm} mm (${insulation.source === 'spec' ? `spec table row ${insulation.row}` : 'explicit'}), envelope ${envelope} mm`;
    return {
      ...changed(
        next,
        `create_pipeline: line ${id} ${lineNumber}${params.lineNumber === undefined ? ` (template ${template.value}${template.defaulted ? ', default' : ''})` : ''}, ` +
          `DN${dn}, spec ${lookup.id} r${lookup.revision} ${lookup.status()}, OD ${outsideDiameter} mm${insulationText}${unverified ? '; unverified' : ''}.`,
        [id],
      ),
      data: {
        lineId: id,
        lineNumber,
        template: { value: template.value, defaulted: template.defaulted, applied: params.lineNumber === undefined },
        ...(params.lineNumber === undefined ? {} : { lineNumberParse: parseLineNumber(template.value, lineNumber, fields) }),
        spec: { id: lookup.id, revision: lookup.revision, status: lookup.status() },
        pipe: { key: pipe.key, outsideDiameterMm: outsideDiameter, wallMm: pipe.dims['wall'] },
        insulation: insulation ?? null,
        envelopeDiameterMm: envelope,
        slope: line.slope ?? null,
        unverified,
      },
    };
  },
});
