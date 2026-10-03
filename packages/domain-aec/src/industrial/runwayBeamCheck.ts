/**
 * runwayCheck: runwayBeamCheck.
 * @layer domain-aec
 */

import type { SteelMemberElement } from '@core/model/building';
import { findProfile, sectionProperties } from '../steel/profiles';
import { craneActions, CRANE_FACTORS, type CraneModel } from './frameModelTypes';
import { lateralTorsionalReduction, sectionResistance, yieldStrength } from './steelDesign';
import {
  BUFFER_SPEED_RATIO,
  CLASSES,
  type CraneClass,
  DEFLECTION_RATIO,
  DYNAMIC_TEST_FACTOR,
  FATIGUE_CATEGORY,
  FATIGUE_PHI,
  GAMMA_BUFFER,
  GAMMA_M0,
  GAMMA_MF,
  GAMMA_TEST,
  GAMMA_ULS,
  type GirderType,
  LOCAL_CATEGORIES,
  LOCAL_LAMBDA_FACTOR,
  PHI7,
  RAILS,
  RAIL_WEAR_INERTIA_FACTOR,
  type RailSize,
  type RunwayCheckRow,
  STATIC_TEST_FACTOR,
  bufferForce,
  wheelDeflection,
  wheelMoment,
  wheelShear,
} from './runwayCheckModel';
import { round } from '../numeric';

export function checkBeam(
  beam: SteelMemberElement,
  span: number,
  capacity: number,
  craneSpan: number,
  model: CraneModel,
  craneClass: CraneClass,
  railSize: RailSize,
  girder: GirderType,
  buffer: { readonly travelSpeed: number; readonly stiffness: number },
): RunwayCheckRow[] {
  const profile = findProfile(beam.profile);
  if (!profile || !(span > 0)) return [];
  const fy = yieldStrength(beam.material);
  const section = sectionProperties(profile);
  const resistance = sectionResistance(profile, fy);
  const wheelBase = model.wheelBase ?? 3000;
  const actions = craneActions(capacity, craneSpan, model);
  const wheel = actions.group1.max / 2;
  // Lateral rail force: envelope of the transverse drive forces HT (group 1) and skewing HS (group 5).
  const lateralWheel =
    Math.max(
      actions.group1.transverseMax,
      actions.group1.transverseMin,
      actions.group5.skewMax,
      actions.group5.skewMin,
    ) / 2;
  const longitudinal = GAMMA_ULS * actions.group1.longitudinal;
  const isI = profile.shape === 'I';
  const row = (
    kind: RunwayCheckRow['kind'],
    check: string,
    value: number,
    limit: number,
    unit: string,
  ): RunwayCheckRow => ({
    elementId: beam.id,
    mark: beam.mark,
    profile: profile.name,
    span: round(span, 0),
    kind,
    check,
    value: round(value),
    limit: round(limit),
    unit,
    utilisation: round(value / limit, 3),
  });

  const rail = RAILS[railSize];
  const distributed = (((profile.massPerMetre + rail.mass) * 9.81) / 1000) * GAMMA_ULS;
  const momentY = GAMMA_ULS * wheelMoment(wheel, wheelBase, span) + (distributed * span ** 2) / 8;
  const shear = GAMMA_ULS * wheelShear(wheel, wheelBase, span) + (distributed * span) / 2;
  const momentZ = GAMMA_ULS * wheelMoment(lateralWheel, wheelBase, span);
  const flangeResistanceZ = isI
    ? (profile.tf * profile.b ** 2 * fy) / 4
    : (section.minorInertia / (profile.b / 2) / 2) * fy;

  // C1 = 1.13 (point loads), 0.85 for the destabilising top-flange load.
  const chi = lateralTorsionalReduction(profile, fy, span, 0.85 * 1.13);

  const characteristic = actions.staticMax / 2;
  const verticalDeflection = wheelDeflection(characteristic, wheelBase, span, section.inertia);
  const lateralDeflection = wheelDeflection(
    lateralWheel,
    wheelBase,
    span,
    section.minorInertia / 2,
  );
  const stressRange =
    wheelMoment(characteristic, wheelBase, span) / (section.inertia / (profile.h / 2));
  const equivalentRange = CLASSES[craneClass] * FATIGUE_PHI * stressRange;

  // EN 1993-6 §5.7.1, rail not rigidly fixed (Tab. 5.1 case b): Irf = Ir,worn + If,eff, separate inertias.
  const effectiveWidth = Math.min(profile.b, rail.foot + rail.height + profile.tf);
  const flangeInertia = (effectiveWidth * profile.tf ** 3) / 12;
  const railFlangeInertia = RAIL_WEAR_INERTIA_FACTOR * rail.inertia + flangeInertia;
  const loadedLength = 3.25 * (railFlangeInertia / profile.tw) ** (1 / 3);
  const localStress = (GAMMA_ULS * wheel) / (loadedLength * profile.tw);
  const localRange = (characteristic * FATIGUE_PHI) / (loadedLength * profile.tw);
  const localLambda = CLASSES[craneClass] * LOCAL_LAMBDA_FACTOR;
  const localCategory = LOCAL_CATEGORIES[girder];

  // Group 7 (§2.11.1): HB,1 shared by nr rails, accidental γ = 1.0, welded stop on the top flange,
  // axial + bending at the beam centroid (eccentricity h/2 + rail height).
  const bufferPerRail =
    (GAMMA_BUFFER * bufferForce(actions.selfWeight, buffer.travelSpeed, buffer.stiffness)) /
    CRANE_FACTORS.rails;
  const stopResistance = profile.b * profile.tf * fy;
  const eccentricity = profile.h / 2 + rail.height;
  const bufferUtilisation =
    bufferPerRail / resistance.axial + (bufferPerRail * eccentricity) / resistance.moment;

  // Group 8 (§2.10): Qtest = max(φ6 · 1.1 Qh, 1.25 Qh), φ6 = 0.5 (1 + φ2), γ = 1.1.
  const hoistLoad = capacity * 9810;
  const phi6 = 0.5 * (1 + actions.phi2);
  const testFactor = Math.max(phi6 * DYNAMIC_TEST_FACTOR, STATIC_TEST_FACTOR);
  const approach = Math.min(Math.max(0, (model.minHookApproach ?? 1) * 1000), craneSpan);
  const testRail =
    0.4 * actions.selfWeight +
    (0.2 * actions.selfWeight + testFactor * hoistLoad) * ((craneSpan - approach) / craneSpan);
  const testDistributed = (((profile.massPerMetre + rail.mass) * 9.81) / 1000) * GAMMA_TEST;
  const testMoment =
    GAMMA_TEST * wheelMoment(testRail / 2, wheelBase, span) + (testDistributed * span ** 2) / 8;

  return [
    row(
      'strength',
      'bending My/Mpl,y + Mz/Mpl,z(top flange)',
      momentY / resistance.moment + momentZ / flangeResistanceZ,
      1,
      '-',
    ),
    row('strength', 'shear V/Vpl', shear, resistance.shear, 'N'),
    row(
      'strength',
      `longitudinal stop force φ5 K/nr (axial N/Npl, HL ${round(actions.group1.longitudinal / 1000, 1)} kN, φ2 ${round(actions.phi2, 3)})`,
      longitudinal,
      resistance.axial,
      'N',
    ),
    row(
      'strength',
      `buffer stop HB,1/nr (group 7, φ7 ${PHI7}, v1 ${round(BUFFER_SPEED_RATIO * buffer.travelSpeed, 3)} m/s, SB ${buffer.stiffness} kN/m, γ ${GAMMA_BUFFER}) vs top-flange weld transfer b tf fy`,
      bufferPerRail,
      stopResistance,
      'N',
    ),
    row(
      'strength',
      `buffer end-bay N/Npl + N e/Mpl,y (group 7, e ${round(eccentricity, 0)} mm)`,
      bufferUtilisation,
      1,
      '-',
    ),
    row(
      'strength',
      `test load My/Mpl,y (group 8, γ ${GAMMA_TEST}, Qtest ${round(testFactor, 3)} Qh, φ6 ${round(phi6, 3)})`,
      testMoment / resistance.moment,
      1,
      '-',
    ),
    row(
      'ltb',
      isI ? 'My/(χLT Mpl,y) + Mz/Mpl,z(top flange)' : 'not susceptible (non-I section)',
      momentY / (chi * resistance.moment) + momentZ / flangeResistanceZ,
      1,
      '-',
    ),
    row(
      'deflection',
      'vertical δz (crane, L/600)',
      verticalDeflection,
      span / DEFLECTION_RATIO,
      'mm',
    ),
    row('deflection', 'lateral δy (L/600)', lateralDeflection, span / DEFLECTION_RATIO, 'mm'),
    row(
      'fatigue',
      `γFf·ΔσE2 (λ=${CLASSES[craneClass]}, ${craneClass}) vs Δσc ${FATIGUE_CATEGORY}/γMf`,
      equivalentRange,
      FATIGUE_CATEGORY / GAMMA_MF,
      'N/mm²',
    ),
    row(
      'local',
      `local web stress σoz (EN 1993-6 §5.7.1) leff ${round(loadedLength, 0)} mm, rail ${railSize}`,
      localStress,
      fy / GAMMA_M0,
      'N/mm²',
    ),
    row(
      'local',
      `local web fatigue (cat ${localCategory}) λ=${round(localLambda, 3)}`,
      localLambda * localRange,
      localCategory / GAMMA_MF,
      'N/mm²',
    ),
  ];
}
