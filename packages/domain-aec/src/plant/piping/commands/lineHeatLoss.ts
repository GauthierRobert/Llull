import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { heatLossPerMetre } from '../heatLoss';
import { getPiping, refuse } from '../model';
import { createSpecLookup, isMiss } from '../specLookup';
import { heatLossBase, heatLossProvenance, inputIssue, insulationConductivity, routedLength, tracingOf } from './lineHeatLossPhases';

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant steady state per metre through the inside film (when given), the steel wall, the insulation of the line and the outside film; every input
 *   that was not given and was defaulted is named in data.defaults; reviewRequired is always true (a screening value, not a thermal design)
 * @failure unknown line -> RTE_UNKNOWN_LINE; spec without the pipe row / the insulation conductivity unknown -> RTE_SPEC_NO_COMPONENT; zero or negative film,
 *   conductivity or a wall that leaves no bore -> RTE_HEAT_LOSS_INPUT
 */
export const lineHeatLoss = defineCommand({
  name: 'line_heat_loss',
  description:
    'Query: steady-state heat loss per metre of a pipe line (create_pipeline) through its steel wall and its insulation (set by create_pipeline / update_pipeline insulation) to the ambient, ' +
    "Q' = (Ti - Ta) / [ 1/(hi pi D0) + ln(D1/D0)/(2 pi ks) + ln(D2/D1)/(2 pi kins) + 1/(ho pi D2) ] (Incropera; ISO 12241), with D0 the bore, D1 the outside diameter from the " +
    'spec pipe row at the line DN, D2 = D1 + 2 x insulation thickness (D2 = D1 for a bare line). Give the fluid and ambient temperatures (degC), the outside film coefficient (W/m2K) and the steel ' +
    'conductivity (W/mK); the inside film is neglected when insideFilmWm2K is omitted; the insulation conductivity is read from the spec insulation table row when omitted. Returns data = ' +
    '{ heatLossWPerM (positive = the line loses heat), surfaceTempC (outer surface), steelOuterTempC, resistances (K m/W), diametersMm, lengthM and totalHeatLossW over the routed runs of the line ' +
    'that derive, tracing (when set_heat_tracing recorded a maintain temperature: the heat loss at that temperature, i.e. the heat the tracing must supply), defaults (each input that was not given and what was assumed), ' +
    'provenance, reviewRequired: true }. Optional refinements: outsideEmissivity adds radiation to the ambient (outsideFilmWm2K is then the CONVECTION coefficient only; h_r = eps sigma (Ts + Ta)(Ts^2 + Ta^2) in kelvin at the solved surface temperature, data.outsideFilm gives both parts), and insulationConductivitySlopeWmK2 with insulationConductivityRefTempC makes the insulation conductivity linear in temperature, k(T) = k + slope (T - ref), evaluated at the mean temperature of the insulation (exact for a linear k; data.insulationConductivityMeanWmK); both are solved by iteration. Without them the closed form is unchanged. A screening figure, not a thermal design. Refusals: RTE_UNKNOWN_LINE, RTE_SPEC_NO_COMPONENT, ' +
    'RTE_HEAT_LOSS_INPUT. Does not modify the document. Next: set_heat_tracing, piping_takeoff.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    lineId: z.string().describe('Pipe line id (affected[0] of create_pipeline).'),
    fluidTempC: z.number().describe('Temperature of the content, degC (the design temperature of the line is a reasonable choice).'),
    ambientTempC: z.number().describe('Ambient air temperature, degC.'),
    outsideFilmWm2K: z
      .number()
      .describe('Outside film coefficient (convection plus radiation lumped), W/m2K, > 0, e.g. 10 still air, 25 wind.'),
    insideFilmWm2K: z
      .number()
      .optional()
      .describe('Inside film coefficient, W/m2K, > 0. Omit to neglect the inside film (a conservative upper bound of the loss).'),
    steelConductivityWmK: z.number().describe('Conductivity of the pipe steel, W/mK, > 0 (carbon steel about 50).'),
    insulationConductivityWmK: z
      .number()
      .optional()
      .describe(
        'Insulation conductivity at its mean temperature, W/mK, > 0. Omit to read the conductivity column of the spec insulation table row.',
      ),
    outsideEmissivity: z
      .number()
      .optional()
      .describe(
        'Surface emissivity of the outer surface (insulation cladding or bare steel), in (0, 1]: adds radiation to the ambient (black-body surroundings at the ambient temperature). When given, outsideFilmWm2K is the convection coefficient only. Omit for no radiation term (outsideFilmWm2K lumped).',
      ),
    insulationConductivitySlopeWmK2: z
      .number()
      .optional()
      .describe(
        'dk/dT of the insulation, W/(m K^2) (positive for mineral wool: conductivity rises with temperature). Needs insulationConductivityRefTempC; k(T) = k + slope (T - ref) with k = insulationConductivityWmK or the spec row value. Omit for a constant conductivity.',
      ),
    insulationConductivityRefTempC: z
      .number()
      .optional()
      .describe(
        'Temperature (degC) at which the insulation conductivity (given or from the spec row) holds. Required with insulationConductivitySlopeWmK2.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const piping = getPiping(doc);
    const line = piping.lines[params.lineId];
    if (line === undefined) return refuse(doc, 'line_heat_loss', 'RTE_UNKNOWN_LINE', `no pipe line "${params.lineId}"`, [], ['lineId']);
    const bad = (path: string, why: string): CommandResult => refuse(doc, 'line_heat_loss', 'RTE_HEAT_LOSS_INPUT', why, [line.id], [path]);
    const issue = inputIssue(params);
    if (issue !== undefined) return bad(issue.path, issue.why);
    const lookup = createSpecLookup(doc, line.spec);
    if (isMiss(lookup)) return refuse(doc, 'line_heat_loss', lookup.miss, lookup.detail, [...lookup.ids, line.id], ['lineId']);
    const pipe = lookup.pipe(line.dn);
    if (isMiss(pipe)) return refuse(doc, 'line_heat_loss', pipe.miss, pipe.detail, [...pipe.ids, line.id], ['lineId']);
    const od = pipe.dims['outsideDiameter'];
    const wall = pipe.dims['wall'];
    if (od === undefined || wall === undefined || !(wall > 0) || !(od > 2 * wall))
      return bad('lineId', `pipe row ${pipe.key} gives no usable outside diameter / wall (${od ?? '?'} / ${wall ?? '?'} mm)`);
    const conductivity = insulationConductivity(doc, line, lookup, params);
    if ('document' in conductivity) return conductivity;
    const { insulationK, defaults } = conductivity;
    const insulation = line.insulation;
    const base = heatLossBase(params, line, od, wall, insulationK);
    if (params.insulationConductivitySlopeWmK2 !== undefined && insulation === undefined)
      defaults.push({ input: 'insulationConductivitySlopeWmK2', assumed: 'ignored: the line has no insulation' });
    const result = heatLossPerMetre({ ...base, fluidTempC: params.fluidTempC });
    if (
      !Number.isFinite(result.heatLossWPerM) ||
      (result.insulationConductivityMeanWmK !== undefined && !(result.insulationConductivityMeanWmK > 0))
    )
      return bad(
        'insulationConductivitySlopeWmK2',
        `the insulation conductivity k + slope (T - ref) is not positive at its mean temperature (${result.insulationConductivityMeanWmK ?? 'n/a'} W/mK): check the slope and the reference temperature`,
      );
    const { lengthMm, skipped } = routedLength(doc, line);
    const lengthM = Math.round(lengthMm) / 1000;
    const tracing = tracingOf(line, base);
    const unit = result.heatLossWPerM >= 0 ? 'loses' : 'gains';
    return report(
      doc,
      `line_heat_loss: line ${line.lineNumber} (${od} mm OD, wall ${wall}, ${insulation === undefined ? 'bare' : `${insulation.thicknessMm} mm insulation k ${insulationK}`}) ${unit} ${Math.abs(result.heatLossWPerM).toFixed(3)} W/m at ${params.fluidTempC}/${params.ambientTempC} degC; surface ${result.surfaceTempC.toFixed(2)} degC; ${lengthM} m routed = ${Math.round(result.heatLossWPerM * lengthM * 1000) / 1000} W${skipped.length === 0 ? '' : `; runs not counted (broken): ${skipped.join(', ')}`}; review required.`,
      {
        lineId: line.id,
        lineNumber: line.lineNumber,
        ...result,
        lengthM,
        totalHeatLossW: Math.round(result.heatLossWPerM * lengthM * 1000) / 1000,
        skippedRuns: skipped,
        tracing,
        defaults,
        provenance: heatLossProvenance(params, pipe.key),
        reviewRequired: true,
      },
    );
  },
});
