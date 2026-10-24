import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { heatLossPerMetre } from '../heatLoss';
import { getPiping, refuse } from '../model';
import { deriveRun } from '../routeParts';
import { createSpecLookup, isMiss } from '../specLookup';

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
    'provenance, reviewRequired: true }. No radiation and no temperature-dependent conductivity: a screening figure, not a thermal design. Refusals: RTE_UNKNOWN_LINE, RTE_SPEC_NO_COMPONENT, ' +
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
  }),
  run: (doc, params): CommandResult => {
    const piping = getPiping(doc);
    const line = piping.lines[params.lineId];
    if (line === undefined) return refuse(doc, 'line_heat_loss', 'RTE_UNKNOWN_LINE', `no pipe line "${params.lineId}"`, [], ['lineId']);
    const bad = (path: string, why: string): CommandResult => refuse(doc, 'line_heat_loss', 'RTE_HEAT_LOSS_INPUT', why, [line.id], [path]);
    for (const [path, value] of [
      ['outsideFilmWm2K', params.outsideFilmWm2K],
      ['steelConductivityWmK', params.steelConductivityWmK],
      ['insideFilmWm2K', params.insideFilmWm2K],
      ['insulationConductivityWmK', params.insulationConductivityWmK],
    ] as const)
      if (value !== undefined && !(value > 0)) return bad(path, `${path} must be > 0 (got ${value})`);
    const lookup = createSpecLookup(doc, line.spec);
    if (isMiss(lookup)) return refuse(doc, 'line_heat_loss', lookup.miss, lookup.detail, [...lookup.ids, line.id], ['lineId']);
    const pipe = lookup.pipe(line.dn);
    if (isMiss(pipe)) return refuse(doc, 'line_heat_loss', pipe.miss, pipe.detail, [...pipe.ids, line.id], ['lineId']);
    const od = pipe.dims['outsideDiameter'];
    const wall = pipe.dims['wall'];
    if (od === undefined || wall === undefined || !(wall > 0) || !(od > 2 * wall))
      return bad('lineId', `pipe row ${pipe.key} gives no usable outside diameter / wall (${od ?? '?'} / ${wall ?? '?'} mm)`);
    const defaults: Array<{ input: string; assumed: string }> = [];
    const insulation = line.insulation;
    let insulationK = params.insulationConductivityWmK ?? 0;
    if (insulation !== undefined && params.insulationConductivityWmK === undefined) {
      const row = line.designTempC === undefined ? undefined : lookup.insulation(insulation.code, line.dn, line.designTempC);
      const fromSpec = row === undefined || isMiss(row) ? null : row.conductivityWmK;
      if (fromSpec === null)
        return refuse(
          doc,
          'line_heat_loss',
          'RTE_SPEC_NO_COMPONENT',
          `insulation conductivity of line ${line.lineNumber}: the spec insulation table has no conductivity for code ${insulation.code} (or the line has no design temperature); pass insulationConductivityWmK`,
          [line.id],
          ['insulationConductivityWmK'],
        );
      insulationK = fromSpec;
      defaults.push({
        input: 'insulationConductivityWmK',
        assumed: `${fromSpec} W/mK from the spec insulation row ${insulation.row ?? insulation.code}`,
      });
    }
    if (params.insideFilmWm2K === undefined)
      defaults.push({ input: 'insideFilmWm2K', assumed: 'neglected: inside film resistance taken as 0 (h_i infinite)' });
    if (insulation === undefined) defaults.push({ input: 'insulation', assumed: 'the line has none: bare pipe, D2 = D1' });
    const base = {
      ambientTempC: params.ambientTempC,
      outsideDiameterMm: od,
      wallMm: wall,
      insulationThicknessMm: insulation?.thicknessMm ?? 0,
      steelConductivityWmK: params.steelConductivityWmK,
      insulationConductivityWmK: insulationK,
      outsideFilmWm2K: params.outsideFilmWm2K,
      insideFilmWm2K: params.insideFilmWm2K ?? null,
    };
    const result = heatLossPerMetre({ ...base, fluidTempC: params.fluidTempC });
    let lengthMm = 0;
    const skipped: string[] = [];
    for (const runId of piping.runOrder) {
      const run = piping.runs[runId];
      if (run?.lineId !== line.id) continue;
      const derivation = deriveRun(doc, run);
      if (derivation.ok) lengthMm += derivation.centrelineLengthMm;
      else skipped.push(runId);
    }
    const lengthM = Math.round(lengthMm) / 1000;
    const maintain = line.tracing?.maintainTempC;
    const tracing =
      line.tracing === undefined
        ? null
        : {
            type: line.tracing.type,
            tracers: line.tracing.tracers,
            maintainTempC: maintain ?? null,
            heatLossAtMaintainWPerM: maintain === undefined ? null : heatLossPerMetre({ ...base, fluidTempC: maintain }).heatLossWPerM,
          };
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
        provenance: {
          formula: "Q' = (Ti - Ta) / [1/(hi pi D0) + ln(D1/D0)/(2 pi ks) + ln(D2/D1)/(2 pi kins) + 1/(ho pi D2)]",
          sources: [
            'Incropera, Fundamentals of Heat and Mass Transfer, ch. 3 (radial systems, critical radius)',
            'ISO 12241 calculation rules for insulation of equipment and pipework',
          ],
          pipeRow: pipe.key,
          model: 'steady state, one dimension radial, constant conductivities, no radiation term',
        },
        reviewRequired: true,
      },
    );
  },
});
