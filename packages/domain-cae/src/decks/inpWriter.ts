/** `writeInp`: the CalculiX deck of an analysis over a mesh artifact (pure; the server transports call it). */

import type { FeArtifactPort, FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { thermalMaterialCards, thermalSections } from '../thermal/deck';
import { coupledMaterialCards, coupledSections } from '../thermomech/coupledDeck';
import { thermomechMaterialCards, thermomechSections } from '../thermomech/deck';
import { buildInp, type DisciplineTable, type InpResult } from './deckBuilder';

const DISCIPLINES: DisciplineTable = {
  heat: { materialCards: thermalMaterialCards, sections: thermalSections },
  thermomech: { materialCards: thermomechMaterialCards, sections: thermomechSections },
  coupled: { materialCards: coupledMaterialCards, sections: coupledSections },
};

/**
 * Deterministic CalculiX deck for `analysisId` over `mesh` (static: 05 mechanical sections; heat_*: thermal lane; thermo_static: 05
 * mechanical materials + thermo-mechanical lane; coupled_temperature_displacement: 05 mechanical + coupled lane). `artifacts` lets a discipline read other cases' results (thermal_result fields).
 * @invariant byte-identical for identical inputs; the mesh must have been built for the current mesh input hash
 * @failure `{ code, message, ids? }`, see `buildInp`
 */
export function writeInp(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact, artifacts: FeArtifactPort | null = null): InpResult {
  return buildInp(doc, analysisId, mesh, artifacts, DISCIPLINES);
}
