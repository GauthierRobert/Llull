/**
 * CalculiX cards of 2D parts (05 §5.6, M6): `*SHELL SECTION` (thickness, OFFSET), the composite form (`*SHELL SECTION, COMPOSITE` with one
 * `*MATERIAL` of engineering constants per lamina and one `*ORIENTATION` per ply) and the plane-stress `*SOLID SECTION` with its thickness.
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { cross3, dot3, normalize3, sub3 } from '@lib/vec3';
import { safeName, type DeckContext, type DeckSections } from '../decks/context';
import { commentText, linesText, num, row } from '../decks/format';
import { densityToAnalysis, stressPerMpa } from '../decks/units';
import { isLaminateRefusal, laminateOf, type Laminate } from './laminate';
import { SHELL_OFFSET } from './meshGeometry';

const SHELL_TYPES: ReadonlySet<string> = new Set(['S3', 'S4', 'S6', 'S8']);

/** The idealization of `entityId` is a composite shell. */
export function isCompositePart(ctx: DeckContext, entityId: string): boolean {
  const idealization = ctx.analysis.parts[entityId];
  return idealization?.kind === 'shell' && idealization.laminate !== undefined;
}

/** Unit normal of the first element of the part (corner order, right-hand rule), or null without one. */
export function firstElementNormal(ctx: DeckContext, entityId: string): Vec3 | null {
  const block = ctx.mesh.blocks.find((candidate) => candidate.entityId === entityId && SHELL_TYPES.has(candidate.type));
  const element = block?.elements[0];
  if (element === undefined) return null;
  const coordinates = new Map(ctx.mesh.nodes.map(([id, x, y, z]) => [id, [x, y, z] as Vec3]));
  const [p0, p1, p2] = [element[1], element[2], element[3]].map((node) => coordinates.get(node ?? 0) ?? ([0, 0, 0] as Vec3));
  return p0 === undefined || p1 === undefined || p2 === undefined ? null : normalize3(cross3(sub3(p1, p0), sub3(p2, p0)));
}

/** Engineering constants of a lamina (transversely isotropic: E3 = E2, nu13 = nu12, G13 = G13 ?? G12, G23 = G23 ?? G13, nu23 = E2 / (2 G23) - 1). */
function laminaCards(doc: CadDocument, ctx: DeckContext, name: string, laminate: Laminate, materialName: string): string[] | string {
  const lamina = laminate.materials[materialName];
  if (lamina === undefined) return `lamina material '${materialName}' is missing`;
  const factor = stressPerMpa(ctx.unitSystem);
  const g13 = lamina.G13 ?? lamina.G12;
  const g23 = lamina.G23 ?? g13;
  const nu23 = lamina.E2 / (2 * g23) - 1;
  if (!(nu23 > -1 && nu23 < 0.5))
    return `lamina '${materialName}': derived nu23 = ${num(nu23)} (E2 / (2 G23) - 1) is outside (-1, 0.5): give G23`;
  const assumed = [lamina.G13 === undefined ? 'G13 = G12' : '', lamina.G23 === undefined ? 'G23 = G13' : ''].filter((text) => text !== '');
  const needsDensity = ctx.analysis.type === 'modal' || ctx.analysis.loadOrder.some((id) => ctx.analysis.loads[id]?.kind === 'gravity');
  if (needsDensity && lamina.density === undefined) return `lamina '${materialName}' has no density (modal / gravity need one)`;
  return [
    `** lamina ${name} = '${commentText(materialName, 80)}' (${commentText(lamina.source, 80)}); transversely isotropic: E3 = E2, nu13 = nu12, nu23 = E2 / (2 G23) - 1${assumed.length > 0 ? `; assumed ${assumed.join(', ')}` : ''}`,
    `*MATERIAL, NAME=${name}`,
    '*ELASTIC, TYPE=ENGINEERING CONSTANTS',
    row(lamina.E1 * factor, lamina.E2 * factor, lamina.E2 * factor, lamina.nu12, lamina.nu12, nu23, lamina.G12 * factor, g13 * factor),
    row(g23 * factor),
    ...(lamina.density === undefined ? [] : ['*DENSITY', row(densityToAnalysis(lamina.density, doc.units, ctx.unitSystem))]),
  ];
}

/**
 * Composite section of `entityId`: lamina materials, ply orientations (rosette 0-degree axis projected on the shell, rotated by the ply angle about the
 * shell normal) and `*SHELL SECTION, COMPOSITE` with one `thickness,, material, orientation` line per ply, bottom to top along the element normal (the
 * laminate is reversed when its stacking direction opposes the element normal).
 * @failure laminate refusals; S3 / S4 / S6 elements (CalculiX composites need S8R) -> FEA_COMPOSITE_ELEMENT; lamina problems -> FEA_COMPOSITE_INVALID
 */
function compositeSection(ctx: DeckContext, entityId: string, offset: number): DeckSections {
  const idealization = ctx.analysis.parts[entityId];
  if (idealization?.kind !== 'shell' || idealization.laminate === undefined) return { text: '' };
  const laminate = laminateOf(ctx.doc, idealization.laminate.compositePartId, entityId, idealization.laminate.sectionId);
  if (isLaminateRefusal(laminate)) return { code: laminate.code, message: laminate.message, ids: [entityId] };
  const types = ctx.mesh.blocks.filter((block) => block.entityId === entityId).map((block) => block.type);
  if (types.some((type) => type !== 'S8'))
    return {
      code: 'FEA_COMPOSITE_ELEMENT',
      message: `composite shell '${entityId}' needs 8-node quadrilaterals (CalculiX S8R): set_mesh_controls elementFamily=shell_quad order=2`,
      ids: [entityId],
    };
  const normal = firstElementNormal(ctx, entityId) ?? laminate.stackNormal;
  const plies = dot3(normal, laminate.stackNormal) < 0 ? [...laminate.plies].reverse() : laminate.plies;
  const part = safeName(entityId);
  const lines: string[] = [];
  const names = new Map<string, string>();
  for (const ply of plies) {
    if (names.has(ply.materialName)) continue;
    const name = `L_${part}_${names.size + 1}`;
    names.set(ply.materialName, name);
    const cards = laminaCards(ctx.doc, ctx, name, laminate, ply.materialName);
    if (typeof cards === 'string') return { code: 'FEA_COMPOSITE_INVALID', message: cards, ids: [entityId] };
    lines.push(...cards);
  }
  const section: string[] = [];
  plies.forEach((ply, index) => {
    const orientation = `OR_${part}_${index + 1}`;
    const b = normalize3(cross3(normal, ply.axis0));
    lines.push(`*ORIENTATION, NAME=${orientation}`, row(...ply.axis0, ...b), row(3, ply.angleDeg));
    section.push(row(ply.thickness * ctx.lengthToAnalysis, '', names.get(ply.materialName) ?? '', orientation));
  });
  lines.push(
    `** composite part '${commentText(laminate.compositePartId, 80)}': ${plies.length} plies bottom to top along the element normal`,
    `*SHELL SECTION, ELSET=${ctx.elset(entityId)}, COMPOSITE, OFFSET=${num(offset)}`,
    ...section,
  );
  return { text: linesText(lines) };
}

/**
 * Section cards of a 2D part, or null for a solid part (the caller writes `*SOLID SECTION`).
 * @failure composite refusals (see compositeSection)
 */
export function planarSectionCards(ctx: DeckContext, entityId: string): DeckSections | null {
  const idealization = ctx.analysis.parts[entityId];
  if (idealization?.kind === 'plane_stress')
    return {
      text: linesText([
        `*SOLID SECTION, ELSET=${ctx.elset(entityId)}, MATERIAL=${ctx.materialName(entityId)}`,
        row(idealization.thickness * ctx.lengthToAnalysis),
      ]),
    };
  if (idealization?.kind !== 'shell') return null;
  const offset = SHELL_OFFSET[idealization.offset];
  if (idealization.laminate !== undefined) return compositeSection(ctx, entityId, offset);
  if (typeof idealization.thickness !== 'number')
    return {
      code: 'FEA_PART_INVALID',
      message: `shell part '${entityId}' has no resolved thickness: set_part_idealization again`,
      ids: [entityId],
    };
  return {
    text: linesText([
      `*SHELL SECTION, ELSET=${ctx.elset(entityId)}, MATERIAL=${ctx.materialName(entityId)}, OFFSET=${num(offset)}`,
      row(idealization.thickness * ctx.lengthToAnalysis),
    ]),
  };
}

/** `*ELEMENT, TYPE=` name of a mesh block: S8 blocks of composite parts are written as S8R (CalculiX composites need it). */
export function deckElementType(ctx: DeckContext, type: string, entityId: string): string {
  return type === 'S8' && isCompositePart(ctx, entityId) ? 'S8R' : type;
}

/** Idealization kind of the part a target belongs to (shell / plane_stress change the boundary dofs and pressure labels). */
export function targetKind(ctx: DeckContext, entityId: string | undefined): 'solid' | 'shell' | 'plane_stress' {
  const kind = entityId === undefined ? undefined : ctx.analysis.parts[entityId]?.kind;
  return kind === 'shell' || kind === 'plane_stress' ? kind : 'solid';
}
