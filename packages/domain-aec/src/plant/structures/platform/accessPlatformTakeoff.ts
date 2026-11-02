import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { elementsOf, getBuilding } from '../../../building/model';
import { round } from '../../../shared/numeric';
import { refuse } from '../codes';
import { platformQuantities } from './platformMeasure';
import { staleReason } from './platformStale';

const isPlatform = (assembly: { kind: string }): boolean => assembly.kind !== 'pipe_rack';

/**
 * @affects none: read-only query, answers in `data` { platforms[], totals }
 * @invariant quantities are read from the stored parts; stale = a fresh derivation from the current vessel / beams would differ
 * @failure an id that is not a platform assembly -> STA_UNKNOWN_ELEMENT
 */
export const accessPlatformTakeoff = defineCommand({
  name: 'access_platform_takeoff',
  description:
    'Quantities of the generated platforms (add_access_platform, add_circular_access_platform): per platform the grating panels, plan area (m2) and grating mass, framing members (beams or brackets, count, length, kg), ' +
    'railings (count, length m, posts, kg), steel kg and total kg; circular platforms add innerRadiusMm / outerRadiusMm, innerArcM / outerArcM (true arcs), bracketCount and outerRailPosts (their gratingAreaM2 and railingLengthM are the true sector and arc values; panelAreaM2 is the area of the chord polygons they are modelled with). ' +
    '`stale: true` (with staleReason) means the vessel or the beams changed since the parts were derived: run update_access_platform { assemblyId }. Read-only. Lengths in metres, areas in m2, masses in kg whatever the document units.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({ ids: z.array(z.string()).optional().describe('Platform assembly ids. Default: every platform.') }),
  run: (doc, { ids }): CommandResult => {
    const building = getBuilding(doc);
    const unknown = (ids ?? []).filter((id) => {
      const element = building.elements[id];
      return !(element?.category === 'assembly' && isPlatform(element));
    });
    if (unknown.length > 0)
      return refuse(doc, 'access_platform_takeoff', 'STA_UNKNOWN_ELEMENT', `${unknown.join(', ')} is not a platform assembly`, unknown, [
        'ids',
      ]);
    const wanted = ids === undefined ? undefined : new Set(ids);
    const platforms = elementsOf(building, 'assembly')
      .filter((assembly) => isPlatform(assembly) && (wanted?.has(assembly.id) ?? true))
      .map((assembly) => {
        const reason = staleReason(doc, building, assembly);
        return { ...platformQuantities(doc, building, assembly), stale: reason !== null, staleReason: reason };
      });
    const totals = {
      platforms: platforms.length,
      gratingAreaM2: round(
        platforms.reduce((sum, row) => sum + row.gratingAreaM2, 0),
        4,
      ),
      gratingMassKg: round(
        platforms.reduce((sum, row) => sum + row.gratingMassKg, 0),
        3,
      ),
      railingLengthM: round(
        platforms.reduce((sum, row) => sum + row.railingLengthM, 0),
        4,
      ),
      posts: platforms.reduce((sum, row) => sum + row.posts, 0),
      steelKg: round(
        platforms.reduce((sum, row) => sum + row.steelKg, 0),
        3,
      ),
      totalKg: round(
        platforms.reduce((sum, row) => sum + row.totalKg, 0),
        3,
      ),
    };
    const stale = platforms.filter((row) => row.stale).map((row) => row.id);
    return report(
      doc,
      `access_platform_takeoff: ${platforms.length} platform(s), ${totals.gratingAreaM2} m2 of grating, ${totals.railingLengthM} m of railing, ${totals.steelKg} kg steel, ${totals.totalKg} kg in total` +
        `${stale.length > 0 ? `; stale: ${stale.join(', ')} (run update_access_platform)` : ''}.`,
      { platforms, totals },
    );
  },
});
