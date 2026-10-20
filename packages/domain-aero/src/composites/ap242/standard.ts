/**
 * The CAx-IF composite entity structure (Recommended Practices for Composite Materials v4.4 and Composite Structure Validation Properties v1.0, see
 * docs/aerospace/06-composites/validation/sources.md) written as AP242 records into an existing Part 21 text: the ply laminate table with its
 * sequences, the plies (category 'ply') with material (make_from_usage_option), orientation (ply_orientation_angle against a
 * reinforcement_orientation_basis), thickness and boundary curves, the ply pieces (the explicit ply solids) under their ply, the base surface, and the
 * composite validation properties named as the practice names them.
 * @invariant pure; entity names and attribute lists follow the AP242 ed4 MIM long form (checked by tests/unit/aero/composites/ap242Schema.test.ts when the schema file is given)
 */

import type { PartSurface } from '@core/model/composites';
import type { Vec3 } from '@core/model/types';
import { len3, sub3 } from '@lib/vec3';
import { referencesOf } from '@lib/step21/records';
import { type Builder, attach, integer, measure, point, text } from './emit';
import type { CompositeRecord, PlyRecord } from './interchange';
import { quoted, real } from './part21';
import { normalAt } from '../surface';

/** The identification string of the practice (section 2 of the document), added to FILE_DESCRIPTION. */
export const RECPRAC_ID = 'CAx-IF Rec.Pracs.---Composite Materials---4.3---2025-10-02';

/** The composite validation property name of the validation practice. */
const VP = 'composite validation property';

const STOCK_CATEGORY: Readonly<Record<string, string>> = {
  ud_tape: 'filament_assembly',
  woven: 'woven_assembly',
  core_honeycomb: 'stock_core',
  core_foam: 'stock_core',
};

export interface StandardInput {
  readonly b: Builder;
  readonly record: CompositeRecord;
  /** PRODUCT_DEFINITION of the tool product: supplies the product and product-definition contexts. */
  readonly anchor: number;
  readonly bodies: ReadonlyMap<number, string>;
  /** PRODUCT_DEFINITION of every product of the file by name (the explicit ply solids are looked up here). */
  readonly definitions: ReadonlyMap<string, number>;
}

/** Orientation values the validation practice lists: ascending, joined by a blank. */
export const orientationList = (angles: readonly number[]): string =>
  [...new Set(angles.map((angle) => String(Math.round(angle * 1e6) / 1e6 + 0)))]
    .map(Number)
    .sort((a, b) => a - b)
    .join(' ');

/** Length of the closed polylines (document units). */
export const curveLength = (curves: readonly (readonly Vec3[])[]): number =>
  curves.reduce(
    (sum, curve) => sum + curve.reduce((inner, vertex, k) => inner + len3(sub3(curve[(k + 1) % curve.length] as Vec3, vertex)), 0),
    0,
  );

function contexts(bodies: ReadonlyMap<number, string>, anchor: number): { definition: number; product: number } | null {
  const definition = referencesOf(bodies.get(anchor) ?? '');
  const formation = definition[0];
  const definitionContext = definition[definition.length - 1];
  const productId = formation === undefined ? undefined : referencesOf(bodies.get(formation) ?? '')[0];
  const productContext = productId === undefined ? undefined : referencesOf(bodies.get(productId) ?? '')[0];
  return definitionContext === undefined || productContext === undefined
    ? null
    : { definition: definitionContext, product: productContext };
}

function placement(b: Builder, origin: Vec3, axis: Vec3, ref: Vec3): number {
  const location = b.out.add(point('', origin));
  const z = b.out.add(`DIRECTION('',(${axis.map(real).join(',')}))`);
  const x = b.out.add(`DIRECTION('',(${ref.map(real).join(',')}))`);
  return b.out.add(`AXIS2_PLACEMENT_3D('',#${location},#${z},#${x})`);
}

/** The unbounded base surface of the part and the material-side direction, or null for a NURBS tool (not written). */
function baseSurface(b: Builder, record: CompositeRecord): number[] | null {
  const surface: PartSurface = record.surface;
  let item: number;
  if (surface.type === 'plane') item = b.out.add(`PLANE('base_surface',#${placement(b, surface.origin, surface.normal, surface.xDir)})`);
  else if (surface.type === 'cylinder')
    item = b.out.add(
      `CYLINDRICAL_SURFACE('base_surface',#${placement(b, surface.origin, surface.axis, surface.xDir)},${real(surface.radius)})`,
    );
  else if (surface.type === 'cone')
    item = b.out.add(
      `CONICAL_SURFACE('base_surface',#${placement(b, surface.apex, surface.axis, surface.xDir)},0.,${real(surface.semiAngle)})`,
    );
  else if (surface.type === 'sphere')
    item = b.out.add(
      `SPHERICAL_SURFACE('base_surface',#${placement(b, surface.center, surface.axis, surface.xDir)},${real(surface.radius)})`,
    );
  else return null;
  const middle = record.outline.reduce<[number, number]>(
    ([x, y], [u, v]) => [x + u / record.outline.length, y + v / record.outline.length],
    [0, 0],
  );
  const outward = normalAt(surface, middle);
  const side = record.laminateSide === 'positive_normal' ? 1 : -1;
  const direction = b.out.add(`DIRECTION('material side',(${outward.map((c) => real(side * c)).join(',')}))`);
  return [item, direction];
}

/** Rosette as `reinforcement_orientation_basis` with a cartesian_11 (or polar_11 for a radial rosette) member; returns the basis and the member. */
function basis(b: Builder, rosette: CompositeRecord['rosettes'][number]): { rob: number; member: number } {
  const location = b.out.add(point('', rosette.origin));
  const z = b.out.add(`DIRECTION('',(${rosette.normal.map(real).join(',')}))`);
  const x = b.out.add(`DIRECTION('',(${rosette.axis0.map(real).join(',')}))`);
  const parts = [
    `AXIS2_PLACEMENT_3D(#${z},#${x})`,
    'GEOMETRIC_REPRESENTATION_ITEM()',
    `PLACEMENT(#${location})`,
    rosette.method === 'radial' ? 'POLAR_11()' : 'CARTESIAN_11()',
    `REPRESENTATION_ITEM(${quoted(rosette.name)})`,
  ].sort();
  const member = b.out.add(`(${parts.join(' ')})`);
  return { rob: b.out.add(`REINFORCEMENT_ORIENTATION_BASIS(${quoted(rosette.name)},(#${member}),#${b.context})`), member };
}

/** Plies grouped into sequences: consecutive plies with the same `sequence` label share one `ply_laminate_sequence_definition`. */
export function sequencesOf(plies: readonly PlyRecord[]): { name: string; plies: PlyRecord[] }[] {
  const sequences: { name: string; plies: PlyRecord[] }[] = [];
  for (const ply of [...plies].sort((a, b) => a.order - b.order)) {
    const last = sequences[sequences.length - 1];
    if (last !== undefined && last.name === ply.sequence) last.plies.push(ply);
    else sequences.push({ name: ply.sequence, plies: [ply] });
  }
  return sequences;
}

/**
 * Appends the practice's structure; returns a failure reason, or null on success.
 * @failure the tool product has no product / definition context -> reason
 */
export function writeStandard(input: StandardInput): string | null {
  const { b, record, anchor, bodies, definitions } = input;
  const ctx = contexts(bodies, anchor);
  if (ctx === null) return 'the tool product has no product / product definition context to reuse';
  const { out, units } = b;
  const categories = new Map<string, number[]>();
  const categorise = (name: string, product: number): void => void categories.set(name, [...(categories.get(name) ?? []), product]);
  const product = (name: string, ...names: string[]): { product: number; formation: number } => {
    const id = out.add(`PRODUCT(${quoted(name)},${quoted(name)},'',(#${ctx.product}))`);
    for (const category of names) categorise(category, id);
    return { product: id, formation: out.add(`PRODUCT_DEFINITION_FORMATION('','',#${id})`) };
  };
  const definition = (entity: string, id: string, formation: number): number =>
    out.add(`${entity}(${quoted(id)},'',#${formation},#${ctx.definition})`);
  let usage = 0;
  const nauo = (relating: number, related: number): number =>
    out.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE(${quoted(String(++usage))},'',$,#${relating},#${related},$)`);

  const one = out.add(`MEASURE_WITH_UNIT(COUNT_MEASURE(1.),#${units.ratio})`);
  const laminate = product(`${record.name} laminate`, 'part', 'ply_laminate');
  const part = definition('PRODUCT_DEFINITION', 'design', laminate.formation);
  const table = definition('PLY_LAMINATE_TABLE', record.name, laminate.formation);
  out.add(`MAKE_FROM_USAGE_OPTION('','','',#${part},#${table},1,'',#${one})`);

  const bases = new Map<string, { rob: number; member: number; property: number }>();
  for (const rosette of record.rosettes) {
    const made = basis(b, rosette);
    const property = out.add(`PROPERTY_DEFINITION('basis','',#${table})`);
    out.add(`PROPERTY_DEFINITION_REPRESENTATION(#${property},#${made.rob})`);
    bases.set(rosette.name, { ...made, property });
  }
  const partBasis = bases.get(record.partRosette) ?? [...bases.values()][0];

  const surface = baseSurface(b, record);
  if (surface !== null) {
    const shape = out.add(`PRODUCT_DEFINITION_SHAPE('','',#${table})`);
    const aspect = out.add(`SHAPE_ASPECT('base_surface','',#${shape},.F.)`);
    const propertyDefinition = out.add(`PROPERTY_DEFINITION('','',#${aspect})`);
    const representation = out.add(`SHAPE_REPRESENTATION('',(${surface.map((id) => `#${id}`).join(',')}),#${b.context})`);
    out.add(`SHAPE_DEFINITION_REPRESENTATION(#${propertyDefinition},#${representation})`);
  }

  const materialDefinitions = new Map<string, number>();
  for (const material of record.materials) {
    const made = product(material.name, STOCK_CATEGORY[material.form] ?? 'isotropic_material');
    materialDefinitions.set(material.name, definition('PRODUCT_DEFINITION', 'design', made.formation));
  }

  const plyDefinitions = new Map<string, number>();
  const orientationAngles: number[] = [];
  const sequences = sequencesOf(record.plies);
  const sequenceDefinitions = sequences.map((sequence) =>
    definition('PLY_LAMINATE_SEQUENCE_DEFINITION', sequence.name, laminate.formation),
  );
  sequenceDefinitions.forEach((id, k) => {
    nauo(k === 0 ? table : (sequenceDefinitions[k - 1] as number), id);
  });
  for (const [k, sequence] of sequences.entries()) {
    for (const ply of sequence.plies) {
      const made = product(ply.name, 'ply');
      const plyDefinition = definition('PRODUCT_DEFINITION', 'design', made.formation);
      plyDefinitions.set(ply.name, plyDefinition);
      nauo(sequenceDefinitions[k] as number, plyDefinition);
      const material = materialDefinitions.get(ply.material);
      if (material !== undefined) out.add(`MAKE_FROM_USAGE_OPTION('','','',#${plyDefinition},#${material},1,'',#${one})`);
      attach(b, 'thickness', '', plyDefinition, [measure('thickness', 'LENGTH_MEASURE', ply.thickness, units.length)]);
      const rosette = bases.get(ply.rosette) ?? partBasis;
      const angle = ply.rosetteOrientation ?? ply.orientation;
      orientationAngles.push(angle);
      if (rosette !== undefined) {
        const angleItem = out.add(measure('orientation', 'PLANE_ANGLE_MEASURE', angle, units.angle));
        const angleRepresentation = out.add(`PLY_ANGLE_REPRESENTATION('',(#${angleItem}),#${b.context})`);
        out.add(`PLY_ORIENTATION_ANGLE('','',#${rosette.rob},#${angleRepresentation})`);
        const orientation = out.add(`PROPERTY_DEFINITION('orientation','',#${plyDefinition})`);
        out.add(`PROPERTY_DEFINITION_REPRESENTATION(#${orientation},#${angleRepresentation})`);
      }
      let previous = plyDefinition;
      for (const solid of ply.solids) {
        const piece = definitions.get(solid);
        if (piece === undefined) continue;
        nauo(previous, piece);
        previous = piece;
      }
      if (ply.curves3d !== undefined && ply.curves3d.length > 0) {
        const geometric = ply.curves3d.map((curve) => {
          const ids = curve.map((vertex) => out.add(point('', vertex)));
          return out.add(`POLYLINE('',(${[...ids, ids[0] as number].map((id) => `#${id}`).join(',')}))`);
        });
        const set = out.add(`GEOMETRIC_SET('',(${geometric.map((id) => `#${id}`).join(',')}))`);
        const shape = out.add(`PRODUCT_DEFINITION_SHAPE('','',#${plyDefinition})`);
        const defining = out.add(`GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION('laid ply shape',(#${set}),#${b.context})`);
        const edge = out.add(`SHAPE_REPRESENTATION('outer edge',(#${set}),#${b.context})`);
        out.add(`SHAPE_REPRESENTATION_RELATIONSHIP('','',#${defining},#${edge})`);
        for (const [name, representation] of [
          ['laid ply shape', defining],
          ['outer edge', edge],
        ] as const) {
          const aspect = out.add(`SHAPE_ASPECT(${quoted(name)},'',#${shape},.F.)`);
          const propertyDefinition = out.add(`PROPERTY_DEFINITION('','',#${aspect})`);
          out.add(`SHAPE_DEFINITION_REPRESENTATION(#${propertyDefinition},#${representation})`);
        }
      }
    }
  }
  for (const [name, members] of categories)
    out.add(`PRODUCT_RELATED_PRODUCT_CATEGORY(${quoted(name)},$,(${members.map((id) => `#${id}`).join(',')}))`);

  writeValidation(input, { part, table, sequences, sequenceDefinitions, plyDefinitions, materialDefinitions, bases, orientationAngles });
  return null;
}

interface Written {
  readonly part: number;
  readonly table: number;
  readonly sequences: { name: string; plies: PlyRecord[] }[];
  readonly sequenceDefinitions: readonly number[];
  readonly plyDefinitions: ReadonlyMap<string, number>;
  readonly materialDefinitions: ReadonlyMap<string, number>;
  readonly bases: ReadonlyMap<string, { rob: number; member: number; property: number }>;
  readonly orientationAngles: readonly number[];
}

/** The composite validation properties of the practice (part, laminate table, sequence, ply, rosette and material level). */
function writeValidation(input: StandardInput, w: Written): void {
  const { b, record } = input;
  const { out, units } = b;
  const plies = record.plies;
  const totalArea = plies.reduce((sum, ply) => sum + ply.area, 0);
  const orientations = new Set(w.orientationAngles.map((angle) => String(Math.round(angle * 1e6) / 1e6 + 0)));
  const counts = [
    integer('number of sequences', w.sequences.length),
    integer('number of plies', plies.length),
    integer('number of cores', 0),
    integer('number of materials', record.materials.length),
    integer('number of orientations', orientations.size),
  ];
  attach(b, VP, null, w.part, [
    integer('number of tables', 1),
    ...counts,
    integer('number of rosettes', record.rosettes.length),
    measure('total ply surface area', 'AREA_MEASURE', totalArea, units.area),
    text('ordered list of orientation values', orientationList(w.orientationAngles)),
  ]);
  const names = w.sequences.map((sequence) => out.add(text('sequence name', sequence.name)));
  const list = out.add(
    `ROW_REPRESENTATION_ITEM('ordered sequences per laminate table',LIST_REPRESENTATION_ITEM((${names.map((id) => `#${id}`).join(',')})))`,
  );
  attach(b, VP, null, w.table, [...counts, `#${list}`, measure('total ply surface area', 'AREA_MEASURE', totalArea, units.area)]);
  w.sequences.forEach((sequence, k) =>
    attach(b, VP, null, w.sequenceDefinitions[k] as number, [integer('number of plies', sequence.plies.length)]),
  );
  for (const ply of plies) {
    const definition = w.plyDefinitions.get(ply.name);
    if (definition === undefined) continue;
    const items = [
      ...(ply.curves3d === undefined ? [] : [measure('curve length measure', 'LENGTH_MEASURE', curveLength(ply.curves3d), units.length)]),
      ...(ply.solids.length === 0 ? [] : [integer('number of ply pieces per ply', ply.solids.length)]),
    ];
    if (items.length > 0) attach(b, VP, null, definition, items);
  }
  for (const rosette of record.rosettes) {
    const found = w.bases.get(rosette.name);
    if (found === undefined) continue;
    const users = plies.filter((ply) => (ply.rosette || record.partRosette) === rosette.name);
    const usage = out.add(`ITEM_IDENTIFIED_REPRESENTATION_USAGE('',$,#${found.property},#${found.rob},#${found.member})`);
    attach(b, VP, null, usage, [
      integer('number of plies', users.length),
      measure(
        'total boundary curve length',
        'LENGTH_MEASURE',
        users.reduce((sum, ply) => sum + curveLength(ply.curves3d ?? []), 0),
        units.length,
      ),
    ]);
  }
  for (const material of record.materials) {
    const definition = w.materialDefinitions.get(material.name);
    if (definition === undefined) continue;
    const area = plies.filter((ply) => ply.material === material.name).reduce((sum, ply) => sum + ply.area, 0);
    attach(b, VP, null, definition, [measure('total ply surface area', 'AREA_MEASURE', area, units.area)]);
  }
}

/** `text` with the practice identification added to the first FILE_DESCRIPTION list (a no-op when there is no header or it is there already). */
export function withRecPracId(textFile: string): string {
  if (textFile.includes(RECPRAC_ID)) return textFile;
  return textFile.replace(/FILE_DESCRIPTION\s*\(\s*\(/, (match) => `${match}${quoted(RECPRAC_ID)},`);
}
