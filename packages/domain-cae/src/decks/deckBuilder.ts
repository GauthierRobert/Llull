/** INP assembly (05 §5.6, FE_PIPELINE_DESIGN §5): model block + materials + sections + the steps of the analysis type. */

import type { FeArtifactPort, FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { analysisInputHash } from '../hash/inputHash';
import { ALL_ELEMENTS, ALL_NODES, buildDeckContext, isDeckRefusal, type DeckContext, type DeckRefusal, type DeckSections } from './context';
import { idLines, linesText, row } from './format';
import { mechanicalMaterialLines, staticStep } from './mechanical';

/** The discipline functions of the thermal and thermo-mechanical lanes (FE_PIPELINE_DESIGN §5 table). */
export interface DisciplineTable {
  readonly heat: {
    readonly materialCards: (ctx: DeckContext, entityId: string) => DeckSections;
    readonly sections: (ctx: DeckContext) => DeckSections;
  };
  readonly thermomech: {
    readonly materialCards: (ctx: DeckContext, entityId: string) => DeckSections;
    readonly sections: (ctx: DeckContext) => DeckSections;
  };
}

export type InpResult = { readonly text: string } | DeckRefusal;

const refuse = (code: string, message: string, ids: readonly string[] = []): DeckRefusal => ({ code, message, ids });
const singleLine = (text: string): string => text.replace(/[\r\n]+/g, ' ');

function precheck(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact, ctx: DeckContext): DeckRefusal | null {
  const { analysis } = ctx;
  if (analysis.type === 'modal' || analysis.type === 'buckling' || analysis.type === 'coupled_temperature_displacement')
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
    if (ctx.materialOf(entityId) === null) return refuse('FEA_MATERIAL_MISSING', `part '${entityId}' has no material`, [entityId]);
  }
  const structural = analysis.type === 'static' || analysis.type === 'thermo_static';
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
 *   part without elements or with non-tet elements -> FEA_PART_INVALID; no material -> FEA_MATERIAL_MISSING; static / thermo_static without a
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
    `** llull analysis ${singleLine(analysis.name)} units ${analysis.unitSystem} inputHash ${analysisInputHash(doc, analysisId, 'full')} meshHash ${sha256Hex(canonicalJson(mesh))}`,
    ...modelBlock(ctx),
  ];
  const materialOwners = new Map<string, string>();
  for (const entityId of Object.keys(analysis.parts))
    if (!materialOwners.has(ctx.materialName(entityId))) materialOwners.set(ctx.materialName(entityId), entityId);
  for (const [name, entityId] of materialOwners) {
    const cards = heat
      ? [disciplines.heat.materialCards(ctx, entityId)]
      : [
          mechanicalMaterialLines(ctx, entityId),
          ...(analysis.type === 'thermo_static' ? [disciplines.thermomech.materialCards(ctx, entityId)] : []),
        ];
    lines.push(`*MATERIAL, NAME=${name}`);
    for (const card of cards) {
      if (isDeckRefusal(card)) return card;
      lines.push(...card.text.split('\n').filter((line) => line !== ''));
    }
  }
  for (const entityId of Object.keys(analysis.parts))
    lines.push(`*SOLID SECTION, ELSET=${ctx.elset(entityId)}, MATERIAL=${ctx.materialName(entityId)}`);
  const steps = heat ? disciplines.heat.sections(ctx) : analysis.type === 'static' ? staticStep(ctx) : disciplines.thermomech.sections(ctx);
  if (isDeckRefusal(steps)) return steps;
  return { text: `${linesText(lines)}${steps.text === '' || steps.text.endsWith('\n') ? steps.text : `${steps.text}\n`}` };
}
