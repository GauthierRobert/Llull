/** Listing what acts on the rigid-body model (list_dynamics_loads): weights, joint axes, gears, motor torques, propeller thrust. */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { LOAD_LAYERS, bodyCentres, dynamicsLoads } from '../../dynamics/dynamicsLoads';

/**
 * @affects nothing — read-only; data { loads: [{ id, layer, shape, title, value, detail, origin, direction, end?, magnitude }], count }
 * @invariant design values only (no run): the SI value, direction and origin (document units) of every load, in layer order
 * @failure none: a document without a dynamics model lists no loads
 */
export const listDynamicsLoads = defineCommand({
  name: 'list_dynamics_loads',
  annotations: { readOnly: true },
  description:
    'List every load of the physics model at its design values: each body weight at its centre of mass (gravity layer), every joint axis and ' +
    'gear coupling (joints), motor drive torque (drives) and propeller thrust at the governed speed (thrust). Each load has a short SI value, ' +
    'the setup behind it (detail), an origin and unit direction in document units and a magnitude (N or N·m; null when it is not a quantity). ' +
    'Filter with layers. Read-only; needs no physics engine. For the values during a run use simulate_motion.',
  params: z.object({ layers: z.array(z.enum(LOAD_LAYERS)).optional().describe('Keep only these layers (default: all of them).') }),
  run: (doc, params): CommandResult => {
    const wanted = params.layers === undefined ? null : new Set<string>(params.layers);
    const loads = dynamicsLoads(doc, null, bodyCentres(doc)).filter((load) => wanted === null || wanted.has(load.layer));
    return report(doc, `${loads.length} load(s)${doc.dynamics === undefined ? ' (no dynamics model)' : ''}`, {
      loads,
      count: loads.length,
    });
  },
});
