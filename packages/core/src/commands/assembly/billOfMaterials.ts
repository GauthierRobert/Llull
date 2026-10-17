/** bill_of_materials: read-only count of component instances, standard parts (by part number) and raw materials (orphan instances reported, never thrown). */

import type { CadDocument, EntityKind, InstanceEntity } from '../../model/types';
import type { Quantity } from '../../model/quantity';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { type MaterialRow, materialRows, unassignedSolidCount } from './bomMaterials';

/** One row in the bill of materials output. */
interface BomRow {
  /** Id of the component in doc.components. Absent for orphan instances. */
  componentId: string;
  /** Human-readable component name. '(missing)' for orphan instances (componentId not in doc.components). */
  componentName: string;
  /** Number of instances of this component in the document. */
  count: number;
  /**
   * Count of the component's own child entities by kind (independent of any instance scale). Empty for orphan instances where the component
   * cannot be found.
   */
  perEntityKindCounts: Partial<Record<EntityKind, number>>;
  /** When true, this component id is not present in doc.components (orphan instances). */
  orphan?: true;
}

/** One standard part (a component with `partRef`), grouped by part number across components. */
interface StandardPartRow {
  partNumber: string;
  family: string;
  description?: string;
  count: number;
  componentIds: string[];
  /** Per piece, when the catalogue lists a mass and the geometry is not a placeholder. */
  unitMass?: Quantity;
  totalMass?: Quantity;
  /** Built from placeholder proportions: no mass is reported (TR-MAT-24). */
  representative?: true;
}

interface BillOfMaterialsData {
  rows: BomRow[];
  totalInstances: number;
  distinctComponents: number;
  standardParts?: StandardPartRow[];
  materials?: MaterialRow[];
  unassignedSolidCount?: number;
}

function standardPartRows(doc: CadDocument, rows: readonly BomRow[]): StandardPartRow[] {
  const byPart = new Map<string, StandardPartRow>();
  for (const row of rows) {
    const partRef = doc.components[row.componentId]?.partRef;
    if (partRef === undefined) continue;
    const found = byPart.get(partRef.partNumber);
    if (found !== undefined) {
      found.count += row.count;
      found.componentIds.push(row.componentId);
      continue;
    }
    byPart.set(partRef.partNumber, {
      partNumber: partRef.partNumber,
      family: partRef.family,
      ...(partRef.description === undefined ? {} : { description: partRef.description }),
      count: row.count,
      componentIds: [row.componentId],
      ...(partRef.representative === true ? { representative: true as const } : {}),
      ...(partRef.unitMass === undefined || partRef.representative === true ? {} : { unitMass: partRef.unitMass }),
    });
  }
  return [...byPart.values()]
    .map((part) =>
      part.unitMass === undefined ? part : { ...part, totalMass: { value: part.unitMass.value * part.count, unit: part.unitMass.unit } },
    )
    .sort((a, b) => a.partNumber.localeCompare(b.partNumber));
}

/**
 * @affects nothing — read-only query, affected:[]
 * @invariant document is returned unchanged; rows are grouped by componentId
 * @failure orphan instances (componentId not in doc.components) produce a warning row with componentName:'(missing)' and orphan:true; no
 *   throw
 */
export const billOfMaterials = defineCommand({
  name: 'bill_of_materials',
  annotations: { readOnly: true, metaHistory: true },
  description:
    'Generate a bill of materials (BOM) from all InstanceEntity objects in the document. ' +
    'Groups instances by componentId; reports count per component and a breakdown of child entity kinds (perEntityKindCounts). ' +
    'Instances whose componentId is absent from doc.components are reported as orphan rows ' +
    '(componentName: "(missing)", orphan: true) — no error is thrown. Returns the unchanged document, affected:[], and data: ' +
    '{ rows: BomRow[], totalInstances: number, distinctComponents: number }. ' +
    'A BomRow has: { componentId, componentName, count, perEntityKindCounts, orphan? }. ' +
    'Standard parts (components with a partRef, e.g. fasteners inserted by insert_fastener_stack) are also grouped by part number in data.standardParts: ' +
    '{ partNumber, family, description?, count, componentIds, unitMass?, totalMass?, representative? } (no mass for placeholder geometry). ' +
    'With includeMaterials, data.materials lists per assigned material { materialId, solidCount, totalVolume, volumeUnit, totalMass (g), totalMassKg, volumeMethod, ' +
    'densitySource, unverified, unverifiedReasons } plus data.unassignedSolidCount.',
  params: z.object({
    includeStandardParts: z
      .boolean()
      .describe(
        'Add data.standardParts (instances grouped by part number). Default true when any component has a partRef, else the section is omitted.',
      )
      .optional(),
    includeMaterials: z
      .boolean()
      .describe('Add data.materials: volume and mass (g) per assigned material over all solids, with unverified flags. Default false.')
      .optional(),
  }),
  run: (doc, { includeStandardParts, includeMaterials = false }, ctx): CommandResult => {
    const byComponent = new Map<string, InstanceEntity[]>();
    for (const entity of Object.values(doc.entities)) {
      if (entity.kind === 'instance') byComponent.set(entity.componentId, [...(byComponent.get(entity.componentId) ?? []), entity]);
    }
    const rows: BomRow[] = [...byComponent].map(([componentId, instances]) => {
      const component = doc.components[componentId];
      if (!component) return { componentId, componentName: '(missing)', count: instances.length, perEntityKindCounts: {}, orphan: true };
      const perEntityKindCounts: Partial<Record<EntityKind, number>> = {};
      for (const childId of component.order) {
        const child = component.entities[childId];
        if (child) perEntityKindCounts[child.kind] = (perEntityKindCounts[child.kind] ?? 0) + 1;
      }
      return { componentId, componentName: component.name, count: instances.length, perEntityKindCounts };
    });
    rows.sort((ra, rb) => ra.componentName.localeCompare(rb.componentName));
    const totalInstances = [...byComponent.values()].reduce((sum, list) => sum + list.length, 0);
    const distinctComponents = rows.filter((r) => !r.orphan).length;
    const standardParts = standardPartRows(doc, rows);
    const data: BillOfMaterialsData = {
      rows,
      totalInstances,
      distinctComponents,
      ...((includeStandardParts ?? standardParts.length > 0) ? { standardParts } : {}),
      ...(includeMaterials ? { materials: materialRows(doc, ctx), unassignedSolidCount: unassignedSolidCount(doc) } : {}),
    };
    const partsSummary = data.standardParts?.length
      ? ` Standard parts: ${data.standardParts.map((p) => `${p.partNumber} ×${p.count}`).join(', ')}.`
      : '';
    const materialsSummary = data.materials?.length
      ? ` Materials: ${data.materials.map((m) => `${m.materialId} ${m.totalMass === undefined ? 'mass n/a' : `${m.totalMass.toPrecision(6)} g`}${m.unverified ? ' (unverified)' : ''}`).join(', ')}.`
      : '';
    if (totalInstances === 0) return report(doc, `bill_of_materials: 0 instances found. BOM is empty.${materialsSummary}`, data);
    const rowSummary = rows.map((r) => `"${r.componentName}" ×${r.count}${r.orphan ? ' [ORPHAN]' : ''}`).join(', ');
    return report(
      doc,
      `bill_of_materials: ${totalInstances} instance(s), ${distinctComponents} distinct component(s). Rows: ${rowSummary}.${partsSummary}${materialsSummary}`,
      data,
    );
  },
});
