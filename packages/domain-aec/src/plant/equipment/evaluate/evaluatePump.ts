/** Derived geometry of a parametric pump (plant 03 EQP §2, §5.8): envelope body, driver and baseplate boxes plus the suction / discharge nozzles. */

import type { Entity } from '@core/model/types';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import { pumpLayout } from '../geometry/pumpLayout';
import type { PumpTemplate } from '../plantData';
import { evaluateNozzles } from './evaluateNozzles';
import { supportBox } from './revolutionPart';

export function evaluatePump(element: EquipmentElement, level: BuildingLevel, template: PumpTemplate): Entity[] {
  return [
    ...pumpLayout(template).boxes.map((box) => supportBox(element, level, box.part, `${box.label} ${element.mark}`, box.center, box.size)),
    ...evaluateNozzles(element, level),
  ];
}
