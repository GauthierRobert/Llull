/**
 * Nastran BDF writer (05 §5.6, TR-FEA-41; M5): small-field fixed format, SOL 101 (static), 103 (modal), 105 (buckling: a preload subcase, then
 * `STATSUB`). Pure and deterministic; the only caller is the `fea_export` transport (`format: 'nastran_bdf'`).
 */

import type { FeArtifactPort, FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { analysisInputHash } from '../hash/inputHash';
import { bindingMarker } from '../results/inputBinding';
import { largest } from '../shared/largest';
import { buildDeckContext, loadCasesOf, type DeckContext, type DeckRefusal } from './context';
import { precheck } from './deckBuilder';
import { cardLines } from './bdf/fields';
import { compositeCards } from './bdf/composite';
import { isCompositePart } from '../shell/shellDeck';
import { constraintCards, loadCards, type FreeIds } from './bdf/loads';
import {
  BDF_ELEMENT_TYPES,
  ELEMENT_CARDS,
  elementCards,
  failed,
  gridCards,
  numbering,
  propertyCards,
  real,
  refusal,
  type Rounding,
} from './bdf/model';
import { commentText, linesText } from './format';

export type BdfResult = { readonly text: string; readonly warnings: readonly string[] } | DeckRefusal;

/** Set ids: one global SPC set, one eigenvalue method, one load set per load case (`LOAD_BASE + index`). */
const SPC_SET = 1;
const METHOD_SET = 10;
const LOAD_BASE = 100;
/** A written real rounded by more than this (relative) is reported: the 8-character field keeps at most 7 significant digits. */
const ROUNDING_WARNING = 1e-6;

const SOLUTIONS = { static: 101, modal: 103, buckling: 105 } as const;

const OUTPUT_REQUESTS = ['DISPLACEMENT(SORT1,REAL) = ALL', 'STRESS(SORT1,REAL,VONMISES,CUBIC) = ALL'];

/** EIGRL entry: `EIGRL 10 [V1 Hz] [V2 Hz] ND` (V1 / V2 from `frequencyRangeHz` of a modal case, in Hz). */
function eigrl(ctx: DeckContext, track: Rounding): string[] | DeckRefusal {
  const modes = String(Math.max(1, Math.round(ctx.analysis.modes ?? (ctx.analysis.type === 'modal' ? 6 : 3))));
  const band = ctx.analysis.type === 'modal' ? ctx.analysis.frequencyRangeHz : undefined;
  const bounds = [
    band?.min === undefined ? '' : real(band.min, 'frequency minimum', track),
    band?.max === undefined ? '' : real(band.max, 'frequency maximum', track),
  ];
  const bad = bounds.find(failed);
  if (bad !== undefined) return bad as DeckRefusal;
  return cardLines('EIGRL', [String(METHOD_SET), ...(bounds as string[]), modes]);
}

/**
 * BDF of `analysisId` over `mesh`: `GRID`, `CTETRA` / `CTRIA3` / `CQUAD4` / `CTRIA6` / `CQUAD8` per the mesh blocks, `PSOLID` / `PSHELL`, `MAT1`,
 * `SPC1` (+ `SPCD` for enforced displacements), `FORCE`, `MOMENT` + `RBE3`, `PLOAD4`, `GRAV`, case control per load case and `EIGRL` for 103 / 105. The
 * node and element ids are the mesh ids, so an OP2 of this deck maps back to the mesh by id (`fea_import_results`).
 * @invariant byte-identical for identical inputs; `$ llull:` lines map Nastran ids to llull names; `warnings` lists the reals the 8-character field rounded
 *   by more than 1e-6 (relative)
 * @failure the INP writer's refusals (stale mesh, units, parts, materials, export gate, no constraint); heat / thermo / nonlinear types ->
 *   FEA_BDF_UNSUPPORTED; element types without a card (CPS*) -> FEA_PART_INVALID; ids above 99 999 999 -> FEA_BDF_ID_TOO_LARGE; a non-finite value -> FEA_BDF_VALUE_INVALID
 */
export function writeBdf(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact, artifacts: FeArtifactPort | null = null): BdfResult {
  const ctx = buildDeckContext(doc, analysisId, mesh, artifacts);
  if (ctx === null) return refusal('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
  const { analysis } = ctx;
  if (analysis.type !== 'static' && analysis.type !== 'modal' && analysis.type !== 'buckling')
    return refusal('FEA_BDF_UNSUPPORTED', `the BDF writer handles static, modal and buckling analyses, not '${analysis.type}'`, [
      analysisId,
    ]);
  if (analysis.preloadLoadCase !== undefined)
    return refusal(
      'FEA_BDF_UNSUPPORTED',
      'the BDF writer has no separate buckling preload: SOL 105 scales its static subcase; clear it with set_buckling_preload',
      [analysisId],
    );
  const problem = precheck(doc, analysisId, mesh, ctx, BDF_ELEMENT_TYPES);
  if (problem !== null) return problem;
  const track: Rounding = { worst: 0 };
  const shells = mesh.blocks.some((block) => ELEMENT_CARDS[block.type]?.shell === true);
  const grids = gridCards(ctx, track);
  if (!Array.isArray(grids)) return grids;
  const { property } = numbering(ctx);
  const elements = elementCards(ctx, property);
  if (!Array.isArray(elements)) return elements;
  const plain = propertyCards(ctx, track);
  if ('code' in plain) return plain;
  const properties = { lines: [...plain.lines], comments: [...plain.comments] };
  let nextMid = numbering(ctx).material.size + 1;
  for (const [entityId, pid] of numbering(ctx).property) {
    if (!isCompositePart(ctx, entityId)) continue;
    const laminate = compositeCards(ctx, entityId, pid, nextMid, track);
    if ('code' in laminate) return laminate;
    properties.lines.push(...laminate.lines);
    properties.comments.push(...laminate.comments);
    nextMid += laminate.materials;
  }
  const supports = analysis.type === 'modal' && analysis.constraintOrder.length === 0 ? null : constraintCards(ctx, SPC_SET, shells);
  if (supports !== null && 'code' in supports) return supports;

  const ids: FreeIds = {
    nextGrid: largest(mesh.nodes.map((node) => node[0])) + 1,
    nextElement: largest(mesh.blocks.flatMap((block) => block.elements.map((element) => element[0] ?? 0))) + 1,
  };
  const cases = analysis.type === 'modal' ? [] : loadCasesOf(analysis).slice(0, analysis.type === 'buckling' ? 1 : undefined);
  if (analysis.type === 'buckling' && analysis.loadOrder.length === 0)
    return refusal('FEA_NO_LOADS', `buckling analysis '${analysisId}' has no load: the buckling factor multiplies the applied load`, [
      analysisId,
    ]);
  const control: string[] = [];
  const bulkLoads: string[] = [];
  const rigid: string[] = [];
  const comments: string[] = [];
  for (const [index, { name }] of cases.entries()) {
    const sid = LOAD_BASE + index;
    const found = loadCards(ctx, name, sid, ids, track);
    if ('code' in found) return found;
    const enforced: string[] = [];
    for (const [node, component, value] of supports?.enforced ?? []) {
      const displacement = real(value, 'enforced displacement', track);
      if (failed(displacement)) return displacement;
      enforced.push(...cardLines('SPCD', [String(sid), String(node), String(component), displacement]));
    }
    bulkLoads.push(...found.loads, ...enforced);
    rigid.push(...found.rigid);
    comments.push(`$ llull: load case ${index + 1} = '${commentText(name)}' -> LOAD ${sid}`, ...found.comments);
    control.push(`SUBCASE ${index + 1}`, `  LABEL = ${commentText(name, 60)}`, `  LOAD = ${sid}`);
  }
  const method = analysis.type === 'static' ? [] : eigrl(ctx, track);
  if (!Array.isArray(method)) return method;
  if (analysis.type === 'modal') control.push('SUBCASE 1', '  LABEL = modes', `  METHOD = ${METHOD_SET}`);
  if (analysis.type === 'buckling') control.push('SUBCASE 2', '  LABEL = buckling', `  METHOD = ${METHOD_SET}`, '  STATSUB = 1');
  const solution = SOLUTIONS[analysis.type];
  const meshHash = sha256Hex(canonicalJson(mesh));
  const inputHash = analysisInputHash(doc, analysisId, 'full');
  const header = [
    `$ llull analysis ${commentText(analysis.name)} units ${analysis.unitSystem} inputHash ${inputHash} meshHash ${meshHash}`,
    '$ llull: node and element ids are the mesh ids; results of this deck import through fea_import_results (op2)',
  ];
  const caseControl = [
    `SOL ${solution}`,
    'CEND',
    `TITLE = ${commentText(analysis.name, 60)}`,
    `SUBTITLE = ${bindingMarker(inputHash)}`,
    'ECHO = NONE',
    ...(supports === null ? [] : [`SPC = ${SPC_SET}`]),
    ...OUTPUT_REQUESTS,
    ...control,
  ];
  const lines = [
    ...header,
    ...caseControl,
    'BEGIN BULK',
    'PARAM,POST,-1',
    ...properties.comments,
    ...comments,
    ...grids,
    ...rigid,
    ...elements,
    ...properties.lines,
    ...(supports?.spc ?? []),
    ...bulkLoads,
    ...method,
    'ENDDATA',
  ];
  const warnings =
    track.worst > ROUNDING_WARNING
      ? [`FEA_BDF_ROUNDED: the small-field (8-character) format rounded a value by up to ${Number(track.worst.toPrecision(2))} relative`]
      : [];
  return { text: linesText(lines), warnings };
}
