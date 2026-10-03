/**
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import { getBuilding } from '../model';
import { findProfile } from '../steel/profiles';
import { windCasesOf, type FrameLoads, type LoadCase } from './frameModelTypes';
import { solveCombination } from './frameModelSolve';
import { framesOf } from './frameModelFrames';
import { memberBuckling, sectionResistance, yieldStrength } from './steelDesign';
import {
  type CheckRow,
  SLS_CRANE,
  SLS_SWAY,
  SLS_VERTICAL,
  connectionCheck,
  solveUltimate,
  ultimateCombinations,
} from './frameCheckSolve';

/**
 * Analyses and checks every portal frame of a level: worst row per element over all combinations.
 * @pure
 */
export function checkFrames(
  doc: CadDocument,
  levelId: string,
  loads: FrameLoads,
): {
  rows: CheckRow[];
  frames: number;
  skipped: string[];
  combinations: string[];
  minAlphaCritical: number;
} {
  const building = getBuilding(doc);
  const { frames, skipped } = framesOf(doc, building, levelId, loads);
  const wind = loads.windPressure > 0;
  const crane = frames.some((frame) => frame.craneNodes.length > 0);
  const combinations = ultimateCombinations(wind, crane, windCasesOf(frames));
  const worst = new Map<string, CheckRow>();
  const keep = (row: CheckRow, key = row.elementId): void => {
    const current = worst.get(key);
    if (!current || row.utilisation > current.utilisation) worst.set(key, row);
  };
  const connectionForces = new Map<string, { moment: number; shear: number }[]>();
  let unstable = 0;
  let minAlphaCritical = Infinity;
  for (const frame of frames) {
    const ultimate = combinations.map((combination) => ({
      combination,
      outcome: solveUltimate(frame, combination),
    }));
    if (ultimate.some(({ outcome }) => outcome === null)) {
      skipped.push(`${frame.label} (unstable)`);
      unstable += 1;
      continue;
    }
    let stability: { alpha: number; column: string; combination: string; method: string } | null =
      null;
    for (const { combination, outcome } of ultimate) {
      if (!outcome) continue;
      const { result, amplification } = outcome;
      if (
        outcome.criticalMember !== null &&
        (stability === null || outcome.alphaCritical < stability.alpha)
      ) {
        stability = {
          alpha: outcome.alphaCritical,
          column: outcome.criticalMember,
          combination: combination.name,
          method: outcome.method,
        };
      }
      frame.members.forEach((analysis, index) => {
        const member = building.elements[analysis.elementId];
        const forces = result.members[index];
        if (member?.category !== 'member' || !forces) return;
        const profile = findProfile(member.profile);
        if (!profile) return;
        const fy = yieldStrength(member.material);
        const resistance = sectionResistance(profile, fy);
        const moment = forces.maxMoment * amplification;
        const shear = Math.max(...forces.shear.map(Math.abs));
        const compression = Math.max(0, ...forces.axial.map((value) => -value));
        const section = forces.maxAxial / resistance.axial + moment / resistance.moment;
        const buckling = memberBuckling(profile, fy, compression, moment, analysis.lengths);
        const shearRatio = shear / resistance.shear;
        const governing =
          buckling.utilisation >= section && buckling.utilisation >= shearRatio
            ? `buckling χy ${buckling.chiMajor.toFixed(2)} χz ${buckling.chiMinor.toFixed(2)} χLT ${buckling.chiLateralTorsional.toFixed(2)}`
            : shearRatio > section
              ? 'shear V/Vpl'
              : `N/Npl + M/M${resistance.sectionClass <= 2 ? 'pl' : 'el'}`;
        keep({
          frame: frame.label,
          elementId: member.id,
          mark: member.mark,
          kind: member.role === 'column' ? 'column' : 'rafter',
          combination: combination.name,
          axial: forces.maxAxial / 1000,
          moment: moment / 1e6,
          shear: shear / 1000,
          utilisation: Math.max(section, buckling.utilisation, shearRatio),
          check: `${governing} (${member.profile} class ${resistance.sectionClass}, ${member.material}${amplification > 1 ? `, sway ×${amplification.toFixed(2)}` : ''})`,
        });
      });
      for (const connection of Object.values(building.elements)) {
        if (connection.category !== 'connection') continue;
        const index = frame.members.findIndex(
          (analysis) => analysis.elementId === connection.rafterId,
        );
        const analysis = frame.members[index];
        const forces = result.members[index];
        if (!analysis || !forces) continue;
        // Map the rafter end to the analysis member end (members are analysed left → right).
        const end = (connection.end === 'start') !== analysis.reversed ? 0 : 1;
        const moment = forces.moment[end] * amplification;
        const shear = forces.shear[end];
        const list = connectionForces.get(connection.id) ?? [];
        list.push({ moment, shear });
        connectionForces.set(connection.id, list);
        const verdict = connectionCheck(doc, building, connection, moment, shear);
        if (!verdict) continue;
        keep({
          frame: frame.label,
          elementId: connection.id,
          mark: connection.mark,
          kind: 'connection',
          combination: combination.name,
          axial: Math.abs(forces.axial[end]) / 1000,
          moment: Math.abs(moment) / 1e6,
          shear: Math.abs(shear) / 1000,
          utilisation: verdict.utilisation,
          check: `${connection.kind}: ${verdict.check}`,
        });
      }
    }
    if (stability) {
      minAlphaCritical = Math.min(minAlphaCritical, stability.alpha);
      const column = building.elements[stability.column];
      keep(
        {
          frame: frame.label,
          elementId: stability.column,
          mark: column?.mark ?? stability.column,
          kind: 'stability',
          combination: stability.combination,
          axial: 0,
          moment: 0,
          shear: 0,
          utilisation: 3 / stability.alpha,
          check: `sway stability αcr ${stability.alpha.toFixed(1)} ≥ 3 (${stability.method}; moments amplified when < 10)`,
        },
        `${frame.label}:stability`,
      );
    }
    // SLS (EN 1990 A1.4): rafter deflection under snow, sway under wind / crane alone.
    const vertical = solveCombination(frame, { S: 1 });
    frame.members.forEach((analysis, index) => {
      const deflection = vertical?.members[index]?.maxDisplacement.y;
      if (analysis.role !== 'rafter' || deflection === undefined) return;
      const [a, b] = [frame.nodes[analysis.geometry.a], frame.nodes[analysis.geometry.b]];
      const middle = ((a?.x ?? 0) + (b?.x ?? 0)) / 2;
      const span = frame.spans.find(([x0, x1]) => middle >= x0 && middle <= x1);
      if (!span) return;
      const limit = (span[1] - span[0]) / SLS_VERTICAL;
      const member = building.elements[analysis.elementId];
      keep(
        {
          frame: frame.label,
          elementId: analysis.elementId,
          mark: member?.mark ?? analysis.elementId,
          kind: 'deflection',
          combination: 'SLS S',
          axial: 0,
          moment: 0,
          shear: 0,
          utilisation: deflection / limit,
          check: `vertical ${deflection.toFixed(0)} mm ≤ span/${SLS_VERTICAL} = ${limit.toFixed(0)} mm`,
        },
        `${frame.label}:vertical`,
      );
    });
    const swayCases: {
      name: string;
      factors: Partial<Record<LoadCase, number>>;
      crane: boolean;
    }[] = [];
    if (wind) {
      swayCases.push(
        ...windCasesOf([frame]).map((windCase) => ({
          name: `SLS ${windCase.label}`,
          factors: { [windCase.loadCase]: 1 },
          crane: false,
        })),
      );
    }
    if (frame.craneNodes.length > 0) {
      swayCases.push(
        // EN 1993-6 §7.3: characteristic crane loads without dynamic factors; envelope of group 1 (HT / φ5) and group 5 (HS).
        { name: 'SLS C1k(left)', factors: { CLk: 1 }, crane: true },
        { name: 'SLS C1k(right)', factors: { CRk: 1 }, crane: true },
        { name: 'SLS C5(left)', factors: { CL5: 1 }, crane: true },
        { name: 'SLS C5(right)', factors: { CR5: 1 }, crane: true },
      );
    }
    for (const swayCase of swayCases) {
      const result = solveCombination(frame, swayCase.factors);
      const points = swayCase.crane ? frame.craneNodes : frame.columnTops;
      const ratio = swayCase.crane ? SLS_CRANE : SLS_SWAY;
      for (const point of points) {
        const sway = Math.abs(result?.displacements[point.node]?.[0] ?? 0);
        const limit = point.height / ratio;
        const member = building.elements[point.elementId];
        keep(
          {
            frame: frame.label,
            elementId: point.elementId,
            mark: member?.mark ?? point.elementId,
            kind: 'deflection',
            combination: swayCase.name,
            axial: 0,
            moment: 0,
            shear: 0,
            utilisation: sway / limit,
            check: `${swayCase.crane ? 'rail-level' : 'eaves'} sway ${sway.toFixed(0)} mm ≤ h/${ratio} = ${limit.toFixed(0)} mm`,
          },
          `${frame.label}:sway`,
        );
      }
    }
  }
  const rows = [...worst.values()].map((row) => {
    const forces = connectionForces.get(row.elementId);
    return forces ? { ...row, forces } : row;
  });
  return {
    rows,
    frames: frames.length - unstable,
    skipped,
    combinations: combinations.map((combination) => combination.name),
    minAlphaCritical,
  };
}
