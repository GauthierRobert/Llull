/**
 * DEXPI 2.0 (root `<Model>`) -> the Proteus-shaped tree the shared mapper reads (plant 04 PID §6.2). The 2.0 plant model is translated object by
 * object (equipment, nozzles, piping systems / segments / pipes / items, instrumentation, loops, actuating systems), positions and routes come from
 * the diagram. Nothing is fetched: the model files named by `Import` are not read, the class list is the mapper's own.
 */

import { xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import type { Vec2 } from '@core/model/vectors';
import { dexpiIssue, type DexpiIssue } from '../dexpi/codes';
import { genericAttributes } from './from20Attributes';
import { orient, readDiagram, type DiagramFacts, type Placement } from './from20Diagram';
import { ASSOCIATION_PROPERTY } from './names20';
import { association, classOf, componentObjects, dataOf, idOf, referenceIds, syn } from './syn';

export interface From20 {
  readonly ok: true;
  readonly root: XmlElement;
  /** `2.0.1` from the model imports, else `2.0`. */
  readonly schemaVersion: string;
  readonly issues: DexpiIssue[];
}

export interface From20Refusal {
  readonly ok: false;
  readonly message: string;
  readonly paths: string[];
}

const where = (el: XmlElement): string => `line ${el.line}, column ${el.column}`;
const round = (value: number): number => Math.round(value * 1e12) / 1e12;
const typeOf = (object: XmlElement): string => xmlAttr(object, 'type') ?? '';

interface Ctx {
  readonly facts: DiagramFacts;
  readonly issues: DexpiIssue[];
  /** Node id -> the object it belongs to and its index in that object's `Nodes`. */
  readonly nodeIndex: Map<string, { readonly owner: string; readonly index: number }>;
}

/** The properties of the plant model that hold items, in the order the Proteus tree lists them. */
const PLANT_PROPERTIES = [
  'TaggedPlantItems',
  'PipingNetworkSystems',
  'ProcessInstrumentationFunctions',
  'SignalConveyingFunctions',
  'InstrumentationLoopFunctions',
  'ActuatingSystems',
  'PlantStructureItems',
  'MetaData',
] as const;

function positionOf(place: Placement | undefined, at: XmlElement): XmlElement[] {
  if (place === undefined) return [];
  const angle = (place.rotationDeg * Math.PI) / 180;
  return [
    syn(
      'Position',
      [],
      [
        syn(
          'Location',
          [
            ['X', String(place.at[0])],
            ['Y', String(place.at[1])],
            ['Z', '0'],
          ],
          [],
          at,
        ),
        syn(
          'Reference',
          [
            ['X', String(round(Math.cos(angle)))],
            ['Y', String(round(Math.sin(angle)))],
            ['Z', '0'],
          ],
          [],
          at,
        ),
      ],
      at,
    ),
  ];
}

const placeOf = (ctx: Ctx, object: XmlElement): XmlElement[] => {
  const id = idOf(object);
  return positionOf(id === undefined ? undefined : ctx.facts.placements.get(id), object);
};

/** `ConnectionPoints` of the `Nodes` of `object` (all nodes, in order, with the position the diagram gives them). */
function connectionPoints(ctx: Ctx, object: XmlElement): XmlElement[] {
  const nodes = componentObjects(object, 'Nodes');
  if (nodes.length === 0) return [];
  const list = nodes.map((node) => {
    const id = idOf(node);
    const at = id === undefined ? undefined : ctx.facts.nodes.get(id);
    return syn(
      'Node',
      [['ID', id]],
      [...positionOf(at === undefined ? undefined : { at, rotationDeg: 0 }, node), ...genericAttributes(node)],
      node,
    );
  });
  return [syn('ConnectionPoints', [['NumPoints', String(list.length)]], list, object)];
}

const identity = (object: XmlElement): Array<readonly [string, string | undefined]> => [
  ['ID', idOf(object)],
  ['ComponentClass', classOf(object)],
];

const coordinates = (route: readonly Vec2[], at: XmlElement): XmlElement[] =>
  route.length === 0
    ? []
    : [
        syn(
          'CenterLine',
          [['NumPoints', String(route.length)]],
          route.map(([x, y]) =>
            syn(
              'Coordinate',
              [
                ['X', String(x)],
                ['Y', String(y)],
              ],
              [],
              at,
            ),
          ),
          at,
        ),
      ];

function nozzleOrEquipment(ctx: Ctx, object: XmlElement): XmlElement {
  const nested: XmlElement[] = [];
  for (const child of componentObjects(object)) {
    if (classOf(child).endsWith('Nozzle')) nested.push(nozzle(ctx, child));
    else if (typeOf(child).startsWith('Plant/ProcessEquipment.')) nested.push(nozzleOrEquipment(ctx, child));
  }
  return syn('Equipment', identity(object), [...placeOf(ctx, object), ...genericAttributes(object), ...nested], object);
}

function nozzle(ctx: Ctx, object: XmlElement): XmlElement {
  const access = classOf(object) === 'AccessNozzle';
  return syn(
    'Nozzle',
    [...identity(object), ['ComponentName', access ? 'MANHOLE' : undefined]],
    [...placeOf(ctx, object), ...connectionPoints(ctx, object), ...genericAttributes(object)],
    object,
  );
}

function component(ctx: Ctx, object: XmlElement): XmlElement {
  const connector = classOf(object).includes('OffPageConnector');
  return syn(
    connector ? 'PipeOffPageConnector' : 'PipingComponent',
    identity(object),
    [...placeOf(ctx, object), ...connectionPoints(ctx, object), ...genericAttributes(object)],
    object,
  );
}

/** `FromID` / `FromNode` (or `ToID` / `ToNode`) from the item and node references of `holder` (`SourceItem`, `SourceNode`). */
function connectionEnd(
  ctx: Ctx,
  holder: XmlElement | undefined,
  side: 'Source' | 'Target',
  itemProperty: string = `${side}Item`,
): Array<readonly [string, string | undefined]> {
  const item = holder === undefined ? undefined : referenceIds(holder, itemProperty)[0];
  const node = holder === undefined ? undefined : referenceIds(holder, `${side}Node`)[0];
  const found = node === undefined ? undefined : ctx.nodeIndex.get(node);
  const prefix = side === 'Source' ? 'From' : 'To';
  return [
    [`${prefix}ID`, item],
    [`${prefix}Node`, found !== undefined && found.owner === item ? String(found.index) : undefined],
  ];
}

function segment(ctx: Ctx, object: XmlElement): XmlElement {
  const items = componentObjects(object, 'Items');
  const pipes = componentObjects(object, 'Connections');
  const byId = new Map<string, XmlElement>();
  for (const item of items) {
    const id = idOf(item);
    if (id !== undefined) byId.set(id, item);
  }
  const isConnector = (item: XmlElement): boolean => classOf(item).includes('OffPageConnector');
  const body: XmlElement[] = [];
  const emitted = new Set<XmlElement>();
  const emit = (id: string | undefined): void => {
    const item = id === undefined ? undefined : byId.get(id);
    if (item === undefined || isConnector(item) || emitted.has(item)) return;
    emitted.add(item);
    body.push(component(ctx, item));
  };
  for (const pipe of pipes) {
    emit(referenceIds(pipe, 'SourceItem')[0]);
    const id = idOf(pipe);
    body.push(...coordinates(id === undefined ? [] : (ctx.facts.routes.get(id) ?? []), pipe));
    emit(referenceIds(pipe, 'TargetItem')[0]);
  }
  for (const item of items) {
    if (isConnector(item)) body.push(component(ctx, item));
    else if (!emitted.has(item)) {
      emitted.add(item);
      body.push(component(ctx, item));
    }
  }
  const id = idOf(object);
  for (const arrow of id === undefined ? [] : (ctx.facts.arrows.get(id) ?? []))
    body.push(syn('PipeFlowArrow', [['ComponentClass', 'PipeFlowArrow']], positionOf(arrow, object), object));
  const first = pipes[0];
  const last = pipes[pipes.length - 1];
  const from = referenceIds(object, 'SourceItem').length > 0 ? object : first;
  const to = referenceIds(object, 'TargetItem').length > 0 ? object : last;
  const ends = [...connectionEnd(ctx, from, 'Source'), ...connectionEnd(ctx, to, 'Target')];
  if (ends.some(([, value]) => value !== undefined)) body.push(syn('Connection', ends, [], object));
  return syn('PipingNetworkSegment', identity(object), [...genericAttributes(object), ...body], object);
}

function pipingSystem(ctx: Ctx, object: XmlElement): XmlElement {
  return syn(
    'PipingNetworkSystem',
    identity(object),
    [...genericAttributes(object), ...componentObjects(object, 'Segments').map((child) => segment(ctx, child))],
    object,
  );
}

function informationFlow(ctx: Ctx, object: XmlElement): XmlElement {
  const source = referenceIds(object, 'Source')[0];
  const target = referenceIds(object, 'Target')[0];
  const id = idOf(object);
  const ends = [...connectionEnd(ctx, object, 'Source', 'Source'), ...connectionEnd(ctx, object, 'Target', 'Target')];
  return syn(
    'InformationFlow',
    identity(object),
    [
      ...genericAttributes(object),
      ...coordinates(id === undefined ? [] : (ctx.facts.routes.get(id) ?? []), object),
      ...(source === undefined ? [] : [association('has logical start', source, object)]),
      ...(target === undefined ? [] : [association('has logical end', target, object)]),
      ...(ends.some(([, value]) => value !== undefined) && dataOf(object, ASSOCIATION_PROPERTY) === undefined
        ? [syn('Connection', ends, [], object)]
        : []),
    ],
    object,
  );
}

function instrument(ctx: Ctx, object: XmlElement): XmlElement {
  const nested: XmlElement[] = [];
  for (const property of ['ProcessSignalGeneratingFunctions', 'ActuatingFunctions', 'SignalConveyingFunctions'] as const)
    for (const child of componentObjects(object, property)) {
      if (property === 'SignalConveyingFunctions') nested.push(informationFlow(ctx, child));
      else if (property === 'ActuatingFunctions') {
        const system = referenceIds(child, 'Systems')[0];
        nested.push(
          syn(
            'ActuatingFunction',
            identity(child),
            [...genericAttributes(child), ...(system === undefined ? [] : [association('is fulfilled by', system, child)])],
            child,
          ),
        );
      } else {
        const sensing = referenceIds(child, 'SensingLocation')[0];
        nested.push(
          syn(
            'ProcessSignalGeneratingFunction',
            identity(child),
            [
              ...placeOf(ctx, child),
              ...genericAttributes(child),
              ...(sensing === undefined ? [] : [association('is located in', sensing, child)]),
            ],
            child,
          ),
        );
      }
    }
  return syn(
    'ProcessInstrumentationFunction',
    identity(object),
    [...placeOf(ctx, object), ...genericAttributes(object), ...nested],
    object,
  );
}

function loop(object: XmlElement): XmlElement {
  return syn(
    'InstrumentationLoopFunction',
    identity(object),
    [
      ...genericAttributes(object),
      ...referenceIds(object, 'ProcessInstrumentationFunctions').map((member) => association('is a collection including', member, object)),
    ],
    object,
  );
}

function actuatingSystem(ctx: Ctx, object: XmlElement): XmlElement {
  const actuator = componentObjects(object, 'ControlledActuator')[0];
  const valve = componentObjects(object, 'OperatedValveReference')[0];
  const valveId = valve === undefined ? undefined : referenceIds(valve, 'Valve')[0];
  return syn(
    'ActuatingSystem',
    identity(object),
    [
      ...genericAttributes(object),
      ...(actuator === undefined
        ? []
        : [syn('ActuatingSystemComponent', identity(actuator), [...placeOf(ctx, actuator), ...genericAttributes(actuator)], actuator)]),
      ...(valve === undefined
        ? []
        : [
            syn(
              'ActuatingSystemComponent',
              identity(valve),
              [...genericAttributes(valve), ...(valveId === undefined ? [] : [association('refers to', valveId, valve)])],
              valve,
            ),
          ]),
    ],
    object,
  );
}

function annotation(ctx: Ctx, object: XmlElement, element: 'MetaData' | 'PlantStructureItem'): XmlElement {
  return syn(element, identity(object), [...placeOf(ctx, object), ...genericAttributes(object)], object);
}

/** Node id -> (owner id, index) for every object that lists `Nodes`. Iterative. */
function indexNodes(root: XmlElement): Ctx['nodeIndex'] {
  const index: Ctx['nodeIndex'] = new Map();
  const stack: XmlElement[] = [root];
  for (let object = stack.pop(); object !== undefined; object = stack.pop()) {
    const owner = idOf(object);
    componentObjects(object, 'Nodes').forEach((node, position) => {
      const id = idOf(node);
      if (owner !== undefined && id !== undefined && !index.has(id)) index.set(id, { owner, index: position });
    });
    stack.push(...componentObjects(object));
  }
  return index;
}

const VERSION = /\/(\d+)\.(\d+)(?:\.(\d+))?\/[^/]*$/;

function versionOf(model: XmlElement): { text: string; major: number } | undefined {
  const source = xmlChildren(model, 'Import')
    .filter((entry) => ['Plant', 'Core'].includes(xmlAttr(entry, 'prefix') ?? ''))
    .map((entry) => VERSION.exec(xmlAttr(entry, 'source') ?? ''))
    .find((match) => match !== null);
  return source === null || source === undefined
    ? undefined
    : { text: [source[1], source[2], source[3]].filter((part) => part !== undefined).join('.'), major: Number(source[1]) };
}

/** Translates the `<Model>` of a DEXPI 2.0 file; a refusal names why it is not a 2.x P&ID model. */
export function proteusFrom20(model: XmlElement): From20 | From20Refusal {
  const plant = xmlChildren(model, 'Import').some((entry) => xmlAttr(entry, 'prefix') === 'Plant');
  const version = versionOf(model);
  if (!plant || version === undefined)
    return {
      ok: false,
      message: 'the <Model> imports no Plant model of a known version (expected .../models/2.x.y/Plant.xml)',
      paths: [where(model)],
    };
  if (version.major !== 2)
    return { ok: false, message: `the Plant model version ${version.text} is not read (only DEXPI 2.x)`, paths: [where(model)] };
  const engineering = xmlChildren(model, 'Object').find((object) => classOf(object) === 'EngineeringModel');
  const plantModel =
    engineering === undefined
      ? undefined
      : componentObjects(engineering, 'ConceptualModel').find((object) => classOf(object) === 'PlantModel');
  if (engineering === undefined || plantModel === undefined)
    return {
      ok: false,
      message: 'the <Model> holds no Core/EngineeringModel with a Plant/PlantModel as ConceptualModel',
      paths: [where(model)],
    };

  const facts = orient(readDiagram(componentObjects(engineering, 'Diagram')[0]));
  const issues: DexpiIssue[] = [];
  const ctx: Ctx = { facts, issues, nodeIndex: indexNodes(plantModel) };
  const known = new Set<string>(PLANT_PROPERTIES);
  for (const components of xmlChildren(plantModel, 'Components')) {
    const property = xmlAttr(components, 'property') ?? '';
    if (!known.has(property))
      issues.push(
        dexpiIssue(
          'DEXPI_UNMAPPED_CLASS',
          'warning',
          `component property "${property}" of the plant model is not read`,
          [],
          [where(components)],
        ),
      );
  }
  const body: XmlElement[] = [];
  for (const object of componentObjects(plantModel, 'TaggedPlantItems'))
    body.push(
      typeOf(object).startsWith('Plant/ProcessEquipment.') ? nozzleOrEquipment(ctx, object) : annotation(ctx, object, 'PlantStructureItem'),
    );
  for (const object of componentObjects(plantModel, 'PipingNetworkSystems')) body.push(pipingSystem(ctx, object));
  for (const object of componentObjects(plantModel, 'ProcessInstrumentationFunctions')) body.push(instrument(ctx, object));
  for (const object of componentObjects(plantModel, 'SignalConveyingFunctions')) body.push(informationFlow(ctx, object));
  for (const object of componentObjects(plantModel, 'InstrumentationLoopFunctions')) body.push(loop(object));
  for (const object of componentObjects(plantModel, 'ActuatingSystems')) body.push(actuatingSystem(ctx, object));
  for (const object of componentObjects(plantModel, 'PlantStructureItems')) body.push(annotation(ctx, object, 'PlantStructureItem'));
  for (const object of componentObjects(plantModel, 'MetaData')) body.push(annotation(ctx, object, 'MetaData'));

  const shapes = componentObjects(engineering, 'ShapeCatalogues').flatMap((catalogue) => componentObjects(catalogue, 'Shapes'));
  const { extent } = facts;
  const children: XmlElement[] = [
    syn(
      'PlantInformation',
      [
        ['SchemaVersion', version.text],
        ['Units', 'mm'],
      ],
      [],
      model,
    ),
    ...body,
    ...(extent === undefined
      ? []
      : [
          syn(
            'Drawing',
            [['Name', facts.name]],
            [
              syn(
                'Extent',
                [],
                [
                  syn(
                    'Min',
                    [
                      ['X', '0'],
                      ['Y', '0'],
                    ],
                    [],
                    model,
                  ),
                  syn(
                    'Max',
                    [
                      ['X', String(extent[0])],
                      ['Y', String(extent[1])],
                    ],
                    [],
                    model,
                  ),
                ],
                model,
              ),
            ],
            model,
          ),
        ]),
    ...(shapes.length === 0
      ? []
      : [
          syn(
            'ShapeCatalogue',
            [],
            shapes.map((shape) => syn('Shape', identity(shape), [], shape)),
            model,
          ),
        ]),
  ];
  return { ok: true, root: syn('PlantModel', [], children, model), schemaVersion: version.text, issues };
}
