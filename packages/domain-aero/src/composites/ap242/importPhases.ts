/** import_composite_ap242 phases: file text, exact solids, materials, rosettes, part + plies, and the solid-volume findings (06 CMP M5). */

import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CompositePart, CompositesModel, LaminaMaterial, Ply, Rosette } from '@core/model/composites';
import type { CadDocument } from '@core/model/types';
import { base64ToText } from '@lib/base64';
import { MM_PER_UNIT } from '@core/model/units';
import { nextId } from '@lib/id';
import { insertPly } from '../plyCommands';
import type { ReadOutcome } from './reader';
import { withoutCompositeUsages } from './standardReader';
import type { rebuildPart } from './rebuild';
import { type ValidationFinding, compare, plyArea } from './validation';

const MAX_STEP_CHARS = 64 * 1024 * 1024;

/** Relative difference between a ply solid's volume and area x thickness: green up to 1 % (curvature of the offset, faceting), yellow up to 5 %. */
const VOLUME_GREEN = 0.01;
const VOLUME_YELLOW = 0.05;

type ReadRecord = Extract<ReadOutcome, { ok: true }>['record'];

export interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly paths: readonly string[];
}

/** An imported lamina record: the original data with its basis reset to unknown (nobody verified it here) and the origin in the source. */
const unverifiedMaterial = (material: LaminaMaterial): LaminaMaterial => ({
  ...material,
  basis: 'unknown',
  source: `imported from STEP AP242 (original basis ${material.basis}; ${material.source})`,
});

/** The STEP text from `text` or `stepBase64`, or the refusal. */
export function stepTextOf(params: { readonly text?: string | undefined; readonly stepBase64?: string | undefined }): string | Refusal {
  if (params.stepBase64 !== undefined && params.stepBase64.length > Math.ceil((MAX_STEP_CHARS * 4) / 3))
    return { code: 'CMP_PARAM_INVALID', message: 'the file is larger than 64 MiB', paths: ['params.stepBase64'] };
  const text = params.text ?? (params.stepBase64 === undefined ? undefined : base64ToText(params.stepBase64));
  if (text === undefined || text === null || text.length === 0)
    return { code: 'CMP_PARAM_INVALID', message: 'give the file as text or stepBase64', paths: ['params.text'] };
  if (text.length > MAX_STEP_CHARS) return { code: 'CMP_PARAM_INVALID', message: 'the file is larger than 64 MiB', paths: ['params.text'] };
  return text;
}

export interface ImportedSolids {
  readonly base: CadDocument;
  readonly solidIds: string[];
  readonly solidsReport: unknown;
}

/** The exact solids of the file through import_step_exact (when wanted), or the refusal message. */
export function importSolids(
  doc: CadDocument,
  text: string,
  wanted: boolean,
  ctx: ExecutionContext | undefined,
): ImportedSolids | { readonly refused: string } {
  if (!wanted) return { base: doc, solidIds: [], solidsReport: undefined };
  const imported: CommandResult = execute(doc, 'import_step_exact', { text: withoutCompositeUsages(text) }, ctx);
  if (imported.error !== undefined || imported.affected.length === 0) return { refused: `import_step_exact answered: ${imported.summary}` };
  return {
    base: imported.document,
    solidIds: imported.affected,
    solidsReport: (imported.data as { report?: unknown } | undefined)?.report,
  };
}

/** Lamina materials of the file the document lacks (added unverified) and the ones it already has. */
export function mergeMaterials(
  model: CompositesModel,
  record: ReadRecord,
): { materials: Record<string, LaminaMaterial>; created: string[]; reused: string[] } {
  const materials: Record<string, LaminaMaterial> = { ...model.materials };
  const created: string[] = [];
  const reused: string[] = [];
  for (const material of record.materials) {
    if (materials[material.name] === undefined) {
      materials[material.name] = unverifiedMaterial(material);
      created.push(material.name);
    } else reused.push(material.name);
  }
  return { materials, created, reused };
}

/** Rosettes of the file the document lacks (minted in file order); the id of every rosette by name. */
export function mergeRosettes(
  model: CompositesModel,
  record: ReadRecord,
): { rosettes: Record<string, Rosette>; rosetteIdOf: Map<string, string>; created: string[] } {
  const rosettes: Record<string, Rosette> = { ...model.rosettes };
  const rosetteIdOf = new Map<string, string>();
  for (const entry of Object.values(rosettes)) if (!rosetteIdOf.has(entry.name)) rosetteIdOf.set(entry.name, entry.id);
  const created: string[] = [];
  for (const entry of record.rosettes) {
    if (rosetteIdOf.has(entry.name)) continue;
    const id = nextId('ros');
    rosettes[id] = { id, ...entry };
    rosetteIdOf.set(entry.name, id);
    created.push(entry.name);
  }
  return { rosettes, rosetteIdOf, created };
}

/** The composite part record of the file on the imported (or file-named) tool solid. */
export function partOf(
  partId: string,
  partName: string,
  record: ReadRecord,
  toolEntity: string | undefined,
  partRosette: string,
): CompositePart {
  return {
    id: partId,
    name: partName,
    toolFaces: [
      {
        entityId: toolEntity ?? record.tool.entityId,
        faceNear: record.tool.faceNear,
        ...(record.tool.faceIndex === undefined ? {} : { faceIndex: record.tool.faceIndex }),
      },
    ],
    laminateSide: record.laminateSide,
    rosetteId: partRosette,
    surface: record.surface,
    outline: record.outline,
    ...(record.rules === undefined ? {} : { rules: record.rules }),
    ...(record.plyDropRules === undefined ? {} : { plyDropRules: record.plyDropRules }),
  };
}

/** The plies of the file inserted into the model in stacking order. */
export function insertPlies(
  start: CompositesModel,
  part: CompositePart,
  record: ReadRecord,
  rosetteIdOf: ReadonlyMap<string, string>,
  partRosette: string,
): { working: CompositesModel; plies: Ply[] } {
  let working = start;
  const plies: Ply[] = [];
  for (const entry of [...record.plies].sort((a, b) => a.order - b.order)) {
    const inserted = insertPly(working, part, {
      name: entry.name,
      materialName: entry.material,
      orientation: entry.orientation,
      sequence: entry.sequence,
      rosetteId: rosetteIdOf.get(entry.rosette) ?? partRosette,
      boundary: entry.boundary,
      ...(entry.drape === undefined ? {} : { drape: entry.drape }),
      ...(entry.cuts === undefined ? {} : { cuts: entry.cuts }),
    });
    working = inserted.model;
    plies.push(inserted.ply);
  }
  return { working, plies };
}

export interface LinkedPly {
  readonly ply: string;
  readonly name: string;
  readonly solids: string[];
  readonly expectedSolids: number;
}

/** Per ply of the file: its inserted id and the imported solids found by name. */
export function linkPlies(record: ReadRecord, plies: readonly Ply[], byName: ReadonlyMap<string, string>): LinkedPly[] {
  return record.plies.map((entry) => ({
    ply: plies.find((ply) => ply.name === entry.name)?.id ?? '',
    name: entry.name,
    solids: entry.solids.flatMap((solid) => (byName.has(solid) ? [byName.get(solid) as string] : [])),
    expectedSolids: entry.solids.length,
  }));
}

/** Findings on the imported solids: tool solid imported, ply solids linked, ply solid volume against area x thickness. */
export function solidFindings(
  record: ReadRecord,
  rebuilt: ReturnType<typeof rebuildPart>,
  linked: readonly LinkedPly[],
  solidsReport: unknown,
  units: CadDocument['units'],
  toolEntity: string | undefined,
): ValidationFinding[] {
  const geometry: ValidationFinding[] = [];
  /** Volume (document units^3) of the products the entities belong to, from the import report's recomputed values (millimetres); undefined when not reported. */
  const reported =
    (solidsReport as { exchange?: { products?: { entityIds?: string[]; recomputed?: { volume: number } }[] } } | undefined)?.exchange
      ?.products ?? [];
  const cubic = MM_PER_UNIT[units] ** 3;
  const volumesOf = (ids: readonly string[]): (number | undefined)[] => {
    const products = [...new Set(ids.map((id) => reported.find((product) => product.entityIds?.includes(id))))];
    return products.map((product) => (product?.recomputed === undefined ? undefined : product.recomputed.volume / cubic));
  };
  geometry.push(compare('structure: tool solid imported', record.tool.name, 1, toolEntity === undefined ? 0 : 1));
  for (const entry of linked)
    if (entry.expectedSolids > 0)
      geometry.push(compare('structure: ply solids linked', entry.name, entry.expectedSolids, entry.solids.length));
  for (const entry of linked) {
    const rebuiltPly = rebuilt.plies.find((candidate) => candidate.record.name === entry.name);
    if (rebuiltPly === undefined || entry.solids.length === 0 || entry.solids.length < entry.expectedSolids) continue;
    const volumes = volumesOf(entry.solids);
    const expected = plyArea(rebuilt.part, rebuiltPly.ply) * rebuiltPly.record.thickness;
    if (volumes.some((volume) => typeof volume !== 'number')) {
      geometry.push({
        property: 'structure: ply solid volume',
        subject: entry.name,
        embedded: null,
        recomputed: expected,
        relativeDifference: null,
        band: 'not_checkable',
      });
      continue;
    }
    const total = (volumes as number[]).reduce((sum, volume) => sum + volume, 0);
    const relative = Math.abs(total - expected) / Math.max(expected, 1e-300);
    geometry.push({
      property: 'structure: ply solid volume',
      subject: entry.name,
      embedded: total,
      recomputed: expected,
      relativeDifference: relative,
      band: relative <= VOLUME_GREEN ? 'green' : relative <= VOLUME_YELLOW ? 'yellow' : 'red',
    });
  }
  return geometry;
}
