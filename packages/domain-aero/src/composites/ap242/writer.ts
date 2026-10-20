/**
 * Writes the composite records of a `CompositeRecord` into an existing ISO 10303-21 text (06 CMP §6.4 V2, M5). OpenCascade's XDE writer has no composite
 * entities, so the records are appended to its output: they hang off the PRODUCT_DEFINITION of the tool product and of the explicit ply solids, and use
 * only AP242 MIM constructs that any reader accepts (PROPERTY_DEFINITION + PROPERTY_DEFINITION_REPRESENTATION + REPRESENTATION with descriptive, value,
 * measure, point, direction and polyline items). The subset is documented in 06 TECHNICAL_SPEC §13.6.
 * @invariant pure; the same record and base text give the same bytes; existing records are untouched, new ids follow the highest existing one
 */

import { MM_PER_UNIT } from '@core/model/units';
import { parseRecords } from '@lib/step21/records';
import type { CompositeRecord, PlyRecord, RosetteRecord } from './interchange';
import { type Builder, Emitter, attach, definitionsByName, makeUnits, measure, measureContext, point, text, value } from './emit';
import { asciiOnly, quoted, real } from './part21';
import { withRecPracId, writeStandard } from './standard';

/** Format tag of the llull composite records (the lossless extension next to the CAx-IF structure), written as `encoding` in the laminate property. */
export const ENCODING = 'llull-composite-2';

/** The first encoding: the same records without the CAx-IF structure; still read. */
export const LEGACY_ENCODING = 'llull-composite-1';

export const PROPERTY = {
  laminate: 'composite laminate',
  rosette: 'composite rosette',
  material: 'composite material',
  ply: 'composite ply',
  piece: 'composite ply piece',
  validation: 'composite validation property',
  extension: 'llull composite validation',
} as const;

function rosetteItems(b: Builder, rosette: RosetteRecord): string[] {
  const triple = (kind: 'CARTESIAN_POINT' | 'DIRECTION', name: string, v: readonly number[]): string =>
    `#${b.out.add(`${kind}(${quoted(name)},(${v.map(real).join(',')}))`)}`;
  const items = [text('name', rosette.name), text('method', rosette.method)];
  const geometry = [
    triple('CARTESIAN_POINT', 'origin', rosette.origin),
    triple('DIRECTION', 'axis0', rosette.axis0),
    triple('DIRECTION', 'normal', rosette.normal),
    ...(rosette.axis === undefined ? [] : [triple('DIRECTION', 'axis', rosette.axis)]),
  ];
  return [...items, ...geometry];
}

function plyItems(b: Builder, ply: PlyRecord): string[] {
  const polyline = (name: string, points: readonly (readonly number[])[]): string => {
    const ids = points.map((point) => b.out.add(`CARTESIAN_POINT('',(${point.map(real).join(',')}))`));
    return `#${b.out.add(`POLYLINE(${quoted(name)},(${ids.map((id) => `#${id}`).join(',')}))`)}`;
  };
  const boundary =
    ply.boundary.kind === 'whole_face' ? [] : ply.boundary.polygons.map((polygon, k) => polyline(`ply boundary ${k + 1}`, polygon));
  const curves = (ply.curves3d ?? []).map((curve, k) => polyline(`ply boundary curve ${k + 1}`, curve));
  return [
    text('name', ply.name),
    text('sequence', ply.sequence),
    text('material', ply.material),
    text('rosette', ply.rosette),
    text('boundary', ply.boundary.kind),
    value('order', 'COUNT_MEASURE', ply.order),
    measure('orientation', 'PLANE_ANGLE_MEASURE', ply.orientation, b.units.angle),
    measure('thickness', 'LENGTH_MEASURE', ply.thickness, b.units.length),
    measure('area', 'AREA_MEASURE', ply.area, b.units.area),
    text('data', JSON.stringify({ drape: ply.drape, cuts: ply.cuts, solids: ply.solids })),
    ...boundary,
    ...curves,
  ];
}

export type WriteOutcome =
  | { readonly ok: true; readonly text: string; readonly records: number }
  | { readonly ok: false; readonly reason: string };

/**
 * `base` with the composite records of `record` appended before the closing ENDSEC of its DATA section.
 * @failure no tool product / no representation context / no DATA section -> `{ ok: false, reason }`
 */
export function appendComposite(base: string, record: CompositeRecord): WriteOutcome {
  const { bodies } = parseRecords(base);
  const end = base.lastIndexOf('ENDSEC;');
  if (bodies.size === 0 || end < 0) return { ok: false, reason: 'the STEP text has no DATA section' };
  const definitions = definitionsByName(bodies);
  const anchor = definitions.get(record.tool.name);
  if (anchor === undefined) return { ok: false, reason: `the file has no product named "${record.tool.name}" for the tool surface` };
  const context = measureContext(bodies);
  if (context === null) return { ok: false, reason: 'the file has no representation context with global units' };
  const out = new Emitter([...bodies.keys()].reduce((max, key) => (key > max ? key : max), 0) + 1);
  const units = makeUnits(out, MM_PER_UNIT[record.units]);
  const b: Builder = { out, units, context };

  attach(b, PROPERTY.laminate, record.name, anchor, [
    text('encoding', ENCODING),
    text('name', record.name),
    text('unit', record.units),
    text('laminate side', record.laminateSide),
    text('tool', record.tool.name),
    text('part rosette', record.partRosette),
    point('tool face near', record.tool.faceNear),
    text(
      'data',
      JSON.stringify({
        surface: record.surface,
        outline: record.outline,
        rules: record.rules,
        plyDropRules: record.plyDropRules,
        tool: record.tool,
      }),
    ),
  ]);
  for (const rosette of record.rosettes) attach(b, PROPERTY.rosette, rosette.name, anchor, rosetteItems(b, rosette));
  for (const material of record.materials)
    attach(b, PROPERTY.material, material.name, anchor, [
      text('name', material.name),
      text('form', material.form),
      text('data', JSON.stringify(material)),
      measure('cured ply thickness', 'LENGTH_MEASURE', material.plyThickness, units.length),
    ]);
  for (const ply of record.plies) {
    attach(b, PROPERTY.ply, ply.name, anchor, plyItems(b, ply));
    ply.solids.forEach((solid) => {
      const piece = definitions.get(solid);
      if (piece !== undefined)
        attach(b, PROPERTY.piece, ply.name, piece, [
          text('ply', ply.name),
          text('laminate', record.name),
          value('order', 'COUNT_MEASURE', ply.order),
        ]);
    });
  }
  const { validation } = record;
  attach(b, PROPERTY.extension, 'laminate', anchor, [
    value('number of plies', 'COUNT_MEASURE', validation.plyCount),
    measure('laminate thickness', 'LENGTH_MEASURE', validation.thickness, units.length),
    ...(validation.mass === undefined ? [] : [value('laminate mass', 'MASS_MEASURE', validation.mass)]),
  ]);
  for (const ply of record.plies)
    attach(b, PROPERTY.extension, 'ply area', anchor, [text('ply', ply.name), measure('ply area', 'AREA_MEASURE', ply.area, units.area)]);
  const failure = writeStandard({ b, record, anchor, bodies, definitions });
  if (failure !== null) return { ok: false, reason: failure };
  const combined = `${withRecPracId(base.slice(0, end))}${out.lines.join('\n')}\n${base.slice(end)}`;
  return { ok: true, text: asciiOnly(combined), records: out.lines.length };
}
