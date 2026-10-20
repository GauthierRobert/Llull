/** import_openvsp_wing: a wing of an OpenVSP `.vsp3` file rebuilt as llull airfoils + wing (planform, sweep, dihedral, twist, NACA 4-series sections). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { Vec3 } from '@core/model/types';
import { briefNumbers, sig } from '../shared/results';
import { refuseAero } from './codes';
import { findAll, parameter, parseXml, type XmlNode } from './vspXml';

interface Segment {
  readonly span: number;
  readonly rootChord: number;
  readonly tipChord: number;
  readonly sweepDeg: number;
  readonly sweepLocation: number;
  readonly dihedralDeg: number;
  readonly twistDeg: number;
}

const groupNamed = (node: XmlNode, pattern: RegExp): XmlNode[] =>
  findAll(node, (n) => n.tag === 'Group' && pattern.test(n.attrs['Name'] ?? ''));

/** The Geom elements that carry wing sections (an `XSec_n` group with Span, Root_Chord and Tip_Chord) with their names. */
function wingGeoms(root: XmlNode): Array<{ node: XmlNode; name: string }> {
  return findAll(root, (n) => n.tag === 'Geom')
    .filter((geom) =>
      groupNamed(geom, /^XSec_\d+$/).some((group) => parameter(group, 'Root_Chord') !== null && parameter(group, 'Tip_Chord') !== null),
    )
    .map((geom, index) => {
      const [name] = findAll(geom, (n) => n.tag === 'Name');
      return { node: geom, name: name?.text.trim() || `wing ${index + 1}` };
    });
}

/** NACA 4-digit designation of an OpenVSP four-series curve (Camber, CamberLoc, ThickChord as fractions), or null when it has no such parameters. */
function fourSeries(curve: XmlNode): string | null {
  const [camber, location, thickness] = [parameter(curve, 'Camber'), parameter(curve, 'CamberLoc'), parameter(curve, 'ThickChord')];
  if (camber === null || location === null || thickness === null) return null;
  const [m, p, tt] = [Math.round(camber * 100), Math.round(location * 10), Math.round(thickness * 100)];
  if (m < 0 || m > 9 || p < 0 || p > 9 || tt < 1 || tt > 99) return null;
  return `${m}${m === 0 ? 0 : p}${String(tt).padStart(2, '0')}`;
}

/**
 * @affects creates the airfoil curves, the wing (doc.aero.wings) and its lofts through airfoil_from_naca and create_wing
 * @invariant planform values are taken from the file as stored (Span, Root_Chord, Tip_Chord, Sweep at Sweep_Location, Dihedral, Twist), scaled by lengthScale
 * @failure text that is not XML -> AERO_VSP_PARSE; no wing in the file / unknown geomName -> AERO_VSP_NO_WING; a section airfoil that is not NACA 4-series without fallbackNaca -> AERO_VSP_UNSUPPORTED (lists them)
 */
export const importOpenvspWing = defineCommand({
  name: 'import_openvsp_wing',
  description:
    'Import a wing from the text of an OpenVSP `.vsp3` file (XML; read the file and pass its text). ' +
    'The wing geometry is rebuilt with create_wing: each section of the file (`XSec_n` parameters Span, Root_Chord, Tip_Chord, Sweep at ' +
    'Sweep_Location, Dihedral, Twist at Twist_Location) becomes a span station with its chord, sweep, dihedral and twist, the position comes from ' +
    'X / Y / Z_Rel_Location and the XZ symmetry flag makes `mirror`. Airfoils: NACA 4-series section curves (Camber, CamberLoc, ThickChord) are ' +
    'recreated with airfoil_from_naca; any other section type (an AF / Selig file airfoil, a conic, ...) is REFUSED with the list of such sections unless ' +
    '`fallbackNaca` names the NACA designation to put there instead (the summary and `data.substituted` then say so and `unverified` is true). Values ' +
    "are used in the file's own length unit: set_units to match first, or give `lengthScale` (e.g. 25.4 for inches into mm). `geomName` picks one " +
    'wing of a multi-wing file (default: the first). Notes: the OpenVSP `Span` of a section is used as its projected span; the real TR1208.vsp3 ' +
    'of the OpenVSP examples was not available when this was written (offline), so the XML layout is the documented one and untested on that file.',
  params: z.object({
    text: z.string().describe('The full text of the .vsp3 file (OpenVSP XML).'),
    geomName: z.string().describe('Name of the wing geometry to import. Default: the first wing of the file.').optional(),
    fallbackNaca: z
      .string()
      .describe(
        'NACA designation ("0012", "2412", "23012") used for sections whose airfoil is not a NACA 4-series curve. Default: refuse such files.',
      )
      .optional(),
    lengthScale: z
      .number()
      .describe('Factor applied to every length of the file (> 0). Default 1: the file unit is the document unit.')
      .optional(),
    mirror: z
      .boolean()
      .describe('Override the symmetry of the file: true adds the left half. Default: from the file (XZ symmetry flag, else true).')
      .optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { text, geomName, fallbackNaca, lengthScale = 1 } = params;
    const refuse = (code: string, message: string, path = 'text'): CommandResult =>
      refuseAero(doc, 'import_openvsp_wing', code, message, [], [`params.${path}`]);
    if (!(lengthScale > 0) || !Number.isFinite(lengthScale))
      return refuse('AERO_PARAM_INVALID', 'lengthScale must be a finite number > 0', 'lengthScale');
    if (text.length > 20_000_000) return refuse('AERO_VSP_PARSE', 'the file is larger than 20 MB');
    const tree = parseXml(text);
    if (typeof tree === 'string') return refuse('AERO_VSP_PARSE', `not an XML document: ${tree}`);
    const wings = wingGeoms(tree);
    const chosen = geomName === undefined ? wings[0] : wings.find((wing) => wing.name === geomName);
    if (chosen === undefined)
      return refuse(
        'AERO_VSP_NO_WING',
        wings.length === 0
          ? 'no wing (XSec_n group with Root_Chord and Tip_Chord) found in the file'
          : `no wing named "${geomName}"; the file has: ${wings.map((w) => w.name).join(', ')}`,
        geomName === undefined ? 'text' : 'geomName',
      );
    const groups = groupNamed(chosen.node, /^XSec_\d+$/)
      .map((group) => ({ group, index: Number((group.attrs['Name'] ?? '').slice(5)) }))
      .filter(
        ({ group }) =>
          parameter(group, 'Root_Chord') !== null && parameter(group, 'Tip_Chord') !== null && parameter(group, 'Span') !== null,
      )
      .sort((a, b) => a.index - b.index);
    const segments: Segment[] = groups.map(({ group }) => ({
      span: (parameter(group, 'Span') as number) * lengthScale,
      rootChord: (parameter(group, 'Root_Chord') as number) * lengthScale,
      tipChord: (parameter(group, 'Tip_Chord') as number) * lengthScale,
      sweepDeg: parameter(group, 'Sweep') ?? 0,
      sweepLocation: parameter(group, 'Sweep_Location') ?? 0.25,
      dihedralDeg: parameter(group, 'Dihedral') ?? 0,
      twistDeg: parameter(group, 'Twist') ?? 0,
    }));
    if (segments.length === 0 || segments.some((s) => !(s.span > 0 && s.rootChord > 0 && s.tipChord > 0)))
      return refuse('AERO_VSP_NO_WING', 'the wing sections need Span, Root_Chord and Tip_Chord > 0');
    const curves = findAll(chosen.node, (n) => n.tag === 'XSecCurve');
    const designations = Array.from({ length: segments.length + 1 }, (_, k) => {
      const curve = curves[k] ?? curves[curves.length - 1];
      return curve === undefined ? null : fourSeries(curve);
    });
    const unsupported = designations.flatMap((designation, k) => (designation === null ? [k] : []));
    if (unsupported.length > 0 && fallbackNaca === undefined)
      return refuse(
        'AERO_VSP_UNSUPPORTED',
        `section(s) ${unsupported.join(', ')} have an airfoil that is not a NACA 4-series curve (AF / file / other type): give fallbackNaca to substitute one, or import the airfoil with import_airfoil and build the wing with create_wing`,
      );
    let current = doc;
    const created: string[] = [];
    const airfoilIds = new Map<string, string>();
    for (const designation of designations.map((d) => d ?? (fallbackNaca as string))) {
      if (airfoilIds.has(designation)) continue;
      const made = execute(current, 'airfoil_from_naca', { designation }, ctx);
      if (made.affected.length === 0) return refuse('AERO_PARAM_INVALID', `airfoil ${designation}: ${made.summary}`, 'fallbackNaca');
      current = made.document;
      created.push(...made.affected);
      airfoilIds.set(designation, made.affected[0] as string);
    }
    const [rootGroup] = groupNamed(chosen.node, /^XSec_0$/);
    const rootTwist = rootGroup === undefined ? 0 : (parameter(rootGroup, 'Twist') ?? 0);
    const stations: number[] = [0];
    for (const segment of segments) stations.push((stations[stations.length - 1] as number) + segment.span);
    const sections = stations.map((span, k) => ({
      airfoilId: airfoilIds.get(designations[k] ?? (fallbackNaca as string)) as string,
      span,
      chord: k === 0 ? (segments[0] as Segment).rootChord : (segments[k - 1] as Segment).tipChord,
      twistDeg: k === 0 ? rootTwist : (segments[k - 1] as Segment).twistDeg,
    }));
    const symmetry = parameter(chosen.node, 'Sym_Planar_Flag');
    const origin: Vec3 = [
      (parameter(chosen.node, 'X_Rel_Location') ?? 0) * lengthScale,
      (parameter(chosen.node, 'Y_Rel_Location') ?? 0) * lengthScale,
      (parameter(chosen.node, 'Z_Rel_Location') ?? 0) * lengthScale,
    ];
    const wing = execute(
      current,
      'create_wing',
      {
        sections,
        segments: segments.map(({ sweepDeg, sweepLocation, dihedralDeg }) => ({ sweepDeg, sweepLocation, dihedralDeg })),
        twistLocation: parameter(chosen.node, 'Twist_Location') ?? 0.25,
        mirror: params.mirror ?? (symmetry === null ? true : (Math.round(symmetry) & 2) !== 0),
        origin,
      },
      ctx,
    );
    if (wing.affected.length === 0) return { ...wing, summary: `import_openvsp_wing: ${wing.summary}` };
    const wingId = wing.affected[0] as string;
    const properties = execute(wing.document, 'wing_properties', { id: wingId }, ctx).data as Record<string, unknown> | undefined;
    const substituted = unsupported.map((k) => ({ section: k, naca: fallbackNaca as string }));
    return {
      ...changed(
        wing.document,
        briefNumbers(
          `import_openvsp_wing: imported "${chosen.name}" as wing "${wingId}" (${sections.length} sections, semi-span ${sig(stations[stations.length - 1] as number)} ${doc.units}, root chord ${sig((segments[0] as Segment).rootChord)}, tip chord ${sig((segments[segments.length - 1] as Segment).tipChord)})` +
            (substituted.length > 0
              ? `; section(s) ${unsupported.join(', ')} use the substitute NACA ${fallbackNaca} (UNVERIFIED: the file airfoil was not read)`
              : '') +
            '.',
        ),
        [...created, ...wing.affected],
      ),
      data: {
        wingId,
        geomName: chosen.name,
        sections: sections.map((s) => ({ span: sig(s.span), chord: sig(s.chord), twistDeg: s.twistDeg })),
        segments: segments.map((s) => ({
          spanLength: sig(s.span),
          sweepDeg: s.sweepDeg,
          sweepLocation: s.sweepLocation,
          dihedralDeg: s.dihedralDeg,
        })),
        substituted,
        unverified: substituted.length > 0,
        properties: properties ?? null,
        unit: doc.units,
        provenance: {
          method: 'OpenVSP parameters read from the XML and replayed through airfoil_from_naca / create_wing',
          reference: 'OpenVSP WingGeom.cpp parameter names',
          inputs: { geomName: chosen.name, lengthScale },
        },
      },
    };
  },
});
