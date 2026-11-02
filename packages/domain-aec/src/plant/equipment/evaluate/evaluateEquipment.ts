/** Dispatch of the derived geometry of a parametric equipment template (vessel, exchanger, tank, pump). */

import type { Entity } from '@core/model/types';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import type { BlockTemplate, EquipmentTemplate } from '../plantData';
import { evaluateExchanger } from './evaluateExchanger';
import { evaluatePump } from './evaluatePump';
import { evaluateTank } from './evaluateTank';
import { evaluateVessel } from './evaluateVessel';

export function evaluateParametricEquipment(
  element: EquipmentElement,
  level: BuildingLevel,
  template: Exclude<EquipmentTemplate, BlockTemplate>,
): Entity[] {
  switch (template.kind) {
    case 'vessel':
      return evaluateVessel(element, level, template);
    case 'exchanger':
      return evaluateExchanger(element, level, template);
    case 'tank':
      return evaluateTank(element, level, template);
    case 'pump':
      return evaluatePump(element, level, template);
  }
}
