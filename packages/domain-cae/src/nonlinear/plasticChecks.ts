/** check_nonlinear result guardrails on the plastic zone: strain beyond the hardening curve, beyond the elongation at break, too few elements across (TR §7.1). */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { MaterialModel } from '@core/model/materialModel';
import { findSet, setMembers } from '@core/model/materialLaws/combination';
import { evaluatePropertyModel } from '@core/model/propertyModelEval';
import type { CadDocument, Material } from '@core/model/types';
import { plasticStrainBound } from '@core/model/materialLaws/validity';
import { appendAll } from '@lib/appendAll';
import { significantNumber } from '@lib/compactNumber';
import type { NonlinearCheckItem } from './check';
import { nlsRemediation } from './codes';
import { propertyTemperatureK } from '../decks/elastic';
import { PLASTIC_ZONE_ELEMENTS, elementsAbove, plasticZones, type PartPlasticZone } from './plasticZone';

/** Element ids named in a finding message. */
const LISTED_ELEMENTS = 10;

const sig = (value: number): string => significantNumber(value, 4);

const item = (code: string, message: string, ids: readonly string[], severity: 'error' | 'warning'): NonlinearCheckItem => ({
  code,
  severity,
  ids,
  message,
  remediation: nlsRemediation(code),
});

function materialOf(doc: CadDocument, entityId: string): { readonly id: string; readonly material: Material } | undefined {
  const id = doc.entities[entityId]?.materialId;
  const material = id !== undefined && Object.hasOwn(doc.materials, id) ? doc.materials[id] : undefined;
  return id === undefined || material === undefined ? undefined : { id, material };
}

/** The plastic law of the part's constitutive set (case selection, else the record default), if any. */
function plasticModel(material: Material, analysis: AnalysisCase, entityId: string): MaterialModel | undefined {
  const selected = analysis.nonlinear?.constitutiveSets;
  const setId = selected !== undefined && Object.hasOwn(selected, entityId) ? selected[entityId] : material.defaultConstitutiveSet;
  const set = findSet(material.constitutiveSets, setId);
  return set === undefined ? undefined : setMembers(set, material.materialModels ?? []).plastic;
}

interface CurveEnd {
  readonly strain: number;
  readonly source: string;
}

/**
 * Last equivalent plastic strain the hardening data reaches: a multilinear curve's last point (the smallest over temperature curves) capped by the
 * model's equivalentPlasticStrain validity (in strain units, '%' converted; the equation range ahead of the data range, as the deck); any other law (perfect, linear, Voce, Johnson-Cook, Ramberg-Osgood) its validity upper bound (the deck
 * tabulates analytic laws up to it, CalculiX extends the last row flat). Null when neither is stated.
 */
export function hardeningCurveEnd(model: MaterialModel): CurveEnd | null {
  const bound = plasticStrainBound(model.validity);
  const validity = bound?.value;
  const named = `model '${model.id}' validity (${bound?.bound ?? 'data'} range) equivalentPlasticStrain <= ${validity}`;
  const law = model.model;
  const isotropic = law.kind === 'j2_plasticity' || law.kind === 'hill48_plasticity' ? law.isotropic : undefined;
  if (isotropic?.kind === 'multilinear') {
    const last = isotropic.curves.reduce(
      (lowest, curve) =>
        Math.min(
          lowest,
          curve.points.reduce((most, [, strain]) => Math.max(most, strain), 0),
        ),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(last)) return null;
    return validity !== undefined && validity < last
      ? { strain: validity, source: named }
      : { strain: last, source: `model '${model.id}' last tabulated point at equivalent plastic strain ${last}` };
  }
  return validity === undefined ? null : { strain: validity, source: named };
}

interface Elongation {
  readonly value: number;
  readonly modelId: string;
}

/** The smallest elongation at break at `temperatureK` over the material's `elongation` models (any direction or basis: conservative), with notes for unreadable ones. */
export function elongationAtBreak(
  materialId: string,
  material: Material,
  temperatureK: number,
): { readonly value: Elongation | null; readonly notes: string[] } {
  const record = { name: materialId, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) };
  const notes: string[] = [];
  let lowest: Elongation | null = null;
  for (const model of material.propertyModels ?? []) {
    if (model.property !== 'elongation') continue;
    const evaluated = evaluatePropertyModel(record, model, { T: { value: temperatureK, unit: 'K' } }, { outputUnit: '1' });
    if (!evaluated.available) {
      notes.push(`material '${materialId}' elongation model '${model.id}' not read at ${temperatureK} K: ${evaluated.reason}`);
      continue;
    }
    if (lowest === null || evaluated.value < lowest.value) lowest = { value: evaluated.value, modelId: model.id };
  }
  return { value: lowest, notes };
}

function elementList(mesh: FeMeshArtifact, results: FeResultsArtifact, entityId: string, limit: number): string {
  const ids = elementsAbove(mesh, results, entityId, limit);
  const shown = ids.slice(0, LISTED_ELEMENTS).join(', ');
  return `${ids.length} element(s) (${shown}${ids.length > LISTED_ELEMENTS ? `, +${ids.length - LISTED_ELEMENTS} more` : ''})`;
}

interface Judging {
  readonly doc: CadDocument;
  readonly analysis: AnalysisCase;
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
  readonly temperatureK: number;
  readonly notes: string[];
  /** Elongation per material id, read once (its notes are written once). */
  readonly elongations: Map<string, Elongation | null>;
}

function elongationOf(judging: Judging, materialId: string, material: Material): Elongation | null {
  if (judging.elongations.has(materialId)) return judging.elongations.get(materialId) ?? null;
  const read = elongationAtBreak(materialId, material, judging.temperatureK);
  appendAll(judging.notes, read.notes);
  judging.elongations.set(materialId, read.value);
  return read.value;
}

/** The findings of one part: the strain checks on any positive nodal PEEQ (a notch peak with no fully plastic element included), adequacy on the plastic elements. */
function zoneItems(judging: Judging, zone: PartPlasticZone): NonlinearCheckItem[] {
  const { doc, analysis, mesh, results, notes, temperatureK } = judging;
  const peak = zone.maxPeeq;
  if (peak === null || !(peak.value > 0)) return [];
  const items: NonlinearCheckItem[] = [];
  const part = zone.entityId;
  const found = materialOf(doc, part);
  const model = found === undefined ? undefined : plasticModel(found.material, analysis, part);
  const end = model === undefined ? null : hardeningCurveEnd(model);
  if (end === null) notes.push(`part '${part}': no hardening curve end known (no tabulated curve, no equivalentPlasticStrain validity)`);
  else if (peak.value > end.strain)
    items.push(
      item(
        'NLS_STRAIN_BEYOND_CURVE',
        `part '${part}': equivalent plastic strain ${sig(peak.value)} at node ${peak.node} is beyond the hardening data (${end.source}); ${elementList(mesh, results, part, end.strain)} above it: CalculiX extends the last row flat`,
        [part],
        'warning',
      ),
    );
  const elongation = found === undefined ? null : elongationOf(judging, found.id, found.material);
  if (elongation !== null) {
    const limit = Math.log1p(elongation.value);
    if (peak.value > limit)
      items.push(
        item(
          'NLS_STRAIN_EXCEEDS_ELONGATION',
          `part '${part}': equivalent plastic strain ${sig(peak.value)} at node ${peak.node} exceeds ln(1 + elongation at break) = ${sig(limit)} (elongation ${sig(elongation.value)}, model '${elongation.modelId}', smallest over the record at ${temperatureK} K); ${elementList(mesh, results, part, limit)} above it`,
          [part],
          'error',
        ),
      );
  }
  if (zone.elementsAcross !== null && zone.elementsAcross < PLASTIC_ZONE_ELEMENTS)
    items.push(
      item(
        'NLS_MESH_PLASTIC_ADEQUACY',
        `part '${part}': the plastic zone (${zone.plasticElements} of ${zone.elements} elements plastic at every corner) is ${sig(zone.elementsAcross)} element(s) across (slab-equivalent thickness 2 V / S over the element size; ${PLASTIC_ZONE_ELEMENTS} needed)`,
        [part],
        'warning',
      ),
    );
  return items;
}

/**
 * NLS_STRAIN_BEYOND_CURVE (warning), NLS_STRAIN_EXCEEDS_ELONGATION (error) and NLS_MESH_PLASTIC_ADEQUACY (warning) per part with a plastic zone, plus
 * notes for what could not be judged.
 * @invariant pure; at most one finding per code and part; the elongation limit is the true-strain equivalent ln(1 + A) of the smallest elongation
 *   at break of the record (any direction / basis) at propertyTemperatureK(analysis), compared with the largest nodal PEEQ of the part over every stored
 *   increment; the strain checks run on any positive nodal PEEQ, the adequacy check on the fully plastic elements; elongation notes once per material
 */
export function plasticItems(
  doc: CadDocument,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
): { readonly items: NonlinearCheckItem[]; readonly notes: string[] } {
  const notes: string[] = [];
  const zones = plasticZones(mesh, results);
  const judging: Judging = { doc, analysis, mesh, results, temperatureK: propertyTemperatureK(analysis), notes, elongations: new Map() };
  const items = zones.flatMap((zone) => zoneItems(judging, zone));
  const measured = new Set(zones.map((zone) => zone.entityId));
  const unmeasured = Object.keys(analysis.parts).filter((part) => !measured.has(part));
  if (unmeasured.length > 0) notes.push(`plastic-zone checks skipped for part(s) without tetrahedra: ${unmeasured.join(', ')}`);
  return { items, notes };
}
