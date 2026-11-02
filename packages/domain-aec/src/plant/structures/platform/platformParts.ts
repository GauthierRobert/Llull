/** Shared plumbing of the platform generators (06 STA M6): part slots that keep ids across regeneration, element makers and outcomes. */

import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import type { BuildingModel, GratingElement, RailingElement, SteelMemberElement } from '@aec/building/types';
import { nextElementId, nextMark, withElement } from '../../../building/model';
import { nextMemberMark } from '../../../industrial/common/memberSupport';
import { round } from '../../../shared/numeric';
import type { StaCode } from '../codes';
import { cumulativeLengths } from '../railing/railingLayout';
import { railingProblem } from '../railing/railingValidate';
import { MAX_POSTS } from './platformGeometry';
import type { RailingSpecFields } from './platformSpec';

/** An id and mark of a part from the previous generation, reused by the next one (references to it stay valid). */
export interface Slot {
  readonly id: string;
  readonly mark: string;
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
      return element?.category === category ? [{ id, mark: element.mark }] : [];
    });
  return { member: of('member'), grating: of('grating'), railing: of('railing') };
}

export interface PlatformFailure {
  readonly ok: false;
  readonly code: StaCode;
  readonly message: string;
  readonly paths: string[];
  readonly ids: string[];
}

export interface PlatformBuilt {
  readonly ok: true;
  readonly building: BuildingModel;
  readonly partIds: string[];
  readonly notes: string[];
}

export type PlatformOutcome = PlatformBuilt | PlatformFailure;

export const failure = (code: StaCode, message: string, paths: string[] = [], ids: string[] = []): PlatformFailure => ({
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
  slots: readonly Slot[],
  makers: ReadonlyArray<Maker<Element>>,
  newMark: (model: BuildingModel) => string,
): { building: BuildingModel; ids: string[] } {
  let next = building;
  const ids = makers.map((make, index) => {
    const slot = slots[index];
    const id = slot?.id ?? nextElementId(next, category);
    next = withElement(next, make(id, slot?.mark ?? newMark(next)));
    return id;
  });
  return { building: next, ids };
}

export interface PartBase {
  readonly levelId: string;
  readonly assemblyId: string;
}

export const placeMembers = (
  building: BuildingModel,
  slots: readonly Slot[],
  base: PartBase,
  role: 'beam' | 'bracket',
  profile: string,
  runs: ReadonlyArray<{ start: Vec3; end: Vec3 }>,
): { building: BuildingModel; ids: string[] } =>
  place(
    building,
    'member',
    slots,
    runs.map(
      (run): Maker<SteelMemberElement> =>
        (id, mark) => ({
          id,
          category: 'member',
          mark,
          entityIds: [],
          ...base,
          role,
          profile,
          start: run.start,
          end: run.end,
          roll: 0,
          material: 'steel',
        }),
    ),
    (model) => nextMemberMark(model, role),
  );

/** Plan points rounded to 4 decimals of the document unit: what is stored, and what the overlap test sees (touching panels of two platforms compare equal). */
export const tidyRing = (ring: ReadonlyArray<Vec2>): Vec2[] => ring.map(([x, y]): Vec2 => [round(x, 4), round(y, 4)]);

/** The first problem of the railing runs of a platform (openings need one run, post count cap, the add_railing validation), or null. */
export function railingRunsProblem(doc: CadDocument, fields: RailingSpecFields, paths: ReadonlyArray<Vec3[]>): PlatformFailure | null {
  if ((fields.openings ?? []).length > 0 && paths.length !== 1)
    return failure('STA_RAIL_OPENING', `railing openings need exactly one railing run, the edges give ${paths.length}`, ['railing']);
  for (const path of paths) {
    const lengths = cumulativeLengths(path);
    if ((lengths[lengths.length - 1] as number) / fields.postSpacingMax > MAX_POSTS)
      return failure(
        'STA_INVALID_GEOMETRY',
        `postSpacingMax gives more than ${MAX_POSTS} posts on one railing: check the unit and the spacing`,
        ['railing'],
      );
    const problem = railingProblem(doc, { ...fields, path, openings: fields.openings ?? [], role: 'guardrail' });
    if (problem !== null) return failure(problem.code, `railing: ${problem.message}`, ['railing']);
  }
  return null;
}

export interface PanelDef {
  readonly boundary: Vec2[];
  readonly supportIds: [string[], string[]];
}

export const placeGratings = (
  building: BuildingModel,
  slots: readonly Slot[],
  base: PartBase,
  fields: { topOffset: number; gratingType: string; bearingBarAngle: number },
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
          supportIds: panel.supportIds,
        }),
    ),
    (model) => nextMark(model, 'grating'),
  );

export const placeRailings = (
  building: BuildingModel,
  slots: readonly Slot[],
  base: PartBase,
  fields: RailingSpecFields,
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
