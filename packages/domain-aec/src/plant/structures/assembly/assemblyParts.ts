/** Shared plumbing of the platform generators (06 STA M6): part slots that keep ids across regeneration, element makers and outcomes. */

import type { Vec2, Vec3 } from '@core/model/types';
import type { BaseFixity, BuildingModel, GratingElement, JointFixity, RailingElement, SteelMemberElement } from '@aec/building/types';
import { nextElementId, nextMark, withElement } from '../../../building/model';
import { nextMemberMark } from '../../../industrial/common/memberSupport';
import { round } from '../../../shared/numeric';
import type { StaCode } from '../codes';

/** An id and mark of a part from the previous generation, reused by the next one (references to it stay valid). */
export interface Slot {
  readonly id: string;
  readonly mark: string;
  /** Members only: a slot is reused by a run of the same role (marks keep their scheme), first by the run with the same note (a rack bent / line / tier label), else in creation order. */
  readonly role?: SteelMemberElement['role'];
  readonly note?: string;
}

export interface Slots {
  readonly member: readonly Slot[];
  readonly grating: readonly Slot[];
  readonly railing: readonly Slot[];
}

/** The slots of an assembly's current parts, per category, in creation order. */
export function slotsOf(building: BuildingModel, partIds: ReadonlyArray<string>): Slots {
  const of = (category: 'member' | 'grating' | 'railing'): Slot[] =>
    partIds.flatMap((id) => {
      const element = building.elements[id];
      return element?.category === category
        ? [
            {
              id,
              mark: element.mark,
              ...(element.category === 'member'
                ? { role: element.role, ...(element.note === undefined ? {} : { note: element.note }) }
                : {}),
            },
          ]
        : [];
    });
  return { member: of('member'), grating: of('grating'), railing: of('railing') };
}

export interface AssemblyFailure {
  readonly ok: false;
  readonly code: StaCode;
  readonly message: string;
  readonly paths: string[];
  readonly ids: string[];
}

export interface AssemblyBuilt {
  readonly ok: true;
  readonly building: BuildingModel;
  readonly partIds: string[];
  readonly notes: string[];
}

export type AssemblyOutcome = AssemblyBuilt | AssemblyFailure;

export const failure = (code: StaCode, message: string, paths: string[] = [], ids: string[] = []): AssemblyFailure => ({
  ok: false,
  code,
  message,
  paths,
  ids,
});

type Maker<Element> = (id: string, mark: string) => Element;

/** Adds one element per maker, taking the ids and marks of `slots` first and minting new ones for the rest. */
function place<Element extends SteelMemberElement | GratingElement | RailingElement>(
  building: BuildingModel,
  category: Element['category'],
  slots: ReadonlyArray<Slot | undefined>,
  makers: ReadonlyArray<Maker<Element>>,
  newMark: (model: BuildingModel, index: number) => string,
): { building: BuildingModel; ids: string[] } {
  let next = building;
  const ids = makers.map((make, index) => {
    const slot = slots[index];
    const id = slot?.id ?? nextElementId(next, category);
    next = withElement(next, make(id, slot?.mark ?? newMark(next, index)));
    return id;
  });
  return { building: next, ids };
}

export interface PartBase {
  readonly levelId: string;
  readonly assemblyId: string;
}

/** A member to place: a catalogue run with its role, section roll and connection fixity. */
export interface MemberRun {
  readonly role: SteelMemberElement['role'];
  readonly profile: string;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly roll?: number;
  readonly startJoint?: JointFixity;
  readonly endJoint?: JointFixity;
  readonly baseFixity?: BaseFixity;
  readonly note?: string;
}

/** Steel grade stored on every generated rack / platform member (no grade parameter yet: INT-FB-014); checks read it like any stored grade. */
const GENERATED_STEEL_GRADE = 'S355';

/** Places the runs as members; each takes the id and mark of an unused slot of its role (in creation order), else a new one. */
export function placeMemberRuns(
  building: BuildingModel,
  slots: readonly Slot[],
  base: PartBase,
  runs: ReadonlyArray<MemberRun>,
): { building: BuildingModel; ids: string[] } {
  const free = new Set(slots);
  const aligned: Array<Slot | undefined> = runs.map((run) => {
    const same =
      run.note === undefined ? undefined : slots.find((slot) => free.has(slot) && slot.role === run.role && slot.note === run.note);
    if (same !== undefined) free.delete(same);
    return same;
  });
  aligned.forEach((taken, index) => {
    if (taken !== undefined) return;
    const next = slots.find((slot) => free.has(slot) && (slot.role ?? 'beam') === runs[index]?.role);
    if (next !== undefined) free.delete(next);
    aligned[index] = next;
  });
  return place(
    building,
    'member',
    aligned,
    runs.map(
      (run): Maker<SteelMemberElement> =>
        (id, mark) => ({
          id,
          category: 'member',
          mark,
          entityIds: [],
          ...base,
          role: run.role,
          profile: run.profile,
          start: run.start,
          end: run.end,
          roll: run.roll ?? 0,
          material: GENERATED_STEEL_GRADE,
          ...(run.startJoint === undefined ? {} : { startJoint: run.startJoint }),
          ...(run.endJoint === undefined ? {} : { endJoint: run.endJoint }),
          ...(run.baseFixity === undefined ? {} : { baseFixity: run.baseFixity }),
          ...(run.note === undefined ? {} : { note: run.note }),
        }),
    ),
    // The mark scheme follows the role of the member each slot is built for.
    (model, index) => nextMemberMark(model, runs[index]?.role ?? 'beam'),
  );
}

export const placeMembers = (
  building: BuildingModel,
  slots: readonly Slot[],
  base: PartBase,
  role: 'beam' | 'bracket',
  profile: string,
  runs: ReadonlyArray<{ start: Vec3; end: Vec3 }>,
): { building: BuildingModel; ids: string[] } =>
  placeMemberRuns(
    building,
    slots,
    base,
    runs.map((run) => ({ role, profile, ...run })),
  );

/** Plan points rounded to 4 decimals of the document unit: what is stored, and what the overlap test sees (touching panels of two platforms compare equal). */
export const tidyRing = (ring: ReadonlyArray<Vec2>): Vec2[] => ring.map(([x, y]): Vec2 => [round(x, 4), round(y, 4)]);

/** The railing fields a generated guard-rail stores (all resolved). */
export interface RailingFields {
  readonly height: number;
  readonly kneeRails: number;
  readonly toePlate: number;
  readonly postProfile: string;
  readonly railProfile: string;
  readonly postSpacingMax: number;
  readonly openings?: Array<{ from: number; to: number; gate: boolean }> | undefined;
}

export interface PanelDef {
  readonly boundary: Vec2[];
  readonly supportIds: [string[], string[]];
}

export const placeGratings = (
  building: BuildingModel,
  slots: readonly Slot[],
  base: PartBase,
  fields: { topOffset: number; gratingType: string; bearingBarAngle: number; imposedLoadKPa?: number },
  panels: ReadonlyArray<PanelDef>,
): { building: BuildingModel; ids: string[] } =>
  place(
    building,
    'grating',
    slots,
    panels.map(
      (panel): Maker<GratingElement> =>
        (id, mark) => ({
          id,
          category: 'grating',
          mark,
          entityIds: [],
          ...base,
          boundary: tidyRing(panel.boundary),
          topOffset: fields.topOffset,
          gratingType: fields.gratingType,
          bearingBarAngle: fields.bearingBarAngle,
          ...(fields.imposedLoadKPa === undefined ? {} : { imposedLoadKPa: fields.imposedLoadKPa }),
          supportIds: panel.supportIds,
        }),
    ),
    (model) => nextMark(model, 'grating'),
  );

export const placeRailings = (
  building: BuildingModel,
  slots: readonly Slot[],
  base: PartBase,
  fields: RailingFields,
  paths: ReadonlyArray<Vec3[]>,
): { building: BuildingModel; ids: string[] } =>
  place(
    building,
    'railing',
    slots,
    paths.map(
      (path): Maker<RailingElement> =>
        (id, mark) => ({
          id,
          category: 'railing',
          mark,
          entityIds: [],
          ...base,
          path,
          height: fields.height,
          kneeRails: fields.kneeRails,
          toePlate: fields.toePlate,
          postProfile: fields.postProfile,
          railProfile: fields.railProfile,
          postSpacingMax: fields.postSpacingMax,
          openings: fields.openings ?? [],
          role: 'guardrail',
        }),
    ),
    (model) => nextMark(model, 'railing'),
  );
