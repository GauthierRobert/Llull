/** The finite element model of a stress model, rebuilt from the current document on every analysis (07 PST §5.1). */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { ruleSetOf, type RuleSet } from '../code/ruleSets';
import type { SourceComponent } from './components';
import type { JunctionFitting } from './junctions';
import { buildLayout, type LayoutComponent } from './layout';
import type { Attachment, Layout, LayoutFailure } from './layoutTypes';
import { applySifOverrides } from './sifOverrides';
import { mapRestraints, type RestraintSet } from './restraints';
import type { StressComponent, StressModel, StressRestraint } from './schema';
import { arcOf, meanSection, pointAtArc, sectionAt, type SectionStep } from './sections';
import { resolveSources, type SourcePipe, type Sources } from './sources';

export interface BuiltModel {
  readonly sources: Sources;
  readonly layout: Layout;
  readonly restraints: RestraintSet;
  readonly walls: ReadonlyMap<string, number>;
  readonly set: RuleSet;
  readonly forces: readonly {
    readonly name: string;
    readonly node: number;
    readonly force: readonly [number, number, number];
    readonly moment: readonly [number, number, number];
  }[];
  /** Imposed displacements of anchor nodes: 6 values (mm, rad). */
  readonly displacements: readonly { readonly name: string; readonly node: number; readonly values: readonly number[] }[];
  /** Stated weights of tees / olets (kg) at their junction node. */
  readonly pointWeights: readonly { readonly node: number; readonly kg: number }[];
  readonly warnings: readonly { readonly code: string; readonly message: string; readonly ids: readonly string[] }[];
}

const failure = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): LayoutFailure => ({
  ok: false,
  code,
  message,
  ids,
  paths,
});

/** Thinnest corroded wall the section formulas are used with (mm): below it the section is not a pipe. */
const MIN_CORRODED_WALL_MM = 0.1;
const MIN_COMPONENT_MM = 2;

export const isBuildFailure = (value: BuiltModel | LayoutFailure): value is LayoutFailure => 'ok' in value;

/** The fitting a branch pipe's tee is modelled with: the stored choice, else what the 02 RTE derivation says, else a fabricated tee (assumed). */
function fittingChoice(
  model: Pick<StressModel, 'components'>,
  sources: Sources,
  branchPipeId: string,
): JunctionFitting & { readonly origin: 'stored' | 'rte' | 'assumed' } {
  const stored = model.components.find((entry) => 'branchPipeId' in entry.target && entry.target.branchPipeId === branchPipeId);
  const derived = sources.branches.find((branch) => branch.branchPipeId === branchPipeId);
  const padMm = stored?.padMm;
  if (stored?.fitting !== undefined) return { fitting: stored.fitting, padMm, origin: 'stored' };
  if (derived !== undefined)
    return {
      fitting: derived.kind === 'tee' ? 'welding_tee' : derived.kind === 'olet' ? 'weldolet' : 'unreinforced_tee',
      padMm,
      origin: 'rte',
    };
  return { fitting: 'unreinforced_tee', padMm, origin: 'assumed' };
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The components of the model as layout input: RTE valves / reducers and the declared ones, each with its stored data. */
function layoutComponents(
  model: StressModel,
  sources: Sources,
  steps: ReadonlyMap<string, readonly SectionStep[]>,
): { readonly list: LayoutComponent[] } | LayoutFailure {
  const list: LayoutComponent[] = [];
  const push = (component: SourceComponent, data: StressComponent | undefined): void => {
    const own = steps.get(component.pipeId) as readonly SectionStep[];
    const arc = arcOf(sources.pipes.find((pipe) => pipe.id === component.pipeId)?.points ?? [], component.faces[0]);
    const section =
      component.kind === 'reducer' && component.downstream !== undefined
        ? meanSection(sectionAt(own, arc - 1), sectionAt(own, arc + component.lengthMm))
        : undefined;
    list.push({
      key: component.key,
      pipeId: component.pipeId,
      kind: component.kind,
      faces: component.faces,
      rigid: data?.rigid ?? component.kind !== 'reducer',
      stiffnessFactor: data?.stiffnessFactor ?? 1,
      weightKg: data?.weightKg ?? null,
      ...(section === undefined ? {} : { section }),
    });
  };
  for (const component of sources.components)
    push(
      component,
      model.components.find((entry) => 'componentId' in entry.target && entry.target.componentId === component.key),
    );
  for (const entry of model.components) {
    if (!('pipeId' in entry.target)) continue;
    const target = entry.target;
    const pipe = sources.pipes.find((candidate) => candidate.id === target.pipeId);
    const first = pipe === undefined ? null : pointAtArc(pipe.points, Math.max(0, target.atMm - target.lengthMm / 2));
    const second = pipe === undefined ? null : pointAtArc(pipe.points, target.atMm + target.lengthMm / 2);
    if (pipe === undefined || first === null || second === null || distance(first, second) < MIN_COMPONENT_MM)
      return failure(
        'PST_POINT_OFF_PIPE',
        `component ${entry.id}: no length of at least ${MIN_COMPONENT_MM} mm on pipe ${target.pipeId} at ${target.atMm} mm`,
        [entry.id, target.pipeId],
      );
    push({ key: entry.id, pipeId: pipe.id, kind: target.kind, faces: [first, second], lengthMm: target.lengthMm }, entry);
  }
  return { list };
}

/**
 * @failure document not in mm -> PST_PARAM_INVALID; missing pipe / run -> PST_PIPE_NOT_FOUND; no wall -> PST_WALL_UNKNOWN; corrosion allowance eating the wall
 *   -> PST_CORROSION_EXCEEDS_WALL; geometry failures of `buildLayout`, `mapRestraints`
 */
export function buildStressModel(doc: CadDocument, model: StressModel): BuiltModel | LayoutFailure {
  if (doc.units !== 'mm') return failure('PST_PARAM_INVALID', `plant lengths are mm; this document is in ${doc.units}`, [], ['units']);
  const sources = resolveSources(doc, model);
  if (sources.missing.length > 0)
    return failure(
      'PST_PIPE_NOT_FOUND',
      `no longer available: ${sources.missing.map(([id, why]) => `${id} (${why})`).join('; ')}`,
      sources.missing.map(([id]) => id),
      ['scope'],
    );
  const walls = new Map<string, number>();
  const steps = new Map<string, SectionStep[]>();
  const corrosion = model.conditions?.corrosionAllowanceMm ?? 0;
  const millFactor = 1 - (model.conditions?.millTolerancePct ?? 0) / 100;
  const checkWall = (pipe: SourcePipe, wall: number | null, odMm: number): LayoutFailure | null => {
    if (wall === null || !(wall > 0) || 2 * wall >= odMm)
      return failure(
        'PST_WALL_UNKNOWN',
        wall === null
          ? `pipe ${pipe.id} has no wall thickness (no spec binding)`
          : `pipe ${pipe.id}: wall ${wall} mm is not a physical wall for OD ${odMm} mm`,
        [pipe.id],
        ['conditions.wallMm'],
      );
    if (!(wall * millFactor - corrosion > MIN_CORRODED_WALL_MM))
      return failure(
        'PST_CORROSION_EXCEEDS_WALL',
        `pipe ${pipe.id}: corrosion allowance ${corrosion} mm leaves ${(wall * millFactor - corrosion).toFixed(3)} mm of the ${wall} mm wall (mill tolerance ${model.conditions?.millTolerancePct ?? 0} %) (needs more than ${MIN_CORRODED_WALL_MM} mm)`,
        [pipe.id],
        ['conditions.corrosionAllowanceMm'],
      );
    return null;
  };
  for (const pipe of sources.pipes) {
    const wall = model.conditions?.wallMm ?? pipe.wallMm;
    const bad = checkWall(pipe, wall, pipe.odMm);
    if (bad !== null) return bad;
    walls.set(pipe.id, wall as number);
    const own: SectionStep[] = [{ fromArcMm: 0, section: { odMm: pipe.odMm, wallMm: wall as number } }];
    for (const component of sources.components) {
      if (component.pipeId !== pipe.id || component.kind !== 'reducer' || component.downstream === undefined) continue;
      const downstream = { odMm: component.downstream.odMm, wallMm: model.conditions?.wallMm ?? component.downstream.wallMm };
      const worse = checkWall(pipe, downstream.wallMm, downstream.odMm);
      if (worse !== null) return worse;
      own.push({ fromArcMm: arcOf(pipe.points, component.faces[0]) + component.lengthMm / 2, section: downstream });
    }
    steps.set(
      pipe.id,
      own.sort((a, b) => a.fromArcMm - b.fromArcMm),
    );
  }
  const attachments: Attachment[] = [];
  for (const support of sources.supports) attachments.push({ key: `support:${support.id}`, pipeId: support.pipeId, point: support.point });
  const lookup = (pipeId: string): SourcePipe | undefined => sources.pipes.find((pipe) => pipe.id === pipeId);
  for (const restraint of model.restraints) {
    if ('supportId' in restraint.at) {
      const support = sources.supports.find((candidate) => candidate.id === (restraint.at as { supportId: string }).supportId);
      if (support === undefined)
        return failure(
          'PST_SUPPORT_NOT_FOUND',
          `restraint ${restraint.id}: no support ${(restraint.at as { supportId: string }).supportId} on the model pipes`,
          [restraint.id],
        );
      attachments.push({ key: `restraint:${restraint.id}`, pipeId: support.pipeId, point: support.point });
    } else {
      const pipe = lookup(restraint.at.pipeId);
      const point = pipe === undefined ? null : pointAtArc(pipe.points, restraint.at.atMm);
      if (pipe === undefined || point === null)
        return failure(
          'PST_POINT_OFF_PIPE',
          `restraint ${restraint.id}: pipe ${restraint.at.pipeId} is not in the model`,
          [restraint.id],
          ['at'],
        );
      attachments.push({ key: `restraint:${restraint.id}`, pipeId: pipe.id, point });
    }
  }
  for (const [index, force] of model.forces.entries()) {
    const pipe = lookup(force.pipeId);
    const point = pipe === undefined ? null : pointAtArc(pipe.points, force.atMm);
    if (pipe === undefined || point === null)
      return failure(
        'PST_POINT_OFF_PIPE',
        `force ${force.name}: pipe ${force.pipeId} is not in the model`,
        [force.pipeId],
        [`forces.${index}`],
      );
    attachments.push({ key: `force:${index}`, pipeId: pipe.id, point });
  }
  const locate = (at: StressRestraint['at'], key: string, label: string): Attachment | LayoutFailure => {
    if ('supportId' in at) {
      const support = sources.supports.find((candidate) => candidate.id === at.supportId);
      return support === undefined
        ? failure('PST_SUPPORT_NOT_FOUND', `${label}: no support ${at.supportId} on the model pipes`, [label])
        : { key, pipeId: support.pipeId, point: support.point };
    }
    const pipe = lookup(at.pipeId);
    const point = pipe === undefined ? null : pointAtArc(pipe.points, at.atMm);
    return pipe === undefined || point === null
      ? failure('PST_POINT_OFF_PIPE', `${label}: pipe ${at.pipeId} is not in the model`, [label], ['at'])
      : { key, pipeId: pipe.id, point };
  };
  for (const [index, moved] of model.displacements.entries()) {
    const placed = locate(moved.at, `displacement:${index}`, `displacement ${moved.name}`);
    if ('ok' in placed) return placed;
    attachments.push(placed);
  }
  for (const override of model.sifOverrides) {
    const placed = locate(override.at, `sif:${override.id}`, `SIF override ${override.id}`);
    if ('ok' in placed) return placed;
    attachments.push(placed);
  }
  const set = ruleSetOf(model.rule);
  const components = layoutComponents(model, sources, steps);
  if ('ok' in components) return components;
  const layout = buildLayout({
    pipes: sources.pipes,
    sections: steps,
    set,
    options: model,
    attachments,
    components: components.list,
    fittingOf: (branchPipeId) => fittingChoice(model, sources, branchPipeId),
  });
  if ('ok' in layout) return layout;
  const overridden = applySifOverrides(
    layout.elements,
    model.sifOverrides.map((override) => ({
      id: override.id,
      node: (layout.attached.get(`sif:${override.id}`) as { node: number }).node,
      ii: override.sifInPlane,
      io: override.sifOutOfPlane,
      flexibility: override.flexibility,
      source: override.source,
    })),
  );
  if ('ok' in overridden) return overridden;
  const finished: Layout = { ...layout, elements: overridden.elements };
  const restraints = mapRestraints(model, sources.supports, finished);
  if ('ok' in restraints) return restraints;
  const displacements: BuiltModel['displacements'][number][] = [];
  for (const [index, moved] of model.displacements.entries()) {
    const node = (finished.attached.get(`displacement:${index}`) as { node: number }).node;
    if (!restraints.anchors.some((anchor) => anchor.node === node))
      return failure(
        'PST_DISPLACEMENT_NOT_ANCHORED',
        `imposed displacement ${moved.name} acts at node N${node + 1}, which is not an anchor`,
        [moved.name],
        [`displacements.${index}`],
      );
    const rotation = moved.rotationDeg ?? [0, 0, 0];
    displacements.push({ name: moved.name, node, values: [...moved.translationMm, ...rotation.map((deg) => (deg * Math.PI) / 180)] });
  }
  const forces = model.forces.map((force, index) => ({
    name: force.name,
    node: (finished.attached.get(`force:${index}`) as { node: number }).node,
    force: force.forceN,
    moment: force.momentNmm ?? ([0, 0, 0] as const),
  }));
  const pointWeights = finished.junctions.flatMap((junction) => {
    const stored = model.components.find((entry) => 'branchPipeId' in entry.target && entry.target.branchPipeId === junction.branchPipeId);
    return stored?.weightKg === undefined || stored.weightKg === 0 ? [] : [{ node: junction.node, kg: stored.weightKg }];
  });
  const assumed = finished.junctions.filter((junction) => fittingChoice(model, sources, junction.branchPipeId).origin === 'assumed');
  const unweighed = components.list.filter((component) => component.kind !== 'reducer' && component.weightKg === null);
  const reducers = components.list.filter((component) => component.kind === 'reducer');
  const warnings = [
    ...restraints.warnings,
    ...overridden.warnings,
    ...assumed.map((junction) => ({
      code: 'PST_TEE_FITTING_ASSUMED',
      message: `branch ${junction.branchPipeId} on ${junction.headerPipeId} is modelled as an unreinforced fabricated tee (set_stress_component fitting to change it)`,
      ids: [junction.branchPipeId],
    })),
    ...(unweighed.length === 0
      ? []
      : [
          {
            code: 'PST_COMPONENT_WEIGHT_MISSING',
            message: `${unweighed.map((component) => component.key).join(', ')}: no weight stated, the body carries only the pipe weight (set_stress_component weightKg)`,
            ids: unweighed.map((component) => component.key),
          },
        ]),
    ...(reducers.length === 0
      ? []
      : [
          {
            code: 'PST_REDUCER_SIF',
            message: `${reducers.map((component) => component.key).join(', ')}: reducer stress intensification is 1.0 (no factor in a read source); a manufacturer or B31J value should replace it`,
            ids: reducers.map((component) => component.key),
          },
        ]),
    ...finished.sharpCorners.map((id) => ({
      code: 'PST_SHARP_CORNERS',
      message: `pipe ${id}: corners kept sharp (elbowRadiusFactor 0): k = 1 and i = 1`,
      ids: [id],
    })),
    ...(set.sifBasis === 'b31j'
      ? [
          {
            code: 'PST_SIF_EDITION',
            message: `${set.id} requires ASME B31J factors (tables not public): code appendix D values are used and may under-state the SIF`,
            ids: [] as string[],
          },
        ]
      : []),
  ];
  return { sources, layout: finished, restraints, walls, set, forces, displacements, pointWeights, warnings };
}
