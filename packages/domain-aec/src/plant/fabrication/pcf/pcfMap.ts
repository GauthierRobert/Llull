/** `PcfLineData` <-> `PipingNetwork` and the summaries both read paths report (plant 05 ISO §5.1 step 5, §5.7). Pure. */

import { distance3 } from '@lib/vec3';
import type { IsoIssue, NetworkComponent, PcfLineData, PcfMaterial, PipingNetwork } from '../model';

/** The network view of a stored / read PCF line: MATERIALS descriptions joined to the components by item code. */
export function networkOf(data: PcfLineData, warnings: readonly IsoIssue[] = []): PipingNetwork {
  const descriptions = new Map(data.materials.map((material) => [material.itemCode, material.fields['DESCRIPTION']]));
  return {
    lineId: data.lineId,
    attributes: data.attributes,
    components: data.components.map((component) => {
      const description = component.itemCode === undefined ? undefined : descriptions.get(component.itemCode);
      return description === undefined ? component : { ...component, description };
    }),
    source: 'pcf',
    warnings,
  };
}

/** The stored form of a network built by the route or legacy reader: MATERIALS from the first description of each item code (first-use order). */
export function dataOfNetwork(network: PipingNetwork, header: Readonly<Record<string, string>>): PcfLineData {
  const materials = new Map<string, PcfMaterial>();
  const components = network.components.map(({ description, ...component }): NetworkComponent => {
    if (component.itemCode !== undefined && !materials.has(component.itemCode))
      materials.set(component.itemCode, {
        itemCode: component.itemCode,
        fields: description === undefined ? {} : { DESCRIPTION: description },
      });
    return component;
  });
  return {
    lineId: network.lineId,
    header,
    attributes: network.attributes,
    components,
    materials: [...materials.values()],
    unknownRecords: [],
  };
}

export interface BomRow {
  readonly itemCode: string;
  readonly description?: string;
  /** Components with this item code. */
  readonly count: number;
  /** PIPE rows: total centreline length, mm. */
  readonly lengthMm?: number;
}

export interface PcfSummary {
  readonly componentCount: number;
  readonly countsByType: Readonly<Record<string, number>>;
  readonly pipeLengthsMm: readonly number[];
  readonly totalPipeLengthMm: number;
  readonly bom: readonly BomRow[];
  /** Components that name no item code (not in the BOM). */
  readonly withoutItemCode: number;
}

/** Counts, pipe lengths (|E2 - E1| over PIPE) and the BOM by ITEM-CODE of a network. */
export function summarise(components: readonly NetworkComponent[]): PcfSummary {
  const countsByType: Record<string, number> = {};
  const pipeLengthsMm: number[] = [];
  const rows = new Map<string, { description?: string; count: number; lengthMm: number; pipe: boolean }>();
  let withoutItemCode = 0;
  for (const component of components) {
    countsByType[component.type] = (countsByType[component.type] ?? 0) + 1;
    const [start, end] = component.ends;
    const length = component.type === 'PIPE' && start !== undefined && end !== undefined ? distance3(start.xyz, end.xyz) : 0;
    if (component.type === 'PIPE') pipeLengthsMm.push(length);
    if (component.itemCode === undefined) {
      withoutItemCode += 1;
      continue;
    }
    const row = rows.get(component.itemCode) ?? { count: 0, lengthMm: 0, pipe: false };
    rows.set(component.itemCode, {
      ...row,
      ...(component.description === undefined || row.description !== undefined ? {} : { description: component.description }),
      count: row.count + 1,
      lengthMm: row.lengthMm + length,
      pipe: row.pipe || component.type === 'PIPE',
    });
  }
  return {
    componentCount: components.length,
    countsByType,
    pipeLengthsMm,
    totalPipeLengthMm: pipeLengthsMm.reduce((sum, length) => sum + length, 0),
    bom: [...rows.entries()].map(([itemCode, row]) => ({
      itemCode,
      ...(row.description === undefined ? {} : { description: row.description }),
      count: row.count,
      ...(row.pipe ? { lengthMm: row.lengthMm } : {}),
    })),
    withoutItemCode,
  };
}

/** Ids of the components that need an isometric key (every type but PIPE, GASKET and BOLT) and have none. */
export const missingSkeyIds = (components: readonly NetworkComponent[]): string[] =>
  components
    .filter(
      (component) =>
        !['PIPE', 'GASKET', 'BOLT'].includes(component.type) && component.skey === undefined && component.weldKind === undefined,
    )
    .map((component) => component.id);
