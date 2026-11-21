/**
 * emboss_on_face across a chain of adjacent faces (03 WRP M5, VC-WRP-36): the sketch is placed on the chain's unfolded chart (`chainCharts.ts`), cut by each chain edge's straight
 * line (`clipRegions.ts`), every part is wrapped onto its own face by that face's chart, and the faces are embossed one after another as exact kernel steps of one recipe; walls on a
 * shared edge are the same plane, so the pieces fuse into one relief.
 * @invariant develop is an isometry on every face and across every smooth edge: the regions' chart areas add up to the sketch area (checked), the volume change is the sum of the
 *   closed forms of the faces (data.expectedVolumeDelta), the result is a valid closed solid or nothing changes
 * @failure a sharp (convex / concave) chain edge for emboss and deboss (walls would meet in a line), clipping that does not close, a region leaving a face, a kernel step that fails
 *   -> coded no-op; the chain refusals are those of `chainCharts.ts`
 */

import type { CadDocument, ShapeRecipe, Vec2 } from '../../model/types';
import { measureDistortion } from '../../geometry/chartDistortion';
import { embossClosedForm } from '../../geometry/embossVolume';
import { type PlaneSegment, sampleSegment, segmentArea } from '../../geometry/planeSegments';
import { scale3 } from '../../lib/vec3';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import type { CommandResult, ExecutionContext } from '../types';
import { buildChain, type Chain, type ChainFace } from './chainCharts';
import { clipRegions } from './clipRegions';
import { isMitreFailure, mitreFillers } from './embossMitre';
import { chainData, chainSummary, type ChainOutcome, type ChainStep } from './embossChainReport';
import { MIN_FIT_TOLERANCE, SEWING_RATIO } from './constants';
import { wrapRejection } from './codes';
import { DEFAULT_MAX_LENGTH_STRAIN } from './conventions';
import type { FaceRefInput, FaceSession, PlacementInput, ResolvedChart } from './faceSession';
import type { ChartRegion } from './sketchProfiles';
import { checkOnFace, checkWrapAround, isMappingFailure, mapOutlineRegions, probePoints } from './wrapMapping';
import { maxOf } from '../../lib/arrayExtrema';

const MAX_PROBES = 48;

export interface ChainParams {
  readonly id: string;
  readonly profileIds: readonly string[];
  readonly mode: 'emboss' | 'deboss' | 'scribe' | 'engrave';
  readonly placement?: PlacementInput | undefined;
  readonly fitTolerance?: number | undefined;
  readonly maxLengthStrain?: number | undefined;
  readonly chain?: readonly FaceRefInput[] | undefined;
}

export interface ChainEmboss {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext | undefined;
  readonly command: string;
  readonly params: ChainParams;
  /** Volume of a kernel shape (exact mass properties). */
  readonly volumeOf: (shape: FaceSession['shape']) => number | null;
  readonly session: FaceSession;
  readonly resolved: ResolvedChart;
  readonly regions: readonly ChartRegion[];
  readonly unverified: boolean;
  readonly tolerance: number;
  readonly depth: number;
}

const loopArea = (loop: readonly PlaneSegment[]): number => loop.reduce((sum, segment) => sum + segmentArea(segment), 0);
const regionsArea = (regions: readonly ChartRegion[]): number =>
  regions.reduce(
    (sum, region) => sum + Math.abs(loopArea(region.outer)) - region.holes.reduce((inner, hole) => inner + Math.abs(loopArea(hole)), 0),
    0,
  );

type Fail = (code: string, message: string, paths: string[], ids?: readonly string[]) => CommandResult;
type KernelBuilt = Exclude<ReturnType<typeof evaluateRecipe>, string>;
type Mitre = Exclude<ReturnType<typeof mitreFillers>, { readonly code: string }>;

interface FacePlan {
  readonly step: ChainStep;
  readonly clipped: number;
  readonly strain: number | null;
}

/** See the module comment. */
export function runEmbossChain(input: ChainEmboss): CommandResult {
  const { doc, ctx, command, params, session, resolved, regions, tolerance, depth, volumeOf } = input;
  const fail: Fail = (code, message, paths, ids = [params.id]) => wrapRejection(doc, command, code, message, [...ids], paths);
  const scribe = params.mode === 'scribe';
  const cutting = params.mode === 'deboss';
  const limit = params.maxLengthStrain ?? DEFAULT_MAX_LENGTH_STRAIN;
  const chain = buildChain(
    doc,
    ctx,
    command,
    { session, resolved, mirror: params.placement?.mirror ?? false },
    params.chain ?? [],
    tolerance,
    limit,
    regions
      .flatMap((region) => [region.outer, ...region.holes])
      .map((chain) => chain.flatMap((piece, k) => sampleSegment(piece, 5).slice(k === 0 ? 0 : 1))),
  );
  if ('summary' in chain) return chain;
  const sketchArea = regionsArea(regions);
  const planned = planSteps(input, chain, fail);
  if ('summary' in planned) return planned;
  const { steps, clippedArea, strain } = planned;
  if (steps.length === 0) return fail('WRP_OUTSIDE_FACE', 'the sketch lies on none of the chain faces', ['profileIds'], params.profileIds);
  const joinStrain = Math.max(0, maxOf(chain.edges.map((edge) => edge.mismatch)));
  if (!chain.developable && strain > limit) {
    const refused = fail(
      'WRP_DISTORTION_EXCEEDED',
      `the geodesic charts of the chain stretch the sketch by up to ${(100 * strain).toPrecision(4)} % (limit ${(100 * limit).toPrecision(4)} %); use a smaller sketch or a larger maxLengthStrain`,
      ['placement'],
      params.profileIds,
    );
    return { ...refused, data: { distortion: { maxLengthStrain: strain, joinMismatch: joinStrain, limit, method: chain.method } } };
  }
  // walls meet in a surface along a smooth edge; across a sharp edge between two planes the slabs overlap or a mitre filler closes the corner (embossMitre.ts), any other sharp edge is refused
  const inked = new Set(steps.map((step) => step.face.session.face));
  const mitre = scribe ? null : mitreFillers({ chain, inked, regions, mode: cutting ? 'deboss' : 'emboss', depth });
  if (mitre !== null && isMitreFailure(mitre)) return fail(mitre.code, mitre.message, ['chain']);
  if (Math.abs(clippedArea - sketchArea) > 1e-9 * Math.max(sketchArea, 1e-12))
    return fail(
      'WRP_CHAIN_CLIP_FAILED',
      `the parts of the sketch on the chain faces (${clippedArea}) do not add up to the sketch area (${sketchArea}): the sketch crosses a chain edge more than once on one face or leaves the chain`,
      ['profileIds'],
      params.profileIds,
    );
  const result = buildChainSolid(input, steps, mitre, fail);
  if ('summary' in result) return result;
  const before = volumeOf(session.shape);
  const after = volumeOf(result.shape);
  const volumeDelta = before !== null && after !== null ? after - before : null;
  if (volumeDelta !== null && !scribe && (cutting ? volumeDelta >= 0 : volumeDelta <= 0))
    return fail(
      'WRP_KERNEL_BUILD_FAILED',
      `the chain ${params.mode} changed the volume by ${volumeDelta} ${doc.units}^3, the wrong way; refused`,
      ['profileIds'],
      params.profileIds,
    );
  const expected = steps.reduce((sum, step) => sum + (embossClosedForm(step.recipeParams)?.delta ?? 0), 0) + (mitre?.delta ?? 0);
  const outcome: ChainOutcome = {
    doc,
    command,
    params,
    session,
    chain,
    steps,
    mitre,
    regions,
    depth,
    tolerance,
    unverified: input.unverified,
    sketchArea,
    clippedArea,
    strain,
    joinStrain,
    limit,
    volumeDelta,
    expected,
  };
  const data = chainData(outcome);
  const committed = commitKernelResult(doc, session.kernel, result, [session.entity], (newId, triangles) =>
    chainSummary(outcome, newId, triangles),
  );
  return { ...committed, data, ...(session.faceName !== undefined ? { recordExtras: { face: { faceName: session.faceName } } } : {}) };
}

function planSteps(
  input: ChainEmboss,
  chain: Chain,
  fail: Fail,
): { readonly steps: ChainStep[]; readonly clippedArea: number; readonly strain: number } | CommandResult {
  const steps: ChainStep[] = [];
  let clippedArea = 0;
  let strain = 0;
  for (const face of chain.faces) {
    const plan = planFace(input, chain, face, fail);
    if (plan === null) continue;
    if ('summary' in plan) return plan;
    clippedArea += plan.clipped;
    if (plan.strain !== null) strain = Math.max(strain, plan.strain);
    steps.push(plan.step);
  }
  return { steps, clippedArea, strain };
}

/** One chain face: cut the sketch to it, map it, check it; null when no part of the sketch lies on the face. */
function planFace(input: ChainEmboss, chain: Chain, face: ChainFace, fail: Fail): FacePlan | CommandResult | null {
  const { params, session, regions, tolerance, depth } = input;
  let part: readonly ChartRegion[] | null = regions;
  for (const plane of face.clips) {
    part = clipRegions(part ?? [], plane);
    if (part === null)
      return fail(
        'WRP_CHAIN_CLIP_FAILED',
        `the sketch outline could not be cut at the chain edges of face ${face.session.face} (a boundary touches an edge tangentially)`,
        ['profileIds'],
        params.profileIds,
      );
  }
  if (part.length === 0) return null;
  const clipped = regionsArea(part);
  const stretch = chain.developable
    ? null
    : measureDistortion(
        face.chart,
        part.flatMap((region) => [region.outer, ...region.holes]),
        [],
        0,
      ).maxLengthStrain;
  const mapped = mapOutlineRegions(face.session, face.chart, part, tolerance);
  if (isMappingFailure(mapped)) return fail(mapped.code, `face ${face.session.face}: ${mapped.message}`, ['profileIds'], params.profileIds);
  const overlap = checkWrapAround(face.chart, mapped.pieces, params.profileIds);
  if (overlap !== null) return fail(overlap.code, `face ${face.session.face}: ${overlap.message}`, ['profileIds'], params.profileIds);
  const outside = checkOnFace(face.session, probePoints(face.chart, mapped.pieces, MAX_PROBES), params.profileIds, {
    slack: face.slack,
    joins: face.joins,
  });
  if (outside !== null) return fail(outside.code, `face ${face.session.face}: ${outside.message}`, ['profileIds'], params.profileIds);
  const recipeParams = {
    surface: face.chart.wire,
    regions: mapped.regions,
    mode: params.mode === 'deboss' ? ('deboss' as const) : (params.mode as 'emboss' | 'scribe'),
    depth,
    direction: scale3(face.chart.normalAt(mapped.regions[0]?.outer.start as Vec2), face.orientation),
    tolerance: Math.max(SEWING_RATIO * session.diagonal, MIN_FIT_TOLERANCE, tolerance),
  };
  return {
    step: { face, recipeParams, area: embossClosedForm(recipeParams)?.area ?? 0, probes: mapped.pieces.length },
    clipped,
    strain: stretch,
  };
}

/** The faces embossed one after another as kernel steps, then the mitre fillers, then the health check of the result. */
function buildChainSolid(input: ChainEmboss, steps: readonly ChainStep[], mitre: Mitre | null, fail: Fail): KernelBuilt | CommandResult {
  const { params, session } = input;
  const cutting = params.mode === 'deboss';
  let recipe: ShapeRecipe = session.source;
  let shape = session.shape;
  for (const [index, step] of steps.entries()) {
    const found = index === 0 ? step.face.session.face : (session.query.distance(shape, [step.face.probe])?.[0]?.face ?? -1);
    if (found < 0)
      return fail('WRP_KERNEL_BUILD_FAILED', `face ${step.face.session.face} was not found again after the earlier chain faces`, ['chain']);
    recipe = { op: 'emboss', source: recipe, face: found, ...step.recipeParams };
    const built = session.kernel.evaluate(recipe);
    if (built === null)
      return fail(
        'WRP_KERNEL_BUILD_FAILED',
        `the exact kernel could not ${params.mode} the ${step.recipeParams.regions.length} region(s) on chain face ${step.face.session.face} (step ${index + 1} of ${steps.length}); try a smaller depth or profile`,
        ['profileIds'],
        params.profileIds,
      );
    shape = built;
  }
  for (const filler of mitre?.fillers ?? []) recipe = { op: 'boolean', boolean: cutting ? 'subtract' : 'union', a: recipe, b: filler };
  const result = evaluateRecipe(session.kernel, recipe);
  if (typeof result === 'string')
    return fail(
      'WRP_KERNEL_BUILD_FAILED',
      `the exact kernel could not build the chain ${params.mode} (${result})`,
      ['profileIds'],
      params.profileIds,
    );
  const health = session.kernel.analyze?.(result.shape) ?? null;
  if (health !== null && !(health.valid && health.closed))
    return fail(
      'WRP_KERNEL_BUILD_FAILED',
      `the chain ${params.mode} is not a valid closed solid (${health.status}); refused`,
      ['profileIds'],
      params.profileIds,
    );
  return result;
}
