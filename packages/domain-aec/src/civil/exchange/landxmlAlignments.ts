/**
 * LandXML `<Alignments>` block: horizontal geometry (Line / Curve with N E coordinates) and the
 * design profile (PVI / ParaCurve) of every alignment, in metres.
 */

import { toDegrees } from '@lib/angle';
import { fixedNumber } from '@lib/compactNumber';
import type { CadDocument, Vec2 } from '@core/model/types';
import type { AlignmentObject } from '@core/model/civil';
import { escapeXml } from '@lib/escapeXml';
import { toMetres } from '@core/model/units';
import { civilObjectsOf, getCivil } from '../model';
import { alignmentLength, horizontalElements, type SpiralElement } from '../alignment/alignmentGeometry';
import { clothoidLocal } from '../alignment/alignmentSpiral';

type Doc = Pick<CadDocument, 'civil' | 'units'>;

/** Metres with at most 4 decimals (0.1 mm), no trailing zeros, never "-0". */
export function metres(doc: Doc, value: number): string {
  return fixedNumber(toMetres(doc, value), 4);
}

/** LandXML points are "northing easting". */
export function northEast(doc: Doc, point: Vec2): string {
  return `${metres(doc, point[1])} ${metres(doc, point[0])}`;
}

function radiusText(doc: Doc, radius: number): string {
  return Number.isFinite(radius) ? metres(doc, radius) : 'INF';
}

function spiralXml(doc: Doc, element: SpiralElement): string {
  const radius = Number.isFinite(element.radiusEnd) ? element.radiusEnd : element.radiusStart;
  const theta = element.length / (2 * radius);
  const [totalX, totalY] = clothoidLocal(element.length, radius, element.length);
  const degrees = Number(toDegrees(theta).toFixed(6));
  return (
    `        <Spiral length="${metres(doc, element.length)}" radiusStart="${radiusText(doc, element.radiusStart)}" ` +
    `radiusEnd="${radiusText(doc, element.radiusEnd)}" rot="${element.rotation}" spiType="clothoid" ` +
    `theta="${degrees}" totalX="${metres(doc, totalX)}" totalY="${metres(doc, totalY)}" ` +
    `tanLong="${metres(doc, totalX - totalY / Math.tan(theta))}" tanShort="${metres(doc, totalY / Math.sin(theta))}" ` +
    `staStart="${metres(doc, element.startStation)}"><Start>${northEast(doc, element.start)}</Start>` +
    `<PI>${northEast(doc, element.pi)}</PI><End>${northEast(doc, element.end)}</End></Spiral>`
  );
}

function alignmentXml(doc: Doc, alignment: AlignmentObject): string[] {
  const elements = horizontalElements(alignment).map((element) => {
    const common = `staStart="${metres(doc, element.startStation)}" length="${metres(doc, element.length)}"`;
    if (element.kind === 'line') {
      return `        <Line ${common}><Start>${northEast(doc, element.start)}</Start>` + `<End>${northEast(doc, element.end)}</End></Line>`;
    }
    if (element.kind === 'spiral') return spiralXml(doc, element);
    const delta = Number(toDegrees(element.deflection).toFixed(6));
    return (
      `        <Curve rot="${element.rotation}" crvType="arc" radius="${metres(doc, element.radius)}" ` +
      `delta="${delta}" ${common}><Start>${northEast(doc, element.start)}</Start>` +
      `<Center>${northEast(doc, element.center)}</Center><End>${northEast(doc, element.end)}</End>` +
      `<PI>${northEast(doc, element.pi)}</PI></Curve>`
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
  const lines = ['  <Alignments name="Alignments">', ...alignments.flatMap((alignment) => alignmentXml(doc, alignment)), '  </Alignments>'];
  return `${lines.join('\n')}\n`;
}
