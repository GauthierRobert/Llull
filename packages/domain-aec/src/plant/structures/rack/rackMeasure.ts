/** Quantities of a pipe rack (06 STA M7, VC-STA-09), read from the stored members: counts, axis lengths in metres and catalogue masses. */

import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import type { AssemblyElement, BuildingModel, SteelMemberElement } from '@aec/building/types';
import { round } from '../../../shared/numeric';
import { findProfile } from '../../../steel/profiles';
import type { RackMemberKind } from './rackLayout';
import { rackSpecOf } from './rackBuild';
import { linesOf, stationsOf } from './rackLayout';

/** What a rack member is: columns and braces by role, the rigid beams across a bent are tier beams, the pinned ones along the column lines struts. */
export function rackMemberKind(member: SteelMemberElement): RackMemberKind | null {
  if (member.role === 'column') return 'column';
  if (member.role === 'brace') return 'brace';
  if (member.role !== 'beam') return null;
  return member.startJoint === 'rigid' || member.endJoint === 'rigid' ? 'tierBeam' : 'strut';
}

/** True for a member the pipe rack `building` generated as a longitudinal strut (IFC `.STRUT.`). */
export function isRackStrut(building: BuildingModel, member: SteelMemberElement): boolean {
  const owner = member.assemblyId === undefined ? undefined : building.elements[member.assemblyId];
  return owner?.category === 'assembly' && owner.kind === 'pipe_rack' && rackMemberKind(member) === 'strut';
}

export interface RackQuantities {
  readonly id: string;
  readonly mark: string;
  readonly level: string;
  /** Null when the stored parameters no longer parse. */
  readonly bents: number | null;
  readonly columnLines: number | null;
  readonly tiers: number | null;
  readonly columns: number;
  readonly tierBeams: number;
  readonly struts: number;
  readonly braces: number;
  readonly columnLengthM: number;
  readonly tierBeamLengthM: number;
  readonly strutLengthM: number;
  readonly braceLengthM: number;
  /** Columns, tier beams and struts (the VC-STA-09 mass). */
  readonly steelMassKgExBracing: number;
  readonly steelKg: number;
}

/** Totals over the members of `assembly` as they are in `building` (nothing is regenerated). */
export function rackQuantities(doc: CadDocument, building: BuildingModel, assembly: AssemblyElement): RackQuantities {
  const metres = toMetres(doc, 1);
  const count: Record<RackMemberKind, number> = { column: 0, tierBeam: 0, strut: 0, brace: 0 };
  const length: Record<RackMemberKind, number> = { column: 0, tierBeam: 0, strut: 0, brace: 0 };
  const mass: Record<RackMemberKind, number> = { column: 0, tierBeam: 0, strut: 0, brace: 0 };
  for (const id of assembly.partIds) {
    const part = building.elements[id];
    const kind = part?.category === 'member' ? rackMemberKind(part) : null;
    if (part?.category !== 'member' || kind === null) continue;
    const metresLong = Math.hypot(part.end[0] - part.start[0], part.end[1] - part.start[1], part.end[2] - part.start[2]) * metres;
    count[kind] += 1;
    length[kind] += metresLong;
    mass[kind] += metresLong * (findProfile(part.profile)?.massPerMetre ?? 0);
  }
  const spec = rackSpecOf(assembly);
  return {
    id: assembly.id,
    mark: assembly.mark,
    level: building.levels[assembly.levelId]?.name ?? assembly.levelId,
    bents: spec === null ? null : stationsOf(spec.along).length,
    columnLines: spec === null ? null : linesOf(spec.across).length,
    tiers: spec === null ? null : spec.tiers.length,
    columns: count.column,
    tierBeams: count.tierBeam,
    struts: count.strut,
    braces: count.brace,
    columnLengthM: round(length.column, 6),
    tierBeamLengthM: round(length.tierBeam, 6),
    strutLengthM: round(length.strut, 6),
    braceLengthM: round(length.brace, 6),
    steelMassKgExBracing: round(mass.column + mass.tierBeam + mass.strut, 4),
    steelKg: round(mass.column + mass.tierBeam + mass.strut + mass.brace, 4),
  };
}
