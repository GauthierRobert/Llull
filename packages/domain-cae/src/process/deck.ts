/**
 * PHY-16 §5.3 deck sections of an `am_build_distortion` case (inherent-strain method, layer by layer, CalculiX 2.21).
 *
 * The carrier is a GLOBAL temperature with one material per layer (measured, `server/tests/feaAmBuild.test.ts`): nodal temperatures cannot give
 * every layer its own strain because layers share their interface nodes, so layer s gets `*EXPANSION, TYPE=ORTHO, ZERO=0` rows alpha(T) T = e(T)
 * with e(T) = eps * clamp(T - (s - 1), 0, 1): the expansion saturates after the global temperature passes s. Build index s costs two steps: s
 * activates the layer (`*MODEL CHANGE, ADD=STRAIN FREE`; CalculiX needs NLGEOM), then the temperature goes to s and only layers <= s respond
 * (adding layer s + 1 in the same step would stiffen the stack while layer s strains: measured 17 % low).
 */

import type { AmBuildSettings } from '@core/model/am';
import { type DeckContext, type DeckRefusal, type DeckSections, isDeckRefusal } from '../decks/context';
import { commentText, linesText, num, row } from '../decks/format';
import { mechanicalMaterialLines, mechanicalStepLines } from '../decks/mechanical';
import { buildFrame } from './frame';
import { amLayerPlan, type AmLayerPlan } from './layers';
import { activationStep, strainStep } from './plan';
import { support321 } from './support321';

const refuse = (code: string, message: string, ids: readonly string[] = []): DeckRefusal => ({ code, message, ids });

/** Orientation name of the build frame. */
const ORIENTATION = 'AM_BUILD';
/** Solver controls of a release step: the removal redistributes the whole residual stress at once. */
const RELEASE_FIRST_INCREMENT = 0.1;
const MINIMUM_INCREMENT = 1e-5;
/** One increment per build step (a cut-back is still allowed down to the minimum, which also silences the CalculiX warning about a zero minimum). */
const ONE_INCREMENT = row(1, 1, MINIMUM_INCREMENT, 1);
const SETS_PER_LINE = 8;
const ELEMENTS_PER_LINE = 16;
const LAYER_OUTPUT = ['*NODE FILE', 'U', '*EL FILE', 'S, E'];

type Point = readonly [number, number, number];

interface Prepared {
  readonly am: AmBuildSettings;
  readonly plan: AmLayerPlan;
  readonly strain: NonNullable<AmBuildSettings['inherentStrain']>;
}

/** The set-up, the strain and the layer plan of the case, or the refusal that stops the deck. */
function prepare(ctx: DeckContext): Prepared | DeckRefusal {
  const { am } = ctx.analysis;
  const id = ctx.analysisId;
  if (am === undefined) return refuse('PRC_BUILD_SETUP_MISSING', `analysis '${id}' has no build set-up: call am_build_setup`, [id]);
  if (am.inherentStrain === undefined)
    return refuse('PRC_INHERENT_STRAIN_MISSING', `analysis '${id}' has no inherent strain: call set_inherent_strain`, [id]);
  if (ctx.analysis.loadOrder.length > 0)
    return refuse(
      'PRC_LOADS_UNSUPPORTED',
      `analysis '${id}' has ${ctx.analysis.loadOrder.length} load(s): the build is driven by the inherent strain only`,
      [id],
    );
  const plan = amLayerPlan(ctx.analysis, am, ctx.mesh, ctx.lengthToAnalysis);
  return 'code' in plan ? plan : { am, plan, strain: am.inherentStrain };
}

const setName = (buildIndex: number, part: number): string => `AML_${buildIndex}_${part + 1}`;

const wrapped = (names: readonly string[]): string[] =>
  Array.from({ length: Math.ceil(names.length / SETS_PER_LINE) }, (_, i) =>
    names.slice(i * SETS_PER_LINE, (i + 1) * SETS_PER_LINE).join(', '),
  );

/**
 * Element sets of the layers, the build-frame `*ORIENTATION`, one `*MATERIAL` per layer and part, and the `*SOLID SECTION` of every layer set
 * (the base deck skips the sections of the build parts).
 * @failure as amSteps; the elastic constants of a build part -> the mechanical refusals
 */
export function amSections(ctx: DeckContext): DeckSections {
  const prepared = prepare(ctx);
  if ('code' in prepared) return prepared;
  const { am, plan, strain } = prepared;
  const [x, y] = buildFrame(am.buildDirection);
  const empty = plan.emptyLayers.length > 0 ? `; EMPTY layers ${plan.emptyLayers.join(', ')} (mesh coarser than the layer height)` : '';
  const lines = [
    `** build ${plan.layers.length} layer(s) of ${num(am.layerHeight)} ${ctx.doc.units} along [${am.buildDirection.map(num).join(', ')}] from the plate top ${num(plan.plateTop)}${empty}`,
    `** inherent strain exx ${num(strain.exx)} eyy ${num(strain.eyy)} ezz ${num(strain.ezz)} (${strain.calibrated ? 'calibrated' : 'NOT calibrated'}): ${commentText(strain.source)}`,
    `*ORIENTATION, NAME=${ORIENTATION}, SYSTEM=RECTANGULAR`,
    row(...x, ...y),
  ];
  const sections: string[] = [];
  const total = plan.layers.length;
  for (const [position, layer] of plan.layers.entries()) {
    const buildIndex = position + 1;
    for (const { part, elements } of layer.sets) {
      const partId = plan.buildParts[part] ?? '';
      const material = mechanicalMaterialLines(ctx, partId);
      if (isDeckRefusal(material)) return material;
      const set = setName(buildIndex, part);
      lines.push(`*ELSET, ELSET=${set}`);
      for (let i = 0; i < elements.length; i += ELEMENTS_PER_LINE) lines.push(elements.slice(i, i + ELEMENTS_PER_LINE).join(', '));
      lines.push(
        `** layer ${buildIndex} (geometric layer ${layer.layer}) of '${commentText(partId)}': strain e(T) = eps clamp(T - ${buildIndex - 1}, 0, 1), alpha = e / T`,
        `*MATERIAL, NAME=MAM_${buildIndex}_${part + 1}`,
        ...material.text.split('\n').filter((line) => line !== ''),
        '*EXPANSION, TYPE=ORTHO, ZERO=0',
        row(0, 0, 0, buildIndex - 1),
      );
      for (let t = buildIndex; t <= total; t++) lines.push(row(strain.exx / t, strain.eyy / t, strain.ezz / t, t));
      sections.push(`*SOLID SECTION, ELSET=${set}, MATERIAL=MAM_${buildIndex}_${part + 1}, ORIENTATION=${ORIENTATION}`);
    }
  }
  return { text: linesText([...lines, ...sections]) };
}

interface Snapped {
  readonly node: number;
  readonly at: Point;
  readonly distance: number;
}

/** Nearest node of `candidates` to `point` (analysis units), or null without candidates. */
function nearest(ctx: DeckContext, candidates: ReadonlySet<number>, point: Point): Snapped | null {
  let best: Snapped | null = null;
  for (const [node, x, y, z] of ctx.mesh.nodes) {
    if (!candidates.has(node)) continue;
    const distance = Math.hypot(x - point[0], y - point[1], z - point[2]);
    if (best === null || distance < best.distance) best = { node, at: [x, y, z], distance };
  }
  return best;
}

/** Nodes of the elements of the parts of the case that are not in `removed`. */
function nodesOfRemaining(ctx: DeckContext, removed: ReadonlySet<string>): Set<number> {
  const kept = new Set(Object.keys(ctx.analysis.parts).filter((id) => !removed.has(id)));
  return new Set(ctx.mesh.blocks.filter((block) => kept.has(block.entityId)).flatMap((block) => block.elements.flatMap((e) => e.slice(1))));
}

/** The `*BOUNDARY` lines of a mechanical step text: loads are refused for an AM case, so the empty `*CLOAD` / `*DLOAD` cards that follow are dropped. */
function boundaryLines(text: string): string[] {
  const lines = text.split('\n').filter((line) => line !== '');
  const loads = lines.findIndex((line) => line.startsWith('*CLOAD') || line.startsWith('*DLOAD'));
  return loads < 0 ? lines : lines.slice(0, loads);
}

/**
 * Procedure: initial temperature 0, step 1 removes every layer (CalculiX requires it before the first `ADD`; a second removal of the same elements
 * breaks later activations) and applies the constraints, then an activation and a strain step per non-empty layer, then one step per release.
 * A release removes the plate and / or supports and replaces the constraints by the 3-2-1 support on the nearest nodes of the remaining parts.
 * Results (`*NODE FILE U`, `*EL FILE S, E`) are requested in the last strain step and in every release step only.
 * @invariant byte-deterministic; each part is removed at most once; the 3-2-1 dofs are six independent rigid-body constraints
 * @failure PRC_BUILD_SETUP_MISSING, PRC_INHERENT_STRAIN_MISSING, PRC_LOADS_UNSUPPORTED, PRC_PART_NOT_BUILT, PRC_LAYERS_TOO_MANY,
 *   PRC_RELEASE_UNSUPPORTED (no node, shared node, dependent support); mechanical refusals
 */
export function amSteps(ctx: DeckContext): DeckSections {
  const prepared = prepare(ctx);
  if ('code' in prepared) return prepared;
  const { am, plan } = prepared;
  const constraints = mechanicalStepLines(ctx);
  if (isDeckRefusal(constraints)) return constraints;
  const total = plan.layers.length;
  const layerSets = plan.layers.flatMap((layer, position) => layer.sets.map(({ part }) => setName(position + 1, part)));
  const lines = [
    '*INITIAL CONDITIONS, TYPE=TEMPERATURE',
    'NALL, 0',
    '** step 1: every layer removed, constraints applied',
    '*STEP, NLGEOM',
    '*STATIC',
    ONE_INCREMENT,
    ...boundaryLines(constraints.text),
    '*MODEL CHANGE, TYPE=ELEMENT, REMOVE',
    ...wrapped(layerSets),
    '*TEMPERATURE',
    'NALL, 0',
    '*END STEP',
  ];
  for (const [position, layer] of plan.layers.entries()) {
    const buildIndex = position + 1;
    lines.push(
      `** step ${activationStep(buildIndex)}: layer ${buildIndex} (geometric ${layer.layer}) added strain free`,
      '*STEP, NLGEOM',
      '*STATIC',
      ONE_INCREMENT,
      '*MODEL CHANGE, TYPE=ELEMENT, ADD=STRAIN FREE',
      ...wrapped(layer.sets.map(({ part }) => setName(buildIndex, part))),
      '*END STEP',
      `** step ${strainStep(buildIndex)}: global temperature ${buildIndex}: layers 1..${buildIndex} take their inherent strain`,
      '*STEP, NLGEOM',
      '*STATIC',
      ONE_INCREMENT,
      '*TEMPERATURE',
      `NALL, ${buildIndex}`,
      ...(buildIndex === total ? LAYER_OUTPUT : []),
      '*END STEP',
    );
  }
  const removed = new Set<string>();
  for (const [index, release] of am.releaseSteps.entries()) {
    const wanted = [
      ...(release.remove.includes('plate') ? [am.plateEntityId] : []),
      ...(release.remove.includes('supports') ? am.supportEntityIds : []),
    ];
    const fresh = wanted.filter((id) => !removed.has(id));
    fresh.forEach((id) => removed.add(id));
    const nodes = nodesOfRemaining(ctx, removed);
    const scale = ctx.lengthToAnalysis;
    const found = release.support321.map((p) => nearest(ctx, nodes, [p[0] * scale, p[1] * scale, p[2] * scale]));
    const stepName = `release '${commentText(release.name)}'`;
    const [s1, s2, s3] = found;
    if (
      s1 === null ||
      s2 === null ||
      s3 === null ||
      s1 === undefined ||
      s2 === undefined ||
      s3 === undefined ||
      new Set([s1.node, s2.node, s3.node]).size !== 3
    )
      return refuse(
        'PRC_RELEASE_UNSUPPORTED',
        `${stepName}: the three support points do not resolve to three distinct nodes of the remaining parts`,
        [ctx.analysisId],
      );
    const dofs = support321([s1.at, s2.at, s3.at]);
    if (typeof dofs === 'string')
      return refuse('PRC_RELEASE_UNSUPPORTED', `${stepName}: ${dofs} (after snapping to mesh nodes)`, [ctx.analysisId]);
    const picked = [s1, s2, s3];
    lines.push(
      `** step ${strainStep(total) + 1 + index}: ${stepName}: remove ${fresh.length === 0 ? 'nothing' : fresh.map((id) => ctx.elset(id)).join(', ')}; 3-2-1 on nodes ${picked.map((s) => `${s.node} (${num(s.distance / scale)} ${ctx.doc.units} from the point)`).join(', ')}`,
      '*STEP, NLGEOM',
      '*STATIC',
      row(RELEASE_FIRST_INCREMENT, 1, MINIMUM_INCREMENT, 1),
      ...(fresh.length === 0 ? [] : ['*MODEL CHANGE, TYPE=ELEMENT, REMOVE', ...wrapped(fresh.map((id) => ctx.elset(id)))]),
      '*BOUNDARY, OP=NEW',
      ...picked.flatMap((s, i) => (dofs[i] ?? []).map((dof) => row(s.node, dof, dof))),
      ...LAYER_OUTPUT,
      '*END STEP',
    );
  }
  return { text: linesText(lines) };
}
