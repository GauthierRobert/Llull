/** The fixed structure of an R2000 file around the entities: header, CLASSES, symbol tables, blocks, OBJECTS (layouts included). */

import { hexToAci } from './dxfUnits';
import { INSUNITS } from './dxfWriter';
import { LLULL_APP } from './dxfReadShapes';

export type Group = readonly [code: number, value: string | number];

/** Layer state written to the LAYER table. */
export interface DxfLayerDef {
  /** `#rrggbb`, written as ACI + true colour; null = ACI 7 only. */
  readonly color: string | null;
  readonly visible: boolean;
  readonly locked: boolean;
}

/** A number as DXF text: shortest round-trip digits, never an exponent (`1e-7` is `0.0000001`), never `-0`. */
function dxfNumber(value: number): string {
  const text = String(value + 0);
  if (!text.includes('e')) return text;
  return value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '.0');
}

export const flatten = (groups: ReadonlyArray<Group>): string[] =>
  groups.flatMap(([code, value]) => [String(code), typeof value === 'number' ? dxfNumber(value) : value]);

export const hexColor = (hex: string): number => Number.parseInt(hex.slice(1), 16);

export interface FileInput {
  readonly unit: keyof typeof INSUNITS;
  readonly bounds: readonly [number, number, number, number];
  readonly handleSeed: number;
  readonly layers: ReadonlyMap<string, DxfLayerDef>;
  readonly entityLines: readonly string[];
}

export function assembleFile(input: FileInput): string {
  let handle = 0x20;
  const next = (): string => (handle++).toString(16).toUpperCase();
  const ids = {
    layoutModel: next(),
    layoutPaper: next(),
    root: next(),
    group: next(),
    layouts: next(),
    plot: next(),
    style: next(),
    normal: next(),
  };
  const table = (name: string, count: number, extra: Group[] = []): { head: Group[]; owner: string } => {
    const owner = next();
    return { head: [[0, 'TABLE'], [2, name], [5, owner], [330, 0], [100, 'AcDbSymbolTable'], [70, count], ...extra], owner };
  };
  const record = (type: string, owner: string, subclass: string, groups: Group[]): Group[] => [
    [0, type],
    [5, next()],
    [330, owner],
    [100, 'AcDbSymbolTableRecord'],
    [100, subclass],
    ...groups,
  ];
  const [minX, minY, maxX, maxY] = input.bounds;
  const header: Group[] = [
    [0, 'SECTION'],
    [2, 'HEADER'],
    [9, '$ACADVER'],
    [1, 'AC1015'],
    [9, '$HANDSEED'],
    [5, input.handleSeed.toString(16).toUpperCase()],
    [9, '$INSUNITS'],
    [70, INSUNITS[input.unit]],
    [9, '$PDMODE'],
    [70, 3],
    [9, '$EXTMIN'],
    [10, minX],
    [20, minY],
    [30, 0],
    [9, '$EXTMAX'],
    [10, maxX],
    [20, maxY],
    [30, 0],
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'CLASSES'],
    ...[
      ['ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault'],
      ['ACDBPLACEHOLDER', 'AcDbPlaceHolder'],
      ['LAYOUT', 'AcDbLayout'],
    ].flatMap(([name, cpp]): Group[] => [
      [0, 'CLASS'],
      [1, name as string],
      [2, cpp as string],
      [3, 'ObjectDBX Classes'],
      [90, 0],
      [280, 0],
      [281, 0],
    ]),
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'TABLES'],
  ];
  const tables: Group[] = [];
  const addTable = (name: string, entries: ReadonlyArray<(owner: string) => Group[]>, extra: Group[] = []): string => {
    const { head, owner } = table(name, entries.length, extra);
    tables.push(...head, ...entries.flatMap((entry) => entry(owner)), [0, 'ENDTAB']);
    return owner;
  };
  const viewport = (owner: string): Group[] =>
    record('VPORT', owner, 'AcDbViewportTableRecord', [
      [2, '*Active'],
      [70, 0],
      [10, 0],
      [20, 0],
      [11, 1],
      [21, 1],
      [12, 0],
      [22, 0],
      [13, 0],
      [23, 0],
      [14, 0.5],
      [24, 0.5],
      [15, 0.5],
      [25, 0.5],
      [16, 0],
      [26, 0],
      [36, 1],
      [17, 0],
      [27, 0],
      [37, 0],
      [40, 1000],
      [41, 1.34],
      [42, 50],
      [43, 0],
      [44, 0],
      [50, 0],
      [51, 0],
      [71, 0],
      [72, 1000],
      [73, 1],
      [74, 3],
      [75, 0],
      [76, 0],
      [77, 0],
      [78, 0],
    ]);
  addTable('VPORT', [viewport]);
  const lineType =
    (name: string, description: string) =>
    (owner: string): Group[] =>
      record('LTYPE', owner, 'AcDbLinetypeTableRecord', [
        [2, name],
        [70, 0],
        [3, description],
        [72, 65],
        [73, 0],
        [40, 0],
      ]);
  addTable('LTYPE', [lineType('ByBlock', ''), lineType('ByLayer', ''), lineType('Continuous', 'Solid line')]);
  const layerEntry =
    (name: string, def: DxfLayerDef) =>
    (owner: string): Group[] =>
      record('LAYER', owner, 'AcDbLayerTableRecord', [
        [2, name],
        [70, def.locked ? 4 : 0],
        [62, def.color === null ? (def.visible ? 7 : -7) : def.visible ? hexToAci(def.color) : -hexToAci(def.color)],
        ...(def.color === null ? [] : ([[420, hexColor(def.color)]] as Group[])),
        [6, 'Continuous'],
      ]);
  const zero: DxfLayerDef = { color: null, visible: true, locked: false };
  addTable('LAYER', [
    ...(input.layers.has('0') ? [] : [layerEntry('0', zero)]),
    ...[...input.layers].map(([name, def]) => layerEntry(name, def)),
  ]);
  addTable('STYLE', [
    (owner) =>
      record('STYLE', owner, 'AcDbTextStyleTableRecord', [
        [2, 'Standard'],
        [70, 0],
        [40, 0],
        [41, 1],
        [50, 0],
        [71, 0],
        [42, 2.5],
        [3, 'txt'],
        [4, ''],
      ]),
  ]);
  addTable('VIEW', []);
  addTable('UCS', []);
  const appId =
    (name: string) =>
    (owner: string): Group[] =>
      record('APPID', owner, 'AcDbRegAppTableRecord', [
        [2, name],
        [70, 0],
      ]);
  addTable('APPID', [appId('ACAD'), appId(LLULL_APP)]);
  const dimStyle = (owner: string): Group[] => [
    [0, 'DIMSTYLE'],
    [105, next()],
    [330, owner],
    [100, 'AcDbSymbolTableRecord'],
    [100, 'AcDbDimStyleTableRecord'],
    [2, 'Standard'],
    [70, 0],
    [3, ''],
    [4, ''],
    [40, 1],
    [41, 2.5],
    [42, 0.625],
    [43, 3.75],
    [44, 1.25],
    [45, 0],
    [46, 0],
    [47, 0],
    [48, 0],
    [140, 2.5],
    [141, 2.5],
    [142, 0],
    [143, 0.03937007874],
    [144, 1],
    [145, 0],
    [146, 1],
    [147, 0.625],
    [148, 0],
    [71, 0],
    [72, 0],
    [73, 0],
    [74, 0],
    [75, 0],
    [76, 0],
    [77, 1],
    [78, 8],
    [79, 3],
    [170, 0],
    [171, 3],
    [172, 1],
    [173, 0],
    [174, 0],
    [175, 0],
    [176, 0],
    [177, 0],
    [178, 0],
    [179, 2],
    [271, 2],
    [272, 2],
    [273, 2],
    [274, 3],
    [275, 0],
    [276, 0],
    [277, 2],
    [278, 44],
    [279, 0],
    [280, 0],
    [281, 0],
    [282, 0],
    [283, 0],
    [284, 8],
    [285, 0],
    [286, 0],
    [288, 0],
    [289, 3],
    [371, -2],
    [372, -2],
  ];
  addTable(
    'DIMSTYLE',
    [dimStyle],
    [
      [100, 'AcDbDimStyleTable'],
      [71, 1],
    ],
  );
  const modelSpace = '1F';
  const blockRecord =
    (name: string, id: string, layout: string) =>
    (owner: string): Group[] => [
      [0, 'BLOCK_RECORD'],
      [5, id],
      [330, owner],
      [100, 'AcDbSymbolTableRecord'],
      [100, 'AcDbBlockTableRecord'],
      [2, name],
      [340, layout],
    ];
  addTable('BLOCK_RECORD', [blockRecord('*Model_Space', modelSpace, ids.layoutModel), blockRecord('*Paper_Space', '1E', ids.layoutPaper)]);
  const block = (name: string, owner: string): Group[] => [
    [0, 'BLOCK'],
    [5, next()],
    [330, owner],
    [100, 'AcDbEntity'],
    [8, '0'],
    [100, 'AcDbBlockBegin'],
    [2, name],
    [70, 0],
    [10, 0],
    [20, 0],
    [30, 0],
    [3, name],
    [1, ''],
    [0, 'ENDBLK'],
    [5, next()],
    [330, owner],
    [100, 'AcDbEntity'],
    [8, '0'],
    [100, 'AcDbBlockEnd'],
  ];
  const blocks: Group[] = [
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'BLOCKS'],
    ...block('*Model_Space', modelSpace),
    ...block('*Paper_Space', '1E'),
    [0, 'ENDSEC'],
  ];
  const dictionary = (id: string, owner: string | number, entries: ReadonlyArray<readonly [string, string]> = []): Group[] => [
    [0, 'DICTIONARY'],
    [5, id],
    [330, owner],
    [100, 'AcDbDictionary'],
    [281, 1],
    ...entries.flatMap(([name, target]): Group[] => [
      [3, name],
      [350, target],
    ]),
  ];
  const layout = (id: string, name: string, order: number, record: string, modelType: boolean): Group[] => [
    [0, 'LAYOUT'],
    [5, id],
    [330, ids.layouts],
    [100, 'AcDbPlotSettings'],
    [1, ''],
    [4, 'A3'],
    [6, ''],
    [40, 7.5],
    [41, 20],
    [42, 7.5],
    [43, 20],
    [44, 420],
    [45, 297],
    [46, 0],
    [47, 0],
    [48, 0],
    [49, 0],
    [140, 0],
    [141, 0],
    [142, 1],
    [143, 1],
    [70, modelType ? 1024 : 0],
    [72, 1],
    [73, 0],
    [74, 5],
    [7, ''],
    [75, 16],
    [76, 0],
    [77, 2],
    [78, 300],
    [147, 1],
    [148, 0],
    [149, 0],
    [100, 'AcDbLayout'],
    [1, name],
    [70, 1],
    [71, order],
    [10, 0],
    [20, 0],
    [11, 420],
    [21, 297],
    [12, 0],
    [22, 0],
    [32, 0],
    [14, 1e20],
    [24, 1e20],
    [34, 1e20],
    [15, -1e20],
    [25, -1e20],
    [35, -1e20],
    [146, 0],
    [13, 0],
    [23, 0],
    [33, 0],
    [16, 1],
    [26, 0],
    [36, 0],
    [17, 0],
    [27, 1],
    [37, 0],
    [76, 1],
    [330, record],
  ];
  const objects: Group[] = [
    [0, 'SECTION'],
    [2, 'OBJECTS'],
    ...dictionary(ids.root, 0, [
      ['ACAD_GROUP', ids.group],
      ['ACAD_LAYOUT', ids.layouts],
      ['ACAD_PLOTSETTINGS', ids.plot],
      ['ACAD_PLOTSTYLENAME', ids.style],
    ]),
    ...dictionary(ids.group, ids.root),
    ...dictionary(ids.layouts, ids.root, [
      ['Model', ids.layoutModel],
      ['Layout1', ids.layoutPaper],
    ]),
    ...dictionary(ids.plot, ids.root),
    [0, 'ACDBDICTIONARYWDFLT'],
    [5, ids.style],
    [330, ids.root],
    [100, 'AcDbDictionary'],
    [281, 1],
    [3, 'Normal'],
    [350, ids.normal],
    [100, 'AcDbDictionaryWithDefault'],
    [340, ids.normal],
    [0, 'ACDBPLACEHOLDER'],
    [5, ids.normal],
    [330, ids.style],
    ...layout(ids.layoutModel, 'Model', 0, modelSpace, true),
    ...layout(ids.layoutPaper, 'Layout1', 1, '1E', false),
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ];
  return [
    ...flatten(header),
    ...flatten(tables),
    ...flatten(blocks),
    ...flatten([
      [0, 'SECTION'],
      [2, 'ENTITIES'],
    ]),
    ...input.entityLines,
    ...flatten([[0, 'ENDSEC'], ...objects]),
  ].join('\n');
}
