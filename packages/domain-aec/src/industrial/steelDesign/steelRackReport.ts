/** Pipe racks in check_steel_members (06 STA M7): per generated rack the verdict of its members, the pipe weight its steel carries and whether it is stale. */

import type { CadDocument } from '@core/model/types';
import { assemblyStaleReason } from '../../building/assemblyHandlers';
import { elementsOf, getBuilding } from '../../building/model';
import { round } from '../../shared/numeric';
import { highestUtilisation } from '../common/utilisation';
import type { LineRunReport } from './steelLineLoads';
import type { MemberRow } from './steelMemberRows';

export interface RackReport {
  readonly assemblyId: string;
  readonly mark: string;
  readonly levelId: string;
  readonly members: number;
  readonly analysed: number;
  readonly notAnalysed: string[];
  readonly failing: string[];
  readonly maxUtilisation: number;
  readonly maxUtilisationMark: string | null;
  /** Weight of the pipes and trays (steel wall + contents) that bear on the rack's members, kN. */
  readonly pipeLoadKn: number;
  readonly steelMassKg: number;
  /** A fresh derivation from the stored parameters would differ from the members in the model. */
  readonly stale: boolean;
  readonly staleReason: string | null;
}

/** One report per pipe rack assembly of the building. */
export function rackReports(
  doc: CadDocument,
  rows: ReadonlyArray<MemberRow>,
  lines: ReadonlyArray<LineRunReport>,
  massKg: ReadonlyMap<string, number>,
): RackReport[] {
  const building = getBuilding(doc);
  return elementsOf(building, 'assembly')
    .filter((assembly) => assembly.kind === 'pipe_rack')
    .map((assembly) => {
      const parts = new Set(assembly.partIds);
      const own = rows.filter((row) => parts.has(row.id));
      const analysed = own.filter((row) => row.analysed);
      const worst = highestUtilisation(analysed);
      const reason = assemblyStaleReason(doc, building, assembly);
      return {
        assemblyId: assembly.id,
        mark: assembly.mark,
        levelId: assembly.levelId,
        members: own.length,
        analysed: analysed.length,
        notAnalysed: own.filter((row) => !row.analysed).map((row) => row.id),
        failing: analysed.filter((row) => !row.ok).map((row) => row.id),
        maxUtilisation: worst?.utilisation ?? 0,
        maxUtilisationMark: worst?.mark ?? null,
        pipeLoadKn: round(
          lines.reduce(
            (sum, run) => sum + run.bearers.filter((bearer) => parts.has(bearer.memberId)).reduce((total, { kn }) => total + kn, 0),
            0,
          ),
          3,
        ),
        steelMassKg: round(
          assembly.partIds.reduce((sum, id) => sum + (massKg.get(id) ?? 0), 0),
          1,
        ),
        stale: reason !== null,
        staleReason: reason,
      };
    });
}
