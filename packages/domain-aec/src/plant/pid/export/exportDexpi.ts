/**
 * Deterministic DEXPI 1.3 (Proteus 4.1.1) writer for `doc.plant.pid` (plant 04 PID §6.3). Ids are the source ids kept from an import, else
 * `<Class>-<n>` per class in model order; elements and attributes come in a fixed order, so the same model gives the same bytes and
 * export -> import -> export is a fixed point.
 */

import { PAPER_MM } from '@core/model/sheet';
import { sha256Hex } from '@lib/sha256';
import type { DexpiIssue } from '../dexpi/codes';
import { COUNT_KEYS, censusCounts, type Counts } from '../lists/counts';
import type { PidEquipment, PidItem, PidLine, PidModel, PidSheet } from '../model';
import { buildChains } from './exportChains';
import { dexpiIssue } from '../dexpi/codes';
import { classWritten, type ExportContext } from './exportContext';
import { actuatingNodes, annotationNodes, instrumentNodes, loopNodes, signalNodes } from './exportInstruments';
import { equipmentNode, lineNode, warnUnplaced } from './exportPiping';
import { el, writeXml, type XNode } from './xmlWrite';

/** Same bound as the import. */
const MAX_CHARACTERS = 50_000_000;

export interface DexpiExport {
  readonly ok: true;
  readonly text: string;
  readonly sha256: string;
  readonly counts: Counts;
  readonly warnings: DexpiIssue[];
  readonly sheets: readonly string[];
}

const className = (item: PidItem): string => classWritten(item).replace(/[^A-Za-z0-9_]/g, '') || 'Item';

function assignIds(
  items: readonly PidItem[],
  heads: readonly PidItem[],
): { ids: Map<string, string>; chainIds: Map<string, string>; claim: (wanted: string) => string } {
  const used = new Set<string>();
  const claim = (wanted: string): string => {
    let id = wanted;
    for (let n = 2; used.has(id); n++) id = `${wanted}~${n}`;
    used.add(id);
    return id;
  };
  const ids = new Map<string, string>();
  const chainIds = new Map<string, string>();
  const targets: Array<{ item: PidItem; chain: boolean }> = [
    ...items.filter((item) => item.kind !== 'segment').map((item) => ({ item, chain: false })),
    ...heads.map((item) => ({ item, chain: true })),
  ];
  const put = (target: { item: PidItem; chain: boolean }, id: string): void => void (target.chain ? chainIds : ids).set(target.item.id, id);
  const later: typeof targets = [];
  for (const target of targets) {
    if (target.item.sourceId !== undefined && target.item.sourceId !== '') put(target, claim(target.item.sourceId));
    else later.push(target);
  }
  const counters = new Map<string, number>();
  for (const target of later) {
    const base = target.chain ? 'PipingNetworkSegment' : className(target.item);
    let n = counters.get(base) ?? 0;
    let id: string;
    do id = `${base}-${++n}`;
    while (used.has(id));
    counters.set(base, n);
    put(target, claim(id));
  }
  return { ids, chainIds, claim };
}

function childrenOfEquipment(items: readonly PidItem[]): Map<string, PidItem[]> {
  const children = new Map<string, PidItem[]>();
  for (const item of items) {
    const parent = item.kind === 'nozzle' ? item.equipmentId : item.kind === 'equipment' ? item.parentId : undefined;
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  return children;
}

const sumCounts = (parts: readonly Counts[]): Counts =>
  Object.fromEntries(COUNT_KEYS.map((key) => [key, parts.reduce((total, part) => total + part[key], 0)])) as Counts;

/** Writes the sheets (all when `sheetIds` is absent) as one DEXPI 1.3 Proteus file. */
export function buildDexpi(
  pid: PidModel,
  sheetIds: readonly string[] | undefined,
): DexpiExport | { readonly ok: false; readonly characters: number } {
  const chosen: PidSheet[] = pid.sheetOrder.flatMap((id) => {
    const sheet = pid.sheets[id];
    return sheet !== undefined && (sheetIds === undefined || sheetIds.includes(id)) ? [sheet] : [];
  });
  const sheets = new Set(chosen.map((sheet) => sheet.id));
  const items = pid.itemOrder.flatMap((id) => {
    const item = pid.items[id];
    return item !== undefined && sheets.has(item.sheetId) ? [item] : [];
  });
  const chains = buildChains(pid, sheets, items);
  const { ids, chainIds, claim } = assignIds(
    items,
    chains.chains.map((chain) => chain.head),
  );
  const ctx: ExportContext = {
    pid,
    items,
    ids,
    chainIds,
    chains,
    warnings: [],
    actuated: new Set(items.flatMap((item) => (item.kind === 'actuating' ? [item.valveId] : []))),
    connections: 0,
    claim,
  };
  const children = childrenOfEquipment(items);
  const hasParent = (item: PidEquipment): boolean => item.parentId !== undefined && ids.has(item.parentId);

  const body: XNode[] = [
    ...items.flatMap((item) => (item.kind === 'equipment' && !hasParent(item) ? [equipmentNode(ctx, item, children)] : [])),
    ...items.flatMap((item): XNode[] => (item.kind === 'line' ? [lineNode(ctx, item as PidLine)] : [])),
    ...instrumentNodes(ctx),
    ...loopNodes(ctx),
    ...signalNodes(ctx),
    ...actuatingNodes(ctx),
    ...annotationNodes(ctx),
  ];
  warnUnplaced(ctx);
  const first = chosen[0];
  const [width, height] = first === undefined ? [0, 0] : PAPER_MM[first.paper];
  const root = el(
    'PlantModel',
    [],
    [
      el(
        'PlantInformation',
        [
          ['Application', 'llull'],
          ['Discipline', 'PID'],
          ['Is3D', 'no'],
          ['OriginatingSystem', 'llull'],
          ['SchemaVersion', '4.1.1'],
          ['Units', 'mm'],
        ],
        [el('UnitsOfMeasure', [])],
      ),
      ...body,
      ...(first === undefined
        ? []
        : [
            el(
              'Drawing',
              [
                ['Name', first.title],
                ['Type', 'PID'],
              ],
              [
                el(
                  'Extent',
                  [],
                  [
                    el('Min', [
                      ['X', '0'],
                      ['Y', '0'],
                    ]),
                    el('Max', [
                      ['X', String(width)],
                      ['Y', String(height)],
                    ]),
                  ],
                ),
              ],
            ),
          ]),
    ],
  );
  const text = writeXml(root);
  if (text.length > MAX_CHARACTERS) return { ok: false, characters: text.length };
  const warnings = [...ctx.warnings];
  if (chosen.length > 1)
    warnings.push(
      dexpiIssue(
        'DEXPI_GRAPHICS_DROPPED',
        'info',
        `${chosen.length} sheets are merged into one PlantModel: DEXPI 1.3 files hold one drawing`,
      ),
    );
  warnings.push(
    dexpiIssue('DEXPI_GRAPHICS_DROPPED', 'info', 'presentation (shape catalogue, labels, text) is not written; the data is complete'),
  );
  const counts = {
    ...sumCounts(chosen.map((sheet) => censusCounts(pid, sheet.id))),
    connections: ctx.connections,
    danglingConnections: 0,
    shapeCatalogueEntries: 0,
  };
  return { ok: true, text, sha256: sha256Hex(text), counts, warnings, sheets: chosen.map((sheet) => sheet.number) };
}
