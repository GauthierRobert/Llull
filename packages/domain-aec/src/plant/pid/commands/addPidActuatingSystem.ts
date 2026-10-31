import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { isValveClass } from '../authoring/classes';
import { Draft, checkTag, fail, findItem, isFail, refuse, mintFree } from '../authoring/refs';
import { PID_ACTUATORS, PID_FAIL_ACTIONS, type PidActuating } from '../model';
import { getPid, withPid } from '../state';

/** Distance of the actuator symbol above its valve, mm. */
const ACTUATOR_OFFSET = 12;

/**
 * @affects plant.pid (one actuating system on a valve; the valve is marked `operated`)
 * @invariant one actuating system per valve; the controller, when given, is an instrument; the symbol sits 12 mm above the valve
 * @failure valve not found -> PID_ITEM_NOT_FOUND; not an inline valve / controller not an instrument -> PID_ITEM_KIND; valve already actuated -> PID_ACTUATOR_EXISTS; tag used -> PID_TAG_DUPLICATE; document unchanged
 */
export const addPidActuatingSystem = defineCommand({
  name: 'add_pid_actuating_system',
  description:
    'Attach an actuating system (the actuator that moves a valve) to an inline valve, and optionally link its controller. `valve` is the valve tag or item id; ' +
    '`actuator` is diaphragm, piston, motor, solenoid, hydraulic or general; `failAction` is the position on loss of signal or power: FC (fail closed), FO (fail open), FL (fail locked), ' +
    'FAI (fail indeterminate); `controller` is the instrument that drives it (tag or id, e.g. the controller FIC-101). The valve is marked operated. One actuating system per valve. ' +
    'Returns affected[0] = the actuating system id; data = { actuating, valve }. Refusals (document unchanged): PID_ITEM_NOT_FOUND, PID_ITEM_KIND (valve is not an inline valve, controller is not an ' +
    'instrument), PID_ACTUATOR_EXISTS, PID_TAG_DUPLICATE. Next: add_pid_signal_line from the controller to the actuating system.',
  params: z.object({
    valve: z.string().min(1).describe('Valve tag (e.g. "FV-101") or item id; must be an inline component whose class is a valve.'),
    actuator: z.enum(PID_ACTUATORS).describe('Actuator type: diaphragm, piston, motor, solenoid, hydraulic or general.'),
    failAction: z
      .enum(PID_FAIL_ACTIONS)
      .optional()
      .describe('Position on failure: FC fail closed, FO fail open, FL fail locked, FAI fail indeterminate.'),
    controller: z.string().min(1).optional().describe('Controlling instrument: tag or item id.'),
    tag: z.string().min(1).optional().describe('Tag of the actuating system itself (optional, unique in the document).'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'add_pid_actuating_system';
    const pid = getPid(doc);
    const valve = findItem(pid, params.valve, 'valve');
    if (isFail(valve)) return refuse(doc, name, valve);
    if (valve.kind !== 'inline' || !isValveClass(valve.dexpiClass))
      return refuse(
        doc,
        name,
        fail('PID_ITEM_KIND', `${params.valve} is not an inline valve (it is ${valve.kind} ${valve.dexpiClass})`, ['valve']),
      );
    if (pid.itemOrder.some((id) => pid.items[id]?.kind === 'actuating' && (pid.items[id] as PidActuating).valveId === valve.id))
      return refuse(doc, name, fail('PID_ACTUATOR_EXISTS', `${params.valve} already has an actuating system`, ['valve'], [valve.id]));
    let controllerId: string | undefined;
    if (params.controller !== undefined) {
      const controller = findItem(pid, params.controller, 'controller');
      if (isFail(controller)) return refuse(doc, name, controller);
      if (controller.kind !== 'instrument')
        return refuse(doc, name, fail('PID_ITEM_KIND', `${params.controller} is a ${controller.kind}, not an instrument`, ['controller']));
      controllerId = controller.id;
    }
    let tag: string | undefined;
    if (params.tag !== undefined) {
      const checked = checkTag(pid, params.tag, undefined, 'tag');
      if (isFail(checked)) return refuse(doc, name, checked);
      tag = checked;
    }
    const actuating: PidActuating = {
      id: mintFree(pid),
      kind: 'actuating',
      sheetId: valve.sheetId,
      at: [valve.at[0], valve.at[1] + ACTUATOR_OFFSET],
      rotationDeg: 0,
      dexpiClass: 'ActuatingSystem',
      attributes: {},
      valveId: valve.id,
      actuator: params.actuator,
      ...(tag === undefined ? {} : { tag }),
      ...(params.failAction === undefined ? {} : { failAction: params.failAction }),
      ...(controllerId === undefined ? {} : { controllerId }),
    };
    const draft = new Draft(pid);
    draft.put(actuating);
    draft.put({ ...valve, operated: true });
    return {
      document: withPid(doc, draft.model()),
      summary: `add_pid_actuating_system: ${params.actuator} actuator (${actuating.id}) on ${valve.tag ?? valve.id}${params.failAction ? `, ${params.failAction}` : ''}${params.controller ? `, controller ${params.controller}` : ''}`,
      affected: [actuating.id, valve.id],
      data: { actuating: actuating.id, valve: valve.id },
    };
  },
});
