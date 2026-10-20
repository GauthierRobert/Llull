/**
 * CalculiX cards of 2D parts (05 §5.6, M6): `*SHELL SECTION` (thickness, OFFSET), the composite form (`*SHELL SECTION, COMPOSITE` with one
 * `*MATERIAL` of engineering constants per lamina and one `*ORIENTATION` per ply) and the plane-stress `*SOLID SECTION` with its thickness.
 */

import type { LaminaMaterial } from '@core/model/composites';
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

/** Elements of one composite part may deviate from a common plane by at most this angle (cos): one orientation / CORD2R serves the part. */
const COPLANAR_COS = Math.cos((1 * Math.PI) / 180);

/**
 * The single element normal of a composite part, or why there is none: composite sections carry ONE ply frame per part, so the part's midsurface
 * must be planar with consistently oriented elements (a sheet-metal bend or an L-shaped face-paired part is refused, not silently mis-oriented).
 */
export function compositePlane(ctx: DeckContext, entityId: string): Vec3 | string {
  const coordinates = new Map(ctx.mesh.nodes.map(([id, x, y, z]) => [id, [x, y, z] as Vec3]));
  let first: Vec3 | null = null;
  for (const block of ctx.mesh.blocks) {
    if (block.entityId !== entityId || !SHELL_TYPES.has(block.type)) continue;
    for (const element of block.elements) {
      const [p0, p1, p2] = [element[1], element[2], element[3]].map((node): Vec3 => coordinates.get(node ?? 0) ?? [0, 0, 0]);
      const normal = normalize3(cross3(sub3(p1 ?? [0, 0, 0], p0 ?? [0, 0, 0]), sub3(p2 ?? [0, 0, 0], p0 ?? [0, 0, 0])));
      if (first === null) first = normal;
      else if (dot3(first, normal) < COPLANAR_COS)
        return `composite shell '${entityId}' is not planar (element ${element[0] ?? 0} turns away from the first element): one ply frame per part is written, so split the part at its bends or keep it solid`;
    }
  }
  return first ?? `composite shell '${entityId}' has no shell element`;
}

/** The rosette 0-degree axis projected on the shell plane (unit), or null when it is normal to it. */
export function projectedAxis(axis: Vec3, normal: Vec3): Vec3 | null {
  const inPlane = sub3(axis, [normal[0] * dot3(axis, normal), normal[1] * dot3(axis, normal), normal[2] * dot3(axis, normal)]);
  return Math.hypot(...inPlane) < 1e-6 ? null : normalize3(inPlane);
}

/** Plausible lamina densities, kg/m^3: outside them the value was almost certainly entered in another unit than g per cubic document unit. */
const LAMINA_DENSITY_KG_M3: readonly [number, number] = [50, 25000];

/**
 * Why a lamina cannot be written to a deck, or null: G23 is required (a derived nu23 from a defaulted G23 goes negative for CFRP), and the density
 * must be plausible in kg/m^3 once read as grams per cubic document unit.
 */
export function laminaProblem(doc: CadDocument, materialName: string, lamina: LaminaMaterial): string | null {
  if (lamina.G23 === undefined)
    return `lamina '${materialName}' has no G23 (transverse shear modulus): composite decks need it (nu23 = E2 / (2 G23) - 1), there is no default`;
  if (lamina.density === undefined) return null;
  const kgPerM3 = densityToAnalysis(lamina.density, doc.units, 'N-m-kg-s');
  const [low, high] = LAMINA_DENSITY_KG_M3;
  return kgPerM3 >= low && kgPerM3 <= high
    ? null
    : `lamina '${materialName}' density ${num(lamina.density)} g/${doc.units}^3 is ${num(kgPerM3)} kg/m^3, outside [${low}, ${high}]: enter it in grams per cubic ${doc.units}`;
}

/** Engineering constants of a lamina (transversely isotropic: E3 = E2, nu13 = nu12, G13 = G13 ?? G12, G23 given, nu23 = E2 / (2 G23) - 1). */
function laminaCards(doc: CadDocument, ctx: DeckContext, name: string, laminate: Laminate, materialName: string): string[] | string {
  const lamina = laminate.materials[materialName];
  if (lamina === undefined) return `lamina material '${materialName}' is missing`;
  const factor = stressPerMpa(ctx.unitSystem);
  const problem = laminaProblem(doc, materialName, lamina);
  if (problem !== null) return problem;
  const g13 = lamina.G13 ?? lamina.G12;
  const g23 = lamina.G23 ?? g13;
  const nu23 = lamina.E2 / (2 * g23) - 1;
  if (!(nu23 > -1 && nu23 < 0.5))
    return `lamina '${materialName}': derived nu23 = ${num(nu23)} (E2 / (2 G23) - 1) is outside (-1, 0.5): check G23`;
  const assumed = [lamina.G13 === undefined ? 'G13 = G12' : ''].filter((text) => text !== '');
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
  const normal = compositePlane(ctx, entityId);
  if (typeof normal === 'string') return { code: 'FEA_COMPOSITE_NOT_PLANAR', message: normal, ids: [entityId] };
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
  for (const [index, ply] of plies.entries()) {
    const orientation = `OR_${part}_${index + 1}`;
    const a = projectedAxis(ply.axis0, normal);
    if (a === null)
      return {
        code: 'FEA_COMPOSITE_INVALID',
        message: `ply '${ply.name}': the rosette 0-degree axis is normal to the shell`,
        ids: [entityId],
      };
    const b = normalize3(cross3(normal, a));
    lines.push(`*ORIENTATION, NAME=${orientation}`, row(...a, ...b), row(3, ply.angleDeg));
    section.push(row(ply.thickness * ctx.lengthToAnalysis, '', names.get(ply.materialName) ?? '', orientation));
  }
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
