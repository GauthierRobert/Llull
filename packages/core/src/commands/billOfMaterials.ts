/**
 * bill_of_materials: read-only count of component instances (orphan instances reported, never thrown).
 *
 * @layer core/commands
 */

import type { EntityKind, InstanceEntity } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { report } from './noop';

/** One row in the bill of materials output. */
interface BomRow {
  /** Id of the component in doc.components. Absent for orphan instances. */
  componentId: string;
  /** Human-readable component name. '(missing)' for orphan instances (componentId not in doc.components). */
  componentName: string;
  /** Number of instances of this component in the document. */
  count: number;
  /**
   * Count of the component's own child entities by kind (independent of any instance scale).
   * Empty for orphan instances where the component cannot be found.
   */
  perEntityKindCounts: Partial<Record<EntityKind, number>>;
  /** When true, this component id is not present in doc.components (orphan instances). */
  orphan?: true;
}

interface BillOfMaterialsData {
  rows: BomRow[];
  totalInstances: number;
  distinctComponents: number;
}

/**
 * @command bill_of_materials
 * @pure
 * @layer core/commands
 * @affects nothing — read-only query, affected:[]
 * @invariant document is returned unchanged; rows are grouped by componentId
 * @failure orphan instances (componentId not in doc.components) produce a warning row with
 *          componentName:'(missing)' and orphan:true; no throw
 */
export const billOfMaterials = defineCommand({
  name: 'bill_of_materials',
  annotations: { readOnly: true, metaHistory: true },
  description:
    'Generate a bill of materials (BOM) from all InstanceEntity objects in the document. ' +
    'Groups instances by componentId; reports count per component and a breakdown of ' +
    'child entity kinds (perEntityKindCounts). ' +
    'Instances whose componentId is absent from doc.components are reported as orphan rows ' +
    '(componentName: "(missing)", orphan: true) — no error is thrown. ' +
    'Returns the unchanged document, affected:[], and data: ' +
    '{ rows: BomRow[], totalInstances: number, distinctComponents: number }. ' +
    'A BomRow has: { componentId, componentName, count, perEntityKindCounts, orphan? }.',
  params: z.object({}),
  run: (doc): CommandResult => {
    const byComponent = new Map<string, InstanceEntity[]>();
    for (const entity of Object.values(doc.entities)) {
      if (entity.kind === 'instance') {
        byComponent.set(entity.componentId, [
          ...(byComponent.get(entity.componentId) ?? []),
          entity,
        ]);
      }
    }

    const rows: BomRow[] = [...byComponent].map(([componentId, instances]) => {
      const component = doc.components[componentId];
      if (!component) {
        return {
          componentId,
          componentName: '(missing)',
          count: instances.length,
          perEntityKindCounts: {},
          orphan: true,
        };
      }
      const perEntityKindCounts: Partial<Record<EntityKind, number>> = {};
      for (const childId of component.order) {
        const child = component.entities[childId];
        if (child) perEntityKindCounts[child.kind] = (perEntityKindCounts[child.kind] ?? 0) + 1;
      }
      return {
        componentId,
        componentName: component.name,
        count: instances.length,
        perEntityKindCounts,
      };
    });
    rows.sort((ra, rb) => ra.componentName.localeCompare(rb.componentName));

    const totalInstances = [...byComponent.values()].reduce((sum, list) => sum + list.length, 0);
    const distinctComponents = rows.filter((r) => !r.orphan).length;
    const data = { rows, totalInstances, distinctComponents } satisfies BillOfMaterialsData;
    if (totalInstances === 0)
      return report(doc, 'bill_of_materials: 0 instances found. BOM is empty.', data);
    const rowSummary = rows
      .map((r) => `"${r.componentName}" ×${r.count}${r.orphan ? ' [ORPHAN]' : ''}`)
      .join(', ');
    return report(
      doc,
      `bill_of_materials: ${totalInstances} instance(s), ${distinctComponents} distinct component(s). ` +
        `Rows: ${rowSummary}.`,
      data,
    );
  },
});
