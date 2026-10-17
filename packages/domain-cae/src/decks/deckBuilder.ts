/** INP assembly (05 §5.6, FE_PIPELINE_DESIGN §5): model block + materials + sections + the steps of the analysis type. */

import type { FeArtifactPort, FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { analysisInputHash } from '../hash/inputHash';
import { ALL_ELEMENTS, ALL_NODES, buildDeckContext, isDeckRefusal, type DeckContext, type DeckRefusal, type DeckSections } from './context';
import type { MaterialCardWriter } from './constitutive';
import { commentText, idLines, linesText, row } from './format';
import { mechanicalMaterialLines, staticStep } from './mechanical';

/** The discipline functions of the thermal and thermo-mechanical lanes (FE_PIPELINE_DESIGN §5 table). */
export interface DisciplineTable {
  /** Constitutive-set cards (plastic / hyperelastic / creep); absent or null result = the elastic / thermal cards below. */
  readonly materialCardWriter?: MaterialCardWriter;
  readonly heat: {
    readonly materialCards: (ctx: DeckContext, entityId: string) => DeckSections;
    readonly sections: (ctx: DeckContext) => DeckSections;
  };
  readonly thermomech: {
    readonly materialCards: (ctx: DeckContext, entityId: string) => DeckSections;
    readonly sections: (ctx: DeckContext) => DeckSections;
  };
  readonly coupled: {
    readonly materialCards: (ctx: DeckContext, entityId: string) => DeckSections;
    readonly sections: (ctx: DeckContext) => DeckSections;
  };
}

export type InpResult = { readonly text: string } | DeckRefusal;

const refuse = (code: string, message: string, ids: readonly string[] = []): DeckRefusal => ({ code, message, ids });

/** Sets are matched case-insensitively by CalculiX: two sources that sanitise to the same name would silently merge. */
function nameCollision(ctx: DeckContext): DeckRefusal | null {
  const groups: {
    readonly kind: string;
    readonly sources: readonly string[];
    readonly name: (source: string) => string;
    readonly reserved: string;
  }[] = [
    { kind: 'element set', sources: [...new Set(ctx.mesh.blocks.map((block) => block.entityId))], name: ctx.elset, reserved: ALL_ELEMENTS },
    { kind: 'node set', sources: Object.keys(ctx.mesh.nodeSets), name: ctx.nset, reserved: ALL_NODES },
  ];
  for (const { kind, sources, name, reserved } of groups) {
    const owners = new Map<string, string>([[reserved, reserved]]);
    for (const source of sources) {
      const upper = name(source).toUpperCase();
      const other = owners.get(upper);
      if (other !== undefined)
        return refuse('FEA_DECK_NAME_COLLISION', `${kind} names of '${other}' and '${source}' are both ${upper} after sanitising`, [
          source,
        ]);
      owners.set(upper, source);
    }
  }
  return null;
}

function precheck(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact, ctx: DeckContext): DeckRefusal | null {
  const { analysis } = ctx;
  if (analysis.type === 'modal' || analysis.type === 'buckling')
    return refuse('FEA_ANALYSIS_TYPE_UNSUPPORTED', `analysis type '${analysis.type}' has no deck writer`, [analysisId]);
  if (mesh.kind !== 'fe_mesh') return refuse('FEA_ARTIFACT_NOT_FOUND', 'the mesh artifact is not an fe_mesh', [analysisId]);
  if (mesh.inputHash !== analysisInputHash(doc, analysisId, 'mesh'))
    return refuse('FEA_MESH_STALE', `the mesh was built for other inputs than the current analysis '${analysisId}'`, [analysisId]);
  if (mesh.unitSystem !== analysis.unitSystem)
    return refuse('FEA_UNITS_MISMATCH', `mesh unit system ${mesh.unitSystem} differs from the analysis ${analysis.unitSystem}`, [
      analysisId,
    ]);
  const blockEntities = new Set<string>();
  for (const block of mesh.blocks) {
    if (block.type !== 'C3D4' && block.type !== 'C3D10')
      return refuse('FEA_PART_INVALID', `element type ${block.type} of '${block.entityId}' is not written (C3D4 and C3D10 only)`, [
        block.entityId,
      ]);
    if (!Object.hasOwn(analysis.parts, block.entityId))
      return refuse('FEA_PART_INVALID', `the mesh has elements of '${block.entityId}', which is not a part of the analysis`, [
        block.entityId,
      ]);
    blockEntities.add(block.entityId);
  }
  for (const entityId of Object.keys(analysis.parts)) {
    if (!blockEntities.has(entityId)) return refuse('FEA_PART_INVALID', `part '${entityId}' has no elements in the mesh`, [entityId]);
    const material = ctx.materialOf(entityId);
    if (material === null) return refuse('FEA_MATERIAL_MISSING', `part '${entityId}' has no material`, [entityId]);
    if (material.record?.unresolved !== undefined)
      return refuse(
        'MAT_LIBRARY_UNRESOLVED',
        `part '${entityId}': material '${material.name}' comes from private library '${material.record.libraryRef?.libraryId ?? '?'}', not resolved on this machine (${material.record.unresolved.reason}); run resolve_material_libraries`,
        [entityId, material.record.id],
      );
  }
  const collision = nameCollision(ctx);
  if (collision !== null) return collision;
  const structural = analysis.type !== 'heat_steady' && analysis.type !== 'heat_transient';
  if (structural && analysis.constraintOrder.length === 0)
    return refuse('FEA_NO_CONSTRAINTS', `analysis '${analysisId}' has no constraint: the stiffness matrix would be singular`, [analysisId]);
  return null;
}

function modelBlock(ctx: DeckContext): string[] {
  const { mesh } = ctx;
  const lines = [`*NODE, NSET=${ALL_NODES}`, ...mesh.nodes.map(([id, x, y, z]) => row(id, x, y, z))];
  for (const block of mesh.blocks) {
    lines.push(`*ELEMENT, TYPE=${block.type}, ELSET=${ctx.elset(block.entityId)}`);
    lines.push(...block.elements.map((element) => row(...element)));
  }
  const elsets = [...new Set(mesh.blocks.map((block) => ctx.elset(block.entityId)))];
  lines.push(`*ELSET, ELSET=${ALL_ELEMENTS}`);
  for (let i = 0; i < elsets.length; i += 8) lines.push(elsets.slice(i, i + 8).join(', '));
  for (const key of Object.keys(mesh.nodeSets).sort()) {
    const ids = mesh.nodeSets[key] ?? [];
    if (ids.length > 0) lines.push(`*NSET, NSET=${ctx.nset(key)}`, ...idLines(ids));
  }
  return lines;
}

/**
 * Deterministic CalculiX deck of `analysisId` over `mesh`, with the discipline functions in `disciplines`.
 * @invariant byte-identical for identical inputs; header `** llull analysis <name> units <us> inputHash <h> meshHash <m>`
 * @failure unknown analysis / unsupported type -> FEA_ANALYSIS_NOT_FOUND / FEA_ANALYSIS_TYPE_UNSUPPORTED; mesh of other inputs -> FEA_MESH_STALE;
 *   part without elements or with non-tet elements -> FEA_PART_INVALID; no material -> FEA_MATERIAL_MISSING; static / thermo_static / coupled without a
 *   constraint -> FEA_NO_CONSTRAINTS; plus every refusal of the mechanical and discipline functions
 */
export function buildInp(
  doc: CadDocument,
  analysisId: string,
  mesh: FeMeshArtifact,
  artifacts: FeArtifactPort | null,
  disciplines: DisciplineTable,
): InpResult {
  const ctx = buildDeckContext(doc, analysisId, mesh, artifacts);
  if (ctx === null) return refuse('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
  const problem = precheck(doc, analysisId, mesh, ctx);
  if (problem !== null) return problem;
  const { analysis } = ctx;
  const heat = analysis.type === 'heat_steady' || analysis.type === 'heat_transient';
  const lines = [
    `** llull analysis ${commentText(analysis.name)} units ${analysis.unitSystem} inputHash ${analysisInputHash(doc, analysisId, 'full')} meshHash ${sha256Hex(canonicalJson(mesh))}`,
    ...modelBlock(ctx),
  ];
  const materialOwners = new Map<string, string>();
  for (const entityId of Object.keys(analysis.parts))
    if (!materialOwners.has(ctx.materialName(entityId))) materialOwners.set(ctx.materialName(entityId), entityId);
  for (const [name, entityId] of materialOwners) {
    const constitutive = heat ? null : (disciplines.materialCardWriter?.(ctx, entityId) ?? null);
    if (constitutive !== null && 'code' in constitutive) return constitutive;
    const cards = heat
      ? [disciplines.heat.materialCards(ctx, entityId)]
      : [
          ...(constitutive === null ? [mechanicalMaterialLines(ctx, entityId)] : []),
          ...(analysis.type === 'thermo_static' ? [disciplines.thermomech.materialCards(ctx, entityId)] : []),
          ...(analysis.type === 'coupled_temperature_displacement' ? [disciplines.coupled.materialCards(ctx, entityId)] : []),
        ];
    lines.push(`** material ${name} = '${commentText(ctx.materialId(entityId) ?? '', 80)}'`);
    if (constitutive === null) lines.push(`*MATERIAL, NAME=${name}`);
    else lines.push(...constitutive.comments, ...constitutive.lines);
    for (const card of cards) {
      if (isDeckRefusal(card)) return card;
      lines.push(...card.text.split('\n').filter((line) => line !== ''));
    }
  }
  for (const entityId of Object.keys(analysis.parts))
    lines.push(`*SOLID SECTION, ELSET=${ctx.elset(entityId)}, MATERIAL=${ctx.materialName(entityId)}`);
  const steps = heat
    ? disciplines.heat.sections(ctx)
    : analysis.type === 'static'
      ? staticStep(ctx)
      : analysis.type === 'coupled_temperature_displacement'
        ? disciplines.coupled.sections(ctx)
        : disciplines.thermomech.sections(ctx);
  if (isDeckRefusal(steps)) return steps;
  return { text: `${linesText(lines)}${steps.text === '' || steps.text.endsWith('\n') ? steps.text : `${steps.text}\n`}` };
}
