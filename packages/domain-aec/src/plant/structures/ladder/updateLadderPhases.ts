import type { CommandResult } from '@core/commands/types';
import { type z } from '@core/commands/schema';
import { fromMm, toMm } from '@core/model/units';
import type { CadDocument } from '@core/model/types';
import type { BuildingModel, LadderCage, LadderElement } from '@aec/building/types';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { round } from '../../../shared/numeric';
import type { refuse } from '../codes';
import { RULESET_NAMES } from '../rules/ruleTable';
import { MAX_RUNGS, type ladderCageParam } from './addLadder';
import { defaultCageMm, pitchRange, planPitch } from './ladderDefaults';
import { cutRailingGate } from './ladderGate';
import { ladderSizes } from './ladderMeasure';
import { walkingSurfaces } from './ladderSurface';

/** Plan reach of the railing search for a through-exit gate, as in add_ladder (§5.7), mm. */
const GATE_REACH_MM = 600;

export interface LadderEdit {
  readonly clearWidth?: number | undefined;
  readonly rungPitch?: number | undefined;
  readonly rungPitchMax?: number | undefined;
  readonly exit?: LadderElement['exit'] | undefined;
  readonly fallProtection?: LadderElement['fallProtection'] | undefined;
  readonly cage?: z.infer<typeof ladderCageParam>;
  readonly landings?: readonly number[] | undefined;
  readonly railExtension?: number | undefined;
  readonly installedOn?: string | undefined;
  readonly rulesets?: ReadonlyArray<(typeof RULESET_NAMES)[number]> | undefined;
}

export type Fail = (code: Parameters<typeof refuse>[2], message: string, paths?: string[]) => CommandResult;

/** The rung pitch and count after the edit (explicit pitch, planned pitch, or unchanged); a refusal when none is feasible. */
export function editedRungs(
  doc: CadDocument,
  ladder: LadderElement,
  params: LadderEdit,
  fail: Fail,
): { rungPitch: number; rungCount: number } | CommandResult {
  let { rungPitch, rungCount } = ladder;
  if (params.rungPitch !== undefined) {
    rungPitch = params.rungPitch;
    rungCount = Math.max(0, Math.ceil(ladder.climbHeight / rungPitch - 1e-9) - 1);
  } else if (params.rungPitchMax !== undefined) {
    const range = pitchRange(params.rulesets ?? RULESET_NAMES);
    const plan = planPitch(toMm(doc, ladder.climbHeight), toMm(doc, params.rungPitchMax), range.min, range.basis);
    if (!plan.ok) return fail('STA_LADDER_PITCH_INFEASIBLE', plan.reason, ['rungPitchMax']);
    rungPitch = fromMm(doc, plan.pitchMm);
    rungCount = plan.spaces - 1;
  }
  if (rungCount > MAX_RUNGS) return fail('STA_INVALID_GEOMETRY', `${rungCount} rungs: check the units of rungPitch`, ['rungPitch']);
  return { rungPitch, rungCount };
}

/** The cage after the edit: given values, else the current ones, else the ISO defaults (none without fall protection "cage"). */
export function editedCage(doc: CadDocument, ladder: LadderElement, params: LadderEdit, fallProtection: string): LadderCage | undefined {
  if (fallProtection !== 'cage') return undefined;
  const mm = (value: number): number => fromMm(doc, value);
  const named = defaultCageMm();
  const current = ladder.cage;
  const given = params.cage ?? {};
  return {
    startHeight: given.startHeight ?? current?.startHeight ?? mm(named.startHeight),
    hoopSpacing: given.hoopSpacing ?? current?.hoopSpacing ?? mm(named.hoopSpacing),
    diameter: given.diameter ?? current?.diameter ?? mm(named.diameter),
    bars: given.bars ?? current?.bars ?? named.bars,
  };
}

export type LadderChanges = Partial<Pick<LadderElement, 'clearWidth' | 'exit' | 'railExtension' | 'installedOn'>>;

export function ladderChanges(params: LadderEdit): LadderChanges {
  return {
    ...(params.clearWidth === undefined ? {} : { clearWidth: params.clearWidth }),
    ...(params.exit === undefined ? {} : { exit: params.exit }),
    ...(params.railExtension === undefined ? {} : { railExtension: params.railExtension }),
    ...(params.installedOn === undefined ? {} : { installedOn: params.installedOn }),
  };
}

type Gate = ReturnType<typeof cutRailingGate>;

/** The railing gate of a through exit: cut / reused when the exit or the width changed, skipped without an arrival surface, noted when side_step. */
export function railingGate(doc: CadDocument, params: LadderEdit, ladder: LadderElement, next: LadderElement, model: BuildingModel): Gate {
  const arrival = walkingSurfaces(model).find((surface) => surface.id === ladder.arrivalSurfaceId);
  const regate = next.exit === 'through' && (params.exit !== undefined || params.clearWidth !== undefined);
  if (regate && arrival !== undefined)
    return cutRailingGate(
      doc,
      model,
      {
        base: [next.base[0], next.base[1]],
        facing: next.facing,
        clearWidth: next.clearWidth,
        stileThickness: ladderSizes(doc).stileThickness,
      },
      arrival,
      fromMm(doc, GATE_REACH_MM),
    );
  if (regate) return { building: model, status: 'skipped', reason: 'the ladder has no arrival surface, so no railing gap can be cut' };
  if (params.exit === 'side_step' && ladder.exit === 'through')
    return {
      building: model,
      status: 'none',
      reason: 'exit is now side_step: a gated gap cut earlier stays in its railing (update_railing openings removes it)',
    };
  return { building: model, status: 'none' };
}

/** The committed update with its summary and data. */
export function ladderUpdateResult(
  doc: CadDocument,
  ladder: LadderElement,
  next: LadderElement,
  gate: Gate,
  names: readonly string[],
): CommandResult {
  const { id, rungCount, rungPitch, fallProtection } = next;
  const result = commitBuilding(
    doc,
    gate.building,
    gate.status === 'cut' && gate.railingId !== undefined ? [id, gate.railingId] : [id],
    `Updated ladder ${ladder.mark} (${id}): ${names.join(', ')}; ${rungCount} rung(s) at ${round(toMm(doc, rungPitch), 3)} mm, ${fallProtection}, back clearance ${round(toMm(doc, next.backClearance), 1)} mm. Gate: ${gate.status}${gate.reason === undefined ? '' : ` (${gate.reason})`}. Run check_access.`,
  );
  return {
    ...result,
    data: {
      elementIds: [id],
      changed: names,
      rungCount,
      rungPitchMm: round(toMm(doc, rungPitch), 4),
      clearWidthMm: round(toMm(doc, next.clearWidth), 3),
      fallProtection,
      backClearanceMm: round(toMm(doc, next.backClearance), 3),
      gate: {
        status: gate.status,
        ...(gate.railingId === undefined ? {} : { railingId: gate.railingId }),
        ...(gate.reason === undefined ? {} : { reason: gate.reason }),
      },
    },
  };
}
