/** BDF model cards (GRID, element, PSOLID / PSHELL, MAT1) of a mesh artifact; element names and node orders follow 05 §3 [R14]. */

import type { FeElementType } from '@core/model/analysis';
import type { DeckContext, DeckRefusal } from '../context';
import { elasticConstants, isElasticRefusal, propertyTemperatureK } from '../elastic';
import { commentText } from '../format';
import { densityToAnalysis, stressPerMpa } from '../units';
import { cardLines, intField, realField, roundingError } from './fields';
import { isCompositePart } from '../../shell/shellDeck';

/** CORD2R id of the material system (MCID) of composite property `pid` is this + pid. */
export const COMPOSITE_CID_BASE = 100;

/** CalculiX / Abaqus element type -> Nastran card. C3D10 and S6 / S8 keep their node order (mid-edge nodes after the corners, same convention in both codes). */
export const ELEMENT_CARDS: Readonly<Partial<Record<FeElementType, { readonly card: string; readonly shell: boolean }>>> = {
  C3D4: { card: 'CTETRA', shell: false },
  C3D10: { card: 'CTETRA', shell: false },
  S3: { card: 'CTRIA3', shell: true },
  S4: { card: 'CQUAD4', shell: true },
  S6: { card: 'CTRIA6', shell: true },
  S8: { card: 'CQUAD8', shell: true },
};

/** Element types the BDF writer maps (the writer's `writable` set). */
export const BDF_ELEMENT_TYPES: ReadonlySet<string> = new Set(Object.keys(ELEMENT_CARDS));

export interface Rounding {
  /** Largest relative rounding of a written real (small field keeps 7 significant digits at most). */
  worst: number;
}

export const refusal = (code: string, message: string, ids: readonly string[] = []): DeckRefusal => ({ code, message, ids });

/** Real field text, or a refusal for a non-finite value; the rounding is tracked in `track`. */
export function real(value: number, what: string, track: Rounding): string | DeckRefusal {
  const text = realField(value);
  if (text === null) return refusal('FEA_BDF_VALUE_INVALID', `${what} = ${value} cannot be written to a BDF field`);
  track.worst = Math.max(track.worst, roundingError(value, text));
  return text;
}

/** Integer field text, or a refusal when the id does not fit 8 characters. */
export function integer(value: number, what: string): string | DeckRefusal {
  return intField(value) ?? refusal('FEA_BDF_ID_TOO_LARGE', `${what} ${value} does not fit an 8-character Nastran field`);
}

export const failed = (value: string | DeckRefusal): value is DeckRefusal => typeof value !== 'string';

/** Property id of each analysed part (1-based, `analysis.parts` order) and material id of each distinct material (1-based, first appearance). */
export function numbering(ctx: DeckContext): {
  readonly property: ReadonlyMap<string, number>;
  readonly material: ReadonlyMap<string, number>;
} {
  const property = new Map<string, number>();
  const material = new Map<string, number>();
  for (const entityId of Object.keys(ctx.analysis.parts)) {
    property.set(entityId, property.size + 1);
    const name = ctx.materialName(entityId);
    if (!material.has(name)) material.set(name, material.size + 1);
  }
  return { property, material };
}

/** GRID cards (`GRID id cp x y z`), coordinates in the analysis unit system. */
export function gridCards(ctx: DeckContext, track: Rounding): string[] | DeckRefusal {
  const lines: string[] = [];
  for (const [id, x, y, z] of ctx.mesh.nodes) {
    const fields = [
      integer(id, 'node id'),
      '',
      real(x, `node ${id} x`, track),
      real(y, `node ${id} y`, track),
      real(z, `node ${id} z`, track),
    ];
    const bad = fields.find(failed);
    if (bad !== undefined) return bad as DeckRefusal;
    lines.push(...cardLines('GRID', fields as string[]));
  }
  return lines;
}

/** Element cards of every block, with the property id of the block's part. */
export function elementCards(ctx: DeckContext, property: ReadonlyMap<string, number>): string[] | DeckRefusal {
  const lines: string[] = [];
  for (const block of ctx.mesh.blocks) {
    const mapped = ELEMENT_CARDS[block.type];
    if (mapped === undefined) return refusal('FEA_PART_INVALID', `element type ${block.type} has no Nastran card`, [block.entityId]);
    const pid = property.get(block.entityId) ?? 0;
    // Composite parts name their material system (MCID = the rosette CORD2R): after the grids, past T1..T4 on a CQUAD8.
    const mcid = isCompositePart(ctx, block.entityId)
      ? [...(mapped.card === 'CQUAD8' ? ['', '', '', ''] : []), String(COMPOSITE_CID_BASE + pid)]
      : [];
    for (const [id = 0, ...nodes] of block.elements) {
      const fields = [integer(id, 'element id'), String(pid), ...nodes.map((node) => integer(node, 'node id')), ...mcid];
      const bad = fields.find(failed);
      if (bad !== undefined) return bad as DeckRefusal;
      lines.push(...cardLines(mapped.card, fields as string[]));
    }
  }
  return lines;
}

/**
 * PSOLID / PSHELL per part and MAT1 per material. E and nu come from the same readers as the INP writer (`elasticConstants`, at the reference temperature
 * or 20 degC) converted to the case unit system; G is left blank so Nastran derives it; density from `Material.density`.
 * @failure missing material / no E, nu -> the INP writer's codes; a shell part without a numeric thickness -> FEA_PART_INVALID
 */
export function propertyCards(ctx: DeckContext, track: Rounding): { readonly lines: string[]; readonly comments: string[] } | DeckRefusal {
  const { property, material } = numbering(ctx);
  const lines: string[] = [];
  const comments: string[] = [];
  const shellTypes = new Set(ctx.mesh.blocks.flatMap((block) => (ELEMENT_CARDS[block.type]?.shell === true ? [block.entityId] : [])));
  for (const [entityId, pid] of property) {
    const mid = material.get(ctx.materialName(entityId)) ?? 0;
    const idealization = ctx.analysis.parts[entityId];
    if (isCompositePart(ctx, entityId)) continue;
    if (shellTypes.has(entityId)) {
      if (idealization?.kind === 'shell' && idealization.offset !== 'mid')
        return refusal(
          'FEA_BDF_UNSUPPORTED',
          `shell '${entityId}' with offset ${idealization.offset}: element ZOFFS is not written (mid only)`,
          [entityId],
        );
      const thickness = idealization?.kind === 'shell' ? idealization.thickness : undefined;
      if (typeof thickness !== 'number' || !(thickness > 0))
        return refusal('FEA_PART_INVALID', `shell part '${entityId}' needs a numeric thickness (an 'auto' thickness is not resolved)`, [
          entityId,
        ]);
      const text = real(thickness * ctx.lengthToAnalysis, `thickness of ${entityId}`, track);
      if (failed(text)) return text;
      lines.push(...cardLines('PSHELL', [String(pid), String(mid), text, String(mid), '', String(mid)]));
    } else lines.push(...cardLines('PSOLID', [String(pid), String(mid)]));
    comments.push(`$ llull: property ${pid} = part '${entityId}'`);
  }
  const done = new Set<number>();
  for (const [entityId] of property) {
    const mid = material.get(ctx.materialName(entityId)) ?? 0;
    if (done.has(mid) || isCompositePart(ctx, entityId)) continue;
    done.add(mid);
    const found = ctx.materialOf(entityId);
    if (found === null) return refusal('FEA_MATERIAL_MISSING', `part '${entityId}' has no material`, [entityId]);
    const elastic = elasticConstants(found, ctx.materialId(entityId) ?? '', propertyTemperatureK(ctx.analysis));
    if (isElasticRefusal(elastic)) return refusal(elastic.code, elastic.message, [entityId]);
    const fields = [
      String(mid),
      real(elastic.E * stressPerMpa(ctx.unitSystem), `E of ${found.name}`, track),
      '',
      real(elastic.nu, `nu of ${found.name}`, track),
      real(densityToAnalysis(found.density, ctx.doc.units, ctx.unitSystem), `density of ${found.name}`, track),
    ];
    const bad = fields.find(failed);
    if (bad !== undefined) return bad as DeckRefusal;
    lines.push(...cardLines('MAT1', fields as string[]));
    comments.push(`$ llull: material ${mid} = '${commentText(ctx.materialId(entityId) ?? '', 80)}' (${commentText(elastic.source)})`);
  }
  return { lines, comments };
}
