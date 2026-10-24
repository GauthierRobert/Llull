import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, noop } from '@core/commands/noop';
import type { LineTracing, PipeLine } from '@aec/plant/types';
import { getPiping, refuse, withPiping } from '../model';

const TYPES = ['electric', 'steam', 'hot_water', 'thermal_fluid'] as const;

/**
 * @affects sets or removes `tracing` on 1 pipe line (plant.piping); no geometry and no run changes
 * @invariant data only: the tracing is read by piping_takeoff (tracer length per line) and by line_heat_loss (maintain temperature); omitted fields stay
 * @failure unknown line -> RTE_UNKNOWN_LINE; first setting without type or tracers -> RTE_TRACING_INVALID; nothing to change -> no-op
 */
export const setHeatTracing = defineCommand({
  name: 'set_heat_tracing',
  description:
    'Record the heat tracing of a pipe line (create_pipeline): tracer type (electric | steam | hot_water | thermal_fluid), the number of tracers along the pipe (1 to 6), ' +
    'the temperature to maintain (degC) and the extra tracer length per valve, flange and pipe support (allowances, metres per item: the loop that wraps the fitting). ' +
    'Data only: it does not change the route. piping_takeoff then lists the tracer length per traced line = tracers x (centreline length) + tracers x (valves x valveM + flanges x flangeM + ' +
    'supports x supportM), supports being the pipe supports on the line runs (add_pipe_support runId), and line_heat_loss gives the heat the tracing must replace at maintainTempC. ' +
    'Omitted fields keep their value; remove: true deletes the tracing. Returns the line id (affected[0]); data = { lineId, tracing }. Refusals: RTE_UNKNOWN_LINE, ' +
    'RTE_TRACING_INVALID (the first setting needs type and tracers). Next: piping_takeoff, line_heat_loss.',
  params: z.object({
    lineId: z.string().describe('Pipe line id (affected[0] of create_pipeline).'),
    type: z.enum(TYPES).optional().describe('Tracer type: electric (trace cable), steam, hot_water or thermal_fluid (glycol / oil).'),
    tracers: z.number().int().min(1).max(6).optional().describe('Number of tracers run along the pipe, 1 to 6.'),
    maintainTempC: z.number().optional().describe('Temperature the line content is kept at, degC.'),
    allowances: z
      .object({
        valveM: z.number().min(0).describe('Extra tracer per valve, metres.'),
        flangeM: z.number().min(0).describe('Extra tracer per flange, metres.'),
        supportM: z.number().min(0).describe('Extra tracer per pipe support, metres.'),
      })
      .optional()
      .describe('Extra tracer length per fitting, metres per item. Absent = none counted (the takeoff names this).'),
    remove: z.boolean().optional().describe('true deletes the tracing of the line.'),
  }),
  run: (doc, params): CommandResult => {
    const piping = getPiping(doc);
    const line = piping.lines[params.lineId];
    if (line === undefined) return refuse(doc, 'set_heat_tracing', 'RTE_UNKNOWN_LINE', `no pipe line "${params.lineId}"`, [], ['lineId']);
    if (params.remove === true) {
      if (line.tracing === undefined) return noop(doc, `set_heat_tracing: line ${line.lineNumber} has no heat tracing.`);
      const { tracing: removed, ...rest } = line;
      void removed;
      const next = withPiping(doc, { ...piping, lines: { ...piping.lines, [line.id]: rest } });
      return {
        ...changed(next, `set_heat_tracing: removed the heat tracing of line ${line.lineNumber}.`, [line.id]),
        data: { lineId: line.id, tracing: null },
      };
    }
    const type = params.type ?? line.tracing?.type;
    const tracers = params.tracers ?? line.tracing?.tracers;
    if (type === undefined || tracers === undefined)
      return refuse(
        doc,
        'set_heat_tracing',
        'RTE_TRACING_INVALID',
        `line ${line.lineNumber} has no tracing yet: give type and tracers`,
        [line.id],
        [type === undefined ? 'type' : 'tracers'],
      );
    const maintainTempC = params.maintainTempC ?? line.tracing?.maintainTempC;
    const allowances = params.allowances ?? line.tracing?.allowances;
    const tracing: LineTracing = {
      type,
      tracers,
      ...(maintainTempC === undefined ? {} : { maintainTempC }),
      ...(allowances === undefined ? {} : { allowances }),
    };
    if (JSON.stringify(tracing) === JSON.stringify(line.tracing))
      return noop(doc, `set_heat_tracing: line ${line.lineNumber} already has this tracing.`);
    const stored: PipeLine = { ...line, tracing };
    const next = withPiping(doc, { ...piping, lines: { ...piping.lines, [line.id]: stored } });
    return {
      ...changed(
        next,
        `set_heat_tracing: line ${line.lineNumber} traced by ${tracers} ${type} tracer(s)${maintainTempC === undefined ? '' : `, maintain ${maintainTempC} degC`}${allowances === undefined ? ', no fitting allowances' : `, allowances valve ${allowances.valveM} m, flange ${allowances.flangeM} m, support ${allowances.supportM} m`}.`,
        [line.id],
      ),
      data: { lineId: line.id, tracing },
    };
  },
});
