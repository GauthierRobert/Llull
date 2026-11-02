/** P3D_CLASS_MISMATCH for one paired inline item or equipment (plant 04 PID §5.6): the mapping table of `classMap.ts`. */

import type { EquipmentElement } from '@aec/building/types';
import type { PidEquipment, PidInline } from '../model';
import { equipmentClassesOf, inlineTypesFor } from './classMap';
import type { Inline3d } from './common';
import { makeFinding3d, type Finding3d, type Skip3d } from './finding';

export type ClassOutcome = { readonly finding: Finding3d } | { readonly skip: Skip3d } | undefined;

export function compareInlineClass(item: PidInline, component: Inline3d): ClassOutcome {
  const label = item.tag ?? item.id;
  const where = { item: label, pidIds: [item.id], elementIds: component.ids };
  const allowed = inlineTypesFor(item.dexpiClass);
  if (allowed === undefined)
    return {
      skip: {
        code: 'P3D_CLASS_MISMATCH',
        reason: 'class_not_mapped',
        ...where,
        detail: `inline ${label}: the class ${item.dexpiClass} has no 3D component type in the mapping table`,
      },
    };
  if (allowed.includes(component.type)) return undefined;
  return {
    finding: makeFinding3d({
      code: 'P3D_CLASS_MISMATCH',
      ...where,
      message: `inline ${label}: P&ID class ${item.dexpiClass} but the 3D component is ${component.type} (expected ${allowed.join(' or ')})`,
      values: { pidClass: item.dexpiClass, modelType: component.type, expected: allowed.join(',') },
    }),
  };
}

export function compareEquipmentClass(item: PidEquipment, element: EquipmentElement): ClassOutcome {
  const label = item.tag ?? item.id;
  const where = { item: label, pidIds: [item.id], elementIds: [element.id] };
  const allowed = equipmentClassesOf(element);
  if (allowed === undefined)
    return {
      skip: {
        code: 'P3D_CLASS_MISMATCH',
        reason: 'no_3d_class',
        ...where,
        detail: `equipment ${label}: the 3D element ${element.id} carries no equipment kind (not a 03 EQP vessel), so ${item.dexpiClass} cannot be compared`,
      },
    };
  if (allowed.has(item.dexpiClass)) return undefined;
  const expected = [...allowed].join(',');
  return {
    finding: makeFinding3d({
      code: 'P3D_CLASS_MISMATCH',
      ...where,
      message: `equipment ${label}: P&ID class ${item.dexpiClass} but the 3D element is a vessel that stands for ${[...allowed].join(' / ')}`,
      values: { pidClass: item.dexpiClass, modelKind: 'vessel', expected },
    }),
  };
}
