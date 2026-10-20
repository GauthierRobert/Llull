/** Fixtures of the composite AP242 suites: a scripted XDE kernel whose writer returns a synthetic Part 21 base, a small panel and the export / import helpers. */

import { quoted } from '@aero/composites/ap242/part21';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExchangeWriteRequest, ImportedExchange } from '@core/geometry/kernelExchange';
import type { CompositePart, CompositesModel, Ply } from '@core/model/composites';
import type { CadDocument } from '@core/model/types';
import { fakeBrep, fakeStepText, fakeXdeKernel, importedBody, type XdeFakeSpec } from '../../../helpers/fakeXdeKernel';
import { apply, ok } from '../../../helpers/commandAssertions';
import { WOVEN } from './drapeFixtures';
import { AS4, ROSETTE, withMaterials } from './fixtures';

/** The fake writer's text plus a geometric context with global units, the one the composite records borrow. */
export const writeStep = (request: Pick<ExchangeWriteRequest, 'products'>): string => {
  const base = fakeStepText(
    request.products.map((product) => ({
      name: quoted(product.name).slice(1, -1),
      volume: product.validation?.volume ?? 1,
      area: product.validation?.area ?? 1,
      centroid: product.validation?.centroid ?? [0, 0, 0],
    })),
  );
  const context = [
    "#9000 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#1)) REPRESENTATION_CONTEXT('ctx','3D') );",
    "#9001 = REPRESENTATION('',(#9002),#9000);",
    "#9002 = MEASURE_REPRESENTATION_ITEM('x',VOLUME_MEASURE(1.),#1);",
    "#9003 = PRODUCT_DEFINITION_CONTEXT('part definition',#6,'design');",
  ].join('\n');
  const fixed = base.replace(/(PRODUCT_DEFINITION\('design','',#\d+,)#6\)/g, '$1#9003)');
  return fixed.replace('ENDSEC;\nEND-ISO', `${context}\nENDSEC;\nEND-ISO`);
};

export const requestOf = (names: readonly string[]): Pick<ExchangeWriteRequest, 'products'> => ({
  products: names.map((name) => ({ key: name, name, solids: [] })),
});

export const ctxOf = (spec: XdeFakeSpec = {}): { ctx: ExecutionContext; kernel: GeometryKernel } => {
  const { kernel } = fakeXdeKernel({ writeStep, ...spec });
  return { ctx: { ...defaultContext(), kernel }, kernel };
};

export const rect = (x0: number, y0: number, x1: number, y1: number): number[][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** A 200 x 100 panel on a named tool box: a full ply, a +45 polygon of another material and a -45 polygon; with ply solids when asked. */
export function panelDoc(withSolids = true): { doc: CadDocument; part: string; tool: string } {
  let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
  const tool = ok(doc, 'add_box', { size: [200, 100, 10], anchor: 'min', position: [0, 0, -10] });
  doc = apply(tool.document, 'set_entity_name', { id: tool.affected[0], name: 'Panel tool' });
  doc = apply(doc, 'define_rosette', ROSETTE);
  const part = ok(doc, 'create_composite_part', {
    name: 'Panel',
    toolSurface: { entityId: tool.affected[0], faceNear: [100, 50, 0] },
    rosette: 'R0',
  });
  doc = part.document;
  const id = part.affected[0] as string;
  doc = apply(doc, 'add_ply', { part: id, name: 'P1', material: WOVEN.name, orientation: 0, boundary: { kind: 'whole_face' } });
  doc = apply(doc, 'add_ply', {
    part: id,
    name: 'P2',
    material: AS4.name,
    orientation: 45,
    boundary: { kind: 'polygon', polygons: [rect(20, 10, 180, 90)] },
  });
  doc = apply(doc, 'add_ply', {
    part: id,
    name: 'P3',
    material: WOVEN.name,
    orientation: -45,
    boundary: { kind: 'polygon', polygons: [rect(60, 20, 140, 80)] },
  });
  if (withSolids) doc = apply(doc, 'create_ply_solids', { part: id });
  return { doc, part: id, tool: tool.affected[0] as string };
}

export interface Exported {
  readonly step: string;
  readonly selfCheck: { readonly band: string; readonly findings: readonly unknown[] };
  readonly plies: readonly {
    readonly name: string;
    readonly order: number;
    readonly area: number;
    readonly thickness: number;
    readonly solids: string[];
  }[];
  readonly validation: { readonly plyCount: number; readonly thickness: number; readonly mass?: number };
  readonly solids: { readonly exact: number; readonly faceted: readonly string[] };
  readonly records: number;
  readonly notWritten: { readonly cores: number };
  readonly reviewRequired: { readonly value: boolean; readonly reasons: readonly string[] };
}

export const exportOf = (
  doc: CadDocument,
  params: Record<string, unknown> = {},
  spec: XdeFakeSpec = {},
): { result: CommandResult; data: Exported } => {
  const { ctx } = ctxOf(spec);
  const result = execute(doc, 'export_composite_ap242', { part: 'Panel', ...params }, ctx);
  return { result, data: result.data as Exported };
};

export const importOf = (doc: CadDocument, params: Record<string, unknown>, spec: XdeFakeSpec = {}): CommandResult =>
  execute(doc, 'import_composite_ap242', params, ctxOf(spec).ctx);

export interface Imported {
  readonly part: string;
  readonly validation: {
    readonly band: string;
    readonly findings: readonly {
      readonly property: string;
      readonly subject: string;
      readonly band: string;
      readonly embedded: number | null;
    }[];
  };
  readonly materials: { readonly created: string[]; readonly reused: string[] };
  readonly rosettes: { readonly created: string[] };
  readonly tool: { readonly entityId: string; readonly imported: boolean };
  readonly solids: { readonly imported: string[]; readonly unlinked: number; readonly perPly: { readonly solids: string[] }[] };
  readonly reviewRequired: { readonly value: boolean; readonly reasons: string[] };
}

/** The solids an import_step_exact of the exported file would yield: one product per name, a tetra B-rep each. */
export const treeOf = (names: readonly string[], volumes: Readonly<Record<string, number>> = {}): ImportedExchange => ({
  solids: names.map((name) => importedBody(fakeBrep(volumes[name] ?? 10, 10, [0, 0, 0]), { name })),
  census: { roots: names.length, solids: names.length, shells: names.length, openShells: 0, faces: 6 * names.length },
  skipped: [],
  products: names.map((name, index) => ({ name, assembly: false, layers: [], solids: [index] })),
  occurrences: [],
  roots: names.map((_, index) => index),
});

export const modelOf = (doc: CadDocument): CompositesModel => doc.composites as CompositesModel;
export const pliesOfPart = (doc: CadDocument, name: string): { part: CompositePart; plies: Ply[] } => {
  const model = modelOf(doc);
  const part = Object.values(model.parts).find((candidate) => candidate.name === name) as CompositePart;
  return {
    part,
    plies: model.plyOrder
      .map((id) => model.plies[id] as Ply)
      .filter((ply) => ply.partId === part.id)
      .sort((a, b) => a.order - b.order),
  };
};
