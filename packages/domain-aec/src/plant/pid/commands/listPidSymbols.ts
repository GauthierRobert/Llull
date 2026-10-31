import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { PID_CONVENTIONS } from '../model';
import { allSymbols } from '../symbols/library';

const FAMILIES = ['equipment', 'piping', 'instrument', 'actuator', 'connector', 'annotation'] as const;

/**
 * @affects nothing (read-only query of the built-in symbol library)
 * @invariant one entry per symbol and convention; equipment symbols differ between the two conventions, other families are shared; sizes are sheet millimetres
 * @failure none (a filter that matches nothing returns zero rows)
 */
export const listPidSymbols = defineCommand({
  name: 'list_pid_symbols',
  annotations: { readOnly: true, idempotent: true },
  description:
    'List the built-in P&ID symbols that export_pid_svg draws (read-only): equipment classes (Tank, CentrifugalPump, PlateHeatExchanger ...), piping components (BallValve, PipeTee, PipeReducer ...), ' +
    'off-page connectors, instrument bubbles (location x display), actuators and the flow arrow. add_pid_equipment / add_pid_inline accept exactly the equipment and piping classes listed here. ' +
    'Returns data = { rows: [{ class, name, family, convention, source: "builtin", halfWidth, halfHeight, ports: [[x, y], ...], shapes (number of drawing shapes) }] , count }; sizes and ports are in sheet millimetres in the symbol frame (+y up, origin at the centre). ' +
    'ISA-5.1 draws equipment as outlines with the class initial, ISO-10628-2 adds the internals; components, bubbles and actuators are the same in both. Refusals: none.',
  params: z.object({
    convention: z.enum(PID_CONVENTIONS).optional().describe('Only the symbols of this convention. Default: both.'),
    class: z.string().trim().min(1).optional().describe('Only this class, exactly (e.g. "BallValve"), case-insensitive.'),
    family: z.enum(FAMILIES).optional().describe('Only this family: equipment, piping, instrument, actuator, connector or annotation.'),
  }),
  run: (doc, params): CommandResult => {
    const wanted = params.class?.toLowerCase();
    const rows = allSymbols()
      .filter(
        ({ convention, symbol }) =>
          (params.convention === undefined || convention === params.convention) &&
          (wanted === undefined || symbol.class.toLowerCase() === wanted) &&
          (params.family === undefined || symbol.family === params.family),
      )
      .map(({ convention, symbol }) => ({
        class: symbol.class,
        name: symbol.name,
        family: symbol.family,
        convention,
        source: 'builtin',
        halfWidth: symbol.halfWidth,
        halfHeight: symbol.halfHeight,
        ports: symbol.ports,
        shapes: symbol.shapes.length,
      }));
    return report(doc, `list_pid_symbols: ${rows.length} symbol(s)`, { rows, count: rows.length });
  },
});
