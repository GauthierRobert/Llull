import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { findAll, parameter, parseXml, type XmlNode } from '@aero/surfacing/vspXml';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';

const empty = createEmptyDocument();

const four = (camber: number, location: number, thick: number): string =>
  `<XSec><XSecCurve><Type>7</Type><Camber Value="${camber}" Type="Parm"/><CamberLoc Value="${location}"/><ThickChord Value="${thick}"/></XSecCurve></XSec>`;

/** A TR1208-like swept wing file with the values stored in the pinned TR1208.vsp3 (the real file is not vendored). */
const tr1208 = (curves = [four(0, 0, 0.12), four(0, 0, 0.12)]): string => `<?xml version="1.0"?>
<!-- OpenVSP-like -->
<Vsp_Geometry>
 <Version>3</Version>
 <Vehicle>
  <Geom>
   <ParmContainer>
    <ID>ABCDEFGHIJ</ID>
    <Name>WingGeom</Name>
    <Group Name="XForm"><X_Rel_Location Value="0"/><Y_Rel_Location Value="0"/><Z_Rel_Location Value="0"/></Group>
    <Group Name="Sym"><Sym_Planar_Flag Value="2"/></Group>
    <Group Name="WingGeom"><Twist_Location Value="0.25"/></Group>
    <Group Name="XSec_1">
     <Span Value="63.63"/><Root_Chord Value="16.672"/><Tip_Chord Value="7.5024"/>
     <Sweep Value="45"/><Sweep_Location Value="0.25"/><Dihedral Value="0"/><Twist Value="0"/>
    </Group>
   </ParmContainer>
   <XSecSurf>${curves.join('')}</XSecSurf>
  </Geom>
 </Vehicle>
</Vsp_Geometry>`;

type Props = { areaPerSide: number; areaRef: number; sweepC4Deg: number };
const importData = (
  result: ReturnType<typeof execute>,
): { wingId: string; properties: Props; unverified: boolean; substituted: unknown[] } =>
  result.data as { wingId: string; properties: Props; unverified: boolean; substituted: unknown[] };

describe('vsp XML reader', () => {
  it('reads elements, attributes with both quote kinds, entities, CDATA and skips comments / instructions', () => {
    const tree = parseXml(
      `<?xml version="1.0"?><!-- c --><a x='1' y="a &amp; b"><b Value="2.5"/><Parm Name="Q" Value="3"/><t><![CDATA[<raw>]]> text &lt;</t></a>`,
    ) as XmlNode;
    expect(tree.tag).toBe('a');
    expect(tree.attrs).toEqual({ x: '1', y: 'a & b' });
    expect(parameter(tree, 'b')).toBe(2.5);
    expect(parameter(tree, 'Q')).toBe(3);
    expect(parameter(tree, 'missing')).toBeNull();
    expect(findAll(tree, (n) => n.tag === 't')[0]!.text).toBe('<raw> text <');
  });

  it('reports malformed documents', () => {
    expect(parseXml('<a><b></a>')).toContain('closing');
    expect(parseXml('<a>')).toContain('unclosed');
    expect(parseXml('<a/><b/>')).toContain('one XML document');
    expect(parseXml('just text')).toContain('one XML document');
  });
});

describe('import_openvsp_wing (VC-SRF-20, planform values of TR1208.vsp3)', () => {
  it('rebuilds the swept wing: semi-span 63.63, area per side 769.1085, total 1538.2171, sweep 45 at c/4', () => {
    const result = execute(empty, 'import_openvsp_wing', { text: tr1208() });
    expect(result.affected.length).toBeGreaterThan(2);
    const data = importData(result);
    expect(data.properties.areaPerSide).toBeCloseTo(769.1085, 3);
    expect(data.properties.areaRef).toBeCloseTo(1538.2171, 3);
    expect(data.properties.sweepC4Deg).toBeCloseTo(45, 6);
    expect(data.unverified).toBe(false);
    const wing = result.document.aero!.wings[data.wingId]!;
    expect(wing.sections.map((s) => [s.span, s.chord])).toEqual([
      [0, 16.672],
      [63.63, 7.5024],
    ]);
    expect(wing.entityIds).toHaveLength(2);
    expect(Object.keys(result.document.aero!.airfoils)).toHaveLength(1);
    expect(result.summary).toContain('import_openvsp_wing');
    expectPure(empty, () => execute(empty, 'import_openvsp_wing', { text: tr1208() }));
  });

  it('scales lengths, honours mirror, picks a wing by name and reuses equal airfoils', () => {
    const scaled = importData(execute(empty, 'import_openvsp_wing', { text: tr1208(), lengthScale: 25.4, mirror: false }));
    expect(scaled.properties.areaPerSide).toBeCloseTo(769.1085 * 25.4 * 25.4, 1);
    const named = execute(empty, 'import_openvsp_wing', { text: tr1208([four(0.02, 0.4, 0.12), four(0, 0, 0.09)]), geomName: 'WingGeom' });
    expect(Object.keys(named.document.aero!.airfoils)).toHaveLength(2);
    expect(Object.keys(named.document.aero!.wings)).toHaveLength(1);
  });

  it('refuses sections that are not NACA 4-series (listing them), unless a fallback NACA is given (then flagged unverified)', () => {
    const file = tr1208(['<XSec><XSecCurve><Type>FILE_AIRFOIL</Type></XSecCurve></XSec>', four(0, 0, 0.12)]);
    const refused = execute(empty, 'import_openvsp_wing', { text: file });
    expectNoOp(refused, empty, 'AERO_VSP_UNSUPPORTED');
    expect(refused.summary).toContain('section(s) 0');
    const substituted = execute(empty, 'import_openvsp_wing', { text: file, fallbackNaca: '0012' });
    const data = importData(substituted);
    expect(data.unverified).toBe(true);
    expect(data.substituted).toEqual([{ section: 0, naca: '0012' }]);
    expect(substituted.summary).toContain('UNVERIFIED');
    expectNoOp(execute(empty, 'import_openvsp_wing', { text: file, fallbackNaca: 'bogus' }), empty, 'AERO_PARAM_INVALID');
  });

  it('refuses text that is not a wing file, an unknown geometry name and bad parameters', () => {
    expectNoOp(execute(empty, 'import_openvsp_wing', { text: 'not xml' }), empty, 'AERO_VSP_PARSE');
    expectNoOp(
      execute(empty, 'import_openvsp_wing', { text: '<Vsp_Geometry><Vehicle><Geom><Name>Pod</Name></Geom></Vehicle></Vsp_Geometry>' }),
      empty,
      'AERO_VSP_NO_WING',
    );
    expectNoOp(execute(empty, 'import_openvsp_wing', { text: tr1208(), geomName: 'Nope' }), empty, 'AERO_VSP_NO_WING');
    expectNoOp(execute(empty, 'import_openvsp_wing', { text: tr1208(), lengthScale: 0 }), empty, 'AERO_PARAM_INVALID');
    const flat = tr1208().replace('<Span Value="63.63"/>', '<Span Value="0"/>');
    expectNoOp(execute(empty, 'import_openvsp_wing', { text: flat }), empty, 'AERO_VSP_NO_WING');
  });
});
