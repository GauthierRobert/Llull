/** Shared context of the deck writers (FE_PIPELINE_DESIGN §5): what a discipline needs to write its sections of one INP. */

import type { AnalysisCase, FeArtifactPort, FeMeshArtifact, UnitSystem } from '@core/model/analysis';
import type { CadDocument, Material } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { caseOf } from '../shared/access';
import { analysisLengthMetres } from '../shared/defaults';

export interface DeckContext {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly analysis: AnalysisCase;
  readonly mesh: FeMeshArtifact;
  /** Artifact port the host gave `writeInp` (null when none); disciplines read other cases' results through it. */
  readonly artifacts: FeArtifactPort | null;
  readonly unitSystem: UnitSystem;
  /** Document length unit -> analysis length unit. */
  readonly lengthToAnalysis: number;
  /** NSET name already written by the model block for that target key. */
  readonly nset: (targetKey: string) => string;
  /** `mesh.faceSets[key] ?? []`: (elementId, CalculiX face label) pairs. */
  readonly faces: (targetKey: string) => readonly (readonly [elementId: number, face: number])[];
  /** ELSET of a part, e.g. P_box_1_1. */
  readonly elset: (entityId: string) => string;
  /** `*MATERIAL` name used by the part's `*SOLID SECTION`: `M_<n>`, n by first appearance of the material among the parts. */
  readonly materialName: (entityId: string) => string;
  /** Document material id of a part (undefined when it has none). */
  readonly materialId: (entityId: string) => string | undefined;
  readonly materialOf: (entityId: string) => Material | null;
}

export type DeckSections =
  | { readonly text: string }
  | { readonly code: string; readonly message: string; readonly ids?: readonly string[] };

export type DeckRefusal = Extract<DeckSections, { readonly code: string }>;

export const isDeckRefusal = (value: DeckSections): value is DeckRefusal => 'code' in value;

/** Name safe for CalculiX set / material names: letters, digits and underscores only. */
export const safeName = (text: string): string => text.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * Deck context of `analysisId` over `mesh`.
 * @failure unknown analysis -> null
 */
export function buildDeckContext(
  doc: CadDocument,
  analysisId: string,
  mesh: FeMeshArtifact,
  artifacts: FeArtifactPort | null = null,
): DeckContext | null {
  const analysis = caseOf(doc, analysisId);
  if (analysis === undefined) return null;
  const materialId = (entityId: string): string | undefined =>
    Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
  const materialNumbers = new Map<string, number>();
  for (const entityId of Object.keys(analysis.parts)) {
    const id = materialId(entityId);
    if (id !== undefined && !materialNumbers.has(id)) materialNumbers.set(id, materialNumbers.size + 1);
  }
  return {
    doc,
    analysisId,
    analysis,
    mesh,
    artifacts,
    unitSystem: analysis.unitSystem,
    lengthToAnalysis: toMetres(doc, 1) / analysisLengthMetres(analysis.unitSystem),
    nset: safeName,
    faces: (targetKey) => (Object.hasOwn(mesh.faceSets, targetKey) ? (mesh.faceSets[targetKey] ?? []) : []),
    elset: (entityId) => `P_${safeName(entityId)}`,
    materialName: (entityId) => `M_${materialNumbers.get(materialId(entityId) ?? '') ?? 'NONE'}`,
    materialId,
    materialOf: (entityId) => {
      const id = materialId(entityId);
      return id !== undefined && Object.hasOwn(doc.materials, id) ? (doc.materials[id] ?? null) : null;
    },
  };
}

/** Load cases of an analysis in solve order (one `*STEP` each): names by first appearance, `ultimate` when any load of the case is. */
export function loadCasesOf(analysis: AnalysisCase): { readonly name: string; readonly category: 'limit' | 'ultimate' }[] {
  if ((analysis.type === 'thermo_static' || analysis.type === 'coupled_temperature_displacement') && analysis.thermomech !== undefined)
    return [{ name: analysis.thermomech.loadCaseName, category: 'limit' }];
  const cases: { name: string; category: 'limit' | 'ultimate' }[] = [];
  for (const id of analysis.loadOrder) {
    const load = analysis.loads[id];
    if (load === undefined) continue;
    const found = cases.find((entry) => entry.name === load.loadCase);
    if (found === undefined) cases.push({ name: load.loadCase, category: load.category });
    else if (load.category === 'ultimate') found.category = 'ultimate';
  }
  return cases.length === 0 ? [{ name: 'LC1', category: 'limit' }] : cases;
}

/** ELSET / NSET holding every element / node of the model (written by the model block). */
export const ALL_ELEMENTS = 'EALL';
export const ALL_NODES = 'NALL';
