/** The finite element model of a stress model, rebuilt from the current document on every analysis (07 PST §5.1). */

import type { CadDocument } from '@core/model/types';
import { ruleSetOf, type RuleSet } from '../code/ruleSets';
import { buildLayout, pointAtArc, type Attachment, type Layout, type LayoutFailure } from './layout';
import { mapRestraints, type RestraintSet } from './restraints';
import type { StressModel } from './schema';
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
  readonly warnings: readonly { readonly code: string; readonly message: string; readonly ids: readonly string[] }[];
}

const failure = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): LayoutFailure => ({
  ok: false,
  code,
  message,
  ids,
  paths,
});

export const isBuildFailure = (value: BuiltModel | LayoutFailure): value is LayoutFailure => 'ok' in value;

/**
 * @failure document not in mm -> PST_PARAM_INVALID; missing pipe / run -> PST_PIPE_NOT_FOUND; run branches / reducers -> PST_COMPONENT_UNSUPPORTED;
 *   no wall -> PST_WALL_UNKNOWN; geometry failures of `buildLayout`, `mapRestraints`
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
  const unsupported = sources.pipes.flatMap((pipe) => pipe.unsupported.map((what) => `${pipe.id}: ${what}`));
  if (unsupported.length > 0)
    return failure(
      'PST_COMPONENT_UNSUPPORTED',
      `components the M3 model cannot represent (tees, branches and reducers arrive with M5): ${unsupported.join('; ')}`,
      sources.pipes.filter((pipe) => pipe.unsupported.length > 0).map((pipe) => pipe.id),
      ['scope'],
    );
  const walls = new Map<string, number>();
  for (const pipe of sources.pipes) {
    const wall = model.conditions?.wallMm ?? pipe.wallMm;
    if (wall === null || !(wall > 0) || 2 * wall >= pipe.odMm)
      return failure(
        'PST_WALL_UNKNOWN',
        wall === null
          ? `pipe ${pipe.id} has no wall thickness (no spec binding)`
          : `pipe ${pipe.id}: wall ${wall} mm is not a physical wall for OD ${pipe.odMm} mm`,
        [pipe.id],
        ['conditions.wallMm'],
      );
    walls.set(pipe.id, wall);
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
  const set = ruleSetOf(model.rule);
  const layout = buildLayout(sources.pipes, walls, set, model, attachments);
  if ('ok' in layout) return layout;
  const restraints = mapRestraints(model, sources.supports, layout);
  if ('ok' in restraints) return restraints;
  const forces = model.forces.map((force, index) => ({
    name: force.name,
    node: (layout.attached.get(`force:${index}`) as { node: number }).node,
    force: force.forceN,
    moment: force.momentNmm ?? ([0, 0, 0] as const),
  }));
  const warnings = [
    ...restraints.warnings,
    ...sources.pipes.flatMap((pipe) =>
      pipe.asPipe.map((what) => ({
        code: 'PST_COMPONENT_AS_PIPE',
        message: `${pipe.id}: ${what} is modelled as plain pipe`,
        ids: [pipe.id],
      })),
    ),
    ...layout.sharpCorners.map((id) => ({
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
  return { sources, layout, restraints, walls, set, forces, warnings };
}
