/**
 * DEXPI 1.3 (Proteus 4.1.x) and 2.0 text -> P&ID items (plant 04 PID §6.1, §6.2; a 2.0 file is translated to the Proteus tree first). Pure: the text goes through `@lib/xmlRead` only (no DTD, no entities beyond the
 * five predefined ones, bounded size and depth), nothing is read from disk or network; the result is all or nothing.
 */

import { readXml, xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import type { PidItem } from '../model';
import { proteusFrom20 } from '../dexpi20/from20';
import { checkDexpi20 } from '../dexpi20/schemaCheck';
import { dexpiIssue, type DexpiIssue } from './codes';
import { DRAWING_UNIT_TO_MM } from './proteusClasses';
import { drop, pointOf, warn, where, type ImportContext, type Pending } from './proteusContext';
import { addItem, baseOf, readAttributes, register } from './proteusContext';
import { mapEquipment } from './proteusEquipment';
import { buildFlows } from './proteusFlows';
import { mapActuating, mapInstrument, mapLoop } from './proteusInstruments';
import { mapPipingSystem } from './proteusPiping';
import { buildSegments } from './proteusSegments';

export type ProteusPaper = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

export interface ProteusImport {
  readonly ok: true;
  readonly version: '1.3' | '2.0';
  readonly schemaVersion: string;
  readonly applicationVersion: string | undefined;
  readonly originatingSystem: string | undefined;
  readonly units: string;
  readonly title: string;
  readonly paper: ProteusPaper;
  readonly items: Record<string, PidItem>;
  readonly order: string[];
  readonly issues: DexpiIssue[];
  /** Source-file counters no item carries (census keys). */
  readonly census: Record<'connections' | 'danglingConnections' | 'shapeCatalogueEntries', number>;
}

export interface ProteusRefusal {
  readonly ok: false;
  readonly code: 'DEXPI_PARSE_ERROR' | 'DEXPI_VERSION_UNSUPPORTED';
  readonly message: string;
  readonly paths: string[];
  readonly detail?: Record<string, unknown>;
}

/** Issues kept in the result and in the import record; the rest is summarised. */
const MAX_ISSUES = 200;

const SIZE_CODES = new Set([
  'XML_TOO_LARGE',
  'XML_TOO_MANY_ELEMENTS',
  'XML_TOO_MANY_ATTRIBUTES',
  'XML_TOO_MANY_NAMESPACES',
  'XML_TOO_DEEP',
]);

const PAPERS: ReadonlyArray<readonly [ProteusPaper, number, number]> = [
  ['A4', 297, 210],
  ['A3', 420, 297],
  ['A2', 594, 420],
  ['A1', 841, 594],
  ['A0', 1189, 841],
];

const refusal = (code: ProteusRefusal['code'], message: string, paths: string[], detail?: Record<string, unknown>): ProteusRefusal => ({
  ok: false,
  code,
  message,
  paths,
  ...(detail === undefined ? {} : { detail }),
});

/** Instance part of the file: ids, Connection elements (the census rules: everything under the root except the ShapeCatalogue subtree). */
function scan(root: XmlElement): { ids: Set<string>; connections: XmlElement[] } {
  const ids = new Set<string>();
  const connections: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  for (let el = stack.pop(); el !== undefined; el = stack.pop()) {
    const id = xmlAttr(el, 'ID');
    if (id !== undefined && id !== '') ids.add(id);
    if (el.local === 'Connection') connections.push(el);
    for (const child of xmlChildren(el)) if (child.local !== 'ShapeCatalogue') stack.push(child);
  }
  return { ids, connections };
}

function paperOf(ctx: ImportContext, root: XmlElement): { title: string; paper: ProteusPaper } {
  const drawing = xmlChildren(root, 'Drawing')[0];
  const max = drawing === undefined ? undefined : pointOf(ctx, xmlChildren(xmlChildren(drawing, 'Extent')[0] ?? drawing, 'Max')[0]);
  const paper = max === undefined ? undefined : PAPERS.find(([, width, height]) => max[0] <= width && max[1] <= height)?.[0];
  return { title: (drawing && xmlAttr(drawing, 'Name')) || 'Imported DEXPI P&ID', paper: paper ?? 'A1' };
}

function summariseIssues(issues: DexpiIssue[], dropped: ReadonlyMap<string, number>): DexpiIssue[] {
  const all = [...issues];
  if (dropped.size > 0) {
    const list = [...dropped].map(([name, count]) => `${name} ${count}`).join(', ');
    all.push(dexpiIssue('DEXPI_GRAPHICS_DROPPED', 'info', `presentation not reproduced (${list}); the data is intact`));
  }
  if (all.length <= MAX_ISSUES) return all;
  const codes = new Set(all.slice(MAX_ISSUES).map((issue) => issue.code));
  return [
    ...all.slice(0, MAX_ISSUES),
    dexpiIssue(
      'DEXPI_GRAPHICS_DROPPED',
      'info',
      `${all.length - MAX_ISSUES} more finding(s) not listed (codes ${[...codes].sort().join(', ')})`,
    ),
  ];
}

/** The first schema violations of a 2.0 file as import warnings, then their count. */
function schemaIssues(root: XmlElement): DexpiIssue[] {
  const report = checkDexpi20(root);
  const listed = report.violations
    .slice(0, 20)
    .map((violation) => dexpiIssue('DEXPI_SCHEMA_VIOLATION', 'warning', violation.message, [], [violation.path]));
  return report.count > listed.length
    ? [...listed, dexpiIssue('DEXPI_SCHEMA_VIOLATION', 'warning', `${report.count - listed.length} more schema violation(s) not listed`)]
    : listed;
}

/** Maps `text` (DEXPI 1.3 or 2.0); `sheetId` is the id of the sheet the items go on, `requested` the `version` param. */
export function readDexpi(text: string, sheetId: string, requested: 'auto' | '1.3' | '2.0'): ProteusImport | ProteusRefusal {
  const read = readXml(text);
  if (!read.ok) {
    const { code, message, line, column } = read.error;
    const reason = SIZE_CODES.has(code) ? `file too large or too complex: ${message}` : `not well-formed XML: ${message}`;
    return refusal('DEXPI_PARSE_ERROR', `${reason} (${code})`, [`line ${line}, column ${column}`], { xmlCode: code });
  }
  const root = read.root;
  if (root.local === 'Model') {
    if (requested === '1.3')
      return refusal('DEXPI_VERSION_UNSUPPORTED', 'the root is <Model>: a DEXPI 2.0 file, but version 1.3 was requested', [where(root)]);
    const converted = proteusFrom20(root);
    if (!converted.ok) return refusal('DEXPI_VERSION_UNSUPPORTED', converted.message, converted.paths);
    const plantInformation = xmlChildren(converted.root, 'PlantInformation')[0] as XmlElement;
    return mapPlant(converted.root, plantInformation, sheetId, '2.0', converted.schemaVersion, [
      ...converted.issues,
      ...schemaIssues(root),
    ]);
  }
  if (root.local !== 'PlantModel')
    return refusal('DEXPI_VERSION_UNSUPPORTED', `the root <${root.name}> is neither a DEXPI Proteus <PlantModel> nor a DEXPI 2.0 <Model>`, [
      where(root),
    ]);
  if (requested === '2.0')
    return refusal('DEXPI_VERSION_UNSUPPORTED', 'the root is <PlantModel>: a DEXPI 1.3 file, but version 2.0 was requested', [where(root)]);
  const information = xmlChildren(root, 'PlantInformation')[0];
  const schemaVersion = information === undefined ? undefined : xmlAttr(information, 'SchemaVersion');
  if (information === undefined || schemaVersion === undefined)
    return refusal('DEXPI_VERSION_UNSUPPORTED', 'PlantInformation has no SchemaVersion: the DEXPI version cannot be told', [
      where(information ?? root),
    ]);
  if (!/^4\.1(\.|$)/.test(schemaVersion))
    return refusal(
      'DEXPI_VERSION_UNSUPPORTED',
      `Proteus SchemaVersion ${schemaVersion} is not read (only 4.1.x = DEXPI 1.3)${requested === '1.3' ? '; version 1.3 was requested' : ''}`,
      [where(information)],
    );
  return mapPlant(root, information, sheetId, '1.3', schemaVersion, []);
}

function mapPlant(
  root: XmlElement,
  information: XmlElement,
  sheetId: string,
  version: '1.3' | '2.0',
  schemaVersion: string,
  inherited: DexpiIssue[],
): ProteusImport {
  const units = xmlAttr(information, 'Units') ?? 'mm';
  const known = Object.hasOwn(DRAWING_UNIT_TO_MM, units);
  const { ids, connections } = scan(root);
  const ctx: ImportContext = {
    sheetId,
    scale: known ? (DRAWING_UNIT_TO_MM[units] ?? 1) : 1,
    items: {},
    order: [],
    refs: new Map(),
    allIds: ids,
    issues: [...inherited],
    dropped: new Map(),
    unitsSeen: new Set(),
  };
  if (!known)
    warn(ctx, 'DEXPI_ATTRIBUTE_UNIT', 'warning', `drawing unit "${units}" is not known; coordinates are taken as mm`, information);
  const pending: Pending = { segments: [], flows: [], actuating: [], loops: [], components: new Map(), controllers: new Map() };

  for (const child of xmlChildren(root)) {
    switch (child.local) {
      case 'PlantInformation':
        break;
      case 'Equipment':
        mapEquipment(ctx, child);
        break;
      case 'PipingNetworkSystem':
        mapPipingSystem(ctx, child, pending);
        break;
      case 'ProcessInstrumentationFunction':
        mapInstrument(ctx, child, pending);
        break;
      case 'InformationFlow':
        pending.flows.push(child);
        break;
      case 'ActuatingSystem':
        pending.actuating.push(child);
        break;
      case 'InstrumentationLoopFunction':
        pending.loops.push(child);
        break;
      case 'PlantStructureItem':
      case 'MetaData': {
        const attributes = readAttributes(ctx, child);
        addItem(ctx, { ...baseOf(ctx, child, xmlAttr(child, 'ComponentClass') || child.local, attributes), kind: 'annotation' });
        register(ctx, child, { type: 'other' });
        break;
      }
      case 'ShapeCatalogue':
      case 'Drawing':
        drop(ctx, child);
        break;
      default:
        warn(ctx, 'DEXPI_UNMAPPED_CLASS', 'warning', `element <${child.name}> is not read`, child);
    }
  }
  for (const system of pending.actuating) mapActuating(ctx, system, pending);
  for (const loop of pending.loops) mapLoop(ctx, loop);
  const lineSegments = new Map<string, string[]>();
  buildSegments(ctx, pending, lineSegments);
  buildFlows(ctx, pending);
  for (const [lineId, segmentIds] of lineSegments) {
    const line = ctx.items[lineId];
    if (line?.kind === 'line') ctx.items[lineId] = { ...line, segmentIds };
  }

  const catalogue = xmlChildren(root, 'ShapeCatalogue')[0];
  const dangling = connections.filter((c) =>
    [xmlAttr(c, 'FromID'), xmlAttr(c, 'ToID')].some((id) => id !== undefined && id !== '' && !ids.has(id)),
  );
  return {
    ok: true,
    version,
    schemaVersion,
    applicationVersion: xmlAttr(information, 'ApplicationVersion'),
    originatingSystem: xmlAttr(information, 'OriginatingSystem'),
    units,
    ...paperOf(ctx, root),
    items: ctx.items,
    order: ctx.order,
    issues: summariseIssues(ctx.issues, ctx.dropped),
    census: {
      connections: connections.length,
      danglingConnections: dangling.length,
      shapeCatalogueEntries: catalogue === undefined ? 0 : xmlChildren(catalogue).length,
    },
  };
}
