/** Instruments, loops, information flows, actuating systems and annotations as Proteus elements (plant 04 PID §6.3). */

import type { PidActuating, PidInstrument, PidItem, PidPlain, PidSignal } from '../model';
import { signalKindOf } from '../dexpi/proteusFlows';
import { ACTUATOR_NAMES, FAIL_ACTION_NAMES, LOCATION_NAMES, actuatorOf, failActionOf, locationOf } from '../dexpi/proteusVocab';
import { attributeNodes } from './exportAttributes';
import { association, centerLine, classWritten, endpointRef, identity, position, warn, type ExportContext } from './exportContext';
import { el, type XNode } from './xmlWrite';

const OPERATED_PREFIX = 'OperatedValveReference.';
const textOf = (item: PidItem, name: string): string | undefined => {
  const value = item.attributes[name];
  return value === undefined || value.kind === 'quantity' ? undefined : value.value;
};

/** The instrument's data the importer reads back, by the importer's own rules (so a stored attribute that already says it is kept as is). */
function instrumentNode(ctx: ExportContext, instrument: PidInstrument, nested: readonly XNode[], loop: PidPlain | undefined): XNode {
  const place = textOf(instrument, 'LocationSpecialization');
  const letters = `${instrument.category}${instrument.functions}`;
  return el('ProcessInstrumentationFunction', identity(ctx, instrument), [
    position(instrument.at, instrument.rotationDeg),
    ...attributeNodes(instrument, {
      set: {
        ProcessInstrumentationFunctionCategoryAssignmentClass: instrument.category,
        ProcessInstrumentationFunctionsAssignmentClass: instrument.functions,
        ProcessInstrumentationFunctionNumberAssignmentClass: instrument.loopNumber,
        LocationSpecialization:
          place !== undefined && locationOf(place) === instrument.location ? undefined : LOCATION_NAMES[instrument.location],
      },
      tag: {
        name: 'TagNameAssignmentClass',
        derive: (raw) => {
          const joined = [
            `${raw.get('ProcessInstrumentationFunctionCategoryAssignmentClass') ?? ''}${raw.get('ProcessInstrumentationFunctionsAssignmentClass') ?? ''}`,
            raw.get('ProcessInstrumentationFunctionNumberAssignmentClass') ?? '',
          ]
            .filter((part) => part !== '')
            .join(' ');
          return raw.get('TagNameAssignmentClass') || (letters === '' && instrument.loopNumber === '' ? undefined : joined);
        },
      },
      pass: { 'pid:display': instrument.display === 'discrete' ? null : instrument.display },
    }),
    ...(loop === undefined || ctx.ids.get(loop.id) === undefined ? [] : [association('is a part of', ctx.ids.get(loop.id) ?? '')]),
    ...nested,
  ]);
}

/** Instruments with the signal-generating functions that sit in them and the actuating functions they fulfil. */
export function instrumentNodes(ctx: ExportContext): XNode[] {
  const instruments = ctx.items.filter((item): item is PidInstrument => item.kind === 'instrument');
  const generating = ctx.items.filter((item) => item.kind === 'annotation' && item.dexpiClass === 'ProcessSignalGeneratingFunction');
  const hostOf = (item: PidItem): PidInstrument | undefined =>
    instruments.find((i) => i.sheetId === item.sheetId && i.at[0] === item.at[0] && i.at[1] === item.at[1]) ??
    instruments.find((i) => i.sheetId === item.sheetId) ??
    instruments[0];
  const skipped: string[] = [];
  const functions = new Map<string, XNode[]>();
  for (const item of generating) {
    const host = hostOf(item);
    if (host === undefined) {
      skipped.push(item.id);
      continue;
    }
    functions.set(host.id, [
      ...(functions.get(host.id) ?? []),
      el('ProcessSignalGeneratingFunction', identity(ctx, item), [position(item.at, item.rotationDeg), ...attributeNodes(item)]),
    ]);
  }
  for (const item of ctx.items) {
    if (item.kind !== 'actuating' || item.controllerId === undefined) continue;
    const system = ctx.ids.get(item.id);
    if (system === undefined || ctx.ids.get(item.valveId) === undefined) continue;
    functions.set(item.controllerId, [
      ...(functions.get(item.controllerId) ?? []),
      el(
        'ActuatingFunction',
        [
          ['ID', ctx.claim(`${ctx.ids.get(item.controllerId) ?? 'Instrument'}-ActuatingFunction-${system}`)],
          ['ComponentClass', 'ActuatingFunction'],
        ],
        [association('is fulfilled by', system)],
      ),
    ]);
  }
  if (skipped.length > 0)
    warn(
      ctx,
      'DEXPI_EXPORT_ITEM_SKIPPED',
      `${skipped.length} signal generating function(s) have no instrument to sit in: not written`,
      skipped.slice(0, 20),
    );
  return instruments.map((instrument) => {
    const loop = instrument.loopId === undefined ? undefined : ctx.pid.items[instrument.loopId];
    return instrumentNode(ctx, instrument, functions.get(instrument.id) ?? [], loop?.kind === 'loop' ? loop : undefined);
  });
}

export function loopNodes(ctx: ExportContext): XNode[] {
  return ctx.items.flatMap((item) => {
    if (item.kind !== 'loop') return [];
    const members = ctx.items.filter((i): i is PidInstrument => i.kind === 'instrument' && i.loopId === item.id);
    return [
      el('InstrumentationLoopFunction', identity(ctx, item), [
        position(item.at, item.rotationDeg),
        ...attributeNodes(item, { set: { InstrumentationLoopFunctionNumberAssignmentClass: item.tag } }),
        ...members.map((member) => association('is a collection including', ctx.ids.get(member.id) ?? '')),
      ]),
    ];
  });
}

function signalNode(ctx: ExportContext, signal: PidSignal): XNode {
  const kind = signalKindOf(signal.dexpiClass);
  const dexpiClass =
    signal.signalKind === 'measuring'
      ? kind === 'measuring'
        ? signal.dexpiClass
        : 'MeasuringLineFunction'
      : kind === signal.signalKind
        ? signal.dexpiClass
        : 'SignalConveyingFunction';
  const from = endpointRef(ctx, signal.from, signal.id);
  const to = endpointRef(ctx, signal.to, signal.id);
  const byAssociation = signal.passthrough?.['dexpi:association'] === 'true';
  if (!byAssociation) ctx.connections++;
  return el(
    'InformationFlow',
    [
      ['ID', ctx.ids.get(signal.id)],
      ['ComponentClass', dexpiClass],
      ['ComponentClassURI', dexpiClass === signal.dexpiClass ? signal.classUri : undefined],
    ],
    [
      ...attributeNodes(signal, { pass: { 'pid:signalKind': signalKindOf(dexpiClass) === signal.signalKind ? null : signal.signalKind } }),
      centerLine(signal.route),
      ...(byAssociation
        ? [
            ...(from.id === undefined ? [] : [association('has logical start', from.id)]),
            ...(to.id === undefined ? [] : [association('has logical end', to.id)]),
          ]
        : [
            el('Connection', [
              ['FromID', from.id],
              ['FromNode', from.node],
              ['ToID', to.id],
              ['ToNode', to.node],
            ]),
          ]),
    ],
  );
}

export const signalNodes = (ctx: ExportContext): XNode[] =>
  ctx.items.flatMap((item) => (item.kind === 'signal' ? [signalNode(ctx, item)] : []));

function actuatingNode(ctx: ExportContext, system: PidActuating): XNode[] {
  const valve = ctx.ids.get(system.valveId);
  const id = ctx.ids.get(system.id);
  if (valve === undefined || id === undefined) {
    warn(
      ctx,
      'DEXPI_DANGLING_REFERENCE',
      `actuating system ${system.tag ?? system.id} operates a valve that is not exported; the system was not written`,
      [system.id],
    );
    return [];
  }
  const device = textOf(system, 'DeviceTypeNameAssignmentClass');
  const fail = textOf(system, 'FailActionSpecialization');
  const sameDevice = device !== undefined && actuatorOf(device) === system.actuator;
  const sameFail = fail !== undefined && failActionOf(fail) === system.failAction;
  const referenced: PidActuating = {
    ...system,
    attributes: Object.fromEntries(
      Object.entries(system.attributes)
        .filter(([name]) => name.startsWith(OPERATED_PREFIX))
        .map(([name, value]) => [name.slice(OPERATED_PREFIX.length), value]),
    ),
  };
  return [
    el('ActuatingSystem', identity(ctx, system), [
      ...attributeNodes(
        system,
        {
          set: {
            ActuatingSystemNumberAssignmentClass:
              system.tag !== undefined && textOf(system, 'ActuatingSystemNumberAssignmentClass') !== system.tag ? system.tag : undefined,
            DeviceTypeNameAssignmentClass: sameDevice
              ? undefined
              : system.actuator === 'general'
                ? 'GeneralActuator'
                : ACTUATOR_NAMES[system.actuator],
            FailActionSpecialization: system.failAction === undefined || sameFail ? undefined : FAIL_ACTION_NAMES[system.failAction],
          },
        },
        (name) => !name.startsWith(OPERATED_PREFIX),
      ),
      el(
        'ActuatingSystemComponent',
        [
          ['ID', ctx.claim(`${id}-Actuator`)],
          ['ComponentClass', 'ControlledActuator'],
        ],
        [position(system.at, system.rotationDeg)],
      ),
      el(
        'ActuatingSystemComponent',
        [
          ['ID', ctx.claim(`${id}-ValveReference`)],
          ['ComponentClass', 'OperatedValveReference'],
        ],
        [...attributeNodes(referenced, {}, (name) => !name.includes(':')), association('refers to', valve)],
      ),
    ]),
  ];
}

export const actuatingNodes = (ctx: ExportContext): XNode[] =>
  ctx.items.flatMap((item) => (item.kind === 'actuating' ? actuatingNode(ctx, item) : []));

/** Annotations that are neither flow arrows nor signal generating functions: plant structure items and metadata. */
export const annotationNodes = (ctx: ExportContext): XNode[] =>
  ctx.items.flatMap((item) => {
    if (item.kind !== 'annotation' || item.dexpiClass === 'PipeFlowArrow' || item.dexpiClass === 'ProcessSignalGeneratingFunction')
      return [];
    return [
      el(
        item.dexpiClass === 'MetaData' ? 'MetaData' : 'PlantStructureItem',
        [
          ['ID', ctx.ids.get(item.id)],
          ['ComponentClass', classWritten(item)],
          ['ComponentClassURI', item.classUri],
        ],
        [position(item.at, item.rotationDeg), ...attributeNodes(item)],
      ),
    ];
  });
