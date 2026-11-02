/**
 * Supports of a pipe line (plant 05 ISO M5, §5.1 SUPPORT, §5.8 support marks): whatever the source, a support is a point on the centreline with a mark and a type.
 * Routed and legacy lines read them from the document's `pipeSupport` elements (`add_pipe_support`, hosted by a run id or a legacy pipe id); an imported line carries
 * them as SUPPORT components (CO-ORDS, `SUPPORT-NAME`, `SUPPORT-TYPE`). Pure; world millimetres.
 */

import type { CadDocument } from '@core/model/types';
import { MM_PER_UNIT } from '@core/model/units';
import type { Vec3 } from '@core/model/vectors';
import { elementsOf, getBuilding } from '../../building/model';
import { getPiping } from '../piping/model';
import { legacyLines } from './legacyNetwork';
import { nearestPipe } from './fieldWelds';
import type { NetworkComponent, PipingNetwork } from './model';

export const SUPPORT_NAME = 'SUPPORT-NAME';
export const SUPPORT_TYPE = 'SUPPORT-TYPE';

export interface LineSupport {
  /** The support element id (`pipeSupport`), or the id of the SUPPORT component of an imported line. */
  readonly id: string;
  /** The mark shown on the sheet (PS1 ...), or the SUPPORT-NAME of the file. */
  readonly mark: string;
  /** shoe | hanger | guide | anchor, or `unspecified` for a file that names none. */
  readonly type: string;
  readonly xyz: Vec3;
}

const SUPPORT_TYPES = ['shoe', 'hanger', 'guide', 'anchor'] as const;

/** Supports of the line behind `network` (`lineId` is the id the line is addressed by), sorted by id for a fixed order. */
export function lineSupports(doc: CadDocument, lineId: string, network: PipingNetwork): LineSupport[] {
  if (network.source === 'pcf') return network.components.flatMap(fromComponent);
  const carriers =
    network.source === 'route'
      ? new Set(getPiping(doc).runOrder.filter((runId) => getPiping(doc).runs[runId]?.lineId === lineId))
      : new Set((legacyLines(doc).get(lineId) ?? []).map((pipe) => pipe.id));
  const building = getBuilding(doc);
  const mm = MM_PER_UNIT[doc.units];
  return elementsOf(building, 'pipeSupport')
    .filter((support) => carriers.has(support.pipeId))
    .map(
      (support): LineSupport => ({
        id: support.id,
        mark: support.mark,
        type: support.type,
        xyz: [
          support.position[0] * mm,
          support.position[1] * mm,
          (support.position[2] + (building.levels[support.levelId]?.elevation ?? 0)) * mm,
        ],
      }),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

function fromComponent(component: NetworkComponent): LineSupport[] {
  if (component.type !== 'SUPPORT' || component.coords === undefined) return [];
  const type = component.extra?.[SUPPORT_TYPE]?.toLowerCase() ?? '';
  return [
    {
      id: component.id,
      mark: component.extra?.[SUPPORT_NAME] ?? component.id,
      type: (SUPPORT_TYPES as readonly string[]).includes(type) ? type : 'unspecified',
      xyz: component.coords,
    },
  ];
}

/** The SUPPORT components (PCF form) of document supports: CO-ORDS on the centreline, the mark and the type as unconfirmed attributes (llull never invents a SKEY). */
export const supportComponents = (supports: readonly LineSupport[]): NetworkComponent[] =>
  supports.map((support) => ({
    id: support.id,
    type: 'SUPPORT',
    ends: [],
    coords: support.xyz,
    extra: { [SUPPORT_NAME]: support.mark, [SUPPORT_TYPE]: support.type.toUpperCase() },
  }));

/** The placeable type of a file's support (`add_pipe_support`): shoe unless the file names another of the four. */
export const placeableType = (type: string): (typeof SUPPORT_TYPES)[number] =>
  (SUPPORT_TYPES as readonly string[]).includes(type) ? (type as (typeof SUPPORT_TYPES)[number]) : 'shoe';

/** `components` with a SUPPORT record after the pipe each support lies on (within 1 mm), the others at the end; the order follows the supports. */
export function insertSupports(components: readonly NetworkComponent[], supports: readonly LineSupport[]): NetworkComponent[] {
  const records = supportComponents(supports);
  const after = new Map<number, NetworkComponent[]>();
  const tail: NetworkComponent[] = [];
  records.forEach((record) => {
    const hit = nearestPipe(components, record.coords as Vec3);
    if (hit === null) tail.push(record);
    else after.set(hit.index, [...(after.get(hit.index) ?? []), record]);
  });
  return [...components.flatMap((component, index) => [component, ...(after.get(index) ?? [])]), ...tail];
}
