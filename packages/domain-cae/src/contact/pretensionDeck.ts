/**
 * PHY-06 §5 deck sections of the bolt pretensions of a nonlinear_static case (pure). Each bolt is cut in the mesh (`pretensionSection.ts`): the
 * nodes of the cut are duplicated, the high-side elements of the bolt part take the duplicates, and `*EQUATION`s force the high side to move
 * `-n u` against the low side (n = the section normal, u = degree of freedom 1 of a reference node), so u is the shortening of the bolt.
 * The preload is `*CLOAD` on u in the first step; a locked bolt holds u with `*BOUNDARY, FIXED` in the later steps. This is the mechanism of
 * CalculiX `*PRE-TENSION SECTION` written out explicitly: the keyword renumbers only the elements that own a face of the cut and gave a third
 * of the force on a tetrahedral mesh (TECHNICAL_SPEC §13.3 D13).
 */

import type { BoltPretension, PreloadSpec } from '@core/model/contact';
import type { Vec3 } from '@core/model/vectors';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { buildDeckContext, type DeckContext, type DeckRefusal } from '../decks/context';
import { commentText, idLines, row } from '../decks/format';
import { indexMesh } from '../thermal/meshGeometry';
import { pretensionProblem } from './pretensionRules';
import { isCutRefusal, numberDuplicates, pretensionCut, type PretensionCut } from './pretensionSection';

/** One bolt of the plan: its cut, the duplicate node of every cut node and the reference node. */
interface PlannedBolt {
  readonly bolt: BoltPretension;
  readonly position: number;
  readonly cut: PretensionCut;
  readonly duplicates: ReadonlyMap<number, number>;
  readonly referenceNode: number;
  readonly names: { readonly nset: string; readonly duplicates: string };
}

export interface PretensionPlan {
  readonly bolts: readonly PlannedBolt[];
  /** Element row `[id, ...nodes]` with the duplicated nodes of the bolts substituted in the high-side elements. */
  readonly substitute: (element: readonly number[]) => readonly number[];
  /** Duplicate node rows `[id, x, y, z]` of every bolt, in id order. */
  readonly duplicateNodes: readonly (readonly [number, number, number, number])[];
}

const EMPTY: PretensionPlan = { bolts: [], substitute: (element) => element, duplicateNodes: [] };

const refuse = (code: string, message: string, ids: readonly string[]): DeckRefusal => ({ code, message, ids });

/** Preload force in the analysis force unit: the force itself, or T / (K D) for a torque (D in document length units). */
export function preloadForce(preload: PreloadSpec, lengthToAnalysis: number): number {
  return preload.kind === 'force' ? preload.value : preload.torque / (preload.nutFactor * preload.diameter * lengthToAnalysis);
}

const memo = new WeakMap<DeckContext, PretensionPlan | DeckRefusal>();

/** Mesh node sets that carry a boundary condition, load or probe: a cut node in one of them would lose its duplicate. */
const GUARDED_SET = /^(C|S|N|L|B|T|V|K|R|P)_/;

/**
 * The cuts, duplicate nodes and reference nodes of every bolt of the case.
 * @invariant empty plan for a case without pretensions; pure and deterministic (duplicates numbered above the mesh nodes in bolt order, the
 *   reference nodes above the duplicates); memoised per deck context
 * @failure invalid stored bolt -> its CNT_* code; plane that misses the part / cuts it more than once, or a cut node that belongs to a
 *   constraint / load / probe node set -> CNT_PRETENSION_SECTION_INVALID (ids: the bolt)
 */
export function pretensionPlan(ctx: DeckContext): PretensionPlan | DeckRefusal {
  const cached = memo.get(ctx);
  if (cached !== undefined) return cached;
  const planned = build(ctx);
  memo.set(ctx, planned);
  return planned;
}

function build(ctx: DeckContext): PretensionPlan | DeckRefusal {
  const settings = ctx.analysis.pretension;
  if (settings === undefined) return EMPTY;
  const index = indexMesh(ctx.mesh);
  const cuts: { bolt: BoltPretension; position: number; cut: PretensionCut }[] = [];
  for (const [position, id] of settings.order.entries()) {
    const bolt = settings.bolts[id];
    if (bolt === undefined) continue;
    const bad = pretensionProblem(ctx.doc, ctx.analysis, bolt);
    if (bad !== null) return refuse(bad.code, `bolt pretension '${bolt.id}': ${bad.message}`, [bolt.id]);
    const point: Vec3 = [
      bolt.section.point[0] * ctx.lengthToAnalysis,
      bolt.section.point[1] * ctx.lengthToAnalysis,
      bolt.section.point[2] * ctx.lengthToAnalysis,
    ];
    const cut = pretensionCut(ctx.mesh, bolt.entityId, point, bolt.section.normal, index);
    if (isCutRefusal(cut)) return refuse(cut.code, `bolt pretension '${bolt.id}' (${bolt.name}): ${cut.message}`, [bolt.id]);
    const onCut = new Set(cut.nodes);
    const held = Object.entries(ctx.mesh.nodeSets).find(
      ([setKey, nodes]) => GUARDED_SET.test(setKey) && nodes.some((node) => onCut.has(node)),
    );
    if (held !== undefined)
      return refuse(
        'CNT_PRETENSION_SECTION_INVALID',
        `bolt pretension '${bolt.id}' (${bolt.name}): the section touches the nodes of '${held[0]}' (a constraint, load or probe target); move the plane along the shank`,
        [bolt.id],
      );
    const clash = cuts.find((other) => other.cut.nodes.some((node) => onCut.has(node)));
    if (clash !== undefined)
      return refuse(
        'CNT_PRETENSION_SECTION_INVALID',
        `bolt pretension '${bolt.id}' (${bolt.name}): its section shares nodes with the section of '${clash.bolt.id}' (${clash.bolt.name}); keep the planes one element apart`,
        [bolt.id, clash.bolt.id],
      );
    cuts.push({ bolt, position, cut });
  }
  const numbered = numberDuplicates(
    ctx.mesh,
    cuts.map((entry) => entry.cut),
  );
  const firstReference =
    ctx.mesh.nodes.reduce((highest, [id]) => Math.max(highest, id), 0) + 1 + numbered.reduce((count, map) => count + map.size, 0);
  const bolts: PlannedBolt[] = cuts.map((entry, order) => ({
    ...entry,
    duplicates: numbered[order] ?? new Map(),
    referenceNode: firstReference + entry.position,
    names: { nset: `PTN_${entry.position + 1}`, duplicates: `PTD_${entry.position + 1}` },
  }));
  const duplicateNodes = bolts.flatMap((planned) =>
    [...planned.duplicates].flatMap(([node, copy]) => {
      const at = index.coordinates.get(node);
      return at === undefined ? [] : [[copy, at[0], at[1], at[2]] as const];
    }),
  );
  // an element above several cuts takes the copy of every cut it lies above (the cuts share no node, checked above)
  const substitute = (element: readonly number[]): readonly number[] => {
    const [id = 0, ...nodes] = element;
    const above = bolts.filter((planned) => planned.cut.highElements.has(id));
    if (above.length === 0) return element;
    return [id, ...nodes.map((node) => above.find((planned) => planned.duplicates.has(node))?.duplicates.get(node) ?? node)];
  };
  return { bolts, substitute, duplicateNodes };
}

/** `*EQUATION` cards of one bolt: per cut node and component, `high - low + n_c u = 0` (the `u` term only where n_c is not zero). */
function equations(planned: PlannedBolt): string[] {
  const lines: string[] = [];
  for (const [node, copy] of planned.duplicates)
    for (const component of [0, 1, 2] as const) {
      const share = planned.cut.normal[component];
      const terms = [
        row(copy, component + 1, 1),
        row(node, component + 1, -1),
        ...(Math.abs(share) > 1e-12 ? [row(planned.referenceNode, 1, share)] : []),
      ];
      lines.push('*EQUATION', String(terms.length), terms.join(', '));
    }
  return lines;
}

/**
 * Model-data cards of every bolt (after the elements): the duplicate nodes, the reference node (`*NODE, NSET=PTN_n`) and the equations.
 * @invariant empty for a case without pretensions
 */
export function pretensionModelLines(ctx: DeckContext): string[] | DeckRefusal {
  const plan = pretensionPlan(ctx);
  if ('code' in plan) return plan;
  const lines: string[] = [];
  for (const planned of plan.bolts)
    lines.push(
      `** bolt pretension ${commentText(planned.bolt.id)} ${commentText(planned.bolt.name)}: ${planned.cut.nodes.length} cut nodes, section area ${row(planned.cut.area)}`,
      `*NSET, NSET=${planned.names.duplicates}`,
      ...idLines([...planned.duplicates.values()]),
      `*NODE, NSET=${planned.names.nset}`,
      row(planned.referenceNode, ...planned.cut.centroid),
      ...equations(planned),
    );
  return lines;
}

/**
 * Step cards of the bolts in step `position` (0-based place in the step order; `parameters` = the `*CLOAD` parameters of the step amplitude):
 * the preload `*CLOAD` on the reference node in the first step (CNT_PRETENSION_STEP_ORDER keeps every preload there), in later steps the load
 * zeroed and `*BOUNDARY, FIXED` for a locked bolt (an unlocked one keeps its constant force), and the reference-node `*NODE PRINT` (U, RF) at `rate`.
 * @invariant empty for a case without pretensions
 */
export function pretensionStepLines(
  ctx: DeckContext,
  position: number,
  parameters: string,
  rate: string,
): { readonly loads: string[]; readonly output: string[] } | DeckRefusal {
  const plan = pretensionPlan(ctx);
  if ('code' in plan) return plan;
  const loads: string[] = [];
  const zeroed: string[] = [];
  const locks: string[] = [];
  const output: string[] = [];
  for (const planned of plan.bolts) {
    if (position === 0) loads.push(row(planned.referenceNode, 1, preloadForce(planned.bolt.preload, ctx.lengthToAnalysis)));
    else if (planned.bolt.lockAfter) {
      zeroed.push(row(planned.referenceNode, 1, 0));
      locks.push(row(planned.referenceNode, 1, 1));
    }
    output.push(
      `*NODE PRINT, NSET=${planned.names.nset}${rate}`,
      'U, RF',
      `*NODE PRINT, NSET=${planned.names.duplicates}, TOTALS=ONLY${rate}`,
      'RF',
    );
  }
  return {
    loads: [
      ...(loads.length > 0 ? [`*CLOAD${parameters}`, ...loads] : []),
      ...(zeroed.length > 0 ? ['*CLOAD', ...zeroed] : []),
      ...(locks.length > 0 ? ['*BOUNDARY, FIXED', ...locks] : []),
    ],
    output,
  };
}

/**
 * Node numbers the pretensions add to the mesh: the duplicates of every cut and the reference nodes (which belong to no element, so a CalculiX results
 * file does not hold them), ascending.
 * @failure no pretension, or one the deck would refuse -> both lists empty
 */
export function pretensionExtraNodes(
  doc: CadDocument,
  analysisId: string,
  mesh: FeMeshArtifact,
): { duplicates: number[]; references: number[] } {
  const ctx = buildDeckContext(doc, analysisId, mesh);
  const plan = ctx === null ? null : pretensionPlan(ctx);
  if (plan === null || 'code' in plan) return { duplicates: [], references: [] };
  const ascending = (nodes: number[]): number[] => nodes.sort((a, b) => a - b);
  return {
    duplicates: ascending(plan.bolts.flatMap((planned) => [...planned.duplicates.values()])),
    references: ascending(plan.bolts.map((planned) => planned.referenceNode)),
  };
}
