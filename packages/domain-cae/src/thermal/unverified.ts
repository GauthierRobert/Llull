/** Unverified-input propagation (PHY-03 FR-THM-22): the k / cp / density inputs of a case whose basis or range is not verified. */

import type { CadDocument } from '@core/model/types';
import type { ThermalCase } from './access';
import { caseTemperatureRange, partMaterials, propertiesNeeded, propertyTable } from './material';

export interface UnverifiedInputs {
  readonly unverified: boolean;
  readonly reasons: readonly string[];
  /** `[materialId, property]` pairs with their reasons, for check items. */
  readonly entries: readonly { readonly materialId: string; readonly property: string; readonly reasons: readonly string[] }[];
}

/** Flags of the property inputs the case reads (a property that cannot be read is reported by check_thermal, not here). */
export function unverifiedInputs(doc: CadDocument, found: ThermalCase): UnverifiedInputs {
  const { analysisCase, thermal } = found;
  const required = caseTemperatureRange(thermal);
  const entries: { materialId: string; property: string; reasons: readonly string[] }[] = [];
  const seen = new Set<string>();
  for (const part of partMaterials(doc, analysisCase)) {
    if (part.material === null) continue;
    for (const property of propertiesNeeded(analysisCase)) {
      const key = `${part.materialId}/${property}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const table = propertyTable({
        materialName: part.materialId,
        material: part.material,
        documentUnit: doc.units,
        property,
        scale: thermal.temperatureScale,
        unitSystem: analysisCase.unitSystem,
        required,
      });
      if (!('code' in table) && table.unverifiedReasons.length > 0)
        entries.push({ materialId: part.materialId, property, reasons: table.unverifiedReasons });
    }
  }
  return { unverified: entries.length > 0, reasons: entries.map((e) => `${e.materialId}.${e.property}: ${e.reasons.join(', ')}`), entries };
}
