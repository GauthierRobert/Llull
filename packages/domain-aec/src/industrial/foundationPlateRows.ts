/**
 * Base-plate and anchor check rows (concrete bearing, anchor tension / shear, M+N) of one column.
 * @layer domain-aec
 * @pure
 */

import type { BasePlateElement, BuildingModel } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '../model';
import { findProfile } from '../steel/profiles';
import type { BaseReaction } from './frameModelSolve';
import { anchorBoltResistance, yieldStrength } from './steelDesign';
import { BEARING_STRENGTH, checkPlateMN } from './basePlateMN';
import { type FoundationRow, MAX_UTILISATION } from './foundationModel';
import {
  type Candidate,
  combine,
  hasCase,
  plateDemands,
  ultimateCombinations,
  worst,
} from './foundationCombinations';
import { rowOf } from './foundationRows';

export function plateRows(
  doc: CadDocument,
  building: BuildingModel,
  reaction: BaseReaction,
  columnMark: string,
  footingMark: string,
  plate: BasePlateElement,
  wind: boolean,
): FoundationRow[] {
  const crane = hasCase(reaction, 'CL') || hasCase(reaction, 'CR');
  const toMm = (value: number): number => toMetres(doc, value) * 1000;
  const areaMm2 = toMm(plate.length) * toMm(plate.width);
  const bolts = Math.max(1, plate.boltCount);
  const resistance = anchorBoltResistance(toMm(plate.boltDiameter));
  const [tensionLimit, shearLimit] = [resistance.tension / 1000, resistance.shear / 1000];
  const row = rowOf(columnMark, footingMark, plate.id);
  const rows: FoundationRow[] = [];

  const bearing: Candidate[] = ultimateCombinations(wind, crane, false).map((combination) => {
    const compression = Math.max(0, combine(reaction, combination.factors).v);
    const stress = areaMm2 > 0 ? (compression * 1000) / areaMm2 : 0;
    return {
      value: stress,
      limit: BEARING_STRENGTH,
      combination: combination.name,
      utilisation: Math.min(stress / BEARING_STRENGTH, MAX_UTILISATION),
    };
  });
  const bearingWorst = worst(bearing);
  if (bearingWorst) rows.push(row('plate concrete bearing fjd (C25/30)', bearingWorst, 'N/mm²'));

  const tension: Candidate[] = [];
  const interaction: Candidate[] = [];
  for (const favourable of [true, false]) {
    for (const combination of ultimateCombinations(wind, crane, favourable)) {
      const { v, h } = combine(reaction, combination.factors);
      const perBoltTension = Math.max(0, -v) / bolts;
      const perBoltShear = Math.abs(h) / bolts;
      if (favourable) {
        tension.push({
          value: perBoltTension,
          limit: tensionLimit,
          combination: combination.name,
          utilisation: Math.min(perBoltTension / tensionLimit, MAX_UTILISATION),
        });
      }
      const combined = perBoltShear / shearLimit + perBoltTension / (1.4 * tensionLimit);
      interaction.push({
        value: combined,
        limit: 1,
        combination: combination.name,
        utilisation: Math.min(Math.max(combined, perBoltShear / shearLimit), MAX_UTILISATION),
      });
    }
  }
  const tensionWorst = worst(tension);
  if (wind && tensionWorst) {
    rows.push(
      row(
        `anchor tension Ft,Rd M${Math.round(toMm(plate.boltDiameter))} 8.8`,
        tensionWorst,
        'kN/bolt',
      ),
    );
  }
  const interactionWorst = worst(interaction);
  if (interactionWorst) {
    rows.push(row('anchor shear + tension (Fv/Fv,Rd + Ft/1.4Ft,Rd)', interactionWorst, '-'));
  }
  const column = building.elements[plate.memberId];
  const profile = column?.category === 'member' ? findProfile(column.profile) : undefined;
  if (plate.fixity === 'fixed' && column?.category === 'member' && profile) {
    const geometry = {
      length: toMm(plate.length),
      width: toMm(plate.width),
      thickness: toMm(plate.thickness),
      boltCount: plate.boltCount,
      boltDiameter: toMm(plate.boltDiameter),
      columnDepth: profile.h,
    };
    const fy = yieldStrength(plate.material);
    const moments: Array<Candidate & { detail: string }> = plateDemands(reaction, wind).map(
      (demand) => {
        const verdict = checkPlateMN(geometry, demand.normal, demand.moment, fy);
        return {
          value: verdict.boltTension,
          limit: verdict.boltLimit,
          combination: demand.combination,
          utilisation: verdict.utilisation,
          detail: `N ${demand.normal.toFixed(0)} kN, M ${demand.moment.toFixed(0)} kNm: ${verdict.check}`,
        };
      },
    );
    const momentWorst = moments.reduce<(Candidate & { detail: string }) | null>(
      (best, item) => (best === null || item.utilisation > best.utilisation ? item : best),
      null,
    );
    if (momentWorst) {
      rows.push(row(`base plate M+N (${momentWorst.detail})`, momentWorst, 'kN/bolt'));
    }
  }
  return rows;
}
