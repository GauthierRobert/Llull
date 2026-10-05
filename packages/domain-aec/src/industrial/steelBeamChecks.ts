/**
 * Beam verification (EN 1993-1-1) of a simply supported floor beam: bending Mc,Rd (§6.2.5) with
 * lateral-torsional buckling Mb,Rd (§6.3.2) unless restrained, shear Vpl,Rd (§6.2.6) with the
 * moment reduction above 0.5 Vpl,Rd (§6.2.8), serviceability deflection under G + Q, and — for the
 * chord of a braced bay — strut compression with bending (§6.3.3).
 * @layer domain-aec
 * @pure
 */

import { lateralTorsionalReduction, memberBuckling, sectionResistance } from './steelDesign';
import type { BeamResult } from './steelFraming';
import { shearReducedMoment } from './steelFrameSection';
import { isBeamShape, type SteelBar } from './steelMemberBars';
import { analysedRow, skippedRow, type CheckLine, type MemberRow } from './steelMemberRows';

export interface StrutForce {
  /** Compression, kN. */
  readonly force: number;
  readonly note: string;
}

const ULS = 'ULS 1.35 G + 1.5 Q';

/**
 * Row of a floor beam.
 * @param deflectionRatio span / limit, e.g. 250 for L/250
 * @failure shape not covered / class 4 -> not analysed
 */
export function checkBeam(
  bar: SteelBar,
  result: BeamResult,
  deflectionRatio: number,
  strut: StrutForce | undefined,
): MemberRow {
  const profile = bar.profile;
  if (!profile) return skippedRow(bar, bar.skipReason ?? 'profile not in the catalogue');
  if (!isBeamShape(profile)) {
    return skippedRow(
      bar,
      `${profile.name}: ${profile.shape} sections as beams (torsion from eccentric load, principal axes) are not covered`,
    );
  }
  const resistance = sectionResistance(profile, bar.fy);
  if (resistance.sectionClass === 4) {
    return skippedRow(
      bar,
      `${profile.name} is class 4 in bending at fy ${bar.fy}: effective-section resistance is not covered`,
    );
  }
  const lengthMm = bar.length;
  const lengthText = `L ${(lengthMm / 1000).toFixed(2)} m`;
  const loads = result.loads;
  const restrained = loads.floorSupport || loads.lineSupport;
  const restraint = loads.floorSupport
    ? 'LTB restrained by the floor'
    : loads.lineSupport
      ? 'LTB restrained by the pipes / trays on the top flange'
      : 'unrestrained over its span';
  const elastic = resistance.sectionClass === 3 ? ', elastic Wel' : '';
  const momentEd = result.uls.maxMoment;
  const shearEd = result.uls.maxShear;
  const shearResistance = resistance.shear / 1000;
  const shearCase = shearReducedMoment(profile, bar.fy, result.uls.shearAtMoment);
  const momentResistance = shearCase.moment / 1e6;
  const reduction = shearCase.reduced
    ? `, reduced for V ${result.uls.shearAtMoment.toFixed(0)} kN (§6.2.8)`
    : '';
  const chiLateral = restrained ? 1 : lateralTorsionalReduction(profile, bar.fy, lengthMm, 1);
  const lines: CheckLine[] = [
    {
      name: `bending (class ${resistance.sectionClass}, ${restrained ? 'LTB restrained' : 'LTB checked'})`,
      utilisation: momentEd / (chiLateral * momentResistance),
      combination: ULS,
      detail: `${profile.name} ${lengthText}, ${restraint}${elastic}: M ${momentEd.toFixed(1)} kNm ≤ ${restrained ? 'Mc,Rd' : `Mb,Rd (χLT ${chiLateral.toFixed(2)})`} ${(chiLateral * momentResistance).toFixed(1)} kNm${reduction}`,
    },
    {
      name: 'shear (§6.2.6)',
      utilisation: shearEd / shearResistance,
      combination: ULS,
      detail: `${profile.name}: V ${shearEd.toFixed(1)} kN ≤ Vpl,Rd ${shearResistance.toFixed(0)} kN`,
    },
  ];
  const limit = lengthMm / deflectionRatio;
  lines.push({
    name: `deflection (L/${deflectionRatio})`,
    utilisation: result.sls.deflection / limit,
    combination: 'SLS G + Q',
    detail: `${profile.name} ${lengthText}: δ ${result.sls.deflection.toFixed(1)} mm ≤ L/${deflectionRatio} = ${limit.toFixed(1)} mm`,
  });
  if (strut && strut.force > 0) {
    const buckling = memberBuckling(profile, bar.fy, strut.force * 1000, momentEd * 1e6, {
      major: lengthMm,
      minor: lengthMm,
      lateralTorsional: restrained ? 1 : lengthMm,
    });
    lines.push({
      name: 'strut compression + bending (§6.3.3)',
      utilisation: buckling.utilisation,
      combination: `${ULS} + notional horizontal force`,
      detail: `${profile.name} ${lengthText}, ${strut.note}: N ${strut.force.toFixed(1)} kN with M ${momentEd.toFixed(1)} kNm, χ ${Math.min(buckling.chiMajor, buckling.chiMinor).toFixed(2)}, χLT ${buckling.chiLateralTorsional.toFixed(2)}`,
    });
  }
  return analysedRow(bar, lines, {
    MEd: momentEd,
    VEd: shearEd,
    deflection: result.sls.deflection,
    reactionStart: result.uls.reactionStart,
    reactionEnd: result.uls.reactionEnd,
    ...(strut ? { NEd: strut.force } : {}),
  });
}
