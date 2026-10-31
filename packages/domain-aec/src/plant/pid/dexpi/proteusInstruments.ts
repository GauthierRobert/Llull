/** Proteus ProcessInstrumentationFunction, ActuatingSystem and InstrumentationLoopFunction -> instrument, actuating and loop items (plant 04 PID §6.1). */

import { xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import { PID_INSTRUMENT_DISPLAYS } from '../model';
import {
  addItem,
  associations,
  baseOf,
  dropGraphics,
  placement,
  readAttributes,
  register,
  warn,
  type ImportContext,
  type Pending,
  type ReadAttributes,
} from './proteusContext';
import { actuatorOf, failActionOf, locationOf } from './proteusVocab';

/** An instrument (+ its nested signal generating and actuating functions); its information flows are queued for the second pass. */
export function mapInstrument(ctx: ImportContext, el: XmlElement, pending: Pending): void {
  const read = readAttributes(ctx, el);
  const category = read.raw.get('ProcessInstrumentationFunctionCategoryAssignmentClass') ?? '';
  const functions = read.raw.get('ProcessInstrumentationFunctionsAssignmentClass') ?? '';
  const loopNumber = read.raw.get('ProcessInstrumentationFunctionNumberAssignmentClass') ?? '';
  const letters = `${category}${functions}`;
  const derived = letters === '' && loopNumber === '' ? undefined : [letters, loopNumber].filter((part) => part !== '').join(' ');
  const tag = read.raw.get('TagNameAssignmentClass') || derived;
  const locationText = read.raw.get('LocationSpecialization') ?? '';
  const location = locationOf(locationText);
  const shown = read.passthrough['pid:display'];
  const display = PID_INSTRUMENT_DISPLAYS.find((name) => name === shown) ?? 'discrete';
  const base = baseOf(ctx, el, xmlAttr(el, 'ComponentClass') || 'ProcessInstrumentationFunction', read, { tag });
  addItem(ctx, { ...base, kind: 'instrument', category, functions, loopNumber, location, display });
  register(ctx, el, { type: 'instrument', id: base.id });
  for (const child of xmlChildren(el)) {
    if (child.local === 'InformationFlow') pending.flows.push(child);
    else if (child.local === 'ProcessSignalGeneratingFunction') {
      const generating = readAttributes(ctx, child);
      addItem(ctx, { ...baseOf(ctx, child, 'ProcessSignalGeneratingFunction', generating, { at: base.at }), kind: 'annotation' });
      const sitsIn = associations(child, 'is located in')[0];
      register(ctx, child, sitsIn === undefined ? { type: 'other' } : { type: 'alias', target: sitsIn });
    } else if (child.local === 'ActuatingFunction') {
      const system = associations(child, 'is fulfilled by')[0];
      register(ctx, child, system === undefined ? { type: 'other' } : { type: 'alias', target: system });
      if (system !== undefined) pending.controllers.set(system, base.id);
    }
  }
  dropGraphics(ctx, el);
}

/** The system's attributes with those of the controlled actuator merged in and those of the valve reference prefixed. */
function mergedAttributes(system: ReadAttributes, actuator: ReadAttributes | undefined, valve: ReadAttributes | undefined): ReadAttributes {
  const attributes = { ...system.attributes, ...actuator?.attributes };
  const raw = new Map([...system.raw, ...(actuator?.raw ?? [])]);
  for (const [name, value] of Object.entries(valve?.attributes ?? {})) attributes[`OperatedValveReference.${name}`] = value;
  return { attributes, raw, passthrough: { ...system.passthrough, ...actuator?.passthrough } };
}

/** An actuating system -> `PidActuating` on the valve its OperatedValveReference names (needs every inline item to exist). */
export function mapActuating(ctx: ImportContext, el: XmlElement, pending: Pending): void {
  const components = xmlChildren(el, 'ActuatingSystemComponent');
  const actuator = components.find((c) => xmlAttr(c, 'ComponentClass') === 'ControlledActuator');
  const valveReference = components.find((c) => xmlAttr(c, 'ComponentClass') === 'OperatedValveReference');
  const valveId = valveReference === undefined ? undefined : associations(valveReference, 'refers to')[0];
  const valve = valveId === undefined ? undefined : ctx.refs.get(valveId);
  const systemId = xmlAttr(el, 'ID') ?? '';
  if (valve?.type !== 'inline') {
    const named = valveId === undefined ? 'no valve' : `the valve "${valveId}" which is not an imported piping component`;
    warn(
      ctx,
      'DEXPI_DANGLING_REFERENCE',
      'warning',
      `actuating system ${systemId} names ${named}; the system was not imported`,
      valveReference ?? el,
      [systemId],
    );
    return;
  }
  const read = mergedAttributes(
    readAttributes(ctx, el),
    actuator === undefined ? undefined : readAttributes(ctx, actuator),
    valveReference === undefined ? undefined : readAttributes(ctx, valveReference),
  );
  const device = read.raw.get('DeviceTypeNameAssignmentClass') ?? '';
  const failAction = failActionOf(read.raw.get('FailActionSpecialization') ?? '');
  const controllerId = pending.controllers.get(systemId);
  const base = baseOf(ctx, el, xmlAttr(el, 'ComponentClass') || 'ActuatingSystem', read, {
    tag: read.raw.get('ActuatingSystemNumberAssignmentClass'),
    at: (actuator === undefined ? undefined : placement(ctx, actuator).at) ?? ctx.items[valve.id]?.at,
  });
  addItem(ctx, {
    ...base,
    kind: 'actuating',
    valveId: valve.id,
    actuator: actuatorOf(device),
    ...(failAction === undefined ? {} : { failAction }),
    ...(controllerId === undefined ? {} : { controllerId }),
  });
  const ref = { type: 'instrument', id: base.id } as const;
  register(ctx, el, ref);
  if (actuator !== undefined) register(ctx, actuator, ref);
  if (valveReference !== undefined) register(ctx, valveReference, valve);
  const inline = ctx.items[valve.id];
  if (inline?.kind === 'inline') ctx.items[valve.id] = { ...inline, operated: true };
  dropGraphics(ctx, el);
}

/** A loop and the membership it declares (`is a collection including`): each member instrument gets `loopId`. */
export function mapLoop(ctx: ImportContext, el: XmlElement): void {
  const read = readAttributes(ctx, el);
  const declared = associations(el, 'is a collection including');
  const members = declared.flatMap((id) => {
    const ref = ctx.refs.get(id);
    return ref?.type === 'instrument' ? [ref.id] : [];
  });
  const base = baseOf(ctx, el, xmlAttr(el, 'ComponentClass') || 'InstrumentationLoopFunction', read, {
    tag: read.raw.get('InstrumentationLoopFunctionNumberAssignmentClass'),
    at: members[0] === undefined ? undefined : ctx.items[members[0]]?.at,
  });
  addItem(ctx, { ...base, kind: 'loop' });
  register(ctx, el, { type: 'other' });
  for (const id of members) {
    const member = ctx.items[id];
    if (member?.kind === 'instrument') ctx.items[id] = { ...member, loopId: base.id };
  }
  if (declared.length !== members.length)
    warn(
      ctx,
      'DEXPI_DANGLING_REFERENCE',
      'warning',
      `loop ${xmlAttr(el, 'ID') ?? ''} names ${declared.length - members.length} member(s) that are not imported instruments`,
      el,
    );
}
