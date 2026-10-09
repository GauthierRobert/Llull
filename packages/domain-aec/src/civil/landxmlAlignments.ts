/**
 * LandXML `<Alignments>` block: horizontal geometry (Line / Curve with N E coordinates) and the
 * design profile (PVI / ParaCurve) of every alignment, in metres.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import type { AlignmentObject } from '@core/model/civil';
import { escapeXml } from '@lib/escapeXml';
import { toMetres } from '../model';
import { civilObjectsOf, getCivil } from './model';
import { alignmentLength, horizontalElements } from './alignmentGeometry';

type Doc = Pick<CadDocument, 'civil' | 'units'>;

function metres(doc: Doc, value: number): string {
  return String(Number(toMetres(doc, value).toFixed(4)));
}

/** LandXML points are "northing easting". */
function ne(doc: Doc, point: Vec2): string {
  return `${metres(doc, point[1])} ${metres(doc, point[0])}`;
}

function alignmentXml(doc: Doc, alignment: AlignmentObject): string[] {
  const elements = horizontalElements(alignment).map((element) => {
    const common = `staStart="${metres(doc, element.startStation)}" length="${metres(doc, element.length)}"`;
    if (element.kind === 'line') {
      return (
        `        <Line ${common}><Start>${ne(doc, element.start)}</Start>` +
        `<End>${ne(doc, element.end)}</End></Line>`
      );
    }
    const delta = Number(((element.deflection * 180) / Math.PI).toFixed(6));
    return (
      `        <Curve rot="${element.rotation}" crvType="arc" radius="${metres(doc, element.radius)}" ` +
      `delta="${delta}" ${common}><Start>${ne(doc, element.start)}</Start>` +
      `<Center>${ne(doc, element.center)}</Center><End>${ne(doc, element.end)}</End>` +
      `<PI>${ne(doc, element.pi)}</PI></Curve>`
    );
  });
  const name = escapeXml(alignment.name);
  const profile =
    alignment.profile.length >= 2
      ? [
          `      <Profile name="${name}">`,
          `        <ProfAlign name="${name} design">`,
          ...alignment.profile.map((pvi, index) => {
            const at = `${metres(doc, pvi.station)} ${metres(doc, pvi.elevation)}`;
            const interior = index > 0 && index < alignment.profile.length - 1;
            return interior && pvi.curveLength > 0
              ? `          <ParaCurve length="${metres(doc, pvi.curveLength)}">${at}</ParaCurve>`
              : `          <PVI>${at}</PVI>`;
          }),
          '        </ProfAlign>',
          '      </Profile>',
        ]
      : [];
  return [
    `    <Alignment name="${name}" length="${metres(doc, alignmentLength(alignment))}" ` +
      `staStart="${metres(doc, alignment.startStation)}">`,
    '      <CoordGeom>',
    ...elements,
    '      </CoordGeom>',
    ...profile,
    '    </Alignment>',
  ];
}

/** `<Alignments>…</Alignments>` XML (indented one level, newline-terminated), or ''. */
export function alignmentsXml(doc: Doc): string {
  const alignments = civilObjectsOf(getCivil(doc), 'alignment');
  if (alignments.length === 0) return '';
  const lines = [
    '  <Alignments name="Alignments">',
    ...alignments.flatMap((alignment) => alignmentXml(doc, alignment)),
    '  </Alignments>',
  ];
  return `${lines.join('\n')}\n`;
}
