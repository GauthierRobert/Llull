/** create_wing (exact lofted wing from airfoil sections, planform or explicit chords) and wing_properties (planform + volume formulas). */

import { colorField, defineCommand, layerIdField, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { nextId } from '@lib/id';
import { DEFAULT_LAYER_ID, type CadDocument, type LoftEntity, type NurbsCurveEntity, type Vec3 } from '@core/model/types';
import type { WingDef, WingSection, WingSegment } from '@core/model/aero';
import { hasClosingEdge, sectionChain, sectionRing } from '@core/geometry/sectionChain';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { briefReport, sig } from '../shared/results';
import { aeroOf, withWing } from './aeroState';
import { refuseAero } from './codes';
import { airfoilMetrics } from './airfoilMetrics';
import { resolvePlanform } from './planform';
import { placeSection, wingStations, type WingStation } from './wingGeometry';
import { wingMetrics } from './wingMetrics';

const MAX_SECTIONS = 40;
const DEFAULT_WING_COLOR = '#9fb4c7';

const planformSchema = z.object({
  semiSpan: z.number().describe('Semi-span (root to tip along y), document units, > 0.').optional(),
  rootChord: z.number().describe('Root chord, document units, > 0.').optional(),
  tipChord: z.number().describe('Tip chord, document units, > 0.').optional(),
  taper: z.number().describe('Taper ratio tip chord / root chord, > 0.').optional(),
  area: z.number().describe('Planform area of the COMPLETE wing (both sides), document units squared, > 0.').optional(),
  aspectRatio: z.number().describe('Aspect ratio (tip-to-tip span)^2 / area of the complete wing, > 0.').optional(),
  sweepDeg: z.number().describe('Sweep (degrees) of the line at chord fraction sweepLocation. Default 0.').optional(),
  sweepLocation: z
    .number()
    .describe('Chord fraction 0..1 where sweepDeg is measured (0 = leading edge, 0.25 = quarter chord). Default 0.')
    .optional(),
  dihedralDeg: z
    .number()
    .describe('Dihedral angle in degrees (panel rises z = dy tan(dihedral); projected span unchanged). Default 0.')
    .optional(),
});

const segmentSchema = z.object({
  sweepDeg: z.number().describe('Sweep (degrees) of this panel at chord fraction sweepLocation. Default 0.').optional(),
  sweepLocation: z.number().describe('Chord fraction 0..1 where sweepDeg is measured. Default 0.').optional(),
  dihedralDeg: z.number().describe('Dihedral (degrees) of this panel. Default 0.').optional(),
});

interface SectionInput {
  readonly airfoilId: string;
  readonly span: number;
  readonly chord?: number | undefined;
  readonly twistDeg?: number | undefined;
}

/** Local frame: positions relative to `origin`. One loft entity (the right half, or the mirrored left half). */
function loftEntity(
  id: string,
  origin: Vec3,
  sections: ReadonlyArray<NurbsCurveData>,
  ruled: boolean,
  color: string,
  layerId: string,
): LoftEntity {
  return { id, kind: 'loft', rings: sections.map(sectionRing), ruled, sections, position: origin, rotation: [0, 0, 0], layerId, color };
}

/**
 * @affects creates doc.aero.wings[id] and 1 loft entity (2 with mirror) whose sections are the exact placed airfoil curves
 * @invariant sections are not resampled (loft v3); trailing edge stays a B-rep edge; span strictly increasing; any 3 independent planform values resolve the rest
 * @failure fewer than 2 sections -> SRF_LOFT_SECTIONS_TOO_FEW; unknown airfoil -> AERO_AIRFOIL_NOT_FOUND; spans not increasing -> AERO_SPAN_NOT_INCREASING; planform values not exactly 3 independent -> AERO_PLANFORM_*; airfoils with different point counts or trailing-edge type -> AERO_SECTIONS_INCOMPATIBLE
 */
export const createWing = defineCommand({
  name: 'create_wing',
  description:
    'Create a lofted wing from airfoil sections (airfoil_from_naca / import_airfoil ids). Wing frame: x aft along the root chord, y to the right ' +
    '(span), z up; lengths in document units. `sections` (2..40, `span` strictly increasing from the root) each give the `airfoilId`, `twistDeg` ' +
    '(nose-up, washout negative, about the chord fraction `twistLocation`, default 0.25) and `chord`. Instead of chords give a `planform`: ' +
    'exactly 3 independent values among semiSpan, rootChord, tipChord, taper, area, aspectRatio (area / aspectRatio refer to the complete ' +
    'two-sided wing) fix a trapezoid whose chord is interpolated linearly along the sections; its sweepDeg / sweepLocation / dihedralDeg apply to ' +
    'every panel unless `segments` (one per span interval: sweepDeg measured at chord fraction sweepLocation, dihedralDeg) says otherwise. The ' +
    'sections are lofted exactly (not resampled) with the trailing edge kept as an edge: `loft` "linear" (default, straight between sections, ' +
    'exact trapezoid) or "smooth". `mirror` adds the left half as a second solid. Every airfoil of a wing needs the same `points` count and ' +
    'trailing-edge type. The result lists the solids (right half first, then the left half): the wing id is the id of the right-half solid, so it ' +
    'also works with mass_properties, boolean and export_*; the exact kernel gets the sections unchanged. Next: wing_properties, mass_properties.',
  params: z.object({
    sections: z
      .array(
        z.object({
          airfoilId: z.string().describe('Airfoil id from airfoil_from_naca / import_airfoil.'),
          span: z.number().describe('Spanwise station y of this section in document units; strictly increasing, 0 at the root.'),
          chord: z.number().describe('Chord length in document units, > 0. Omit when `planform` gives the chord distribution.').optional(),
          twistDeg: z
            .number()
            .describe('Nose-up rotation of the section in degrees about the twist axis (washout is negative). Default 0.')
            .optional(),
        }),
      )
      .describe('2..40 sections from the root to the tip.'),
    planform: planformSchema
      .describe('Optional trapezoidal planform: exactly 3 independent of semiSpan, rootChord, tipChord, taper, area, aspectRatio.')
      .optional(),
    segments: z
      .array(segmentSchema)
      .describe('Optional sweep / dihedral per span interval (sections - 1 entries, or 1 entry for all). Overrides the planform sweep.')
      .optional(),
    twistLocation: z.number().describe('Chord fraction 0..1 of the twist axis. Default 0.25.').optional(),
    loft: z
      .enum(['linear', 'smooth'])
      .describe('"linear" (default): ruled between sections; "smooth": blended through all sections.')
      .optional(),
    mirror: z.boolean().describe('true: also create the mirrored left half (y -> -y) as a second solid. Default false.').optional(),
    tip: z.enum(['flat']).describe('Tip closure: only "flat" (planar cap) is built.').optional(),
    origin: vec3('Position [x, y, z] of the wing root leading edge in document units. Default [0, 0, 0].').optional(),
    color: colorField(DEFAULT_WING_COLOR),
    layerId: layerIdField(),
  }),
  run: (doc, params): CommandResult => {
    const { sections, planform, twistLocation = 0.25, loft = 'linear', mirror = false, origin = [0, 0, 0] } = params;
    const refuse = (code: string, message: string, path: string, ids: string[] = []): CommandResult =>
      refuseAero(doc, 'create_wing', code, message, ids, [`params.${path}`]);
    if (sections.length < 2)
      return refuse('SRF_LOFT_SECTIONS_TOO_FEW', `a wing needs at least 2 sections (got ${sections.length})`, 'sections');
    if (sections.length > MAX_SECTIONS)
      return refuse('AERO_PARAM_INVALID', `at most ${MAX_SECTIONS} sections (got ${sections.length})`, 'sections');
    if (!(twistLocation >= 0 && twistLocation <= 1))
      return refuse('AERO_PARAM_INVALID', 'twistLocation must be within 0..1', 'twistLocation');
    const increasing = sections.findIndex((section, i) => i > 0 && !(section.span > (sections[i - 1] as SectionInput).span));
    if (increasing > 0)
      return refuse(
        'AERO_SPAN_NOT_INCREASING',
        `section ${increasing} span ${sections[increasing]?.span} is not above section ${increasing - 1}`,
        `sections.${increasing}.span`,
      );
    const airfoils = aeroOf(doc).airfoils;
    const missing = sections.findIndex((section) => airfoils[section.airfoilId] === undefined);
    if (missing >= 0)
      return refuse('AERO_AIRFOIL_NOT_FOUND', `no airfoil "${sections[missing]?.airfoilId}"`, `sections.${missing}.airfoilId`, [
        sections[missing]?.airfoilId ?? '',
      ]);
    let chords: number[];
    let segmentDefaults: WingSegment = { sweepDeg: 0, sweepLocation: 0, dihedralDeg: 0 };
    if (planform !== undefined) {
      const resolved = resolvePlanform(planform);
      if ('code' in resolved) return refuse(resolved.code, resolved.message, 'planform');
      const [first, last] = [sections[0] as SectionInput, sections[sections.length - 1] as SectionInput];
      if (Math.abs(first.span) > 1e-9 || Math.abs(last.span - resolved.semiSpan) > 1e-9 * Math.max(1, resolved.semiSpan))
        return refuse(
          'AERO_PARAM_INVALID',
          `with a planform the first section must be at span 0 and the last at the semi-span ${resolved.semiSpan} (got ${first.span} and ${last.span})`,
          'sections',
        );
      chords = sections.map(
        (section) => resolved.rootChord + ((resolved.tipChord - resolved.rootChord) * section.span) / resolved.semiSpan,
      );
      segmentDefaults = {
        sweepDeg: planform.sweepDeg ?? 0,
        sweepLocation: planform.sweepLocation ?? 0,
        dihedralDeg: planform.dihedralDeg ?? 0,
      };
    } else {
      const noChord = sections.findIndex((section) => !((section.chord ?? 0) > 0));
      if (noChord >= 0)
        return refuse('AERO_PARAM_INVALID', `section ${noChord} needs chord > 0 (or give a planform)`, `sections.${noChord}.chord`);
      chords = sections.map((section) => section.chord as number);
    }
    if (params.segments !== undefined && params.segments.length !== 1 && params.segments.length !== sections.length - 1)
      return refuse(
        'AERO_PARAM_INVALID',
        `segments needs ${sections.length - 1} entries (or 1 for all), got ${params.segments.length}`,
        'segments',
      );
    const segments: WingSegment[] = Array.from({ length: sections.length - 1 }, (_, i) => {
      const given = params.segments?.[params.segments.length === 1 ? 0 : i];
      return {
        sweepDeg: given === undefined ? segmentDefaults.sweepDeg : (given.sweepDeg ?? 0),
        sweepLocation: given === undefined ? segmentDefaults.sweepLocation : (given.sweepLocation ?? 0),
        dihedralDeg: given === undefined ? segmentDefaults.dihedralDeg : (given.dihedralDeg ?? 0),
      };
    });
    const bad = segments.findIndex(
      (segment) =>
        !(segment.sweepLocation >= 0 && segment.sweepLocation <= 1) ||
        Math.abs(segment.sweepDeg) >= 89 ||
        Math.abs(segment.dihedralDeg) >= 89,
    );
    if (bad >= 0)
      return refuse(
        'AERO_PARAM_INVALID',
        `segment ${bad}: sweepLocation must be within 0..1 and sweep / dihedral within +-89 degrees`,
        'segments',
      );
    const defs: WingSection[] = sections.map((section, i) => ({
      airfoilId: section.airfoilId,
      span: section.span,
      chord: chords[i] as number,
      twistDeg: section.twistDeg ?? 0,
    }));
    const stations = wingStations(defs, segments);
    const curves = defs.map((section) => {
      const entity = doc.entities[(airfoils[section.airfoilId] as { entityId: string }).entityId];
      return entity?.kind === 'nurbs_curve' ? (entity as NurbsCurveEntity).curve : null;
    });
    const gone = curves.findIndex((curve) => curve === null);
    if (gone >= 0)
      return refuse('AERO_AIRFOIL_NOT_FOUND', `the curve of airfoil "${defs[gone]?.airfoilId}" was deleted`, `sections.${gone}.airfoilId`, [
        defs[gone]?.airfoilId ?? '',
      ]);
    const unit = curves as NurbsCurveData[];
    const reference = unit[0] as NurbsCurveData;
    const incompatible = unit.findIndex((curve) => {
      const [chain, base] = [sectionChain(curve), sectionChain(reference)];
      return chain === null || base === null || chain.length !== base.length || hasClosingEdge(curve) !== hasClosingEdge(reference);
    });
    if (incompatible > 0)
      return refuse(
        'AERO_SECTIONS_INCOMPATIBLE',
        `section ${incompatible} (${defs[incompatible]?.airfoilId}) differs from section 0 in point count or trailing-edge type`,
        `sections.${incompatible}.airfoilId`,
      );
    const color = params.color ?? DEFAULT_WING_COLOR;
    const layerId = params.layerId !== undefined && doc.layers[params.layerId] !== undefined ? params.layerId : DEFAULT_LAYER_ID;
    const ruled = loft === 'linear';
    const halves = [false, ...(mirror ? [true] : [])].map((left) =>
      loftEntity(
        nextId('loft'),
        origin,
        unit.map((curve, i) => placeSection(curve, stations[i] as WingStation, twistLocation, left)),
        ruled,
        color,
        layerId,
      ),
    );
    const wingId = (halves[0] as LoftEntity).id;
    const def: WingDef = {
      id: wingId,
      origin,
      sections: defs,
      segments,
      twistLocation,
      loft,
      mirror,
      entityIds: halves.map((half) => half.id),
    };
    const next: CadDocument = withWing(
      {
        ...doc,
        entities: { ...doc.entities, ...Object.fromEntries(halves.map((half) => [half.id, half])) },
        order: [...doc.order, ...halves.map((half) => half.id)],
      },
      def,
    );
    return changed(
      next,
      `create_wing: created wing "${wingId}" = its right-half loft solid (${defs.length} sections, ${loft} loft${mirror ? `, left half ${def.entityIds[1]}` : ''}); ` +
        `semi-span ${sig(stations[stations.length - 1]!.span)} ${doc.units}, root chord ${sig(chords[0] as number)}, tip chord ${sig(chords[chords.length - 1] as number)}.`,
      [...def.entityIds],
    );
  },
});

/**
 * @affects none; data = { id, semiSpan, span, areaPerSide, areaRef, aspectRatio, taper, mac, yMac, xLeMac, sweepLeDeg, sweepC4Deg, sweepTeDeg, volumePerSide, volume, units, unverified, provenance }
 * @failure unknown wing -> AERO_WING_NOT_FOUND; an airfoil curve deleted -> AERO_AIRFOIL_NOT_FOUND
 */
export const wingProperties = defineCommand({
  name: 'wing_properties',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only planform and volume figures of a wing made with create_wing, from its definition (no kernel needed): semi-span, planform area per ' +
    'side and of the complete symmetric wing (areaRef), aspect ratio (2 * semi-span)^2 / areaRef, taper ratio, mean aerodynamic chord MAC with its ' +
    'spanwise position yMac and leading-edge x xLeMac, leading-edge / quarter-chord / trailing-edge sweep root to tip in degrees, and the volume ' +
    'from the section areas (exact for one airfoil along the wing, an estimate when airfoils differ). Areas and volumes are in document units ' +
    'squared / cubed; angles in degrees. `unverified` is true when an airfoil input has no pinned source.',
  params: z.object({ id: z.string().describe('Wing id (affected[0] of create_wing).') }),
  run: (doc, { id }): CommandResult => {
    const wing = aeroOf(doc).wings[id];
    if (wing === undefined) return refuseAero(doc, 'wing_properties', 'AERO_WING_NOT_FOUND', `no wing "${id}"`, [id], ['params.id']);
    const unitAreas: number[] = [];
    let unverified = false;
    for (const section of wing.sections) {
      const airfoil = aeroOf(doc).airfoils[section.airfoilId];
      const entity = airfoil === undefined ? undefined : doc.entities[airfoil.entityId];
      const metrics = entity?.kind === 'nurbs_curve' ? airfoilMetrics(entity.curve) : null;
      if (airfoil === undefined || metrics === null || typeof metrics === 'string')
        return refuseAero(
          doc,
          'wing_properties',
          'AERO_AIRFOIL_NOT_FOUND',
          `airfoil "${section.airfoilId}" of wing "${id}" is missing or not a section`,
          [id, section.airfoilId],
          ['params.id'],
        );
      unitAreas.push(metrics.area);
      unverified = unverified || !airfoil.provenance.verified;
    }
    const m = wingMetrics(wingStations(wing.sections, wing.segments), unitAreas);
    const areaRef = 2 * m.areaPerSide;
    const data = {
      id,
      semiSpan: sig(m.semiSpan),
      span: sig(2 * m.semiSpan),
      mirror: wing.mirror,
      areaPerSide: sig(m.areaPerSide),
      areaRef: sig(areaRef),
      aspectRatio: sig((4 * m.semiSpan * m.semiSpan) / areaRef),
      taper: sig(m.taper),
      mac: sig(m.mac),
      yMac: sig(m.yMac),
      xLeMac: sig(m.xLeMac),
      sweepLeDeg: sig(m.sweepLeDeg),
      sweepC4Deg: sig(m.sweepC4Deg),
      sweepTeDeg: sig(m.sweepTeDeg),
      volumePerSide: sig(m.volumePerSide),
      volume: sig(m.volumePerSide * (wing.mirror ? 2 : 1)),
      unit: doc.units,
      areaUnit: `${doc.units}^2`,
      volumeUnit: `${doc.units}^3`,
      angleUnit: 'deg',
      unverified,
      provenance: {
        method: 'trapezoid planform formulas; volume = integral of (section area x chord^2) along the span',
        reference: 'Raymer, Aircraft Design: A Conceptual Approach, ch. 7 (MAC); Abbott & von Doenhoff for the sections',
        inputs: { id },
      },
    };
    return briefReport(
      doc,
      `wing_properties ${id}: semi-span ${data.semiSpan} ${doc.units}, area ${data.areaRef} ${doc.units}^2 (complete wing), AR ${data.aspectRatio}, taper ${data.taper}, ` +
        `MAC ${data.mac} at y ${data.yMac}, sweep LE ${data.sweepLeDeg} / c4 ${data.sweepC4Deg} deg, volume ${data.volume} ${doc.units}^3${unverified ? ' (UNVERIFIED airfoil input)' : ''}.`,
      data,
    );
  },
});
