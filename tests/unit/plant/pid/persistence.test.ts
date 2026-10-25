/**
 * Plant 04 PID M1: the `plant.pid` slice survives save and load (TR-PID model), and a hand-edited file that breaks an invariant is refused with
 * its path. Imported data may repeat a tag: that loads (check_pid reports it later).
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { PidItem, PidModel } from '@aec/plant/pid/model';
import { DEFAULT_LINE_NUMBER_FORMAT, EMPTY_PID, getPid, withPid } from '@aec/plant/pid/state';
import { pidErrors } from '@aec/plant/pid/validate';
import { expectPure } from '../../../helpers/expectNoOp';

const base = { sheetId: 'pid-1.1', rotationDeg: 0, attributes: {} } as const;

const items: PidItem[] = [
  {
    ...base,
    id: 'pid-2.1',
    kind: 'equipment',
    at: [100, 100],
    dexpiClass: 'Tank',
    tag: 'T-101',
    attributes: { DesignPressure: { kind: 'quantity', value: 3.5, unit: 'bar' } },
  },
  { ...base, id: 'pid-2.2', kind: 'equipment', at: [110, 110], dexpiClass: 'Heater', tag: 'E-1', parentId: 'pid-2.1' },
  {
    ...base,
    id: 'pid-2.3',
    kind: 'nozzle',
    at: [130, 100],
    dexpiClass: 'Nozzle',
    equipmentId: 'pid-2.1',
    subTag: 'N1',
    dn: 100,
    access: false,
    port: [130, 100],
  },
  {
    ...base,
    id: 'pid-3.1',
    kind: 'line',
    at: [0, 0],
    dexpiClass: 'PipingNetworkSystem',
    lineNumber: '100-P-1001-A1A',
    dn: 100,
    pipingClass: 'A1A',
    fluidCode: 'P',
    segmentIds: ['pid-3.2', 'pid-3.3', 'pid-5.2'],
  },
  {
    ...base,
    id: 'pid-3.2',
    kind: 'segment',
    at: [0, 0],
    dexpiClass: 'PipingNetworkSegment',
    lineId: 'pid-3.1',
    from: { type: 'nozzle', itemId: 'pid-2.3' },
    to: { type: 'inline', itemId: 'pid-3.4', node: 0 },
    route: [
      [130, 100],
      [200, 100],
    ],
    flow: 'forward',
    dn: 100,
    primary: true,
  },
  {
    ...base,
    id: 'pid-3.3',
    kind: 'segment',
    at: [0, 0],
    dexpiClass: 'PipingNetworkSegment',
    lineId: 'pid-3.1',
    from: { type: 'inline', itemId: 'pid-3.4', node: 1 },
    to: { type: 'opc', itemId: 'pid-3.7' },
    route: [
      [210, 100],
      [300, 100],
    ],
    flow: 'forward',
    primary: false,
  },
  {
    ...base,
    id: 'pid-3.4',
    kind: 'inline',
    at: [205, 100],
    dexpiClass: 'GlobeValve',
    tag: 'HV-102',
    ports: [
      [200, 100],
      [210, 100],
    ],
    dn: 100,
    operated: true,
    reversed: false,
  },
  { ...base, id: 'pid-4.1', kind: 'loop', at: [250, 200], dexpiClass: 'InstrumentationLoopFunction' },
  {
    ...base,
    id: 'pid-4.2',
    kind: 'instrument',
    at: [250, 180],
    dexpiClass: 'ProcessInstrumentationFunction',
    tag: 'FIC-101',
    category: 'F',
    functions: 'IC',
    loopNumber: '101',
    location: 'field',
    display: 'discrete',
    loopId: 'pid-4.1',
  },
  {
    ...base,
    id: 'pid-4.3',
    kind: 'actuating',
    at: [205, 120],
    dexpiClass: 'ActuatingSystem',
    valveId: 'pid-3.4',
    actuator: 'diaphragm',
    failAction: 'FC',
    controllerId: 'pid-4.2',
  },
  {
    ...base,
    id: 'pid-4.4',
    kind: 'signal',
    at: [0, 0],
    dexpiClass: 'SignalLineFunction',
    signalKind: 'pneumatic',
    from: { type: 'instrument', itemId: 'pid-4.2' },
    to: { type: 'instrument', itemId: 'pid-4.3' },
    route: [
      [250, 180],
      [205, 120],
    ],
  },
  {
    ...base,
    id: 'pid-3.7',
    kind: 'opc',
    at: [300, 100],
    dexpiClass: 'PipeOffPageConnector',
    direction: 'out',
    pairKey: 'OPC-1',
    targetSheet: 'pid-1.2',
  },
  { ...base, id: 'pid-5.1', kind: 'annotation', at: [10, 10], dexpiClass: 'Note', passthrough: { Text: 'hello' }, sourceId: 'Label-1' },
  {
    ...base,
    id: 'pid-5.2',
    kind: 'segment',
    at: [0, 0],
    dexpiClass: 'PipingNetworkSegment',
    lineId: 'pid-3.1',
    from: { type: 'branch', segmentId: 'pid-3.2', at: [150, 100] },
    to: { type: 'free', at: [150, 50] },
    route: [
      [150, 100],
      [150, 50],
    ],
    flow: 'none',
    primary: false,
  },
];

const model: PidModel = {
  version: 1,
  convention: 'ISO-10628-2',
  lineNumberFormat: '{dn}-{fluid}-{seq}-{class}',
  tagFormats: { equipment: { pattern: '^[A-Z]-\\d{3}$', separator: '-' } },
  sheets: {
    'pid-1.1': { id: 'pid-1.1', number: 'PID-001', title: 'Feed', paper: 'A1', revision: 'A', status: 'draft' },
    'pid-1.2': {
      id: 'pid-1.2',
      number: 'PID-002',
      title: 'Product',
      paper: 'A1',
      revision: '0',
      status: 'issued_for_construction',
      issuedBy: { signer: 'J. Doe', at: '2026-10-25' },
    },
  },
  sheetOrder: ['pid-1.1', 'pid-1.2'],
  items: Object.fromEntries(items.map((item) => [item.id, item])),
  itemOrder: items.map((item) => item.id),
  acceptances: { 'pid:PID_SIZE_MISMATCH:pid-3.4': { reason: 'reducer on the next sheet', by: 'J. Doe', at: '2026-10-25' } },
  imports: [{ format: 'dexpi-proteus', version: '4.1.1', sha256: 'a'.repeat(64), warnings: ['DEXPI_UNMAPPED_CLASS Foo'] }],
  counters: { seq: 3 },
};

const documentWith = (pid: PidModel): CadDocument => withPid(createEmptyDocument(), pid);

/** The saved text of `model` with `edit` applied to the JSON of the slice, then validated. */
function errorsAfter(edit: (slice: Record<string, unknown>) => void): string[] {
  const slice = JSON.parse(JSON.stringify(model)) as Record<string, unknown>;
  edit(slice);
  return pidErrors(slice);
}

const at = (slice: Record<string, unknown>, id: string): Record<string, unknown> =>
  (slice['items'] as Record<string, Record<string, unknown>>)[id] as Record<string, unknown>;

describe('plant.pid state', () => {
  it('reads an empty model from a document without the slice and keeps the other plant slices when writing', () => {
    const doc = createEmptyDocument();
    expect(getPid(doc)).toBe(EMPTY_PID);
    expect(EMPTY_PID.lineNumberFormat).toBe(DEFAULT_LINE_NUMBER_FORMAT);
    expect(pidErrors(EMPTY_PID)).toEqual([]);
    const withOther = { ...doc, plant: { fabrication: { version: 1 as const, pcfLines: {} } } };
    const written = withPid(withOther, model);
    expect(written.plant?.fabrication).toBe(withOther.plant.fabrication);
    expect(getPid(written)).toBe(model);
    expectPure(withOther, () => withPid(withOther, model));
  });
});

describe('plant.pid persistence', () => {
  it('the fixture is valid', () => {
    expect(pidErrors(JSON.parse(JSON.stringify(model)))).toEqual([]);
  });

  it('round trips the slice exactly and re-serialises the same text', () => {
    const doc = documentWith(model);
    const text = serializeDocument(doc);
    const loaded = deserializeDocument(text);
    expect(loaded.plant?.pid).toEqual(model);
    expect(serializeDocument(loaded)).toBe(text);
  });

  it('loads a document without the slice and refuses a slice that is not an object', () => {
    expect(pidErrors(undefined)).toEqual([]);
    expect(pidErrors([])).toEqual(['plant.pid must be an object']);
    expect(deserializeDocument(serializeDocument(createEmptyDocument())).plant?.pid).toBeUndefined();
  });

  it('refuses a corrupt file when it is loaded, naming the path', () => {
    const doc = documentWith({
      ...model,
      items: { ...model.items, 'pid-2.3': { ...(model.items['pid-2.3'] as PidItem), equipmentId: 'pid-9.9' } as PidItem },
    });
    expect(() => deserializeDocument(serializeDocument(doc))).toThrow(
      /plant\.pid\.items\.pid-2\.3\.equipmentId must name an item of kind equipment/,
    );
  });

  it('loads repeated tags: tag uniqueness is a check finding, not a load error', () => {
    const twin: PidItem = { ...(items[0] as PidItem), id: 'pid-2.9' };
    const doc = documentWith({ ...model, items: { ...model.items, [twin.id]: twin }, itemOrder: [...model.itemOrder, twin.id] });
    expect(deserializeDocument(serializeDocument(doc)).plant?.pid?.itemOrder).toHaveLength(model.itemOrder.length + 1);
  });

  const cases: Array<[label: string, edit: (slice: Record<string, unknown>) => void, expected: RegExp]> = [
    ['version', (s) => (s['version'] = 2), /version must be 1/],
    ['convention', (s) => (s['convention'] = 'DIN'), /convention must be/],
    ['line number format', (s) => (s['lineNumberFormat'] = ''), /lineNumberFormat/],
    ['tag formats shape', (s) => (s['tagFormats'] = []), /tagFormats must be an object/],
    ['tag format kind', (s) => (s['tagFormats'] = { pump: { pattern: 'x', separator: '-' } }), /the kind must be/],
    ['tag format entry', (s) => (s['tagFormats'] = { equipment: { pattern: 3 } }), /must be \{ pattern: string/],
    ['tag format regex', (s) => (s['tagFormats'] = { valve: { pattern: '(', separator: '-' } }), /regular expression/],
    ['sheets shape', (s) => (s['sheets'] = 3), /sheets must be an object/],
    ['sheet order', (s) => (s['sheetOrder'] = ['pid-1.1']), /sheetOrder must list every sheet/],
    ['sheet id', (s) => ((s['sheets'] as Record<string, Record<string, unknown>>)['pid-1.1']!['id'] = 'x'), /id must equal its key/],
    [
      'sheet number',
      (s) => ((s['sheets'] as Record<string, Record<string, unknown>>)['pid-1.1']!['number'] = ''),
      /number must be a non-empty string/,
    ],
    [
      'duplicate sheet number',
      (s) => ((s['sheets'] as Record<string, Record<string, unknown>>)['pid-1.1']!['number'] = 'PID-002'),
      /used by another sheet/,
    ],
    ['sheet title', (s) => ((s['sheets'] as Record<string, Record<string, unknown>>)['pid-1.1']!['title'] = 3), /title must be a string/],
    ['sheet paper', (s) => ((s['sheets'] as Record<string, Record<string, unknown>>)['pid-1.1']!['paper'] = 'B1'), /paper must be/],
    [
      'sheet revision',
      (s) => ((s['sheets'] as Record<string, Record<string, unknown>>)['pid-1.1']!['revision'] = 1),
      /revision must be a string/,
    ],
    ['sheet status', (s) => ((s['sheets'] as Record<string, Record<string, unknown>>)['pid-1.1']!['status'] = 'final'), /status must be/],
    [
      'sheet issuedBy shape',
      (s) => ((s['sheets'] as Record<string, Record<string, unknown>>)['pid-1.1']!['issuedBy'] = { signer: '' }),
      /issuedBy must be/,
    ],
    [
      'construction issue without signer',
      (s) => delete (s['sheets'] as Record<string, Record<string, unknown>>)['pid-1.2']!['issuedBy'],
      /needs issuedBy/,
    ],
    ['sheet shape', (s) => ((s['sheets'] as Record<string, unknown>)['pid-1.1'] = 3), /sheets\.pid-1\.1 must be an object/],
    ['item order', (s) => (s['itemOrder'] = []), /itemOrder must list every item/],
    ['items shape', (s) => (s['items'] = []), /items must be an object/],
    ['item shape', (s) => ((s['items'] as Record<string, unknown>)['pid-2.1'] = 3), /items\.pid-2\.1 must be an object/],
    ['item id', (s) => (at(s, 'pid-2.1')['id'] = 'x'), /id must equal its key/],
    ['item kind', (s) => (at(s, 'pid-2.1')['kind'] = 'valve'), /kind must be one of/],
    ['item sheet', (s) => (at(s, 'pid-2.1')['sheetId'] = 'nope'), /sheetId must name a sheet/],
    ['item position', (s) => (at(s, 'pid-2.1')['at'] = [1]), /\.at must be two finite numbers/],
    ['item rotation', (s) => (at(s, 'pid-2.1')['rotationDeg'] = null), /rotationDeg/],
    ['item class', (s) => (at(s, 'pid-2.1')['dexpiClass'] = ''), /dexpiClass/],
    ['item tag', (s) => (at(s, 'pid-2.1')['tag'] = 5), /tag must be a string/],
    ['item attributes', (s) => (at(s, 'pid-2.1')['attributes'] = []), /attributes must be an object/],
    ['attribute kind', (s) => (at(s, 'pid-2.1')['attributes'] = { A: { kind: 'blob' } }), /kind must be text, quantity or enum/],
    [
      'attribute quantity',
      (s) => (at(s, 'pid-2.1')['attributes'] = { A: { kind: 'quantity', value: 'x', unit: '' } }),
      /value must be a finite number/,
    ],
    [
      'attribute unit',
      (s) => (at(s, 'pid-2.1')['attributes'] = { A: { kind: 'quantity', value: 1, unit: '' } }),
      /unit must be a non-empty string/,
    ],
    [
      'attribute flag',
      (s) => (at(s, 'pid-2.1')['attributes'] = { A: { kind: 'text', value: 'x', defaulted: false } }),
      /defaulted must be true when present/,
    ],
    ['attribute text', (s) => (at(s, 'pid-2.1')['attributes'] = { A: { kind: 'text', value: 3 } }), /value must be a string/],
    ['attribute enum', (s) => (at(s, 'pid-2.1')['attributes'] = { A: { kind: 'enum', value: 'a', uri: 3 } }), /uri must be a string/],
    ['attribute shape', (s) => (at(s, 'pid-2.1')['attributes'] = { A: 3 }), /attributes\.A must be an object/],
    ['passthrough', (s) => (at(s, 'pid-5.1')['passthrough'] = { Text: 3 }), /passthrough must map strings to strings/],
    ['parent kind', (s) => (at(s, 'pid-2.2')['parentId'] = 'pid-2.3'), /parentId must name an item of kind equipment/],
    ['parent cycle', (s) => (at(s, 'pid-2.1')['parentId'] = 'pid-2.2'), /returns to the item itself/],
    ['nozzle sub-tag', (s) => (at(s, 'pid-2.3')['subTag'] = ''), /subTag/],
    ['nozzle dn', (s) => (at(s, 'pid-2.3')['dn'] = 2.5), /dn must be a positive integer/],
    ['nozzle access', (s) => (at(s, 'pid-2.3')['access'] = 'yes'), /access must be a boolean/],
    ['nozzle port', (s) => (at(s, 'pid-2.3')['port'] = [Infinity, 0].map(String)), /port must be two finite numbers/],
    ['line segments', (s) => (at(s, 'pid-3.1')['segmentIds'] = 'x'), /segmentIds must be an array/],
    ['line segment kind', (s) => (at(s, 'pid-3.1')['segmentIds'] = ['pid-2.1']), /segmentIds\[0\] must name a segment/],
    [
      'line segment owner',
      (s) => {
        (s['items'] as Record<string, unknown>)['pid-3.8'] = { ...at(s, 'pid-3.1'), id: 'pid-3.8', segmentIds: ['pid-3.2'] };
        (s['itemOrder'] as string[]).push('pid-3.8');
      },
      /segmentIds\[0\] belongs to another line/,
    ],
    ['line text', (s) => (at(s, 'pid-3.1')['pipingClass'] = 3), /pipingClass must be a string/],
    ['segment line', (s) => (at(s, 'pid-3.2')['lineId'] = 'pid-2.1'), /lineId must name an item of kind line/],
    ['segment owner', (s) => ((at(s, 'pid-3.1')['segmentIds'] = ['pid-5.1']), void 0), /segmentIds\[0\]/],
    [
      'segment nozzle end',
      (s) => (at(s, 'pid-3.2')['from'] = { type: 'nozzle', itemId: 'pid-3.4' }),
      /from\.itemId must name an item of kind nozzle/,
    ],
    [
      'segment inline node',
      (s) => (at(s, 'pid-3.2')['to'] = { type: 'inline', itemId: 'pid-3.4', node: 2 }),
      /to\.node must be a port index/,
    ],
    [
      'segment inline kind',
      (s) => (at(s, 'pid-3.2')['to'] = { type: 'inline', itemId: 'pid-2.1', node: 0 }),
      /to\.itemId must name an item of kind inline/,
    ],
    ['segment opc end', (s) => (at(s, 'pid-3.3')['to'] = { type: 'opc', itemId: 'pid-2.1' }), /to\.itemId must name an item of kind opc/],
    [
      'segment branch end',
      (s) => (at(s, 'pid-5.2')['from'] = { type: 'branch', segmentId: 'pid-2.1', at: [0, 0] }),
      /from\.segmentId must name a segment/,
    ],
    [
      'segment branch point',
      (s) => (at(s, 'pid-5.2')['from'] = { type: 'branch', segmentId: 'pid-3.2', at: 'x' }),
      /from\.at must be two finite numbers/,
    ],
    ['segment free end', (s) => (at(s, 'pid-5.2')['to'] = { type: 'free' }), /to\.at must be two finite numbers/],
    ['segment end type', (s) => (at(s, 'pid-5.2')['to'] = { type: 'teleport' }), /to\.type must be/],
    ['segment end shape', (s) => (at(s, 'pid-5.2')['to'] = 3), /to must be an object/],
    ['segment route', (s) => (at(s, 'pid-3.2')['route'] = [[0, 0]]), /route must be at least two points/],
    ['segment flow', (s) => (at(s, 'pid-3.2')['flow'] = 'up'), /flow must be forward, reverse or none/],
    ['segment primary', (s) => (at(s, 'pid-3.2')['primary'] = 1), /primary must be a boolean/],
    ['inline ports', (s) => (at(s, 'pid-3.4')['ports'] = [[1]]), /ports must be an array of points/],
    ['inline flags', (s) => (at(s, 'pid-3.4')['operated'] = 'yes'), /operated must be a boolean/],
    ['instrument text', (s) => (at(s, 'pid-4.2')['category'] = 1), /category must be a string/],
    ['instrument location', (s) => (at(s, 'pid-4.2')['location'] = 'moon'), /location must be/],
    ['instrument display', (s) => (at(s, 'pid-4.2')['display'] = 'moon'), /display must be/],
    ['instrument loop', (s) => (at(s, 'pid-4.2')['loopId'] = 'pid-2.1'), /loopId must name an item of kind loop/],
    ['signal kind', (s) => (at(s, 'pid-4.4')['signalKind'] = 'smoke'), /signalKind must be/],
    [
      'signal end',
      (s) => (at(s, 'pid-4.4')['from'] = { type: 'instrument', itemId: 'pid-2.1' }),
      /from\.itemId must name an item of kind instrument or actuating/,
    ],
    ['signal route', (s) => (at(s, 'pid-4.4')['route'] = []), /route must be at least two points/],
    ['actuating valve', (s) => (at(s, 'pid-4.3')['valveId'] = 'pid-2.1'), /valveId must name an item of kind inline/],
    ['actuating type', (s) => (at(s, 'pid-4.3')['actuator'] = 'hand'), /actuator must be/],
    ['actuating fail action', (s) => (at(s, 'pid-4.3')['failAction'] = 'XX'), /failAction must be/],
    ['actuating controller', (s) => (at(s, 'pid-4.3')['controllerId'] = 'pid-2.1'), /controllerId must name an item of kind instrument/],
    ['opc direction', (s) => (at(s, 'pid-3.7')['direction'] = 'sideways'), /direction must be in or out/],
    ['opc pair key', (s) => (at(s, 'pid-3.7')['pairKey'] = ''), /pairKey/],
    ['opc target sheet', (s) => (at(s, 'pid-3.7')['targetSheet'] = 'pid-9'), /targetSheet must name a sheet/],
    ['acceptances shape', (s) => (s['acceptances'] = []), /acceptances must be an object/],
    ['acceptance entry', (s) => (s['acceptances'] = { k: { reason: '' } }), /acceptances\.k must be/],
    ['imports shape', (s) => (s['imports'] = {}), /imports must be an array/],
    ['import entry', (s) => (s['imports'] = [3]), /imports\[0\] must be an object/],
    ['import format', (s) => (s['imports'] = [{ format: 'pdf', version: '1', sha256: 'a'.repeat(64), warnings: [] }]), /format must be/],
    [
      'import version',
      (s) => (s['imports'] = [{ format: 'dexpi-xml', version: '', sha256: 'a'.repeat(64), warnings: [] }]),
      /version must be a non-empty string/,
    ],
    [
      'import hash',
      (s) => (s['imports'] = [{ format: 'dexpi-xml', version: '2.0', sha256: 'ABC', warnings: [] }]),
      /sha256 must be 64 lowercase hex digits/,
    ],
    [
      'import warnings',
      (s) => (s['imports'] = [{ format: 'dexpi-xml', version: '2.0', sha256: 'a'.repeat(64), warnings: [1] }]),
      /warnings must be an array of strings/,
    ],
    ['counters', (s) => (s['counters'] = { seq: -1 }), /counters must map names to non-negative integers/],
  ];

  it.each(cases)('refuses a file with a broken %s', (_label, edit, expected) => {
    const errors = errorsAfter(edit);
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((error) => expected.test(error)),
      errors.join('\n'),
    ).toBe(true);
  });

  it('refuses ids that are names on Object.prototype', () => {
    const errors = errorsAfter((s) => {
      (s['sheets'] as Record<string, unknown>)['constructor'] = (s['sheets'] as Record<string, unknown>)['pid-1.1'];
      (s['items'] as Record<string, unknown>)['toString'] = at(s, 'pid-2.1');
    });
    expect(errors.some((error) => /sheets\.constructor: the id is a reserved name/.test(error))).toBe(true);
    expect(errors.some((error) => /items\.toString: the id is a reserved name/.test(error))).toBe(true);
  });
});
