/** check_nonlinear result guardrails on the plastic zone: strain beyond the hardening curve, beyond the elongation at break, too few elements across (TR §7.1). */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { MaterialModel } from '@core/model/materialModel';
import { findSet, setMembers } from '@core/model/materialLaws/combination';
import { evaluatePropertyModel } from '@core/model/propertyModelEval';
import type { CadDocument, Material } from '@core/model/types';
import { appendAll } from '@lib/appendAll';
import { significantNumber } from '@lib/compactNumber';
import type { NonlinearCheckItem } from './check';
import { nlsRemediation } from './codes';
import { PLASTIC_ZONE_ELEMENTS, elementsAbove, plasticZones, type PartPlasticZone } from './plasticZone';

/** Temperature the elongation at break is read at: the room-temperature value (a nonlinear_static case carries no temperature field). */
const ROOM_TEMPERATURE_K = 293.15;
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
 * model's equivalentPlasticStrain validity; any other law (perfect, linear, Voce, Johnson-Cook, Ramberg-Osgood) its validity upper bound (the deck
 * tabulates analytic laws up to it, CalculiX extends the last row flat). Null when neither is stated.
 */
export function hardeningCurveEnd(model: MaterialModel): CurveEnd | null {
  const range = model.validity?.find((candidate) => candidate.variable === 'equivalentPlasticStrain');
  const validity = range === undefined ? undefined : (range.equation ?? range.data)[1];
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
      ? { strain: validity, source: `model '${model.id}' validity equivalentPlasticStrain <= ${validity}` }
      : { strain: last, source: `model '${model.id}' last tabulated point at equivalent plastic strain ${last}` };
  }
  return validity === undefined
    ? null
    : { strain: validity, source: `model '${model.id}' validity equivalentPlasticStrain <= ${validity}` };
}

interface Elongation {
  readonly value: number;
  readonly modelId: string;
}

/** The smallest room-temperature elongation at break over the material's `elongation` models (any direction or basis: conservative), with notes for unreadable ones. */
export function elongationAtBreak(materialId: string, material: Material): { readonly value: Elongation | null; readonly notes: string[] } {
  const record = { name: materialId, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) };
  const notes: string[] = [];
  let lowest: Elongation | null = null;
  for (const model of material.propertyModels ?? []) {
    if (model.property !== 'elongation') continue;
    const evaluated = evaluatePropertyModel(record, model, { T: { value: ROOM_TEMPERATURE_K, unit: 'K' } }, { outputUnit: '1' });
    if (!evaluated.available) {
      notes.push(`material '${materialId}' elongation model '${model.id}' not read at ${ROOM_TEMPERATURE_K} K: ${evaluated.reason}`);
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

/** The three findings of one part with a plastic zone. */
function zoneItems(
  doc: CadDocument,
  analysis: AnalysisCase,
  zone: PartPlasticZone,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  notes: string[],
): NonlinearCheckItem[] {
  const peak = zone.maxPeeq;
  if (peak === null || zone.plasticElements === 0) return [];
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
  if (found !== undefined) {
    const elongation = elongationAtBreak(found.id, found.material);
    appendAll(notes, elongation.notes);
    const limit = elongation.value === null ? null : Math.log1p(elongation.value.value);
    if (elongation.value !== null && limit !== null && peak.value > limit)
      items.push(
        item(
          'NLS_STRAIN_EXCEEDS_ELONGATION',
          `part '${part}': equivalent plastic strain ${sig(peak.value)} at node ${peak.node} exceeds ln(1 + elongation at break) = ${sig(limit)} (elongation ${sig(elongation.value.value)}, model '${elongation.value.modelId}', smallest over the record at ${ROOM_TEMPERATURE_K} K); ${elementList(mesh, results, part, limit)} above it`,
          [part],
          'error',
        ),
      );
  }
  if (zone.elementsAcross !== null && zone.elementsAcross < PLASTIC_ZONE_ELEMENTS)
    items.push(
      item(
        'NLS_MESH_PLASTIC_ADEQUACY',
        `part '${part}': the plastic zone (${zone.plasticElements} of ${zone.elements} elements) is ${sig(zone.elementsAcross)} element(s) across (slab-equivalent thickness 2 V / S over the element size; ${PLASTIC_ZONE_ELEMENTS} needed)`,
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
 *   at break of the record (any direction / basis), compared with the largest nodal PEEQ of the part over every stored increment
 */
export function plasticItems(
  doc: CadDocument,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
): { readonly items: NonlinearCheckItem[]; readonly notes: string[] } {
  const notes: string[] = [];
  const zones = plasticZones(mesh, results);
  const items = zones.flatMap((zone) => zoneItems(doc, analysis, zone, mesh, results, notes));
  const measured = new Set(zones.map((zone) => zone.entityId));
  const unmeasured = Object.keys(analysis.parts).filter((part) => !measured.has(part));
  if (unmeasured.length > 0) notes.push(`plastic-zone checks skipped for part(s) without tetrahedra: ${unmeasured.join(', ')}`);
  return { items, notes };
}
