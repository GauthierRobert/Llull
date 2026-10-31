/** Plant 04 PID M2: the Proteus mapper on small constructed files (units, attributes, classes, segment splitting, signals, actuating systems, warnings). */

import { describe, expect, it } from 'vitest';
import { pidPlugin } from '@aec/index';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { PidInline, PidItem, PidSegment, PidSignal } from '@aec/plant/pid/model';
import { getPid } from '@aec/plant/pid/state';

const loc = (x: number, y: number): string => `<Position><Location X="${x}" Y="${y}" Z="0"/></Position>`;
const node = (id: string, x: number, y: number): string => `<Node Type="process" ID="${id}">${loc(x, y)}</Node>`;
const ga = (...pairs: Array<[string, string]>): string =>
  `<GenericAttributes Set="DexpiAttributes">${pairs.map(([n, v]) => `<GenericAttribute Name="${n}" Format="string" Value="${v}"/>`).join('')}</GenericAttributes>`;
const centre = (...points: Array<[number, number]>): string =>
  `<CenterLine NumPoints="${points.length}">${points.map(([x, y]) => `<Coordinate X="${x}" Y="${y}"/>`).join('')}</CenterLine>`;
const component = (id: string, cls: string, ports: Array<[number, number]>, at?: [number, number], extra = ''): string =>
  `<PipingComponent ID="${id}" ComponentClass="${cls}"><ConnectionPoints NumPoints="${ports.length + 1}"><Node ID="${id}-d"/>${ports.map(([x, y], i) => node(`${id}-${i}`, x, y)).join('')}</ConnectionPoints>${at ? loc(...at) : ''}${extra}</PipingComponent>`;
const segment = (id: string, body: string, connection = '', attributes = ''): string =>
  `<PipingNetworkSegment ID="${id}" ComponentClass="PipingNetworkSegment">${attributes}${body}${connection}</PipingNetworkSegment>`;
const connection = (from: string, fromNode: number | '', to: string, toNode: number | ''): string =>
  `<Connection FromID="${from}" ${fromNode === '' ? '' : `FromNode="${fromNode}"`} ToID="${to}" ${toNode === '' ? '' : `ToNode="${toNode}"`}/>`;
const system = (id: string, segments: string, attributes = ga(['LineNumberAssignmentClass', id])): string =>
  `<PipingNetworkSystem ID="${id}" ComponentClass="PipingNetworkSystem">${attributes}${segments}</PipingNetworkSystem>`;
const proteus = (body: string, information = 'Units="mm"'): string =>
  `<?xml version="1.0"?><PlantModel><PlantInformation SchemaVersion="4.1.1" ${information}/>${body}</PlantModel>`;

function load(text: string): { pid: ReturnType<typeof getPid>; items: PidItem[]; warnings: Array<{ code: string; message: string }> } {
  const result = execute(createEmptyDocument(), 'import_dexpi', { text });
  expect(result.rejected, result.summary).toBeUndefined();
  const pid = getPid(result.document);
  expect(pidPlugin.document?.validate({ plant: JSON.parse(JSON.stringify({ pid })) as unknown })).toEqual([]);
  return {
    pid,
    items: pid.itemOrder.flatMap((id) => (pid.items[id] ? [pid.items[id]] : [])),
    warnings: (result.data as { warnings: [] }).warnings,
  };
}

const ofKind = <K extends PidItem['kind']>(items: PidItem[], kind: K): Array<Extract<PidItem, { kind: K }>> =>
  items.filter((item): item is Extract<PidItem, { kind: K }> => item.kind === kind);

describe('units, placement and attributes', () => {
  it('scales the drawing unit to mm and reads the rotation from the Reference axis', () => {
    const body = `<Equipment ID="E1" ComponentClass="Tank"><Position><Location X="0.5" Y="0.25" Z="0"/><Reference X="0" Y="1" Z="0"/></Position></Equipment>`;
    const { items } = load(proteus(body, 'Units="m"'));
    expect(ofKind(items, 'equipment')[0]).toMatchObject({ at: [500, 250], rotationDeg: 90 });
  });

  it('takes an unknown drawing unit as mm with a DEXPI_ATTRIBUTE_UNIT warning', () => {
    const { items, warnings } = load(proteus(`<Equipment ID="E1" ComponentClass="Tank">${loc(3, 4)}</Equipment>`, 'Units="furlong"'));
    expect(ofKind(items, 'equipment')[0]?.at).toEqual([3, 4]);
    expect(warnings.map((w) => w.code)).toContain('DEXPI_ATTRIBUTE_UNIT');
  });

  it('types attributes by format and keeps the rest verbatim', () => {
    const body = `<Equipment ID="E1" ComponentClass="Tank">
      <GenericAttributes Set="DexpiAttributes">
        <GenericAttribute Name="TagNamePrefixAssignmentClass" Format="string" Value="T"/>
        <GenericAttribute Name="TagNameSequenceNumberAssignmentClass" Format="string" Value="101"/>
        <GenericAttribute Name="TagNameSuffixAssignmentClass" Format="string" Value="A"/>
        <GenericAttribute Name="Height" Format="double" Units="Millimetre" Value="1500"/>
        <GenericAttribute Name="Odd" Format="double" Units="Furlong" Value="3"/>
        <GenericAttribute Name="Odd2" Format="double" Units="Furlong" Value="4"/>
        <GenericAttribute Name="Bad" Format="double" Units="Bar" Value="abc"/>
        <GenericAttribute Name="Kind" Format="anyURI" Value="Vertical" ValueURI="http://x/y"/>
        <GenericAttribute Name="Plain" Format="anyURI" Value="Plain"/>
        <GenericAttribute Name="Empty" Format="string"/>
        <GenericAttribute Name="constructor" Format="string" Value="c"/>
        <GenericAttribute Name="__proto__" Format="string" Value="p"/>
        <GenericAttribute Format="string" Value="nameless"/>
        <GenericAttribute Name="" Format="string" Value="empty name"/>
      </GenericAttributes>
      <GenericAttributes Set="DexpiCustomAttributes"><GenericAttribute Name="Owner" Format="string" Value="me"/></GenericAttributes>
    </Equipment>`;
    const { items, warnings } = load(proteus(body));
    const tank = ofKind(items, 'equipment')[0];
    expect(tank?.tag).toBe('T101A');
    expect(tank?.attributes['Height']).toEqual({ kind: 'quantity', value: 1500, unit: 'Millimetre' });
    expect(tank?.attributes['Odd']).toEqual({ kind: 'text', value: '3 Furlong', unverified: true });
    expect(tank?.attributes['Bad']).toEqual({ kind: 'text', value: 'abc Bar', unverified: true });
    expect(tank?.attributes['Kind']).toEqual({ kind: 'enum', value: 'Vertical', uri: 'http://x/y' });
    expect(tank?.attributes['Plain']).toEqual({ kind: 'enum', value: 'Plain' });
    expect(tank?.attributes['Empty']).toEqual({ kind: 'text', value: '' });
    expect(tank?.attributes['attr:constructor']).toEqual({ kind: 'text', value: 'c' });
    expect(Object.keys(tank?.attributes ?? {})).toContain('attr:__proto__');
    expect(tank?.passthrough).toEqual({ 'DexpiCustomAttributes:Owner': 'me' });
    const unitWarnings = warnings.filter((w) => w.code === 'DEXPI_ATTRIBUTE_UNIT');
    expect(unitWarnings.map((w) => w.message.split(':')[0])).toEqual(['attribute Odd', 'attribute Bad']);
  });
});

describe('equipment, nozzles and classes', () => {
  it('maps sub-equipment, nozzles (sub tag, DN from a node, access), unknown classes and unknown elements', () => {
    const body = `
      <Equipment ID="E1" ComponentClass="Tank" ComponentClassURI="http://rdl/tank">${ga(['TagNameAssignmentClass', 'T-1'])}${loc(10, 20)}
        <Nozzle ID="N1" ComponentClass="Nozzle" ComponentName="MANHOLE_SHAPE">${ga(['SubTagNameAssignmentClass', 'N1'], ['NominalDiameterRepresentationAssignmentClass', 'DN 800'])}</Nozzle>
        <Nozzle ID="N2" ComponentClass="Nozzle">${loc(5, 6)}<ConnectionPoints NumPoints="2"><Node ID="d"/><Node Type="process" ID="n">${ga(['NominalDiameterNumericalValueRepresentationAssignmentClass', '50'])}${loc(7, 8)}</Node></ConnectionPoints></Nozzle>
        <Nozzle>${ga(['NominalDiameterNumericalValueRepresentationAssignmentClass', 'x'])}</Nozzle>
        <Equipment ID="E1a" ComponentClass="Chamber"/>
        <Label ID="l"/>
      </Equipment>
      <Equipment ID="E2" ComponentClass="FlyingCarpet"/>
      <Equipment/>
      <Mystery ID="m"/>
      <PlantStructureItem ID="P1" ComponentClass="PlantStructureItem">${ga(['SiteNameAssignmentClass', 'Site A'])}</PlantStructureItem>
      <MetaData ID="M1"/>`;
    const { items, warnings } = load(proteus(body));
    const equipment = ofKind(items, 'equipment');
    expect(equipment.map((e) => [e.dexpiClass, e.tag, e.parentId === undefined])).toEqual([
      ['Tank', 'T-1', true],
      ['Chamber', undefined, false],
      ['Custom', undefined, true],
      ['Custom', undefined, true],
    ]);
    expect(equipment[0]).toMatchObject({ at: [10, 20], classUri: 'http://rdl/tank', sourceId: 'E1' });
    expect(equipment[1]?.parentId).toBe(equipment[0]?.id);
    expect(equipment[2]?.passthrough).toEqual({ 'dexpi:ComponentClass': 'FlyingCarpet' });
    expect(equipment[3]?.passthrough).toEqual({ 'dexpi:ComponentClass': '' });
    const nozzles = ofKind(items, 'nozzle');
    expect(nozzles.map((n) => [n.subTag, n.dn, n.access, n.port])).toEqual([
      ['N1', 800, true, [0, 0]],
      ['N2', 50, undefined, [7, 8]],
      ['N', undefined, undefined, [0, 0]],
    ]);
    expect(nozzles[0]?.attributes['nominalDiameterText']).toEqual({ kind: 'text', value: 'DN 800' });
    expect(items.filter((item) => item.kind === 'annotation').map((a) => [a.dexpiClass, a.sourceId])).toEqual([
      ['PlantStructureItem', 'P1'],
      ['MetaData', 'M1'],
    ]);
    expect(warnings.filter((w) => w.code === 'DEXPI_UNMAPPED_CLASS').map((w) => w.message)).toEqual([
      'class "FlyingCarpet" has no llull mapping; imported as Custom',
      'class "" has no llull mapping; imported as Custom',
      'element <Mystery> is not read',
    ]);
    expect(warnings.find((w) => w.code === 'DEXPI_GRAPHICS_DROPPED')?.message).toContain('Label 1');
  });
});

describe('piping: segments split at components', () => {
  const pieces = (items: PidItem[], key: string): PidSegment[] =>
    ofKind(items, 'segment').filter((s) => s.passthrough?.['dexpi:segment'] === key);

  it('splits a segment without Connection into pieces between free ends and its components', () => {
    const body = system(
      'L1',
      segment(
        'S1',
        centre([0, 0], [10, 0]) +
          component(
            'V1',
            'BallValve',
            [
              [10, 0],
              [14, 0],
            ],
            [12, 0],
          ) +
          centre([14, 0], [30, 0]) +
          component('V2', 'MysteryValve', [
            [30, 0],
            [34, 0],
          ]) +
          `<PipeOffPageConnector ID="O1" ComponentClass="FlowOutPipeOffPageConnector">${ga(['PipeConnectorNumberAssignmentClass', '7'])}<ConnectionPoints NumPoints="2"><Node ID="d"/>${node('o', 50, 0)}</ConnectionPoints></PipeOffPageConnector>` +
          `<PipeFlowArrow ID="A1" ComponentName="ARROW"/><PipeSlopeSymbol ID="SL"/>`,
      ),
    );
    const { items, warnings } = load(proteus(body));
    const [first, middle, last] = pieces(items, 'S1');
    const [v1, v2] = ofKind(items, 'inline');
    expect(pieces(items, 'S1')).toHaveLength(3);
    expect(first).toMatchObject({
      from: { type: 'free', at: [0, 0] },
      to: { type: 'inline', itemId: v1?.id, node: 0 },
      route: [
        [0, 0],
        [10, 0],
      ],
      flow: 'none',
      sourceId: 'S1',
    });
    expect(middle).toMatchObject({
      from: { type: 'inline', itemId: v1?.id, node: 1 },
      to: { type: 'inline', itemId: v2?.id, node: 0 },
      route: [
        [14, 0],
        [30, 0],
      ],
    });
    expect(middle?.sourceId).toBeUndefined();
    expect(last).toMatchObject({ from: { type: 'inline', itemId: v2?.id, node: 1 }, to: { type: 'free', at: [34, 0] } });
    expect(v2).toMatchObject({ at: [32, 0], dexpiClass: 'Custom' });
    expect(ofKind(items, 'opc')[0]).toMatchObject({ direction: 'out', pairKey: '7', at: [50, 0] });
    expect(items.filter((item) => item.kind === 'annotation').map((a) => a.dexpiClass)).toEqual(['PipeFlowArrow']);
    expect(warnings.map((w) => w.code)).toEqual(['DEXPI_UNMAPPED_CLASS', 'DEXPI_GRAPHICS_DROPPED']);
    const line = ofKind(items, 'line')[0];
    expect(line?.segmentIds).toEqual(pieces(items, 'S1').map((s) => s.id));
    expect(line?.lineNumber).toBe('L1');
  });

  it('does not repeat the component a Connection starts or ends on, and keeps one piece for a lone component', () => {
    const v = (id: string, x: number): string =>
      component(
        id,
        'GlobeValve',
        [
          [x, 0],
          [x + 4, 0],
        ],
        [x + 2, 0],
      );
    const body = system(
      'L1',
      segment('S3', centre([0, 0], [4, 0]) + v('V3', 0) + centre([4, 0], [20, 0]) + v('V4', 20), connection('V3', 2, 'V4', 2)) +
        segment('S4', v('V5', 40), connection('V5', 1, 'V5', 2)) +
        segment('S5', centre([60, 0], [70, 0]), connection('V3', 1, 'V4', 1)),
    );
    const { items } = load(proteus(body));
    const [v3, v4, v5] = ofKind(items, 'inline');
    const s3 = pieces(items, 'S3');
    expect(s3).toHaveLength(1);
    expect(s3[0]).toMatchObject({
      from: { type: 'inline', itemId: v3?.id, node: 1 },
      to: { type: 'inline', itemId: v4?.id, node: 0 },
      flow: 'forward',
    });
    expect(pieces(items, 'S4')).toHaveLength(1);
    expect(pieces(items, 'S4')[0]).toMatchObject({ from: { itemId: v5?.id, node: 0 }, to: { itemId: v5?.id, node: 1 } });
    expect(pieces(items, 'S5')[0]).toMatchObject({
      from: { itemId: v3?.id, node: 0 },
      to: { itemId: v4?.id, node: 0 },
      route: [
        [60, 0],
        [70, 0],
      ],
    });
  });

  it('turns a reference to nothing, to an equipment or to an unknown node into a free end or a nearest port with a warning', () => {
    const body =
      `<Equipment ID="E1" ComponentClass="Tank"/>` +
      system(
        'L1',
        segment('S1', centre([0, 0], [5, 0]), connection('E1', 1, 'GHOST', 1)) +
          segment(
            'S2',
            component(
              'V1',
              'GlobeValve',
              [
                [10, 0],
                [14, 0],
              ],
              [12, 0],
            ),
            '<Connection ToID="V1" ToNode="9"/>',
          ) +
          segment('S3', '', '<Connection FromID="S1"/>'),
      );
    const { items, warnings } = load(proteus(body));
    const s1 = pieces(items, 'S1')[0];
    expect(s1).toMatchObject({ from: { type: 'free' }, to: { type: 'free' } });
    expect(warnings.filter((w) => w.code === 'DEXPI_DANGLING_REFERENCE').map((w) => w.message)).toEqual([
      '"E1" cannot take a connection; the end was imported as free',
      '"GHOST" names no object; the end was imported as free',
    ]);
    expect(pieces(items, 'S2').at(-1)?.to).toMatchObject({ type: 'inline' });
    const dangling = execute(createEmptyDocument(), 'import_dexpi', { text: proteus(body) }).document;
    expect(dangling.plant?.pid?.imports?.[0]?.census).toMatchObject({ connections: 3, danglingConnections: 1 });
  });

  it('reads primary / secondary, DN and class from the segment, falling back to the line', () => {
    const lineAttributes = ga(
      ['LineNumberAssignmentClass', '9'],
      ['NominalDiameterRepresentationAssignmentClass', 'DN 100'],
      ['PipingClassCodeAssignmentClass', 'A1'],
    );
    const own = ga(
      ['PrimarySecondaryPipingNetworkSegmentSpecialization', 'SecondaryPipingNetworkSegment'],
      ['NominalDiameterNumericalValueRepresentationAssignmentClass', '25'],
      ['PipingClassCodeAssignmentClass', 'B2'],
    );
    const body = system('L1', segment('S1', centre([0, 0], [1, 0]), '', own) + segment('S2', centre([0, 0], [1, 0])), lineAttributes);
    const { items } = load(proteus(body));
    expect(ofKind(items, 'segment').map((s) => [s.primary, s.dn, s.pipingClass])).toEqual([
      [false, 25, 'B2'],
      [true, 100, 'A1'],
    ]);
    expect(ofKind(items, 'line')[0]).toMatchObject({ dn: 100, pipingClass: 'A1' });
  });
});

describe('instrumentation: instruments, actuating systems, loops and signals', () => {
  const instrument = (id: string, attributes: Array<[string, string]>, extra = ''): string =>
    `<ProcessInstrumentationFunction ID="${id}" ComponentClass="ProcessInstrumentationFunction">${ga(...attributes)}${extra}</ProcessInstrumentationFunction>`;
  const valve = system(
    'L1',
    segment(
      'S1',
      component(
        'V1',
        'BallValve',
        [
          [0, 0],
          [4, 0],
        ],
        [2, 0],
      ) +
        component(
          'V2',
          'GlobeValve',
          [
            [10, 0],
            [14, 0],
          ],
          [12, 0],
        ),
    ),
  );
  const actuating = (id: string, device: string, fail: string, valveId: string): string =>
    `<ActuatingSystem ID="${id}" ComponentClass="ActuatingSystem">${ga(['ActuatingSystemNumberAssignmentClass', id])}
       <ActuatingSystemComponent ID="${id}-ca" ComponentClass="ControlledActuator">${ga(['DeviceTypeNameAssignmentClass', device], ['FailActionSpecialization', fail])}${loc(1, 9)}</ActuatingSystemComponent>
       <ActuatingSystemComponent ID="${id}-vr" ComponentClass="OperatedValveReference">${ga(['SubTagNameAssignmentClass', 'YV'])}<Association Type="refers to" ItemID="${valveId}"/></ActuatingSystemComponent>
     </ActuatingSystem>`;

  it('maps instruments, actuating systems (device, fail action, controller, operated valve), loops and the three kinds of dangling reference', () => {
    const body =
      valve +
      instrument(
        'PIF1',
        [
          ['ProcessInstrumentationFunctionCategoryAssignmentClass', 'T'],
          ['ProcessInstrumentationFunctionsAssignmentClass', 'IC'],
          ['ProcessInstrumentationFunctionNumberAssignmentClass', '9'],
          ['LocationSpecialization', 'LocalPanel'],
        ],
        `<ActuatingFunction ID="AF1" ComponentClass="ActuatingFunction"><Association Type="is fulfilled by" ItemID="AS1"/></ActuatingFunction>
         <ActuatingFunction ID="AF2" ComponentClass="ActuatingFunction"/>`,
      ) +
      instrument('PIF2', [['LocationSpecialization', 'AuxiliaryLocation']]) +
      instrument('PIF3', [
        ['ProcessInstrumentationFunctionNumberAssignmentClass', '3'],
        ['LocationSpecialization', 'CentralLocation'],
      ]) +
      instrument('PIF4', [['ProcessInstrumentationFunctionCategoryAssignmentClass', 'P']]) +
      actuating('AS1', 'Spring-diaphragm', 'FailOpen', 'V1') +
      actuating('AS2', 'Electric', 'FailLock', 'V2') +
      actuating('AS3', 'Hydraulic piston', 'Unknown', 'V1') +
      actuating('AS4', 'Solenoid', 'FailIndeterminate', 'GHOST') +
      `<ActuatingSystem ID="AS5" ComponentClass="ActuatingSystem"/>` +
      `<InstrumentationLoopFunction ID="LP1" ComponentClass="InstrumentationLoopFunction">${ga(['InstrumentationLoopFunctionNumberAssignmentClass', '9'])}
         <Association Type="is a collection including" ItemID="PIF1"/><Association Type="is a collection including" ItemID="V1"/></InstrumentationLoopFunction>
       <InstrumentationLoopFunction ID="LP2" ComponentClass="InstrumentationLoopFunction"/>`;
    const { items, warnings } = load(proteus(body));
    const instruments = ofKind(items, 'instrument');
    expect(instruments.map((i) => [i.tag, i.location])).toEqual([
      ['TIC 9', 'local_panel'],
      [undefined, 'auxiliary'],
      ['3', 'central'],
      ['P', 'field'],
    ]);
    const systems = ofKind(items, 'actuating');
    expect(systems.map((s) => [s.tag, s.actuator, s.failAction, s.controllerId === instruments[0]?.id])).toEqual([
      ['AS1', 'diaphragm', 'FO', true],
      ['AS2', 'motor', 'FL', false],
      ['AS3', 'piston', undefined, false],
    ]);
    expect(systems[0]?.attributes['OperatedValveReference.SubTagNameAssignmentClass']).toEqual({ kind: 'text', value: 'YV' });
    expect(systems[0]?.at).toEqual([1, 9]);
    const [v1, v2] = ofKind(items, 'inline');
    expect([v1?.operated, v2?.operated]).toEqual([true, true]);
    expect(items.filter((i) => i.kind === 'loop')).toHaveLength(2);
    expect(instruments[0]?.loopId).toBeDefined();
    const messages = warnings.filter((w) => w.code === 'DEXPI_DANGLING_REFERENCE').map((w) => w.message);
    expect(messages).toEqual([
      'actuating system AS4 names the valve "GHOST" which is not an imported piping component; the system was not imported',
      'actuating system AS5 names no valve; the system was not imported',
      'loop LP1 names 1 member(s) that are not imported instruments',
    ]);
  });

  it('builds signals from a Connection or from the logical start / end, with the signal kind from the class', () => {
    const flow = (id: string, cls: string, body: string): string =>
      `<InformationFlow ID="${id}" ComponentClass="${cls}">${body}</InformationFlow>`;
    const start = (id: string): string => `<Association Type="has logical start" ItemID="${id}"/>`;
    const end = (id: string): string => `<Association Type="has logical end" ItemID="${id}"/>`;
    const body =
      valve +
      `<ProcessInstrumentationFunction ID="PIF1" ComponentClass="ProcessInstrumentationFunction">${ga(['ProcessInstrumentationFunctionNumberAssignmentClass', '1'])}${loc(50, 50)}
         <ProcessSignalGeneratingFunction ID="PSG1" ComponentClass="ProcessSignalGeneratingFunction"><Association Type="is located in" ItemID="V1"/></ProcessSignalGeneratingFunction>
         <ProcessSignalGeneratingFunction ID="PSG2" ComponentClass="ProcessSignalGeneratingFunction"><Association Type="is located in" ItemID="S1"/></ProcessSignalGeneratingFunction>
         <ProcessSignalGeneratingFunction ID="PSG3" ComponentClass="ProcessSignalGeneratingFunction"/>
         ${flow('F1', 'MeasuringLineFunction', start('PSG1') + end('PIF1'))}
         ${flow('F2', 'PneumaticSignalLine', start('PSG2') + end('PIF1') + centre([1, 1], [2, 2]))}
         ${flow('F3', 'SoftwareLink', start('PSG3') + end('NOWHERE'))}
         ${flow('F4', 'CapillaryTube', '')}
       </ProcessInstrumentationFunction>` +
      flow('F5', 'SignalConveyingFunction', '<Connection FromID="PIF1" FromNode="1" ToID="V2" ToNode="2"/>');
    const { items } = load(proteus(body));
    const signals: PidSignal[] = ofKind(items, 'signal');
    const [v1, v2] = ofKind(items, 'inline') as [PidInline, PidInline];
    const segmentId = ofKind(items, 'segment')[0]?.id;
    expect(signals.map((s) => s.signalKind)).toEqual(['measuring', 'pneumatic', 'software', 'capillary', 'electric']);
    expect(signals[0]).toMatchObject({ from: { type: 'inline', itemId: v1.id }, to: { type: 'instrument' } });
    expect(signals[1]).toMatchObject({
      from: { type: 'branch', segmentId },
      route: [
        [1, 1],
        [2, 2],
      ],
    });
    expect(signals[2]?.from.type).toBe('free');
    expect(signals[3]).toMatchObject({ from: { type: 'free' }, to: { type: 'free' } });
    expect(signals[4]).toMatchObject({ from: { type: 'instrument' }, to: { type: 'inline', itemId: v2.id, node: 1 } });
  });
});

describe('warnings are bounded', () => {
  it('lists at most 200 findings and says how many more there were', () => {
    const body = Array.from({ length: 260 }, (_, i) => `<Equipment ID="E${i}" ComponentClass="Odd${i}"/>`).join('');
    const { warnings, pid } = load(proteus(body));
    expect(warnings).toHaveLength(201);
    expect(warnings[200]?.message).toBe('60 more finding(s) not listed (codes DEXPI_UNMAPPED_CLASS)');
    expect(pid.imports?.[0]?.warnings).toHaveLength(201);
  });
});
